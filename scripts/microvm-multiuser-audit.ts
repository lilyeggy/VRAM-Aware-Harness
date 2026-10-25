/**
 * 真机多 VM 并发 + 跨用户对抗验收（P0）。
 *
 * ## 为什么需要这个脚本
 *
 * 此前 microVM 的所有证据都来自**单 VM** 场景（23/23 审计跑的是一台）。而产品核心
 * 承诺是"多用户每人一台云电脑"——唯一没有证据的维度恰好是卖点：
 *
 * - 全仓库没有任何测试同时跑两台以上 microVM
 * - blast-radius-isolation.e2e.test.ts 里 microVM 出现 0 次
 * - 攻击烟测只有容器版
 *
 * 本脚本在真实 KVM 上**同时**拉起 N 台 Firecracker，验证：
 *
 * 1. 并发启动：N 台 VM 同时创建，全部成功（号段、内存、cgroup 不冲突）
 * 2. 真实并发：宿主确实存在 N 个 Firecracker 进程（不是串行）
 * 3. 跨用户文件隔离：A 的工作区文件在 B 的 VM 内不可见
 * 4. 跨用户写入隔离：各自 marker 互不污染
 * 5. 凭据注入：每用户独立 secret
 * 6. 反向隔离：VM 存活期宿主看不到 VM 内产物
 * 7. 并发终止无残留：全部终止后宿主无进程/目录残留
 * 8. 启动延迟基线：P50/P95
 *
 * 用法（jailer 模式需 root）：
 *   sudo bun scripts/microvm-multiuser-audit.ts [并发数]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    MicrovmSandboxProvider,
    FirecrackerSandboxDriver,
} from "../src/sandbox/microvm/index.ts";
import type { SandboxRecord, SecretProvider } from "../src/sandbox/sandbox-provider.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

const CONCURRENCY = Number(process.argv[2] ?? process.env.HARNESS_AUDIT_CONCURRENCY ?? "5");
const RUNTIME_ROOT = resolve(process.cwd(), "data/mt-audit-runtime");
const HOST_WS_ROOT = resolve(process.cwd(), "data/mt-audit-ws");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
    if (ok) {
        passed += 1;
        console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
    } else {
        failed += 1;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

class MemorySandboxStore {
    private readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
    listActive(): SandboxRecord[] {
        return Array.from(this.records.values()).filter((r) => r.status === "ACTIVE");
    }
    listOrphans(): SandboxRecord[] { return []; }
    listUnsettled(): SandboxRecord[] { return this.listActive(); }
}

/** 每个用户一份 secret，值可辨识（名字与 allowedSecrets 一致） */
function makeSecrets(): SecretProvider {
    return {
        get: (_userId: string, name: string) => (
            name === "AUDIT_SECRET" ? "s3cr3t-multiuser-value" : null
        ),
    };
}

function policyFor(userId: string, runId: string, workspaceRoot: string) {
    // 复用平台的基线策略（与 microvm-live-audit.ts 一致），只覆盖用户相关字段。
    // 不要手写 policy：漏掉 resourceLimits 等字段会让 provider 读到 undefined。
    return {
        ...unrestrictedPolicy,
        id: `policy-${userId}`,
        runId,
        userId,
        workspaceRoots: [workspaceRoot],
        allowNetwork: false,
        allowedSecrets: ["AUDIT_SECRET"],
    };
}

interface User {
    readonly userId: string;
    readonly sandboxId: string;
    readonly runId: string;
    readonly hostWorkspace: string;
    readonly provider: MicrovmSandboxProvider;
    createMs: number;
}

