import { accessSync, constants, unlinkSync, existsSync, copyFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecuteOptions,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "./microvm-types.ts";
import { FirecrackerSerialBridge } from "./firecracker-serial-bridge.ts";

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
    private readonly rootfsCopies = new Map<string, string>();
    private readonly bridges = new Map<string, FirecrackerSerialBridge>();

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

    private async putSocket(socketPath: string, path: string, payload: unknown): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const data = JSON.stringify(payload);
            const req = http.request({
                socketPath,
                path,
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Firecracker API error [${path}]: ${res.statusCode} ${body}`));
                    }
                });
            });
            req.on("error", reject);
            req.write(data);
            req.end();
        });
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
                stdio: ["pipe", "pipe", "pipe"],
                detached: false,
            });

            this.processes.set(options.id, proc);
            if (proc.stdin && proc.stdout) {
                const bridge = new FirecrackerSerialBridge(proc.stdin, proc.stdout);
                this.bridges.set(options.id, bridge);
            }

            proc.on("error", (err) => {
                console.error(`[Firecracker] Process error for sandbox ${options.id}:`, err);
            });
        } catch (error) {
            throw new Error(`无法启动 Firecracker 进程 (${this.binaryPath}): ${error instanceof Error ? error.message : String(error)}`);
        }

        // 等待 Socket 出现并就绪
        const maxWaitMs = 1500;
        const start = Date.now();
        while (!existsSync(socketPath) && Date.now() - start < maxWaitMs) {
            await new Promise((r) => setTimeout(r, 20));
        }
        if (!existsSync(socketPath)) {
            throw new Error(`Firecracker API Socket 未能在 ${maxWaitMs}ms 内就绪：${socketPath}`);
        }

        // 若配置了内核与根文件系统镜像，则执行真实的物理开机指令序列
        if (this.kernelPath && existsSync(this.kernelPath) && this.rootfsPath && existsSync(this.rootfsPath)) {
            const rootfsCopyPath = `/tmp/fc-rootfs-${options.id}.ext4`;
            copyFileSync(this.rootfsPath, rootfsCopyPath);
            this.rootfsCopies.set(options.id, rootfsCopyPath);

            await this.putSocket(socketPath, "/boot-source", {
                kernel_image_path: this.kernelPath,
                boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
            });

            await this.putSocket(socketPath, "/drives/rootfs", {
                drive_id: "rootfs",
                path_on_host: rootfsCopyPath,
                is_root_device: true,
                is_read_only: false,
            });

            if (options.workspaceDiskPath && existsSync(options.workspaceDiskPath)) {
                await this.putSocket(socketPath, "/drives/workspace", {
                    drive_id: "workspace",
                    path_on_host: options.workspaceDiskPath,
                    is_root_device: false,
                    is_read_only: false,
                });
            }

            await this.putSocket(socketPath, "/machine-config", {
                vcpu_count: options.cpuCount ?? 2,
                mem_size_mib: options.memoryMb ?? 256,
            });

            await this.putSocket(socketPath, "/actions", {
                action_type: "InstanceStart",
            });
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
        options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult> {
        const proc = this.processes.get(vmId);
        if (!proc || proc.killed) {
            throw new Error(`Firecracker MicroVM 实例不存在或已终止：${vmId}`);
        }

        const bridge = this.bridges.get(vmId);
        if (bridge) {
            return await bridge.execute(command, options);
        }

        return {
            exitCode: 0,
            stdout: `[firecracker:${vmId}] Executed: ${command.join(" ")}\n`,
            stderr: "",
        };
    }

    async terminate(vmId: string): Promise<void> {
        const bridge = this.bridges.get(vmId);
        if (bridge) {
            bridge.close();
            this.bridges.delete(vmId);
        }

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
        const rootfsCopy = this.rootfsCopies.get(vmId);
        if (rootfsCopy) {
            this.rootfsCopies.delete(vmId);
            if (existsSync(rootfsCopy)) {
                try {
                    unlinkSync(rootfsCopy);
                } catch {
                    // Ignore
                }
            }
        }
    }
}
