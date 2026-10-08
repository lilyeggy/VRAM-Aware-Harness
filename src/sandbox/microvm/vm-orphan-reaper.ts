import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 孤儿 Firecracker 进程回收。
 *
 * ## 为什么需要这个模块
 *
 * `FirecrackerSandboxDriver.processes` 是**进程内 Map**。Harness 重启后它是空的，
 * 于是 `stopVm()` 查不到 ChildProcess 句柄，杀不掉任何东西。如果此时再把运行
 * 目录删掉（socket / 磁盘一起消失），那个 Firecracker 进程就彻底不可寻址：
 *
 * - 没有 pidfile
 * - 没有 /proc 扫描
 * - 没有周期巡检
 *
 * 结果是**宿主内存被静默吃掉**，而容量准入看不见这些 VM → 超卖 → 别人的 VM
 * 被 OOM。真机验证：那台服务器上长期挂着 7 个孤儿 firecracker 进程。
 *
 * ## 本模块的职责
 *
 * 1. **pidfile 落盘**：每个 VM 启动时把 pid 写到运行目录下的 `vm.pid`，进程被杀
 *    后删除。pidfile 是跨重启唯一的寻址凭据。
 * 2. **启动回收**：`reapOrphans()` 扫描运行目录，对每个残留 pid 做"验活 → 杀 →
 *    删目录"。必须在任何 VM 启动**之前**调用，否则新旧 VM 会互相误杀。
 * 3. **验活而非盲杀**：pid 可能已被系统回收并复用给别的进程。杀之前必须用
 *    `/proc/<pid>/cmdline` 确认它确实是我们启动的 Firecracker/jailer，否则会
 *    误杀无辜进程。
 */

/** pidfile 文件名（放在每个 Run 的私有运行目录内） */
export const VM_PIDFILE_NAME = "vm.pid";

/** 一个 pidfile 的内容 */
interface PidFile {
    readonly pid: number;
    /** 写入时的可执行文件名（firecracker 或 jailer），用于验活时确认身份 */
    readonly binary: string;
    /** sandboxId，仅用于日志定位 */
    readonly sandboxId: string;
}

export interface ReapOrphansReport {
    /** 成功杀掉并清理的孤儿 VM 数量 */
    readonly reaped: number;
    /** 逐条明细，供日志与测试断言 */
    readonly details: readonly string[];
    /** 扫描到的 pidfile 总数（含未存活的） */
    readonly scanned: number;
}

/**
 * 判断某个 pid 是否是"我们启动的 Firecracker VMM 进程"。
 *
 * 不用 `kill(pid, 0)` 单独判断存活，因为 pid 会被系统复用；必须同时校验
 * `/proc/<pid>/cmdline` 里确实含有我们启动的二进制名。
 *
 * 注意：jailer 模式下 `/proc/<pid>` 是 jailer 进程本身（firecracker 是它的子
 * 进程），两者 cmdline 都含 exec-file 的 basename，所以按 basename 匹配即可。
 *
 * ## 平台说明
 *
 * 依赖 Linux 的 `/proc`。宿主目标平台是 Linux（真机验证在 Ubuntu + KVM），
 * 没问题。但在 macOS 上 `/proc` 不存在，本函数会对任何 pid 返回 false——
 * 这是**预期的保守行为**（宁可不杀，也不误杀），但意味着非 Linux 环境下
 * 无法做真实进程回收。测试通过注入 `procRoot` 用假 procfs 覆盖该逻辑。
 */
export function isFirecrackerProcess(pid: number, binaryName: string, procRoot = "/proc"): boolean {
    const cmdlinePath = resolve(procRoot, String(pid), "cmdline");
    if (!existsSync(cmdlinePath)) {
        return false; // 进程已不存在
    }
    let cmdline: string;
    try {
        // cmdline 是 NUL 分隔的；取第一段即可（可执行文件路径）
        cmdline = readFileSync(cmdlinePath, "utf8").split("\0")[0] ?? "";
    } catch {
        // 权限不足或进程已退出（ENOENT）
        return false;
    }
    if (cmdline.length === 0) {
        // 内核线程的 cmdline 为空，绝不能误杀
        return false;
    }
    const base = cmdline.split("/").pop() ?? cmdline;
    return base === binaryName;
}

