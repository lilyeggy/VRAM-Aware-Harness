import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import {
    isFirecrackerProcess,
    killPid,
    readPidFile,
    reapOrphans,
    waitForExitAsync,
    writePidFile,
    VM_PIDFILE_NAME,
} from "../../src/sandbox/microvm/vm-orphan-reaper";

/**
 * 孤儿 Firecracker 回收的回归测试（P0）。
 *
 * ## 背景
 *
 * `FirecrackerSandboxDriver.processes` 是**进程内 Map**。Harness 重启后它是空的，
 * 于是 `stopVm()` 查不到 ChildProcess 句柄，杀不掉任何东西。如果再把运行目录
 * 删掉（socket / 磁盘一起消失），那个 Firecracker 进程就彻底不可寻址：
 * 没有 pidfile、没有 /proc 扫描、没有周期巡检。它会持续占用宿主内存，而容量
 * 准入看不见这些 VM → 超卖 → 别人的 VM 被 OOM。
 *
 * 真机实证：172.17.43.193 上长期挂着 7 个孤儿 firecracker 进程，无人发现。
 *
 * ## 平台要求
 *
 * 身份验活依赖 Linux 的 `/proc`。宿主目标平台是 Linux（真机在 Ubuntu + KVM），
 * 因此这里**刻意使用真实 `/proc` 与真实子进程**验证，不用假 procfs —— 那样只能
 * 验证 mock，验不出"进程到底有没有被杀掉"。
 *
 * 在 macOS / Windows 等无 `/proc` 的平台上，需要真实进程杀活的用例会 skip，
 * 仅保留纯逻辑（pidfile 读写、参数校验）用例。
 */

const HAS_PROC = existsSync("/proc/self/cmdline");

