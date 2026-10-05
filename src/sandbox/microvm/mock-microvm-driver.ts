import type {
    MicrovmCreateOptions,
    MicrovmDriver,
    MicrovmExecutionResult,
    MicrovmInstance,
} from "./microvm-types.ts";

export interface MockExecutionHandler {
    (command: readonly string[], options?: { workdir?: string }): MicrovmExecutionResult | Promise<MicrovmExecutionResult>;
}

export class MockMicrovmDriver implements MicrovmDriver {
    readonly name = "mock" as const;
    readonly instances = new Map<string, MicrovmInstance & {
        environment: Record<string, string>;
        currentWorkdir: string;
    }>();
    readonly executionHistory: Array<{
        vmId: string;
        command: readonly string[];
        workdir?: string;
    }> = [];

    private customHandler?: MockExecutionHandler;
    private available = true;

    setAvailable(available: boolean): void {
        this.available = available;
    }

    setExecutionHandler(handler: MockExecutionHandler): void {
        this.customHandler = handler;
    }

    async isAvailable(): Promise<boolean> {
        return this.available;
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        if (!this.available) {
            throw new Error("Mock MicroVM Driver is not available");
        }
        const instance = {
            id: options.id,
            driver: "mock" as const,
            vmPid: 99999 + Math.floor(Math.random() * 1000),
            ipAddress: "192.168.127.2",
            workspacePath: options.workspacePath,
            createdAt: new Date().toISOString(),
            environment: { ...(options.environment ?? {}) },
            currentWorkdir: "/workspace",
        };
        this.instances.set(options.id, instance);
        return {
            id: instance.id,
            driver: instance.driver,
            vmPid: instance.vmPid,
            ipAddress: instance.ipAddress,
            workspacePath: instance.workspacePath,
            createdAt: instance.createdAt,
        };
    }

    async execute(
        vmId: string,
        command: readonly string[],
        options?: { readonly workdir?: string },
    ): Promise<MicrovmExecutionResult> {
        const instance = this.instances.get(vmId);
        if (!instance) {
            throw new Error(`MicroVM 实例不存在或已销毁：${vmId}`);
        }
        this.executionHistory.push({ vmId, command, workdir: options?.workdir });

        if (this.customHandler) {
            return this.customHandler(command, options);
        }

        // 默认模拟通用命令行为
        const cmdStr = command.join(" ");
        if (options?.workdir) {
            instance.currentWorkdir = options.workdir;
        }

        if (cmdStr.includes("uname -r") || cmdStr.includes("uname -a")) {
            return {
                exitCode: 0,
                stdout: "Linux microvm-guest 6.1.102-microvm #1 SMP PREEMPT_DYNAMIC x86_64\n",
                stderr: "",
            };
        }
        if (cmdStr.includes("whoami")) {
            return {
                exitCode: 0,
                stdout: "root\n",
                stderr: "",
            };
        }

        return {
            exitCode: 0,
            stdout: `mock-vm-stdout: ${cmdStr}\n`,
            stderr: "",
        };
    }

    async terminate(vmId: string): Promise<void> {
        this.instances.delete(vmId);
    }
}
