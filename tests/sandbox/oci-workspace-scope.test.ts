import { expect, test } from "bun:test";
import { OciSandboxSpecCompiler, stripResourceLimitArgs } from "../../src/sandbox/oci-sandbox-spec.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";

function policy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy,
        layers: [],
        createdAt: new Date().toISOString(), id: "policy", runId: "run", tenantId: "tenant",
        workspaceRoots: ["/srv/workspaces"], allowNetwork: false,
        resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: null },
        ...overrides,
    };
}

const baseConfig = {
    image: "alpine:3.20",
    userId: 65532,
    profile: "default" as const,
    runtime: "runsc" as const,
};

test("RUN 视野（默认）：挂载根就是本 Run 的工作区", () => {
    const compiler = new OciSandboxSpecCompiler(baseConfig);
    const compiled = compiler.compile(
        "c", "/srv/workspaces/tenant/ws-1", policy(), [],
    );
    expect(compiled.createArgs.join(" "))
        .toContain("type=bind,src=/srv/workspaces/tenant/ws-1,dst=/workspace");
    expect(compiled.spec.workspaceScope).toBe("RUN");
    expect(compiled.spec.mountedRoot).toBe("/srv/workspaces/tenant/ws-1");
});

test("TENANT 视野：挂载根上提到租户根，工作区仍是 Run 自己的", () => {
    const compiler = new OciSandboxSpecCompiler({
        ...baseConfig, workspaceScope: "tenant", tenantWorkspaceRoot: "/srv/workspaces",
    });
    const compiled = compiler.compile(
        "c", "/srv/workspaces/tenant/ws-1", policy(), [],
    );
    // 挂载点只到租户根——同租户所有 Run 共用它，池因此可以跨工作区复用。
    expect(compiled.createArgs.join(" "))
        .toContain("type=bind,src=/srv/workspaces/tenant,dst=/workspace");
    expect(compiled.createArgs.join(" "))
        .not.toContain("src=/srv/workspaces/tenant/ws-1");
    expect(compiled.spec.workspaceScope).toBe("TENANT");
    expect(compiled.spec.mountedRoot).toBe("/srv/workspaces/tenant");
    // 工作区归属仍然如实记录在 spec 里，审计链不断。
    expect(compiled.spec.workspacePath).toBe("/srv/workspaces/tenant/ws-1");
});

test("TENANT 视野的三类越界都在编译期被拒绝", () => {
    const scoped = (workspacePath: string, tenantId = "tenant", root?: string) => {
        const compiler = new OciSandboxSpecCompiler({
            ...baseConfig,
            workspaceScope: "tenant",
            ...(root === undefined ? {} : { tenantWorkspaceRoot: root }),
        });
        return compiler.compile("c", workspacePath, policy({ tenantId }), []);
    };
    // ① 未配置租户工作区根
    expect(() => scoped("/srv/workspaces/tenant/ws-1", "tenant", undefined))
        .toThrow("必须配置租户工作区根目录");
    // ② 租户 ID 带路径分隔符，解析后跑到根之外
    expect(() => scoped("/srv/workspaces/tenant/ws-1", "../evil", "/srv/workspaces"))
        .toThrow("租户工作区根越界");
    // ③ 工作区不属于这个租户，容器挂上去也看不见自己的工作区
    expect(() => scoped("/srv/workspaces/other/ws-1", "tenant", "/srv/workspaces"))
        .toThrow("不在租户挂载根内");
});

test("池化规格剥离 CPU/内存限额，保留 pids-limit", () => {
    const args = [
        "run", "--name", "x", "--cpus", "2", "--memory", "512m",
        "--pids-limit", "128", "--network", "none", "alpine:3.20",
    ];
    expect(stripResourceLimitArgs(args)).toEqual([
        "run", "--name", "x", "--pids-limit", "128", "--network", "none", "alpine:3.20",
    ]);
});

test("同一工作区、仅资源限额不同的两次编译产出同一池化规格", () => {
    const compiler = new OciSandboxSpecCompiler(baseConfig);
    const lean = compiler.compile("c", "/srv/workspaces/tenant/ws-1", policy({
        resourceLimits: { cpuCores: 1, memoryMiB: 512, diskMiB: null },
    }), []);
    const heavy = compiler.compile("c", "/srv/workspaces/tenant/ws-1", policy({
        resourceLimits: { cpuCores: 4, memoryMiB: 4096, diskMiB: null },
    }), []);
    // 完整创建参数不同（正式容器必须带各自限额）
    expect(lean.createArgs).not.toEqual(heavy.createArgs);
    // 但剥离限额后的池化规格相同——这正是复用率提升的来源
    expect(stripResourceLimitArgs(lean.createArgs))
        .toEqual(stripResourceLimitArgs(heavy.createArgs));
});