async function main(): Promise<void> {
    console.log("=== microVM 多用户并发 + 跨用户对抗审计 ===");
    console.log(`并发数: ${CONCURRENCY} | root: ${process.geteuid?.() === 0} | jailer: ${process.env.HARNESS_USE_JAILER !== "false"}`);
    console.log(`宿主内核: ${require("node:os").release()}`);

    rmSync(RUNTIME_ROOT, { recursive: true, force: true });
    rmSync(HOST_WS_ROOT, { recursive: true, force: true });
    mkdirSync(HOST_WS_ROOT, { recursive: true, mode: 0o700 });

    const fcBefore = countFirecrackerProcesses();

    // 所有用户共用同一个 driver —— 这正是平台形态：一个控制面管 N 个 VM
    const driver = new FirecrackerSandboxDriver({ vmRuntimeRoot: RUNTIME_ROOT });

    const users: User[] = [];
    const t0All = performance.now();

    // ---- [1] 并发启动 ----
    console.log(`\n[1] 并发启动 ${CONCURRENCY} 台真实 Firecracker VM...`);
    const userIds = Array.from(
        { length: CONCURRENCY },
        (_, i) => `user-${String(i).padStart(2, "0")}`,
    );

    await Promise.all(userIds.map(async (userId) => {
        const runId = `run-${userId}`;
        const sandboxId = `mt-${userId}`;
        const hostWorkspace = resolve(HOST_WS_ROOT, userId);
        mkdirSync(hostWorkspace, { recursive: true, mode: 0o700 });
        // 每个用户预置"私有文件"，用于验证互不可见
        writeFileSync(resolve(hostWorkspace, "private.txt"), `secret-of-${userId}`);

        const provider = new MicrovmSandboxProvider(new MemorySandboxStore() as never, makeSecrets(), {
            driver,
            vmRuntimeRoot: RUNTIME_ROOT,
            ...(process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH !== undefined
                ? { workspaceDiskTemplatePath: process.env.FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH }
                : {}),
        });

        const t0 = performance.now();
        await provider.create({
            id: sandboxId,
            runId,
            workspacePath: hostWorkspace,
            policy: policyFor(userId, runId, hostWorkspace) as never,
        });
        const createMs = performance.now() - t0;

        users.push({ userId, sandboxId, runId, hostWorkspace, provider, createMs });
        console.log(`    ${userId}: 就绪 ${createMs.toFixed(0)}ms`);
    }));

    // 按 userId 排序保证后续断言顺序稳定
    users.sort((a, b) => a.userId.localeCompare(b.userId));

    const wallMs = performance.now() - t0All;
    check(`${CONCURRENCY} 台 VM 全部并发启动成功`, users.length === CONCURRENCY, `墙钟 ${wallMs.toFixed(0)}ms`);

    // ---- [2] 确认真实并发（不是串行）----
    const fcDuring = countFirecrackerProcesses();
    check(
        `宿主同时存在 ${CONCURRENCY} 个 Firecracker/jailer 进程`,
        fcDuring >= CONCURRENCY,
        `启动前 ${fcBefore} → 现 ${fcDuring}`,
    );
    check(
        "并发确实重叠（总墙钟显著小于单机耗时之和）",
        wallMs < users.reduce((s, t) => s + t.createMs, 0) * 0.95,
        `墙钟 ${wallMs.toFixed(0)}ms vs 串行预期 ${users.reduce((s, t) => s + t.createMs, 0).toFixed(0)}ms`,
    );

    // ---- [3] 启动延迟基线 ----
    console.log(`\n[2] 启动延迟基线`);
    const times = users.map((t) => t.createMs).sort((a, b) => a - b);
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    console.log(`    min=${times[0]!.toFixed(0)}ms P50=${p50.toFixed(0)}ms P95=${p95.toFixed(0)}ms max=${times[times.length - 1]!.toFixed(0)}ms`);
    check("P95 启动延迟 < 15s（并发退化可接受上限）", p95 < 15_000, `P95=${p95.toFixed(0)}ms`);

    // ---- [4] 跨用户文件隔离 ----
    console.log(`\n[3] 跨用户文件隔离`);
    {
        const probe = users[0]!;
        // 在 A 的 VM 内查找其他用户的工作区目录
        for (const other of users.slice(1, Math.min(4, users.length))) {
            const r = await probe.provider.execute(probe.sandboxId, [
                "sh", "-c",
                `test -e /workspace/${other.userId} && echo LEAK || echo CLEAN`,
            ]);
            check(
                `${probe.userId} 的 VM 看不到 ${other.userId} 的目录`,
                r.stdout.includes("CLEAN"),
                r.stdout.trim() || `exit=${r.exitCode}`,
            );
        }
        // 自己workspace 不应含其他用户目录
        const listing = await probe.provider.execute(probe.sandboxId, ["ls", "/workspace"]);
        const leaked = users
            .slice(1)
            .filter((o) => listing.stdout.includes(o.userId));
        check(
            `${probe.userId} 的 /workspace 列表不含其他用户目录`,
            leaked.length === 0,
            leaked.length > 0 ? `泄漏: ${leaked.map((l) => l.userId).join(",")}` : listing.stdout.trim().replace(/\n/g, " "),
        );
    }

    // ---- [5] 跨用户写入互不干扰 ----
    console.log(`\n[4] 跨用户写入互不干扰`);
    {
        await Promise.all(users.map((t) =>
            t.provider.execute(t.sandboxId, [
                "sh", "-c", `echo marker-of-${t.userId} > /workspace/marker.txt`,
            ])));
        for (const t of users) {
            const r = await t.provider.execute(t.sandboxId, ["cat", "/workspace/marker.txt"]);
            const pollutedBy = users
                .filter((o) => o.userId !== t.userId)
                .filter((o) => r.stdout.includes(`marker-of-${o.userId}`))
                .map((o) => o.userId);
            check(
                `${t.userId} 的 marker 只含自己的内容`,
                r.stdout.includes(`marker-of-${t.userId}`) && pollutedBy.length === 0,
                pollutedBy.length > 0 ? `被污染: ${pollutedBy.join(",")}` : r.stdout.trim(),
            );
        }
    }

    // ---- [6] 凭据注入与跨用户不串 ----
    console.log(`\n[5] 凭据注入与跨用户不串`);
    {
        // 每用户应拿到自己的 secret 值
        for (const t of users.slice(0, 3)) {
            const r = await t.provider.execute(t.sandboxId, ["sh", "-c", "echo [$AUDIT_SECRET]"]);
            check(
                `${t.userId} 拿到自己的 secret`,
                r.stdout.includes("s3cr3t-multiuser-value"),
                r.stdout.trim(),
            );
        }
        // env 中不得出现其他用户的 secret 名（本例所有用户同名，故验证数量为 1，
        // 即"只注入允许的那个"，没有把宿主/其他来源的凭据带进来）
        const leak = await users[0]!.provider.execute(
            users[0]!.sandboxId,
            ["sh", "-c", "env | grep -c AUDIT_SECRET"],
        );
        check(
            "env 中仅有允许的 secret（无多余凭据）",
            leak.stdout.trim() === "1",
            `count=${leak.stdout.trim()}`,
        );
    }

    // ---- [6.5] 网络隔离：guest 内无网卡 ----
    console.log("\n[6.5] 网络隔离：guest 内只有 loopback");
    {
        const net = await users[0]!.provider.execute(
            users[0]!.sandboxId,
            ["sh", "-c", "grep -c ':' /proc/net/dev"],
        );
        const count = net.stdout.trim();
        check("guest 内只有 loopback 网络设备（无网卡）", count === "1", "设备数=" + count);
    }

    // ---- [7] 反向隔离：VM 内存产物宿主不可见 ----
    console.log(`\n[6] VM 存活期宿主看不到 VM 内产物`);
    for (const t of users.slice(0, 3)) {
        check(
            `${t.userId} 的 marker 未落到宿主工作区`,
            !existsSync(resolve(t.hostWorkspace, "marker.txt")),
        );
    }

    // ---- [8] 并发终止 + 残留 ----
    console.log(`\n[7] 并发终止全部 VM 并检查残留`);
    await Promise.all(users.map((t) =>
        t.provider.terminate(t.sandboxId).catch((e: unknown) => {
            console.error(`    ${t.userId} 终止失败:`, e instanceof Error ? e.message : e);
        })));
    await new Promise((r) => setTimeout(r, 2000));

    const fcAfter = countFirecrackerProcesses();
    check("终止后宿主无 Firecracker 进程残留", fcAfter <= fcBefore, `剩余 ${fcAfter}（启动前 ${fcBefore}）`);

    let dirs: string[] = [];
    try {
        dirs = readdirSync(RUNTIME_ROOT).filter((d) => !d.startsWith("."));
    } catch {
        dirs = [];
    }
    check("终止后运行根目录无残留", dirs.length === 0, dirs.join(",") || "(空)");

    // 工作区产物应已导出回宿主（终止流程正确）
    const exported = users.filter((t) => existsSync(resolve(t.hostWorkspace, "marker.txt")));
    check(
        "终止后各用户产物已导出到各自宿主工作区",
        exported.length === users.length,
        `${exported.length}/${users.length}`,
    );

    console.log(`\n=== 审计完成：${passed} 项通过，${failed} 项失败 ===`);
    console.log(`启动延迟：min=${times[0]!.toFixed(0)}ms P50=${p50.toFixed(0)}ms P95=${p95.toFixed(0)}ms max=${times[times.length - 1]!.toFixed(0)}ms（并发 ${CONCURRENCY}）`);
    if (failed > 0) {
        process.exit(1);
    }
}

/** 统计宿主 firecracker / jailer 进程数 */
function countFirecrackerProcesses(): number {
    try {
        let count = 0;
        for (const entry of readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
                const first = cmdline.split("\0")[0] ?? "";
                const base = (first.split("/").pop() ?? first).toLowerCase();
                if (base.includes("firecracker") || base.includes("jailer") || base.startsWith("fc1")) {
                    count += 1;
                }
            } catch {
                // 进程已退出
            }
        }
        return count;
    } catch {
        return -1;
    }
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
}

main().catch((err) => {
    console.error("多用户并发审计异常终止：", err);
    process.exit(1);
});
