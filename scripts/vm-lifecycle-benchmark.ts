import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { FirecrackerSandboxDriver } from "../src/sandbox/microvm/firecracker-sandbox-driver.ts";
import type { MicrovmInstance } from "../src/sandbox/microvm/microvm-types.ts";

type Mode = "cold" | "snapshot" | "concurrency" | "all";

interface Stats {
    count: number;
    min: number;
    median: number;
    p95: number;
    max: number;
    avg: number;
}

interface CreateSample {
    ms: number;
    warmHit: boolean;
}

function envString(name: string, fallback: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) return fallback;
    return value;
}

function envNumber(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value.length === 0) return fallback;
    const parsed = Number(value);
    if (Number.isFinite(parsed) === false) return fallback;
    return parsed;
}

function envBoolean(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return fallback;
}

function envNumberList(name: string, fallback: number[]): number[] {
    const value = process.env[name];
    if (value === undefined || value.length === 0) return fallback;
    const parts = value.split(",");
    const result: number[] = [];
    for (const part of parts) {
        const parsed = Number(part.trim());
        if (Number.isFinite(parsed) && parsed > 0) result.push(parsed);
    }
    if (result.length === 0) return fallback;
    return result;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
}

function stats(values: number[]): Stats {
    if (values.length === 0) {
        return { count: 0, min: 0, median: 0, p95: 0, max: 0, avg: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
        count: sorted.length,
        min: sorted[0] ?? 0,
        median: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1] ?? 0,
        avg: sum / sorted.length,
    };
}

function safeExec(command: string): string {
    try {
        const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return output.trim();
    } catch {
        return "";
    }
}

function countProcesses(pattern: string): number {
    const output = safeExec(`pgrep -f '${pattern}' || true`);
    if (output.length === 0) return 0;
    return output.split("\n").filter((line) => line.trim().length > 0).length;
}

function hostSample(): Record<string, unknown> {
    return {
        at: new Date().toISOString(),
        firecracker: countProcesses("[f]c117"),
        jailer: countProcesses("[j]ailer117"),
        mem: safeExec("free -m"),
        loadavg: safeExec("cat /proc/loadavg"),
        data: safeExec("df -h /data"),
        root: safeExec("df -h /"),
    };
}

function poolDir(): string {
    return envString("HARNESS_BENCH_POOL_DIR", envString("HARNESS_VM_SNAPSHOT_POOL_DIR", "/tmp/harness-vm-bench-pool"));
}

function runtimeRoot(): string {
    return envString("HARNESS_BENCH_RUNTIME_ROOT", envString("HARNESS_VM_RUNTIME_ROOT", "/tmp/harness-vm-bench-runtime"));
}

function workspaceRoot(): string {
    return envString("HARNESS_BENCH_WORKSPACE_ROOT", "/tmp/harness-vm-bench-workspaces");
}

async function withDriver<T>(snapshotsEnabled: boolean, fn: (driver: FirecrackerSandboxDriver) => Promise<T>): Promise<T> {
    const driver = new FirecrackerSandboxDriver({
        snapshotsEnabled,
        snapshotPoolDir: poolDir(),
        vmRuntimeRoot: runtimeRoot(),
        useJailer: envBoolean("HARNESS_USE_JAILER", true),
    });
    const available = await driver.isAvailable();
    if (available === false) {
        throw new Error("Firecracker 驱动不可用（检查 FIRECRACKER_* 与 /dev/kvm）");
    }
    try {
        return await fn(driver);
    } finally {
        await driver.reapOrphanVms?.({ dryRun: false });
    }
}

async function createVm(driver: FirecrackerSandboxDriver, id: string): Promise<CreateSample> {
    const workspacePath = join(workspaceRoot(), id);
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const startedAt = performance.now();
    const instance: MicrovmInstance = await driver.create({
        id,
        runId: id,
        workspacePath,
        cpuCount: envNumber("HARNESS_BENCH_VCPU", 2),
        memoryMb: envNumber("HARNESS_BENCH_MEMORY_MB", 512),
        allowNetwork: false,
    });
    const ms = performance.now() - startedAt;
    return { ms, warmHit: instance.warmHit === true };
}

async function terminateVm(driver: FirecrackerSandboxDriver, id: string): Promise<void> {
    try {
        await driver.terminate(id);
    } catch (error) {
        console.error(`[bench] terminate ${id} 失败`, error);
    }
}

async function runCold(driver: FirecrackerSandboxDriver, iterations: number): Promise<Record<string, unknown>> {
    rmSync(poolDir(), { recursive: true, force: true });
    const samples: CreateSample[] = [];
    for (let i = 0; i < iterations; i += 1) {
        const id = `bench-cold-${i}`;
        const sample = await createVm(driver, id);
        samples.push(sample);
        await terminateVm(driver, id);
    }
    return {
        iterations,
        createMs: stats(samples.map((sample) => sample.ms)),
        warmHits: samples.filter((sample) => sample.warmHit).length,
        samples: samples.map((sample) => ({ ms: Math.round(sample.ms), warmHit: sample.warmHit })),
    };
}

