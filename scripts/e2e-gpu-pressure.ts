import type { Database } from "bun:sqlite";
import { openHarnessDatabase } from "../src/storage/database.ts";
import { VllmResourceObserver } from "../src/resources/vllm-resource-observer.ts";
import type { ResourceThresholds } from "../src/resources/resource-classifier.ts";
import { ResourceAdmissionService } from "../src/resources/resource-admission-service.ts";
import { DeterministicExecutionPolicy } from "../src/resources/execution-policy.ts";
import { PolicyDecisionStore } from "../src/resources/policy-decision-store.ts";

/**
 * ECS 端到端：用【真实】VllmResourceObserver 拉取隧道过来的 GPU 机 vLLM /metrics，
 * 观察 GPU 并发压力如何真实驱动准入决策（RESOURCE_NORMAL -> BUSY/CRITICAL -> QUEUE）。
 * 与之前注入 Fake observer 的 demo 不同，这里 observer 读的是真实 /metrics。
 */

const METRICS_URL =
    process.env.HARNESS_GPU_METRICS_URL ?? "http://localhost:18000/metrics";

const thresholds: ResourceThresholds = {
    busyGpuMemoryPercent: 80,
    criticalGpuMemoryPercent: 90,
    busyKvCachePercent: 80,
    criticalKvCachePercent: 90,
    busyRunningRequests: 8,
    criticalRunningRequests: 40,
    busyWaitingRequests: 8,
    criticalWaitingRequests: 40,
};

function ensureRun(db: Database, runId: string, tenantId: string): void {
    const now = new Date().toISOString();
    db.query<unknown, Record<string, string>>(
        `INSERT OR IGNORE INTO agent_runs
            (id, tenant_id, harness_session_id, status, user_input,
             workspace_path, created_at, updated_at)
         VALUES ($id, $tenant, 'gpu-e2e-session', 'QUEUED', 'demo',
                 '/tmp/gpu-e2e', $now, $now)`,
    ).run({ id: runId, tenant: tenantId, now });
}

if (import.meta.main) {
    const db = openHarnessDatabase(
        process.env.HARNESS_E2E_DB_PATH ?? "/tmp/gpu-e2e.db",
    );
    const recorder = new PolicyDecisionStore(db);

    const observer = new VllmResourceObserver({
        metricsUrl: METRICS_URL,
        timeoutMs: 6_000,
        gpuIds: ["gpu0"],
    });
    const policy = new DeterministicExecutionPolicy({ maxActiveRuns: 200 });
    const admission = new ResourceAdmissionService(
        observer, thresholds, policy, recorder,
    );

    console.log(`采样真实 GPU /metrics: ${METRICS_URL}`);
    const samples: Array<Record<string, unknown>> = [];
    const iterations = Number(process.env.HARNESS_E2E_SAMPLES ?? 15);

    for (let i = 0; i < iterations; i += 1) {
        const runId = `gpu-run-${i}`;
        const tenantId = i % 2 === 0 ? "tenant-a" : "tenant-b";
        ensureRun(db, runId, tenantId);
        const result = await admission.evaluate({
            runId,
            tenantId,
            activeRunCount: 0,
            activeTenantRunCount: 0,
        });
        const snap = result.observation.ok ? result.observation.snapshot : null;
        samples.push({
            i,
            running: snap?.runningRequests ?? null,
            waiting: snap?.waitingRequests ?? null,
            kvCachePct: snap ? Math.round((snap.kvCacheUsagePercent ?? 0) * 10) / 10 : null,
            pressure: result.classification?.pressure ?? null,
            action: result.decision.action,
            reasonCode: result.decision.reasonCode,
        });
        await Bun.sleep(2_000);
    }

    console.log(JSON.stringify({ samples }, null, 1));
    db.close();
}
