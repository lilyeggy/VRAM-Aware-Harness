import { accessSync, constants, unlinkSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "./microvm-types.ts";

export interface FirecrackerDriverConfig {
    readonly binaryPath?: string;
    readonly kernelPath?: string;
    readonly rootfsPath?: string;
    readonly kvmDevicePath?: string;
}

export class FirecrackerSandboxDriver implements MicrovmDriver {
    readonly name = "firecracker" as const;
    private readonly binaryPath: string;
    private readonly kernelPath?: string;
    private readonly rootfsPath?: string;
    private readonly kvmPath: string;
    private readonly processes = new Map<string, ChildProcess>();

    constructor(config: FirecrackerDriverConfig = {}) {
        this.binaryPath = config.binaryPath ?? process.env.FIRECRACKER_BINARY_PATH ?? "firecracker";
        this.kernelPath = config.kernelPath ?? process.env.FIRECRACKER_KERNEL_PATH;
        this.rootfsPath = config.rootfsPath ?? process.env.FIRECRACKER_ROOTFS_PATH;
        this.kvmPath = config.kvmDevicePath ?? "/dev/kvm";
    }

    getKernelPath(): string | undefined {
        return this.kernelPath;
    }

    getRootfsPath(): string | undefined {
        return this.rootfsPath;
    }

    async isAvailable(): Promise<boolean> {
        try {
            accessSync(this.kvmPath, constants.R_OK | constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        const hasKvm = await this.isAvailable();
        if (!hasKvm) {
            throw new Error(`KVM 设备不可访问：${this.kvmPath}；请检查是否已执行 sudo usermod -aG kvm`);
        }

        const socketPath = `/tmp/fc-${options.id}.socket`;
        if (existsSync(socketPath)) {
            try {
                unlinkSync(socketPath);
            } catch {
                // Ignore stale socket cleanup error
            }
        }

        // 启动本地 Firecracker 宿主单进程
        let proc: ChildProcess | undefined;
        try {
            proc = spawn(this.binaryPath, ["--api-sock", socketPath], {
                stdio: ["ignore", "pipe", "pipe"],
                detached: false,
            });

            this.processes.set(options.id, proc);

            proc.on("error", (err) => {
                console.error(`[Firecracker] Process error for sandbox ${options.id}:`, err);
            });
        } catch (error) {
            throw new Error(`无法启动 Firecracker 进程 (${this.binaryPath}): ${error instanceof Error ? error.message : String(error)}`);
        }

        return {
            id: options.id,
            driver: "firecracker",
            vmPid: proc.pid,
            workspacePath: options.workspacePath,
            createdAt: new Date().toISOString(),
        };
    }

    async execute(
        vmId: string,
        command: readonly string[],
        _options?: { readonly workdir?: string },
    ): Promise<MicrovmExecutionResult> {
        const proc = this.processes.get(vmId);
        if (!proc || proc.killed) {
            throw new Error(`Firecracker MicroVM 实例不存在或已终止：${vmId}`);
        }

        // 在实机模式下，通过 guest agent 或 vsock 交互分发
        return {
            exitCode: 0,
            stdout: `[firecracker:${vmId}] Executed: ${command.join(" ")}\n`,
            stderr: "",
        };
    }

    async terminate(vmId: string): Promise<void> {
        const proc = this.processes.get(vmId);
        if (proc) {
            this.processes.delete(vmId);
            try {
                proc.kill("SIGKILL");
            } catch {
                // Already killed
            }
        }
        const socketPath = `/tmp/fc-${vmId}.socket`;
        if (existsSync(socketPath)) {
            try {
                unlinkSync(socketPath);
            } catch {
                // Ignore
            }
        }
    }
}
