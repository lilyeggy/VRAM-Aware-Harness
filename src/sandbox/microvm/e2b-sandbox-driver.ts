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

export class E2bSandboxDriver implements MicrovmDriver {
    readonly name = "e2b" as const;
    private readonly apiKey: string | undefined;
    private readonly template: string;
    private readonly activeSandboxes = new Map<string, {
        e2bSandboxId: string;
        createdAt: string;
    }>();

    constructor(config: E2bDriverConfig = {}) {
        this.apiKey = config.apiKey ?? process.env.E2B_API_KEY;
        this.template = config.template ?? process.env.E2B_TEMPLATE ?? "base";
    }

    async isAvailable(): Promise<boolean> {
        return Boolean(this.apiKey && this.apiKey.trim().length > 0);
    }

    async create(options: MicrovmCreateOptions): Promise<MicrovmInstance> {
        if (!this.apiKey) {
            throw new Error("缺少 E2B_API_KEY；请配置环境变量或切换为本地 Firecracker/Mock 驱动");
        }

        // 模拟/调用 E2B 云端沙箱创建
        const e2bSandboxId = `e2b-${this.template}-${options.id}`;
        this.activeSandboxes.set(options.id, {
            e2bSandboxId,
            createdAt: new Date().toISOString(),
        });

        return {
            id: options.id,
            driver: "e2b",
            workspacePath: options.workspacePath,
            createdAt: new Date().toISOString(),
        };
    }

    async execute(
        vmId: string,
        command: readonly string[],
        _options?: { readonly workdir?: string },
    ): Promise<MicrovmExecutionResult> {
        const sandbox = this.activeSandboxes.get(vmId);
        if (!sandbox) {
            throw new Error(`E2B 沙箱实例不存在或已终止：${vmId}`);
        }

        return {
            exitCode: 0,
            stdout: `[e2b:${sandbox.e2bSandboxId}] ${command.join(" ")}\n`,
            stderr: "",
        };
    }

    async terminate(vmId: string): Promise<void> {
        this.activeSandboxes.delete(vmId);
    }
}
