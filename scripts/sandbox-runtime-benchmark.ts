import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContainerSandboxProvider } from "../src/sandbox/container-sandbox-provider.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../src/policies/effective-policy.ts";
import type { SandboxRecord } from "../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

type BenchmarkRuntime = "runc" | "runsc";
type Measurement = {
    readonly runtime: BenchmarkRuntime;
    readonly status: "PASS" | "UNAVAILABLE" | "FAIL";
    readonly iterations: number;
    readonly coldStartMs: readonly number[];
    readonly commandMs: readonly number[];
    readonly ioMs: readonly number[];
    readonly cleanupMs: readonly number[];
    readonly observedRuntimes: readonly string[];
    readonly errors: readonly string[];
};

class MemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

const runtimeList = parseRuntimes(process.env.HARNESS_BENCHMARK_RUNTIMES);
const iterations = positiveInteger(process.env.HARNESS_BENCHMARK_ITERATIONS, 5);
const image = process.env.HARNESS_CONTAINER_IMAGE ?? "alpine:3.20";
const root = mkdtempSync(join(tmpdir(), "harness-sandbox-benchmark-"));
const measurements: Measurement[] = [];

try {
    for (const runtime of runtimeList) {
        measurements.push(await benchmarkRuntime(runtime, root, image, iterations));
    }
    const available = measurements.some((measurement) => measurement.status === "PASS");
    const complete = measurements.every((measurement) => measurement.status === "PASS");
    console.log(JSON.stringify({
        result: complete ? "PASS" : available ? "INCOMPLETE" : "NO_RUNTIME_AVAILABLE",
        image,
        iterations,
        generatedAt: new Date().toISOString(),
        measurements: measurements.map((measurement) => ({
            ...measurement,
            summary: summarize(measurement),
        })),
        comparison: compare(measurements),
    }, null, 2));
    if (!complete) process.exitCode = 1;
} finally {
    rmSync(root, { recursive: true, force: true });
}

async function benchmarkRuntime(
    runtime: BenchmarkRuntime,
    rootPath: string,
    containerImage: string,
    count: number,
): Promise<Measurement> {
    const coldStartMs: number[] = [];
    const commandMs: number[] = [];
    const ioMs: number[] = [];
    const cleanupMs: number[] = [];
    const observedRuntimes: string[] = [];
    const errors: string[] = [];
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        new EnvironmentSecretProvider({}),
        {
            image: containerImage,
            profile: runtime === "runsc" ? "default" : "development",
            sandboxRuntime: runtime,
            userId: configuredUid(),
        },
    );

    for (let index = 0; index < count; index += 1) {
        const workspace = join(rootPath, `${runtime}-${index}`);
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        writeFileSync(join(workspace, "input.txt"), "benchmark-input\n");
        const sandboxId = crypto.randomUUID();
        const policy = benchmarkPolicy(sandboxId, workspace);
        let handle: { id: string } | null = null;
        try {
            const createStarted = performance.now();
            handle = await provider.create({
                id: sandboxId,
                runId: `benchmark-${runtime}-${index}`,
                instanceId: `benchmark-instance-${runtime}-${index}`,
                workspacePath: workspace,
                policy,
            });
            coldStartMs.push(performance.now() - createStarted);
            const record = store.get(sandboxId);
            if (record?.runtimeEvidence.verified !== true) {
                throw new Error("没有取得 verified runtime evidence");
            }
            observedRuntimes.push(record.runtimeEvidence.observedRuntime ?? "unknown");

            const commandStarted = performance.now();
            const command = await provider.execute(handle.id, ["sh", "-lc", "true"]);
            commandMs.push(performance.now() - commandStarted);
            if (command.exitCode !== 0) throw new Error(`command failed: ${command.stderr}`);

            const ioStarted = performance.now();
            const io = await provider.execute(handle.id, [
                "sh", "-lc", "cat /workspace/input.txt >/tmp/input-copy && dd if=/dev/zero of=/tmp/io-test bs=1M count=8 2>/dev/null",
            ]);
            ioMs.push(performance.now() - ioStarted);
            if (io.exitCode !== 0) throw new Error(`io workload failed: ${io.stderr}`);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        } finally {
            const cleanupStarted = performance.now();
            await provider.terminate(sandboxId).catch((error) => {
                errors.push(error instanceof Error ? error.message : String(error));
            });
            cleanupMs.push(performance.now() - cleanupStarted);
            rmSync(workspace, { recursive: true, force: true });
        }
    }

    const status = errors.length === 0 && coldStartMs.length === count
        ? "PASS"
        : coldStartMs.length === 0
            ? "UNAVAILABLE"
            : "FAIL";
    return {
        runtime,
        status,
        iterations: count,
        coldStartMs,
        commandMs,
        ioMs,
        cleanupMs,
        observedRuntimes,
        errors,
    };
}