async function runSnapshot(driver: FirecrackerSandboxDriver, warmIterations: number, execProbe: boolean): Promise<Record<string, unknown>> {
    rmSync(poolDir(), { recursive: true, force: true });
    const firstId = "bench-snapshot-first";
    const firstSample = await createVm(driver, firstId);
    await terminateVm(driver, firstId);

    const samples: CreateSample[] = [];
    const execMs: number[] = [];
    for (let i = 0; i < warmIterations; i += 1) {
        const id = `bench-warm-${i}`;
        const sample = await createVm(driver, id);
        samples.push(sample);
        if (execProbe) {
            const startedAt = performance.now();
            try {
                const result = await driver.execute(id, ["uname", "-r"], { timeoutMs: 10000 });
                execMs.push(performance.now() - startedAt);
                if (i === 0) {
                    console.log(`[bench] warm exec uname -r exit=${result.exitCode} stdout=${result.stdout.trim()}`);
                }
            } catch (error) {
                console.error(`[bench] warm exec ${id} 失败`, error);
            }
        }
        await terminateVm(driver, id);
    }
    return {
        firstCreateMs: Math.round(firstSample.ms),
        firstWarmHit: firstSample.warmHit,
        warmIterations,
        warmCreateMs: stats(samples.map((sample) => sample.ms)),
        warmHits: samples.filter((sample) => sample.warmHit).length,
        warmExecMs: stats(execMs),
        samples: samples.map((sample) => ({ ms: Math.round(sample.ms), warmHit: sample.warmHit })),
    };
}

async function warmupSnapshot(driver: FirecrackerSandboxDriver): Promise<void> {
    const id = "bench-warmup";
    await createVm(driver, id);
    await terminateVm(driver, id);
}

async function runConcurrency(
    driver: FirecrackerSandboxDriver,
    concurrency: number[],
    includeCold: boolean,
    includeWarm: boolean,
): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];

    if (includeWarm) {
        rmSync(poolDir(), { recursive: true, force: true });
        await warmupSnapshot(driver);
        for (const n of concurrency) {
            const startedAt = performance.now();
            const before = hostSample();
            const ids = Array.from({ length: n }, (_, index) => `bench-conc-warm-${n}-${index}`);
            const samples = await Promise.all(ids.map((id) => createVm(driver, id)));
            const totalMs = performance.now() - startedAt;
            const after = hostSample();
            await Promise.all(ids.map((id) => terminateVm(driver, id)));
            results.push({
                n,
                mode: "warm",
                totalMs: Math.round(totalMs),
                perVm: stats(samples.map((sample) => sample.ms)),
                warmHits: samples.filter((sample) => sample.warmHit).length,
                hostBefore: before,
                hostAfter: after,
            });
        }
    }

    if (includeCold) {
        for (const n of concurrency) {
            rmSync(poolDir(), { recursive: true, force: true });
            const startedAt = performance.now();
            const before = hostSample();
            const ids = Array.from({ length: n }, (_, index) => `bench-conc-cold-${n}-${index}`);
            const samples = await Promise.all(ids.map((id) => createVm(driver, id)));
            const totalMs = performance.now() - startedAt;
            const after = hostSample();
            await Promise.all(ids.map((id) => terminateVm(driver, id)));
            results.push({
                n,
                mode: "cold",
                totalMs: Math.round(totalMs),
                perVm: stats(samples.map((sample) => sample.ms)),
                warmHits: samples.filter((sample) => sample.warmHit).length,
                hostBefore: before,
                hostAfter: after,
            });
        }
    }

    return { concurrency, includeCold, includeWarm, results };
}

async function main(): Promise<void> {
    const mode = envString("HARNESS_BENCH_MODE", "all") as Mode;
    const coldIterations = envNumber("HARNESS_BENCH_COLD_ITERATIONS", 5);
    const warmIterations = envNumber("HARNESS_BENCH_WARM_ITERATIONS", 20);
    const concurrency = envNumberList("HARNESS_BENCH_CONCURRENCY", [1, 2, 4, 8, 10]);
    const coldConcurrency = envBoolean("HARNESS_BENCH_COLD_CONCURRENCY", false);
    const execProbe = envBoolean("HARNESS_BENCH_EXEC_PROBE", false);
    const outputPath = resolve(envString("HARNESS_BENCH_OUTPUT", "vm-lifecycle-benchmark.json"));
    const report: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        host: hostSample(),
        config: {
            mode,
            coldIterations,
            warmIterations,
            concurrency,
            coldConcurrency,
            execProbe,
            useJailer: envBoolean("HARNESS_USE_JAILER", true),
            binaryPath: envString("FIRECRACKER_BINARY_PATH", "firecracker"),
            kernelPath: envString("FIRECRACKER_KERNEL_PATH", ""),
            rootfsPath: envString("FIRECRACKER_ROOTFS_PATH", ""),
            workspaceDiskTemplatePath: envString("FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH", ""),
            vmRuntimeRoot: runtimeRoot(),
            snapshotPoolDir: poolDir(),
        },
    };

    if (mode === "cold" || mode === "all") {
        await withDriver(false, async (driver) => {
            report.cold = await runCold(driver, coldIterations);
        });
    }
    if (mode === "snapshot" || mode === "all") {
        await withDriver(true, async (driver) => {
            report.snapshot = await runSnapshot(driver, warmIterations, execProbe);
        });
    }
    if (mode === "concurrency" || mode === "all") {
        await withDriver(true, async (driver) => {
            report.concurrency = await runConcurrency(driver, concurrency, coldConcurrency, true);
        });
    }

    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[bench] 报告已写入 ${outputPath}`);
    console.log(`VM_BENCHMARK_OK ${JSON.stringify({ cold: report.cold ?? null, snapshot: report.snapshot ?? null })}`);
}

main().catch((error) => {
    console.error("VM_BENCHMARK_FAIL", error);
    process.exit(1);
});
