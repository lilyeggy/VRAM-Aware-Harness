/**
 * Worker Landlock 文件系统约束（Linux）。
 *
 * 目标：Worker 进程（Pi/LLM loop）只读宿主，只允许写自己的 HOME、TMPDIR 与
 * 必要的设备/运行时路径；即使 Worker 被模型输出或插件利用，也无法改写仓库、
 * 控制面数据或其他用户目录。
 *
 * 约束通过 Linux Landlock LSM 的三个 syscall 完成：
 *   landlock_create_ruleset(444) / landlock_add_rule(445) / landlock_restrict_self(446)
 * Bun 没有内置 Landlock 绑定，因此用 bun:ffi 调 libc 的 syscall(2)。
 *
 * 开关：HARNESS_WORKER_LANDLOCK
 *   - 未设置 / "0" / "false"：不启用（默认，兼容无 Landlock 的旧内核）。
 *   - "1" / "true"：尽力启用；不支持时记录原因并继续。
 *   - "required"：必须启用；不支持或应用失败时进程以 exit code 78 退出（fail-closed）。
 *
 * 可写路径：HARNESS_WORKER_LANDLOCK_WRITABLE_PATHS（逗号分隔，默认 /tmp、$HOME、
 * /run/harness 与几个 /dev 设备文件）。
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import fs from "node:fs";

export type WorkerLandlockMode = "off" | "on" | "required";

export interface WorkerLandlockResult {
    readonly applied: boolean;
    readonly abi?: number;
    readonly reason?: string;
}

export interface WorkerLandlockOptions {
    readonly mode?: WorkerLandlockMode;
    readonly writablePaths?: readonly string[];
    readonly writableFiles?: readonly string[];
}

const SYS_LANDLOCK_CREATE_RULESET = 444n;
const SYS_LANDLOCK_ADD_RULE = 445n;
const SYS_LANDLOCK_RESTRICT_SELF = 446n;
const LANDLOCK_CREATE_RULESET_VERSION = 1n;
const LANDLOCK_RULE_PATH_BENEATH = 1n;
const PR_SET_NO_NEW_PRIVS = 38;

const FS_EXECUTE = 1n << 0n;
const FS_WRITE_FILE = 1n << 1n;
const FS_READ_FILE = 1n << 2n;
const FS_READ_DIR = 1n << 3n;
const FS_REMOVE_DIR = 1n << 4n;
const FS_REMOVE_FILE = 1n << 5n;
const FS_MAKE_CHAR = 1n << 6n;
const FS_MAKE_DIR = 1n << 7n;
const FS_MAKE_REG = 1n << 8n;
const FS_MAKE_SOCK = 1n << 9n;
const FS_MAKE_FIFO = 1n << 10n;
const FS_MAKE_BLOCK = 1n << 11n;
const FS_MAKE_SYM = 1n << 12n;
const FS_REFER = 1n << 13n;
const FS_TRUNCATE = 1n << 14n;
const FS_IOCTL_DEV = 1n << 15n;

const ABI1_ACCESS =
    FS_EXECUTE |
    FS_WRITE_FILE |
    FS_READ_FILE |
    FS_READ_DIR |
    FS_REMOVE_DIR |
    FS_REMOVE_FILE |
    FS_MAKE_CHAR |
    FS_MAKE_DIR |
    FS_MAKE_REG |
    FS_MAKE_SOCK |
    FS_MAKE_FIFO |
    FS_MAKE_BLOCK |
    FS_MAKE_SYM;

const READ_ONLY_ACCESS = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
const DEVICE_WRITE_ACCESS = FS_WRITE_FILE | FS_READ_FILE;

type Syscall = (...args: readonly (bigint | Pointer)[]) => bigint;
type Prctl = (option: number, arg2: bigint, arg3: bigint, arg4: bigint, arg5: bigint) => number;

let cachedLibc: { syscall: Syscall; prctl: Prctl } | null | undefined;

function loadLibc(): { syscall: Syscall; prctl: Prctl } | null {
    if (cachedLibc !== undefined) {
        return cachedLibc;
    }
    if (process.platform !== "linux") {
        cachedLibc = null;
        return null;
    }
    const candidates = ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
    for (const candidate of candidates) {
        try {
            const libc = dlopen(candidate, {
                syscall: {
                    args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
                    returns: FFIType.i64,
                },
                prctl: {
                    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
                    returns: FFIType.i32,
                },
            });
            cachedLibc = {
                syscall: libc.symbols.syscall as unknown as Syscall,
                prctl: libc.symbols.prctl as unknown as Prctl,
            };
            return cachedLibc;
        } catch {
            // 尝试下一个 libc 名称。
        }
    }
    cachedLibc = null;
    return null;
}

/** 根据 Landlock ABI 版本计算内核支持的 handled_access_fs 位掩码。 */
export function computeHandledAccessMask(abi: number): bigint {
    let mask = ABI1_ACCESS; // ABI 1：bits 0..12
    if (abi >= 2) {
        mask |= FS_REFER;
    }
    if (abi >= 3) {
        mask |= FS_TRUNCATE;
    }
    if (abi >= 5) {
        mask |= FS_IOCTL_DEV;
    }
    return mask;
}

