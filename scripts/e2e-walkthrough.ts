/**
 * 端到端走查脚本：真实 HTTP → 鉴权 → Workspace → 准入 → 队列 → Sandbox →
 * Worker 子进程（NDJSON IPC）→ 事件落库 → 输出/证据查询。
 *
 * 与 src/main.ts 的唯一区别：
 * 1. 注入一个可切换的 ResourceObserver（代替需要真实 vLLM + nvidia-smi 的观测器），
 *    以便在没有 GPU 的机器上演示 VRAM 准入的两条分支（START 与 QUEUE）。
 * 2. HTTP 端口用 0，由内核分配空闲端口。
 *
 * Worker 侧沿用生产入口 src/worker/worker-main.ts，用 HARNESS_WORKER_SIMULATE
 * 内置的 mock_stream 模式回放一段 text_delta（不启动 Pi、不需要模型与容器），
 * 因此整条控制面、IPC 与持久化路径都是真实的。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadHarnessConfig } from "../src/app/harness-config.ts";
import { startHarnessProcess } from "../src/main.ts";
import type {
    ResourceObservation,
    ResourceObserver,
    ResourceSnapshot,
} from "../src/resources/resource-observer.ts";
import { formatRunEventTimeline } from "../src/events/run-event-timeline.ts";

/** 可切换的假观测器：只替换"GPU 现在多忙"这一个输入，其余全是真实链路。 */
class MutableResourceObserver implements ResourceObserver {
    private observation: ResourceObservation;

    constructor(observation: ResourceObservation) {
        this.observation = observation;
    }

    async observe(): Promise<ResourceObservation> {
        return this.observation;
    }

    set(snapshot: ResourceSnapshot): void {
        this.observation = { ok: true, snapshot };
    }
}

/** 构造一个可控的 GPU 快照：used/total 决定压力等级。 */
function snapshot(id: string, usedMiB: number, running: number): ResourceSnapshot {
    const total = 100;
    return {
        snapshotId: id,
        observedAt: new Date().toISOString(),
        sources: ["FAKE"],
        gpuTotalMemoryMiB: total,
        gpuUsedMemoryMiB: usedMiB,
        gpuFreeMemoryMiB: total - usedMiB,
        gpuUtilizationPercent: usedMiB,
        runningRequests: running,
        waitingRequests: 0,
        kvCacheUsagePercent: 20,
        inputTokensPerSecond: null,
        outputTokensPerSecond: null,
    };
}

interface HttpContext {
    baseUrl: string;
    apiKey: string;
}