/**
 * 杀掉单个 pid 并确认其消失。
 *
 * 注：这里刻意**不做** `/proc` 身份复核——调用方（`reapOrphans`）已先用
 * `isFirecrackerProcess` 验过身份；重复校验反而可能在进程退出竞态下误判。
 *
 * @returns true 表示进程确实被杀（或本就不存在），false 表示杀不掉
 */
export function killPid(pid: number): boolean {
    if (pid <= 1) {
        // 绝不自杀，也不碰 init
        return false;
    }
    try {
        // signal 0 只做存在性与权限校验，不实际发信号
        process.kill(pid, 0);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
            return true; // 本就不存在，视为已回收
        }
        if (code === "EPERM") {
            // 存在但无权限（可能已降权为其他 uid）。尝试强杀，让内核裁决。
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                return false;
            }
            return true;
        }
        return false;
    }

    try {
        process.kill(pid, "SIGKILL");
    } catch {
        return false;
    }
    // 注意：这里**不**同步等待进程退出。
    //
    // SIGKILL 是异步投递的，发出瞬间目标进程通常仍存在。若在此处同步忙等
    // （Atomics.wait 等）来"确认"，会得到错误结论：进程并未被杀，只是
    // 本进程的事件循环被阻塞、无法观察到退出。真正的确认必须交给
    // `waitForExitAsync`（await 让事件循环继续推进），否则就会出现
    // "报告已回收、实际仍在跑"的假成功 —— 那正是本模块要消灭的静默泄漏。
    return true;
}

/**
 * 异步等待 pid 退出（最多 ~2s）。
 *
 * SIGKILL 不可被捕获，进程会在极短时间内消失。这里用 await 推进事件循环，
 * 让运行时有机会观察并回收目标进程；超时则如实返回 false，让上层显式告警。
 */
export async function waitForExitAsync(pid: number, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                return true; // 已退出
            }
            // EPERM：还在，但本进程无权查询；继续等
        }
        await new Promise((r) => setTimeout(r, 10));
    }
    // 超时：再确认一次，如实返回
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}

/** 写入 pidfile */
export function writePidFile(runDir: string, pid: number, binary: string, sandboxId: string): void {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const payload: PidFile = { pid, binary, sandboxId };
    const target = resolve(runDir, VM_PIDFILE_NAME);
    writeFileSync(target, JSON.stringify(payload), { mode: 0o600 });
    chmodSync(target, 0o600);
}

/** 读取 pidfile；不存在或损坏返回 null（损坏视为孤儿，不静默放过） */
export function readPidFile(runDir: string): PidFile | null {
    const target = resolve(runDir, VM_PIDFILE_NAME);
    if (!existsSync(target)) return null;
    try {
        const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<PidFile>;
        if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 1) {
            return null;
        }
        return {
            pid: parsed.pid,
            binary: typeof parsed.binary === "string" ? parsed.binary : "firecracker",
            sandboxId: typeof parsed.sandboxId === "string" ? parsed.sandboxId : "unknown",
        };
    } catch {
        return null;
    }
}

/** 删除 pidfile（best-effort） */
export function removePidFile(runDir: string): void {
    try {
        rmSync(resolve(runDir, VM_PIDFILE_NAME), { force: true });
    } catch {
        // best-effort
    }
}

/**
 * 扫描运行目录，回收所有孤儿 VM 进程并清理其残留目录。
 *
 * 必须在 Harness 启动时、创建任何新 VM **之前**调用。
 *
 * ## 为什么是异步
 *
 * `SIGKILL` 是异步投递的：信号发出瞬间目标进程通常仍然存在。因此本函数在
 * 发出信号后 `await` 等待进程真正退出，再据此决定"计入 reaped"还是"报告失败"。
 * 若只发信号就宣称成功，就会产生**假成功**——报告已回收、进程实际仍在跑，
 * 那正是本模块要消灭的静默内存泄漏。
 *
 * @param runtimeRoot VM 运行根目录
 * @param options.binaryName 用于验活的二进制名（默认 firecracker）
 */