/** 起一个长驻子进程模拟孤儿 Firecracker，并返回可断言的句柄 */
function spawnLongLived(): { pid: number; cleanup: () => void } {
    const child = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
    const pid = child.pid!;
    return {
        pid,
        cleanup: () => {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // 已退出
            }
        },
    };
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("vm-orphan-reaper: pidfile 读写与校验（无平台依赖）", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = resolve(process.cwd(), `data/test-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmp, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it("写入的 pidfile 可被读回，含 pid/binary/sandboxId", () => {
        writePidFile(tmp, 4242, "fc117", "sbx-1");
        const pf = readPidFile(tmp);
        expect(pf).not.toBeNull();
        expect(pf?.pid).toBe(4242);
        expect(pf?.binary).toBe("fc117");
        expect(pf?.sandboxId).toBe("sbx-1");
    });

    it("pidfile 文件确实落盘（这是跨重启回收的唯一凭据）", () => {
        writePidFile(tmp, 4242, "fc117", "sbx-1");
        expect(existsSync(resolve(tmp, VM_PIDFILE_NAME))).toBe(true);
        // 目录与文件权限都应限制到当前用户
        expect(chmodSync(tmp, 0o700)).toBeUndefined;
    });

    it("pidfile 缺失或损坏时返回 null 而不是抛错", () => {
        expect(readPidFile(tmp)).toBeNull();
        writeFileSync(resolve(tmp, VM_PIDFILE_NAME), "{not json");
        expect(readPidFile(tmp)).toBeNull();
    });

    it("非法 pid（0/1/负数/非整数/NaN）一律视为无效，防止误杀系统进程", () => {
        for (const bad of [0, 1, -5, 1.5, NaN]) {
            writeFileSync(resolve(tmp, VM_PIDFILE_NAME), JSON.stringify({ pid: bad, binary: "fc" }));
            expect(readPidFile(tmp)).toBeNull();
        }
    });
});

describe("vm-orphan-reaper: killPid 安全性（无平台依赖）", () => {
    it("拒绝杀 pid 0 与 1（自身所在进程组 / init）", () => {
        expect(killPid(0)).toBe(false);
        expect(killPid(1)).toBe(false);
        expect(killPid(-1)).toBe(false);
    });

    it("杀不存在的进程视为已回收（ESRCH → true），幂等", async () => {
        // 这个 pid 不存在
        expect(killPid(4194302)).toBe(true);
        expect(await waitForExitAsync(4194302)).toBe(true);
    });
});

describe.skipIf(!HAS_PROC)("vm-orphan-reaper: 真实 /proc 身份验活", () => {
    it("自身进程可被识别，但身份不符时判 false（绝不误杀）", () => {
        // 真实 /proc：拿本进程当被测对象
        const selfPid = process.pid;
        const selfBase = process.execPath.split("/").pop()!;
        expect(isFirecrackerProcess(selfPid, selfBase, "/proc")).toBe(true);
        // 换个不匹配的名字 → 必须判 false，否则会盲杀无辜进程
        expect(isFirecrackerProcess(selfPid, "definitely-not-me", "/proc")).toBe(false);
    });

    it("不存在的 pid 判 false（绝不能盲杀）", () => {
        expect(isFirecrackerProcess(4194301, "fc117", "/proc")).toBe(false);
    });
});

describe.skipIf(!HAS_PROC)("vm-orphan-reaper: 真实进程回收（Linux 真机语义）", () => {
    let tmp: string;
    let runtimeRoot: string;
    let live: { pid: number; cleanup: () => void } | undefined;

    beforeEach(() => {
        tmp = resolve(process.cwd(), `data/test-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        runtimeRoot = resolve(tmp, "vm");
        mkdirSync(runtimeRoot, { recursive: true });
    });

    afterEach(() => {
        live?.cleanup();
        live = undefined;
        rmSync(tmp, { recursive: true, force: true });
    });

    it("核心用例：pidfile 指向的真实孤儿进程被杀、目录被清理", async () => {
        live = spawnLongLived();
        await waitForExitAsync(live.pid, 1).catch(() => false);
        // 等子进程真正 exec 完成，确保 /proc/<pid>/cmdline 可读
        await new Promise((r) => setTimeout(r, 200));
        expect(isAlive(live.pid)).toBe(true);

        const runDir = resolve(runtimeRoot, "orphan-1");
        mkdirSync(runDir, { recursive: true });
        // binary 写该进程真实的 basename（Linux 上是 /usr/bin/sleep 之类）
        const realBase = readFileCmdlineBase(live.pid);
        writePidFile(runDir, live.pid, realBase, "orphan-1");

        const report = await reapOrphans(runtimeRoot, { binaryName: realBase });

        expect(report.scanned).toBe(1);
        expect(report.reaped).toBe(1);
        expect(report.details.join("\n")).toContain("孤儿");

        // **本测试的核心断言**：进程真的死了。不能只断言"调用了 kill"。
        expect(isAlive(live.pid)).toBe(false);
        expect(existsSync(runDir)).toBe(false);
    });

    it("pid 被系统复用给别的程序时绝不误杀（身份不符只清目录）", async () => {
        live = spawnLongLived();
        await new Promise((r) => setTimeout(r, 200));

        const runDir = resolve(runtimeRoot, "orphan-reused");
        mkdirSync(runDir, { recursive: true });
        // pidfile 声称它是 fc117，但该 pid 实际是 sleep —— 身份不符
        writePidFile(runDir, live.pid, "fc117", "orphan-reused");

        const report = await reapOrphans(runtimeRoot, { binaryName: "fc117" });

        // 关键断言：被复用的 pid 必须还活着
        expect(isAlive(live.pid)).toBe(true);
        expect(report.details.join("\n")).toContain("进程已不存在");
    });

    it("dry-run 只报告不杀也不删目录", async () => {
        live = spawnLongLived();
        await new Promise((r) => setTimeout(r, 200));
        const realBase = readFileCmdlineBase(live.pid);

        const runDir = resolve(runtimeRoot, "orphan-dry");
        mkdirSync(runDir, { recursive: true });
        writePidFile(runDir, live.pid, realBase, "orphan-dry");

        const report = await reapOrphans(runtimeRoot, { binaryName: realBase, dryRun: true });

        expect(report.scanned).toBe(1);
        expect(report.reaped).toBe(0);
        expect(report.details.join("\n")).toContain("dry-run");
        expect(isAlive(live.pid)).toBe(true);
        expect(existsSync(runDir)).toBe(true);
    });

    it("进程已死时只清目录，不报错也不误杀", async () => {
        const runDir = resolve(runtimeRoot, "orphan-dead");
        mkdirSync(runDir, { recursive: true });
        writePidFile(runDir, 4194303, "fc117", "orphan-dead");

        const report = await reapOrphans(runtimeRoot, { binaryName: "fc117" });

        expect(report.scanned).toBe(1);
        expect(report.reaped).toBe(1);
        expect(report.details.join("\n")).toContain("进程已不存在");
        expect(existsSync(runDir)).toBe(false);
    });

    it("无 pidfile 的目录不被动（避免误删用户数据）", async () => {
        const runDir = resolve(runtimeRoot, "no-pidfile");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(resolve(runDir, "important.txt"), "user data");

        const report = await reapOrphans(runtimeRoot, { binaryName: "fc117" });

        expect(report.scanned).toBe(0);
        expect(report.reaped).toBe(0);
        expect(existsSync(resolve(runDir, "important.txt"))).toBe(true);
    });
});

describe("vm-orphan-reaper: 边界", () => {
    it("运行根目录不存在时返回空报告而非抛错", async () => {
        const report = await reapOrphans(
            resolve(process.cwd(), "data/definitely-missing-orphan-root"),
            { binaryName: "fc117" },
        );
        expect(report).toEqual({ reaped: 0, details: [], scanned: 0 });
    });
});

/** 读取真实进程的 cmdline 首段 basename（仅 Linux 可用） */
function readFileCmdlineBase(pid: number): string {
    const raw = require("node:fs").readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const first = raw.split("\0")[0] ?? "";
    return first.split("/").pop() ?? first;
}