function benchmarkPolicy(
    runId: string,
    workspacePath: string,
): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        id: crypto.randomUUID(),
        runId,
        tenantId: "benchmark-tenant",
        templateVersionId: "benchmark-template",
        layers: [],
        createdAt: new Date().toISOString(),
        workspaceRoots: [workspacePath],
        allowNetwork: false,
        resourceLimits: { cpuCores: 1, memoryMiB: 256, diskMiB: null },
    };
}

function summarize(measurement: Measurement): Record<string, number | null> {
    return {
        coldStartP50Ms: percentile(measurement.coldStartMs, 0.5),
        coldStartP95Ms: percentile(measurement.coldStartMs, 0.95),
        commandP50Ms: percentile(measurement.commandMs, 0.5),
        ioP50Ms: percentile(measurement.ioMs, 0.5),
        cleanupP50Ms: percentile(measurement.cleanupMs, 0.5),
    };
}

function compare(measurements: readonly Measurement[]): Record<string, unknown> {
    const passed = measurements.filter((measurement) => measurement.status === "PASS");
    if (passed.length < 2) {
        return { status: "INSUFFICIENT_DATA", reason: "至少需要两个真实 runtime 的 PASS 结果" };
    }
    const byRuntime = new Map(passed.map((measurement) => [measurement.runtime, summarize(measurement)]));
    const runc = byRuntime.get("runc");
    const runsc = byRuntime.get("runsc");
    if (runc === undefined || runsc === undefined) {
        return { status: "INSUFFICIENT_DATA", reason: "需要同时取得 runc 和 runsc 结果" };
    }
    return {
        status: "DESCRIPTIVE_ONLY",
        note: "此比较只描述本机测量，不自动作出安全/性能结论",
        runscVsRuncColdStartP50Ratio: ratio(runsc.coldStartP50Ms ?? null, runc.coldStartP50Ms ?? null),
        runscVsRuncCommandP50Ratio: ratio(runsc.commandP50Ms ?? null, runc.commandP50Ms ?? null),
        runscVsRuncIoP50Ratio: ratio(runsc.ioP50Ms ?? null, runc.ioP50Ms ?? null),
    };
}

function percentile(values: readonly number[], quantile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
    return Number(sorted[index]!.toFixed(3));
}

function ratio(numerator: number | null, denominator: number | null): number | null {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return Number((numerator / denominator).toFixed(3));
}

function parseRuntimes(value: string | undefined): BenchmarkRuntime[] {
    if (value === undefined) return ["runc", "runsc"];
    const result = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (result.length === 0 || result.some((item) => item !== "runc" && item !== "runsc")) {
        throw new Error("HARNESS_BENCHMARK_RUNTIMES 只能包含 runc/runsc");
    }
    return [...new Set(result)] as BenchmarkRuntime[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("HARNESS_BENCHMARK_ITERATIONS 必须是正整数");
    }
    return parsed;
}

function configuredUid(): number {
    const raw = process.env.HARNESS_CONTAINER_USER_ID;
    const fallback = process.getuid?.();
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value === undefined || value <= 0) {
        throw new Error("请设置非 root HARNESS_CONTAINER_USER_ID");
    }
    return value;
}
