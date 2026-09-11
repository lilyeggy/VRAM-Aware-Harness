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
    /**
     * N14：容器 PID 上限（docker --pids-limit）。未配置时沿用 128。
     * gVisor（runsc）在触达该上限时会**终结整个沙箱**，runsc 的全局进程
     * 上限比 runc 低得多，因此需要把它调到 gVisor 内部上限之下，让本平台
     * 配置的这条限制先触发（触发后 harness 会把沙箱对账为 LOST，fail-closed）。
     */
    readonly pidsLimit?: number;
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
        // gVisor runsc 实测接受并执行 --pids-limit：release-20260817.0 上不传该
        // 参数时 900/900 个子进程全部创建成功，传 --pids-limit 128 / 512 时分别在
        // 约 40 / 229 个子进程处被拦停。旧注释声称 runsc 启动阶段会拒绝该参数，
        // 与实测不符；跳过它会让沙箱进程数完全不设上限（本项目
        // smoke:container:attacks 的 PID 项正是因此失败）。注意 gVisor 的进程计数
        // 与 runc 不同，同一名义值下可并发的进程数明显更少，超限错误文本为
        // "Out of memory" 而非 fork 失败。
        //
        // N14：两种 runtime 的**爆炸半径**不同——runc 下只是 fork 失败、容器继续
        // 存活；gVisor 下触达 PID 上限会终结整个沙箱（随后 `docker exec` 报
        // "container ... is not running"）。harness 能把后者正确对账为 LOST 并发
        // INTERRUPTED（fail-closed 收敛正确），但"一条命令吃满 PID"会连带中断该
        // Run。因此该值应当配置在 gVisor 内部上限之下（默认 128，可用
        // HARNESS_CONTAINER_PIDS_LIMIT 覆盖），让本平台配置的限制先触发。
        const pidLimit = this.config.pidsLimit ?? 128;
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
        // N13：Secret 不进入容器创建参数。历史上这里下发
        // `--env NAME=__HARNESS_SECRET_NAME__`，再由 Provider 在 argv 里替换成明文，
        // 结果是①创建期明文出现在 docker 进程参数中；②明文长期留在容器
        // Config.Env，任何 docker 组成员 `docker inspect` 都能读出。
        // 现在只把 Secret **名字**记进可审计 spec，明文在执行期经
        // `docker exec --env NAME` 从客户端进程环境注入（见 ContainerSandboxProvider.execute）。
        args.push(this.config.image, "tail", "-f", "/dev/null");

        return Object.freeze({ spec, createArgs: Object.freeze(args) });
    }
}