/** 解析 HARNESS_WORKER_LANDLOCK。 */
export function resolveWorkerLandlockMode(env: NodeJS.ProcessEnv = process.env): WorkerLandlockMode {
    const raw = env.HARNESS_WORKER_LANDLOCK?.trim().toLowerCase();
    if (raw === "required") {
        return "required";
    }
    if (raw === "1" || raw === "true") {
        return "on";
    }
    return "off";
}

/** 默认可写目录：TMPDIR、HOME、Broker socket 所在目录。 */
export function defaultWritablePaths(env: NodeJS.ProcessEnv = process.env): string[] {
    const paths = new Set<string>(["/tmp"]);
    const home = env.HOME?.trim();
    if (home !== undefined && home.length > 0) {
        paths.add(home);
    }
    const configured = env.HARNESS_WORKER_LANDLOCK_WRITABLE_PATHS?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (configured !== undefined) {
        for (const entry of configured) {
            paths.add(entry);
        }
    }
    // Broker 的 Unix socket 在 /run/harness 下；Worker 需要能连它。
    paths.add("/run/harness");
    return [...paths];
}

/** 默认可写文件：Bun/Node 运行时常写的设备文件。 */
export function defaultWritableFiles(): string[] {
    return ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"];
}

function errnoFrom(result: bigint): number {
    return result < 0n ? Number(-result) : 0;
}

/**
 * 应用 Landlock 约束。返回结果而不是抛出，便于调用方根据 required 决定是否退出。
 */
export function applyWorkerLandlock(options: WorkerLandlockOptions = {}): WorkerLandlockResult {
    const mode = options.mode ?? resolveWorkerLandlockMode();
    if (mode === "off") {
        return { applied: false, reason: "disabled" };
    }
    const libc = loadLibc();
    if (libc === null) {
        return { applied: false, reason: "libc 不可用或非 Linux" };
    }
    const abiRaw = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, 0n, 0n, LANDLOCK_CREATE_RULESET_VERSION, 0n, 0n, 0n);
    if (abiRaw < 1n) {
        return { applied: false, reason: `landlock_create_ruleset(version) 失败：errno ${errnoFrom(abiRaw)}` };
    }
    const abi = Number(abiRaw);
    const handled = computeHandledAccessMask(abi);
    const rulesetAttr = Buffer.alloc(16);
    rulesetAttr.writeBigUInt64LE(handled, 0);
    rulesetAttr.writeBigUInt64LE(0n, 8);
    const rulesetFdRaw = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET,
        ptr(rulesetAttr) as unknown as bigint,
        16n,
        0n,
        0n,
        0n,
        0n,
    );
    if (rulesetFdRaw < 0n) {
        return { applied: false, reason: `landlock_create_ruleset 失败：errno ${errnoFrom(rulesetFdRaw)}` };
    }
    const rulesetFd = Number(rulesetFdRaw);
    const addRule = (path: string, allowed: bigint): void => {
        const fd = fs.openSync(path, "r");
        try {
            const rule = Buffer.alloc(16);
            rule.writeBigUInt64LE(allowed, 0);
            rule.writeInt32LE(fd, 8);
            const result = libc.syscall(
                SYS_LANDLOCK_ADD_RULE,
                BigInt(rulesetFd),
                LANDLOCK_RULE_PATH_BENEATH,
                ptr(rule) as unknown as bigint,
                0n,
                0n,
                0n,
            );
            if (result < 0n) {
                throw new Error(`landlock_add_rule(${path}) 失败：errno ${errnoFrom(result)}`);
            }
        } finally {
            fs.closeSync(fd);
        }
    };
    try {
        addRule("/", READ_ONLY_ACCESS);
        const writablePaths = options.writablePaths ?? defaultWritablePaths();
        for (const path of writablePaths) {
            if (!fs.existsSync(path)) {
                continue;
            }
            addRule(path, handled);
        }
        const writableFiles = options.writableFiles ?? defaultWritableFiles();
        for (const file of writableFiles) {
            if (!fs.existsSync(file)) {
                continue;
            }
            addRule(file, DEVICE_WRITE_ACCESS);
        }
        const prctlResult = libc.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n);
        if (prctlResult !== 0) {
            return { applied: false, reason: `prctl(PR_SET_NO_NEW_PRIVS) 失败：${prctlResult}` };
        }
        const restrictResult = libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, BigInt(rulesetFd), 0n, 0n, 0n, 0n, 0n);
        if (restrictResult < 0n) {
            return { applied: false, reason: `landlock_restrict_self 失败：errno ${errnoFrom(restrictResult)}` };
        }
        return { applied: true, abi };
    } catch (error) {
        return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
        try {
            fs.closeSync(rulesetFd);
        } catch {
            // 已关闭或 fd 无效时忽略。
        }
    }
}