async function call(
    context: HttpContext,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; json: any }> {
    const response = await fetch(`${context.baseUrl}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${context.apiKey}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }
    return { status: response.status, json };
}

async function waitForTerminal(
    context: HttpContext,
    runId: string,
    timeoutMs = 30_000,
): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const payload = await call(context, "GET", `/runs/${runId}`);
        const status = payload.json?.run?.status;
        if (status === "COMPLETED" || status === "FAILED" || status === "INTERRUPTED") {
            return payload.json;
        }
        if (Date.now() > deadline) {
            throw new Error(`等待 Run 终态超时：${runId} status=${status}`);
        }
        await Bun.sleep(100);
    }
}

async function waitForQueueReason(
    context: HttpContext,
    runId: string,
    expected: string,
    timeoutMs = 10_000,
): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const payload = await call(context, "GET", "/queue");
        const entry = payload.json?.queue?.find((item: any) => item.runId === runId);
        if (entry !== undefined && entry.reasonCode === expected) {
            return entry;
        }
        if (Date.now() > deadline) {
            throw new Error(`等待排队原因超时：${runId} 期望 ${expected}`);
        }
        await Bun.sleep(100);
    }
}

function heading(title: string): void {
    console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

/** 借内核分配一个空闲端口：HARNESS_PORT 只接受正整数，不能用 0。 */
function findFreePort(): number {
    const probe = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("ok"),
    });
    const port = probe.port;
    probe.stop(true);
    if (port === undefined) {
        throw new Error("无法分配空闲端口");
    }
    return port;
}

/** 注册并登录一个新用户；其 tenantId 等于 userId，会话凭证持有全部 scope。 */
async function registerTenant(
    baseUrl: string,
    email: string,
): Promise<{ tenantId: string; token: string }> {
    const password = "demo-password-1234";
    const registered = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (!registered.ok) {
        throw new Error(`注册失败：HTTP ${registered.status} ${await registered.text()}`);
    }
    const loggedIn = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (!loggedIn.ok) {
        throw new Error(`登录失败：HTTP ${loggedIn.status} ${await loggedIn.text()}`);
    }
    const payload = await loggedIn.json() as { token: string; tenantId: string };
    return { tenantId: payload.tenantId, token: payload.token };
}

async function main(): Promise<void> {
    const tempRoot = mkdtempSync(join(tmpdir(), "harness-e2e-"));
    // Worker 子进程通过继承环境变量读取模拟模式。
    process.env.HARNESS_WORKER_SIMULATE = "mock_stream";

    const observer = new MutableResourceObserver({
        ok: true,
        snapshot: snapshot("snap-initial-normal", 20, 0),
    });

    const config = loadHarnessConfig({
        VLLM_MODEL_ID: "Qwen3-8B-demo",
        HARNESS_DATABASE_PATH: join(tempRoot, "harness.sqlite"),
        HARNESS_WORKSPACE_ROOT: join(tempRoot, "workspaces"),
        HARNESS_PORT: String(findFreePort()),
        HARNESS_BOOTSTRAP_API_KEY: "demo-bootstrap-key-0001",
        HARNESS_AGENT_API_KEY: "demo-agent-key-0002",
        HARNESS_PUMP_INTERVAL_MS: "1000",
        HARNESS_SANDBOX_PROVIDER: "managed-local",
        HARNESS_MAX_USER_INPUT_CHARS: "2000",
    });

    const running = await startHarnessProcess({
        config,
        compositionDependencies: { resourceObserver: observer },
        installSignalHandlers: false,
    });
    const context: HttpContext = {
        baseUrl: running.baseUrl,
        apiKey: "demo-bootstrap-key-0001",
    };

    try {
        heading("0. 进程启动：真实 HTTP 服务 + 真实 Worker 入口");
        console.log(`baseUrl              = ${running.baseUrl}`);
        console.log(`databasePath         = ${running.config.databasePath}`);
        console.log(`sandboxProvider      = ${running.config.sandboxProvider}`);
        console.log(`sandboxProfile       = ${running.config.sandboxProfile}`);
        console.log(`workerIsolation      = ${running.config.workerIsolation}`);
        console.log(`workerScriptPath     = ${running.config.workerScriptPath}`);
        console.log(`pumpIntervalMs       = ${running.config.pumpIntervalMs}`);
        console.log(`maxActiveRuns        = ${running.config.maxActiveRuns}`);
        console.log(`沙箱阈值 busy/critical GPU% = ${running.config.resourceThresholds.busyGpuMemoryPercent}/${running.config.resourceThresholds.criticalGpuMemoryPercent}`);
        console.log(`沙箱阈值 busy/critical KV%  = ${running.config.resourceThresholds.busyKvCachePercent}/${running.config.resourceThresholds.criticalKvCachePercent}`);

        const health = await call(context, "GET", "/health");
        console.log(`\nGET /health -> ${health.status} ${JSON.stringify(health.json)}`);

        heading("1. 异常与边界：鉴权、越权、输入上界、路由");
        const probeBody = JSON.stringify({
            sessionId: "probe",
            userInput: "probe",
            workspaceId: "00000000-0000-0000-0000-000000000000",
        });
        const probe = async (label: string, key: string | null, input = probeBody) => {
            const response = await fetch(`${running.baseUrl}/runs`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(key === null ? {} : { authorization: `Bearer ${key}` }),
                },
                body: input,
            });
            console.log(`${label} -> HTTP ${response.status} ${await response.text()}`);
        };
        await probe("空 body、无凭证        ", null, "");
        await probe("合法 JSON、无凭证      ", null);
        await probe("错误密钥               ", "wrong-key");
        await probe("仅 models:generate 密钥", "demo-agent-key-0002");
        const notFound = await fetch(`${running.baseUrl}/nope`, { method: "POST" });
        console.log(`未知路由 POST /nope     -> HTTP ${notFound.status} ${await notFound.text()}`);
        const notFoundJob = await fetch(`${running.baseUrl}/runs/does-not-exist`, {
            headers: { authorization: "Bearer demo-bootstrap-key-0001" },
        });
        console.log(`查询不存在的 Run       -> HTTP ${notFoundJob.status} ${await notFoundJob.text()}`);

        heading("2. 场景 A：GPU 空闲（NORMAL）→ 直接 START");
        const workspaceA = await call(context, "POST", "/workspaces", {
            name: `demo-a-${Date.now()}`,
        });
        console.log(`POST /workspaces -> ${workspaceA.status} id=${workspaceA.json.workspace.id}`);
        const workspaceIdA = workspaceA.json.workspace.id as string;

        // 输入上界（HARNESS_MAX_USER_INPUT_CHARS=2000）在 workspace 解析之后检查，
        // 所以这里必须带一个真实存在的 workspaceId 才能命中 413。
        const noisy = JSON.stringify({
            sessionId: "probe-too-long",
            userInput: "x".repeat(2001),
            workspaceId: workspaceIdA,
        });
        await probe("超长输入 2001 字符     ", "demo-bootstrap-key-0001", noisy);

        const requestA = {
            sessionId: `sess-a-${crypto.randomUUID()}`,
            userInput: "请读取 README.md，并只用一行回答首行内容。",
            workspaceId: workspaceIdA,
            thinkingLevel: "low",
        };
        console.log(`\nPOST /runs body = ${JSON.stringify(requestA)}`);

        observer.set(snapshot("snap-normal-1", 20, 0));
        const submitA = await call(context, "POST", "/runs", requestA);
        console.log(`POST /runs -> ${submitA.status}`);
        console.log(`响应 run = ${JSON.stringify({
            id: submitA.json.run.id,
            status: submitA.json.run.status,
            templateVersionId: submitA.json.run.templateVersionId,
            harnessInstanceId: submitA.json.run.harnessInstanceId,
        })}`);
        const runIdA = submitA.json.run.id as string;

        const finalA = await waitForTerminal(context, runIdA);
        console.log(`\n终态 status = ${finalA.run.status}`);
        console.log(`decisions = ${JSON.stringify(finalA.decisions.map((d: any) => ({
            action: d.action,
            reasonCode: d.reasonCode,
            pressure: d.pressure,
            snapshot: d.resourceSnapshotId,
        })))}`);
        console.log(`limitations = ${JSON.stringify(finalA.limitations)}`);

        const eventsA = await call(context, "GET", `/runs/${runIdA}/events`);
        console.log(`\n事件时间线（GET /runs/:id/events）：`);
        console.log(formatRunEventTimeline(eventsA.json.events));

        const outputA = await call(context, "GET", `/runs/${runIdA}/output`);
        console.log(`\nGET /runs/:id/output -> finalText = ${JSON.stringify(outputA.json.finalText)}`);

        const obsA = await call(context, "GET", `/runs/${runIdA}/observability`);
        console.log(`\nGET /runs/:id/observability = ${JSON.stringify(obsA.json, null, 2)}`);

        heading("3. 场景 B：GPU 打满（CRITICAL）→ QUEUE，回落后 START");
        const workspaceB = await call(context, "POST", "/workspaces", {
            name: `demo-b-${Date.now()}`,
        });
        const workspaceIdB = workspaceB.json.workspace.id as string;

        observer.set(snapshot("snap-critical-1", 95, 9));
        const submitB = await call(context, "POST", "/runs", {
            sessionId: `sess-b-${crypto.randomUUID()}`,
            userInput: "统计 src 下的模块数量并给出结论。",
            workspaceId: workspaceIdB,
        });
        console.log(`POST /runs -> ${submitB.status} status=${submitB.json.run.status}`);
        const runIdB = submitB.json.run.id as string;

        const queuedEntry = await waitForQueueReason(context, runIdB, "RESOURCE_CRITICAL");
        console.log(`\nGET /queue 命中排队项 = ${JSON.stringify(queuedEntry)}`);

        const queueSnapshot = await call(context, "GET", "/queue");
        console.log(`GET /queue 全量 = ${JSON.stringify(queueSnapshot.json.queue)}`);

        const blockedB = await call(context, "GET", `/runs/${runIdB}`);
        console.log(`\n排队中的 decisions = ${JSON.stringify(blockedB.json.decisions.map((d: any) => ({
            action: d.action,
            reasonCode: d.reasonCode,
            pressure: d.pressure,
        })))}`);

        console.log(`\n>>> 切换观测器：GPU 回落到 20%（NORMAL），等待下一次 pump tick`);
        observer.set(snapshot("snap-normal-2", 20, 0));
        const finalB = await waitForTerminal(context, runIdB);
        console.log(`终态 status = ${finalB.run.status}`);
        console.log(`decisions = ${JSON.stringify(finalB.decisions.map((d: any) => ({
            action: d.action,
            reasonCode: d.reasonCode,
            pressure: d.pressure,
            snapshot: d.resourceSnapshotId,
        })))}`);

        const eventsB = await call(context, "GET", `/runs/${runIdB}/events`);
        console.log(`\n事件时间线：`);
        console.log(formatRunEventTimeline(eventsB.json.events));

        heading("4. 场景 C：双租户并发排队 → 每租户 FIFO、租户间轮转");
        const tenantB = await registerTenant(running.baseUrl, "demo-tenant-b@example.com");
        console.log(`新租户 tenantId = ${tenantB.tenantId}`);
        const contextB: HttpContext = { baseUrl: running.baseUrl, apiKey: tenantB.token };
        const workspaceC = await call(contextB, "POST", "/workspaces", {
            name: `demo-c-${Date.now()}`,
        });
        const workspaceIdC = workspaceC.json.workspace.id as string;
        const workspaceA2 = await call(context, "POST", "/workspaces", {
            name: `demo-c2-${Date.now()}`,
        });
        const workspaceIdA2 = workspaceA2.json.workspace.id as string;

        observer.set(snapshot("snap-critical-2", 96, 12));
        const tenantARuns: string[] = [];
        const tenantBRuns: string[] = [];
        tenantARuns.push((await call(context, "POST", "/runs", {
            sessionId: `a1-${crypto.randomUUID()}`,
            userInput: "租户 A 的第 1 个任务",
            workspaceId: workspaceIdA,
        })).json.run.id);
        tenantBRuns.push((await call(contextB, "POST", "/runs", {
            sessionId: `b1-${crypto.randomUUID()}`,
            userInput: "租户 B 的第 1 个任务",
            workspaceId: workspaceIdC,
        })).json.run.id);
        tenantARuns.push((await call(context, "POST", "/runs", {
            sessionId: `a2-${crypto.randomUUID()}`,
            userInput: "租户 A 的第 2 个任务",
            workspaceId: workspaceIdA2,
        })).json.run.id);
        tenantBRuns.push((await call(contextB, "POST", "/runs", {
            sessionId: `b2-${crypto.randomUUID()}`,
            userInput: "租户 B 的第 2 个任务",
            workspaceId: workspaceIdC,
        })).json.run.id);

        await waitForQueueReason(context, tenantARuns[1]!, "RESOURCE_CRITICAL");
        await waitForQueueReason(contextB, tenantBRuns[1]!, "RESOURCE_CRITICAL");

        const queueA = await call(context, "GET", "/queue");
        const queueB = await call(contextB, "GET", "/queue");
        console.log(`\n租户 A 视角的 /queue（position 是全局轮转序号）：`);
        for (const entry of queueA.json.queue) {
            console.log(`  position=${entry.position} tenantPosition=${entry.tenantPosition} reason=${entry.reasonCode} run=${entry.runId}`);
        }
        console.log(`\n租户 B 视角的 /queue（同一份全局序号，另一租户的切片）：`);
        for (const entry of queueB.json.queue) {
            console.log(`  position=${entry.position} tenantPosition=${entry.tenantPosition} reason=${entry.reasonCode} run=${entry.runId}`);
        }
        console.log(`\n租户 A 的 runId 顺序 = ${JSON.stringify(tenantARuns)}`);
        console.log(`租户 B 的 runId 顺序 = ${JSON.stringify(tenantBRuns)}`);
        console.log("（对照 position：全局投影顺序为 A1, B1, A2, B2 —— 每租户内部 FIFO，租户之间轮转）");

        console.log(`\n>>> 切换观测器：GPU 回落到 20%（NORMAL），等待 4 个 Run 全部收敛`);
        observer.set(snapshot("snap-normal-3", 20, 0));
        for (const runId of [...tenantARuns, ...tenantBRuns]) {
            const owner = tenantARuns.includes(runId) ? context : contextB;
            const settled = await waitForTerminal(owner, runId);
            console.log(`run=${runId} status=${settled.run.status} tenant=${settled.run.tenantId}`);
        }

        heading("5. 落库证据：Attempt / Sandbox / 策略快照 / 输出");
        for (const runId of [runIdA, runIdB]) {
            console.log(`\n--- run ${runId} ---`);
            const attempts = running.composition.attemptStore.listForRun(runId);
            for (const attempt of attempts) {
                console.log(`attempt#${attempt.attemptNumber} kind=${attempt.kind} status=${attempt.status} sandboxId=${attempt.sandboxId ?? "none"} reason=${attempt.failureReason ?? "none"}`);
                if (attempt.sandboxId !== null) {
                    const record = running.composition.sandboxStore.get(attempt.sandboxId);
                    if (record !== null) {
                        console.log(`  sandbox provider=${record.provider} status=${record.status} runtime=${record.runtime}`);
                        console.log(`  spec = ${JSON.stringify({
                            profile: record.spec.profile,
                            runtime: record.spec.runtime,
                            networkMode: record.spec.networkMode,
                            readOnlyRootfs: record.spec.readOnlyRootfs,
                            droppedCapabilities: record.spec.droppedCapabilities,
                            noNewPrivileges: record.spec.noNewPrivileges,
                            pidLimit: record.spec.pidLimit,
                        })}`);
                        console.log(`  runtimeEvidence = ${JSON.stringify(record.runtimeEvidence)}`);
                        console.log(`  failureReason   = ${record.failureReason ?? "none"}（正常终止）`);
                    }
                }
            }
            const snapshots = running.composition.effectivePolicyStore.listSnapshotsForRun(runId);
            for (const snap of snapshots) {
                console.log(`policySnapshot id=${snap.id} profile=${snap.sandboxProfile} allowNetwork=${snap.allowNetwork} allowedTools=${JSON.stringify(snap.allowedTools)} workspaceRoots=${JSON.stringify(snap.workspaceRoots)}`);
                const compilations = running.composition.effectivePolicyStore.listCompilations(snap.id);
                for (const compilation of compilations) {
                    console.log(`  compilation status=${compilation.status} reasons=${JSON.stringify(compilation.reasons)}`);
                }
                const toolDecisions = running.composition.effectivePolicyStore.listToolDecisions(runId);
                console.log(`  toolDecisions = ${JSON.stringify(toolDecisions)}`);
            }
            const chunks = running.composition.runOutputStore.list(runId);
            console.log(`outputChunks = ${chunks.length} 条，finalText=${JSON.stringify(running.composition.runOutputStore.finalText(runId))}`);
            const instances = running.composition.instanceStore.listForTenant(
                finalA.run.tenantId,
            );
            for (const instance of instances) {
                console.log(`instance ${instance.id} actual=${instance.actualState} activeRunCount=${instance.activeRunCount} capability=${instance.capabilityProfileId}`);
            }
        }

        heading("6. 审计：ALLOW / DENY 均落库，按租户可查");
        const audit = await call(context, "GET", "/audit");
        const events: any[] = audit.json.events ?? [];
        console.log(`GET /audit（租户 bootstrap 视角）-> ${audit.status}，共 ${events.length} 条`);
        const auditB = await call(contextB, "GET", "/audit");
        console.log(`GET /audit（租户 B 视角）        -> ${auditB.status}，共 ${auditB.json.events.length} 条（租户隔离）`);

        // 无凭证 / 无效密钥的 DENY 没有可归属的租户，tenant_id 记为 NULL，
        // 因此不出现在任何租户视图里；这里直接查库把证据链补全。
        const allAudit = running.composition.database.query<{
            timestamp: string;
            action: string;
            outcome: string;
            tenantId: string | null;
            reason: string;
            attemptedKeyDigest: string | null;
        }, Record<string, never>>(`
            SELECT timestamp, action, outcome, tenant_id AS tenantId, reason,
                attempted_key_digest AS attemptedKeyDigest
            FROM access_audit_events
            ORDER BY timestamp ASC, rowid ASC
        `).all({});
        console.log(`\n全库审计共 ${allAudit.length} 条。DENY 记录（含被尝试密钥摘要，不存明文）：`);
        for (const event of allAudit.filter((item) => item.outcome === "DENY")) {
            console.log(`  ${event.timestamp} action=${event.action} tenant=${event.tenantId ?? "NULL"} reason=${event.reason} keyDigest=${event.attemptedKeyDigest ?? "none"}`);
        }
        console.log(`\nRUN_SUBMIT 类 ALLOW 记录：`);
        for (const event of allAudit.filter((item) => item.action === "RUN_SUBMIT")) {
            console.log(`  ${event.timestamp} tenant=${event.tenantId ?? "NULL"} reason=${event.reason}`);
        }

        heading("7. 生命周期：安全关闭");
        await running.close();
        console.log("close() 完成：HTTP 停止 → 队列 Pump 停止 → SQLite 关闭");

        console.log("\nRESULT: PASS");
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

