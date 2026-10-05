export type MicrovmDriverName = "mock" | "e2b" | "firecracker";

export interface MicrovmInstance {
    readonly id: string;
    readonly driver: MicrovmDriverName;
    readonly vmPid?: number;
    readonly ipAddress?: string;
    readonly workspacePath: string;
    readonly createdAt: string;
}

export interface MicrovmCreateOptions {
    readonly id: string;
    readonly runId: string;
    readonly workspacePath: string;
    readonly workspaceDiskPath?: string;
    readonly cpuCount?: number;
    readonly memoryMb?: number;
    readonly allowNetwork?: boolean;
    readonly environment?: Readonly<Record<string, string>>;
}

export interface MicrovmExecuteOptions {
    readonly workdir?: string;
    readonly timeoutMs?: number;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onStderrChunk?: (chunk: string) => void;
}

export interface MicrovmExecutionResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface MicrovmDriver {
    readonly name: MicrovmDriverName;
    create(options: MicrovmCreateOptions): Promise<MicrovmInstance>;
    execute(
        vmId: string,
        command: readonly string[],
        options?: MicrovmExecuteOptions,
    ): Promise<MicrovmExecutionResult>;
    terminate(vmId: string): Promise<void>;
    isAvailable(): Promise<boolean>;
}
