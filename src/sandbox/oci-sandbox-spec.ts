import { isWithin, type EffectivePolicySnapshot } from "../policies/effective-policy.ts";
import {
    freezeSandboxSpec,
    resolveSandboxProfile,
    type SandboxProfile,
    type SandboxRuntime,
    type SandboxSpec,
} from "./sandbox-profile.ts";

export interface OciSandboxCompilerConfig {
    readonly image: string;
    readonly userId: number;
    readonly profile: SandboxProfile;
    readonly runtime: SandboxRuntime;
}

export interface CompiledOciSandboxSpec {
    readonly spec: SandboxSpec;
    readonly createArgs: readonly string[];
}

/**
 * Compiles policy into OCI facts without knowing how Docker/containerd starts
 * the workload. Secret values are accepted only while building argv and never
 * enter the immutable spec or runtime evidence.
 */
export class OciSandboxSpecCompiler {
    constructor(private readonly config: OciSandboxCompilerConfig) {
        if (!Number.isInteger(config.userId) || config.userId <= 0) {
            throw new Error("Container Sandbox userId 必须是正整数，不能使用 root");
        }
        if (config.profile === "default" || config.profile === "restricted-egress") {
            if (config.runtime !== "runsc") {
                throw new Error(
                    `${config.profile} profile 必须使用 runsc；拒绝回退到 ${config.runtime}`,
                );
            }
        }
        if (config.profile === "strict") {
            throw new Error("strict profile 必须路由到独立 microVM Provider");
        }
    }

    compile(
        name: string,
        workspacePath: string,
        policy: EffectivePolicySnapshot,
        secretNames: readonly string[],
    ): CompiledOciSandboxSpec {
        const profile = resolveSandboxProfile(policy.sandboxProfile, this.config.profile);
        if (profile !== this.config.profile) {
            throw new Error(
                `Sandbox profile 与 Container Provider 配置不一致：${profile} 与 ${this.config.profile}`,
            );
        }
        if (policy.workspaceRoots !== null && !policy.workspaceRoots.some(
            (root) => isWithin(workspacePath, root),
        )) {
            throw new Error(`Sandbox Workspace 超出策略范围：${workspacePath}`);
        }
        if (policy.resourceLimits.diskMiB !== null) {
            throw new Error("Container bind mount 无法强制磁盘配额，拒绝执行");
        }
        if (profile === "restricted-egress" && policy.allowNetwork) {
            throw new Error(
                "restricted-egress 尚未接入受控 egress proxy，拒绝直连公网",
            );
        }

        const networkMode = profile === "development"
            ? (policy.allowNetwork ? "bridge" : "none")
            : "none";
        // Docker's runsc integration on the currently supported server image
        // rejects --pids-limit during container startup. Do not claim a PID
        // cgroup limit that the runtime cannot enforce; the capability is
        // represented explicitly in the compiled/audited spec instead.
        const pidLimit = this.config.runtime === "runsc" ? null : 128;
        const spec = freezeSandboxSpec({
            profile,
            runtime: this.config.runtime,
            image: this.config.image,
            userId: this.config.userId,
            workspaceMount: "/workspace",
            workspacePath,
            networkMode,
            readOnlyRootfs: true,
            droppedCapabilities: "ALL",
            noNewPrivileges: true,
            pidLimit,
            resourceLimits: policy.resourceLimits,
            secretNames,
        });

        const args: string[] = [
            "run", "--detach", "--rm", "--name", name,
            "--user", `${this.config.userId}:${this.config.userId}`,
            "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--workdir", "/workspace", "--mount",
            `type=bind,src=${workspacePath},dst=/workspace`,
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--network", networkMode === "none" ? "none" : "bridge",
        ];
        if (pidLimit !== null) {
            args.push("--pids-limit", String(pidLimit));
        }
        if (policy.resourceLimits.cpuCores !== null) {
            args.push("--cpus", String(policy.resourceLimits.cpuCores));
        }
        if (policy.resourceLimits.memoryMiB !== null) {
            args.push("--memory", `${policy.resourceLimits.memoryMiB}m`);
        }
        for (const name of secretNames) {
            // The caller replaces this marker with a value in the short-lived
            // Docker argv. It cannot accidentally be persisted as evidence.
            args.push("--env", `${name}=__HARNESS_SECRET_${name}__`);
        }
        args.push(this.config.image, "tail", "-f", "/dev/null");

        return Object.freeze({ spec, createArgs: Object.freeze(args) });
    }
}