export async function reapOrphans(
    runtimeRoot: string,
    options: { readonly binaryName?: string; readonly procRoot?: string; readonly dryRun?: boolean } = {},
): Promise<ReapOrphansReport> {
    const binaryName = options.binaryName ?? "firecracker";
    const procRoot = options.procRoot ?? "/proc";
    const dryRun = options.dryRun ?? false;
    const details: string[] = [];

    if (!existsSync(runtimeRoot)) {
        return { reaped: 0, details, scanned: 0 };
    }

    let runDirs: string[];
    try {
        runDirs = readdirSync(runtimeRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => resolve(runtimeRoot, e.name));
    } catch {
        return { reaped: 0, details, scanned: 0 };
    }

    let reaped = 0;
    let scanned = 0;

    for (const runDir of runDirs) {
        const pidFile = readPidFile(runDir);
        if (pidFile === null) {
            // 没有 pidfile 的目录：可能是"删了目录但 pidfile 未落盘"的旧版本残留，
            // 或者根本不是本模块管理的目录。保守起见不删，交由上层按正常
            // cleanupStale 处理，避免误删用户数据。
            continue;
        }
        scanned += 1;

        // pidfile 里的 binary 优先；缺失时退回调用方给的默认值
        const expectedBinary = pidFile.binary || binaryName;

        if (!isFirecrackerProcess(pidFile.pid, expectedBinary, procRoot)) {
            // 进程已死（或 pid 已被复用为别的进程）—— 此时**绝不能**盲杀。
            // 只清理目录即可。
            details.push(
                `pid=${pidFile.pid} 进程已不存在，仅清理目录 ${runDir}`
                + (dryRun ? "（dry-run，未删）" : ""),
            );
            if (!dryRun) {
                rmSync(runDir, { recursive: true, force: true });
                reaped += 1;
            }
            continue;
        }

        if (dryRun) {
            details.push(`pid=${pidFile.pid} 仍存活且确为 ${expectedBinary}（dry-run，未杀）`);
            continue;
        }

        const signalled = killPid(pidFile.pid);
        // 关键：发出信号 ≠ 进程已死。必须 await 确认退出，否则是假成功。
        const exited = signalled && await waitForExitAsync(pidFile.pid);

        if (exited) {
            details.push(`pid=${pidFile.pid} 孤儿 Firecracker 已回收，清理 ${runDir}`);
            rmSync(runDir, { recursive: true, force: true });
            reaped += 1;
        } else {
            // 杀不掉必须显式暴露，不能静默——否则又回到"内存静默流失"。
            details.push(
                `pid=${pidFile.pid} 回收失败（仍存活且确为 ${expectedBinary}），`
                + "需人工介入，目录已保留以便取证",
            );
        }
    }

    return { reaped, details, scanned };
}

/**
 * 供上层在 terminate 时使用的安全清理顺序：
 * **先终止进程，再删除目录**。
 *
 * 反过来（先删目录）会造成：目录没了 → 无法验活 → pid 被系统复用后无法确认
 * 身份 → 进程永远杀不掉，成为不可寻址的孤儿。
 *
 * 异步原因同 `reapOrphans`：必须 await 确认进程退出，不能只发信号就宣称成功。
 */
export async function disposeRunDirAfterStop(
    runDir: string,
    pid: number | undefined,
    expectedBinary: string,
    procRoot = "/proc",
): Promise<{ readonly killed: boolean; readonly dirRemoved: boolean }> {
    let killed = false;
    if (pid !== undefined && isFirecrackerProcess(pid, expectedBinary, procRoot)) {
        killed = killPid(pid) && await waitForExitAsync(pid);
    }
    // 只有确认进程已死（或本就不存在）才删目录。
    // 杀不掉时保留目录，避免制造不可寻址的孤儿。
    const stillAlive = pid !== undefined
        && isFirecrackerProcess(pid, expectedBinary, procRoot);
    let dirRemoved = false;
    if (!stillAlive) {
        rmSync(runDir, { recursive: true, force: true });
        dirRemoved = true;
    }
    return { killed, dirRemoved };
}