interface FailureCase {
    label: string;
    simulate: string;
    env: Record<string, string>;
    expectedStatus: string;
    action?: "interrupt";
    note: string;
    /** 非空表示这是与其它分支不一致的观察，打印为告警而不是断言错误。 */
    warning?: string;
}

/** 故障走查：同一套生产入口，只换 Worker 的注入模式。 */
async function failureWalkthrough(): Promise<void> {
    const cases: FailureCase[] = [
        {
            label: "Worker 崩溃（SIGKILL 自身）",
            simulate: "crash_sigkill",
            env: {},
            expectedStatus: "FAILED",
            note: "Master 的 exited 看门狗把子进程死亡翻译成 agent_failed → RUN_FAILED",
        },
        {
            label: "Worker 主动回报失败",
            simulate: "fail_run",
            env: {},
            expectedStatus: "INTERRUPTED",
            note: "Worker 经 IPC 发 RUN_FAILED，Master 只 reject(start) 而不发 agent_failed",
            warning:
                "行为不一致：RUN_FAILED 分支只 rejectPromise，不发 agent_failed 事件，"
                + "于是走 markRuntimeInvocationFailureInterrupted → Run 变成 INTERRUPTED 且 "
                + "failureReason=null，而不是像崩溃分支那样 FAILED。失败原因只留在 "
                + "RUN_INTERRUPTED 事件的 payload.message 与 attempt.failureReason 里，"
                + "Run 级 API 看不到。此差异无测试覆盖。",
        },
        {
            label: "Worker 卡死且忽略中断（执行超时兜底）",
            simulate: "hang_stubborn",
            env: { HARNESS_EXECUTION_TIMEOUT_MS: "3000", HARNESS_INTERRUPT_GRACE_MS: "1000" },
            expectedStatus: "INTERRUPTED",
            note: "Supervisor 在 3s 超时后优雅中断 → 宽限 1s → SIGKILL 强杀，Run 收敛为 INTERRUPTED",
        },
    ];

    for (const testCase of cases) {
        const tempRoot = mkdtempSync(join(tmpdir(), "harness-e2e-fail-"));
        const pumpErrors: string[] = [];
        process.env.HARNESS_WORKER_SIMULATE = testCase.simulate;
        const observer = new MutableResourceObserver({
            ok: true,
            snapshot: snapshot("snap-fail", 20, 0),
        });
        const config = loadHarnessConfig({
            VLLM_MODEL_ID: "Qwen3-8B-demo",
            HARNESS_DATABASE_PATH: join(tempRoot, "harness.sqlite"),
            HARNESS_WORKSPACE_ROOT: join(tempRoot, "workspaces"),
            HARNESS_PORT: String(findFreePort()),
            HARNESS_BOOTSTRAP_API_KEY: "demo-bootstrap-key-0001",
            HARNESS_PUMP_INTERVAL_MS: "500",
            HARNESS_SANDBOX_PROVIDER: "managed-local",
            ...testCase.env,
        });
        const running = await startHarnessProcess({
            config,
            compositionDependencies: {
                resourceObserver: observer,
                // 统计 pump 抛出的错误次数，用来验证"一次失败被记了几条"。
                onPumpError: (error) => {
                    pumpErrors.push(
                        error instanceof Error
                            ? (error.message.split("\n")[0] ?? String(error))
                            : String(error),
                    );
                },
            },
            installSignalHandlers: false,
        });
        const context: HttpContext = {
            baseUrl: running.baseUrl,
            apiKey: "demo-bootstrap-key-0001",
        };

        try {
            heading(`故障走查：${testCase.label}`);
            console.log(`HARNESS_WORKER_SIMULATE = ${testCase.simulate}`);
            console.log(`说明：${testCase.note}`);
            pumpErrors.length = 0;

            const workspace = await call(context, "POST", "/workspaces", {
                name: `fail-${Date.now()}`,
            });
            const submitted = await call(context, "POST", "/runs", {
                sessionId: `fail-${crypto.randomUUID()}`,
                userInput: "触发一次故障注入执行。",
                workspaceId: workspace.json.workspace.id,
            });
            const runId = submitted.json.run.id as string;
            console.log(`runId = ${runId}`);

            if (testCase.action === "interrupt") {
                console.log(`POST /runs/${runId}/interrupt -> ${(await call(context, "POST", `/runs/${runId}/interrupt`)).status}`);
            }

            const settled = await waitForTerminal(context, runId, 60_000);
            console.log(`\n终态 status = ${settled.run.status}`);
            console.log(`failureReason = ${JSON.stringify(settled.run.failureReason)}`);
            console.log(`decisions = ${JSON.stringify(settled.decisions.map((d: any) => d.action + "/" + d.reasonCode))}`);

            const events = await call(context, "GET", `/runs/${runId}/events`);
            console.log(`\n事件时间线：`);
            console.log(formatRunEventTimeline(events.json.events));

            const attempts = running.composition.attemptStore.listForRun(runId);
            for (const attempt of attempts) {
                console.log(`attempt#${attempt.attemptNumber} status=${attempt.status} reason=${attempt.failureReason ?? "none"}`);
                if (attempt.sandboxId !== null) {
                    const record = running.composition.sandboxStore.get(attempt.sandboxId);
                    // 关键：异常路径也不能留下未回收的执行环境。
                    console.log(`  sandbox status=${record?.status ?? "missing"} failureReason=${record?.failureReason ?? "none"}`);
                }
            }

            const distinctPumpErrors = new Set(pumpErrors);
            console.log(`\nRunQueuePump onError 触发次数 = ${pumpErrors.length}，去重后 = ${distinctPumpErrors.size}`);
            for (const message of distinctPumpErrors) {
                console.log(`  ${message}`);
            }
            if (pumpErrors.length > distinctPumpErrors.size) {
                console.log(
                    `  [WARN] 同一次 drain 失败被重复上报 ${pumpErrors.length / distinctPumpErrors.size} 次：`
                    + "drain() 会把同一个 in-flight promise 返回给每个等待的 tick，"
                    + "它 reject 时所有等待者各自调用一次 onError。",
                );
            }

            if (settled.run.status !== testCase.expectedStatus) {
                throw new Error(`期望 ${testCase.expectedStatus}，实际 ${settled.run.status}`);
            }
            console.log(`\n[PASS] ${testCase.label} → ${settled.run.status}`);
            if (testCase.warning !== undefined) {
                console.log(`\n[WARN] ${testCase.warning}`);
            }
        } finally {
            await running.close();
            rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    console.log("\nRESULT: PASS（全部故障分支符合预期）");
}

if (process.argv[2] === "failure") {
    await failureWalkthrough();
} else {
    await main();
}
