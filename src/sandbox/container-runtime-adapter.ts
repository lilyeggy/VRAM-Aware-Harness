import type { SandboxRuntime, SandboxRuntimeEvidence } from "./sandbox-profile.ts";

export interface ContainerCommandRuntime {
    run(args: readonly string[]): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
}

export interface ContainerRuntimeAdapter {
    readonly runtime: SandboxRuntime;
    readonly name: string;
    augmentCreateArgs(args: readonly string[]): readonly string[];
    verify(
        commands: ContainerCommandRuntime,
        docker: string,
        containerName: string,
    ): Promise<SandboxRuntimeEvidence>;
}

abstract class DockerRuntimeAdapter implements ContainerRuntimeAdapter {
    abstract readonly runtime: SandboxRuntime;
    abstract readonly name: string;

    augmentCreateArgs(args: readonly string[]): readonly string[] {
        if (args[0] !== "run") {
            throw new Error("OCI create args 必须以 docker run 开始");
        }
        return Object.freeze([args[0], "--runtime", this.runtime, ...args.slice(1)]);
    }

    async verify(
        commands: ContainerCommandRuntime,
        docker: string,
        containerName: string,
    ): Promise<SandboxRuntimeEvidence> {
        const result = await commands.run([
            docker, "inspect", "--format", "{{.HostConfig.Runtime}}", containerName,
        ]);
        const observedRuntime = result.stdout.trim() || null;
        const verified = result.exitCode === 0 && observedRuntime === this.runtime;
        return Object.freeze({
            adapter: this.name,
            requestedRuntime: this.runtime,
            observedRuntime,
            verified,
            verificationReason: verified
                ? null
                : redact(result.stderr || `实际 runtime 不是 ${this.runtime}`),
            verifiedAt: verified ? new Date().toISOString() : null,
        });
    }
}

export class DockerRunscRuntimeAdapter extends DockerRuntimeAdapter {
    readonly runtime = "runsc" as const;
    readonly name = "docker-runsc";
}

/** Development-only compatibility adapter. It is never selected for default. */
export class DockerRuncRuntimeAdapter extends DockerRuntimeAdapter {
    readonly runtime = "runc" as const;
    readonly name = "docker-runc";
}

function redact(value: string): string {
    return value.replace(/(?:[A-Z][A-Z0-9_]{2,})=\S+/g, "$1=[REDACTED]").slice(0, 1_000);
}
