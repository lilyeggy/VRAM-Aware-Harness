import { accessSync, constants } from "node:fs";

export interface JailerPrereqResult {
    readonly ok: boolean;
    readonly failures: readonly string[];
}

export async function checkJailerPrereqs(config: {
    jailerBinaryPath: string;
    firecrackerBinaryPath: string;
    kvmDevicePath: string;
}): Promise<JailerPrereqResult> {
    const failures: string[] = [];

    // 1. jailer 二进制存在且可执行
    try {
        accessSync(config.jailerBinaryPath, constants.X_OK);
    } catch {
        failures.push(`jailer binary not executable or missing at "${config.jailerBinaryPath}"`);
    }

    // 2. firecracker 二进制存在且可执行
    try {
        accessSync(config.firecrackerBinaryPath, constants.X_OK);
    } catch {
        failures.push(`firecracker binary not executable or missing at "${config.firecrackerBinaryPath}"`);
    }

    // 3. /dev/kvm 可读写
    try {
        accessSync(config.kvmDevicePath, constants.R_OK | constants.W_OK);
    } catch {
        failures.push(`KVM device not accessible (read/write) at "${config.kvmDevicePath}"`);
    }

    // 4. jailer 需要 root (euid === 0) 或 CAP_SYS_ADMIN
    const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
    if (euid !== 0) {
        failures.push("jailer requires root privileges (euid === 0) or setuid configuration");
    }

    return {
        ok: failures.length === 0,
        failures,
    };
}
