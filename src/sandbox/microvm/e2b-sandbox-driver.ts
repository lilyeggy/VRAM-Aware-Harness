import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "./microvm-types.ts";

export interface E2bDriverConfig {
    readonly apiKey?: string;
    readonly domain?: string;
    readonly template?: string;
}

/**
 * P0 修复：E2B 驱动原先是一个"假装创建 VM、假装执行命令"的桩——
 * create() 只在内存 Map 里记 ID，execute() 无条件返回 exitCode 0 和一段
 * echo 字符串，而上游 MicrovmSandboxProvider 曾据此写入
 * `runtimeEvidence.verified: true`（"KVM/hypervisor boundary"）。
 *
 * 在接入真实 E2B SDK 之前，本驱动必须 fail-closed：
 * - isAvailable() 恒为 false（Provider 会在创建期拒绝）；
 * - create()/execute() 直接抛错，杜绝任何静默假执行路径。
 */
export class E2bSandboxDriver implements MicrovmDriver {
    readonly name = "e2b" as const;
    readonly providesHardwareIsolation = false;

    constructor(_config: E2bDriverConfig = {}) {}

    async isAvailable(): Promise<boolean> {
        // 真实实现接入前，E2B 驱动永远不可用。
        return false;
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        throw new Error(
            `E2B 驱动尚未实现真实的沙箱创建（sandboxId=${options.id}）；`
            + "在接入 E2B SDK 之前拒绝伪造 VM 实例。请改用 firecracker 驱动。",
        );
    }

    async execute(
        vmId: string,
        _command: readonly string[],
        _options?: { readonly workdir?: string },
    ): Promise<MicrovmExecutionResult> {
        throw new Error(
            `E2B 驱动尚未实现真实的命令执行（vmId=${vmId}）；拒绝伪造执行结果。`,
        );
    }

    async terminate(_vmId: string): Promise<void> {}
}
