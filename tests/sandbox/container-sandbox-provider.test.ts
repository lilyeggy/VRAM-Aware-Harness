import { expect, test } from "bun:test";
import { ContainerSandboxProvider } from "../../src/sandbox/container-sandbox-provider.ts";
import type { SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";
import { unrestrictedPolicy, type EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

class FakeDocker {
    readonly calls: string[][] = [];
    readonly environments: (Readonly<Record<string, string>> | undefined)[] = [];
    nextExecResult: { exitCode: number; stdout: string; stderr: string } | null = null;
    async run(args: readonly string[], environment?: Readonly<Record<string, string>>) {
        this.calls.push([...args]);
        this.environments.push(environment);
        if (args[1] === "inspect") {
            // 预热池探活用 State.Running；runtime 举证用 HostConfig.Runtime。
            return {
                exitCode: 0,
                stdout: args.includes("{{.State.Running}}") ? "true\n" : "runsc\n",
                stderr: "",
            };
        }
        // 预热池初始化会按 label 列遗留容器；返回空表示没有遗留。
        if (args[1] === "ps") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "exec" && this.nextExecResult !== null) return this.nextExecResult;
        return { exitCode: 0, stdout: "container-id", stderr: "" };
    }
}

/** 统计真正创建出来的预热容器数量（区别于租用后的正式名字）。 */
function warmContainers(docker: FakeDocker): number {
    return docker.calls.filter((call) => {
        if (call[1] !== "run") return false;
        const nameIndex = call.indexOf("--name");
        return nameIndex >= 0
            && String(call[nameIndex + 1]).startsWith("agent-harness-warm-");
    }).length;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("等待条件超时");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function policy(overrides: Partial<EffectivePolicySnapshot> = {}): EffectivePolicySnapshot {
    return {
        ...unrestrictedPolicy, id: "policy", runId: "run", tenantId: "tenant",
        templateVersionId: "version", layers: [], createdAt: "2026-08-17T00:00:00.000Z",
        workspaceRoots: ["/srv/workspaces/tenant"], allowNetwork: false,
        resourceLimits: { cpuCores: 1.5, memoryMiB: 512, diskMiB: null },
        ...overrides,
    };
}

test("容器 Sandbox 将隔离策略编译为可审计 Docker 参数，并仅持久化 Secret 名称", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: (tenantId, name) => tenantId === "tenant" && name === "TOKEN" ? "secret-value" : null },
        { image: "agent-sandbox:test" }, docker,
    );
    const handle = await provider.create({
        id: "sandbox-1", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy({ allowedSecrets: ["TOKEN"] }),
    });
    const create = docker.calls[0]!;
    expect(create).toContain("--runtime");
    expect(create).toContain("runsc");
    expect(create).toContain("--read-only");
    expect(create).toContain("--cap-drop");
    expect(create).toContain("ALL");
    expect(create).toContain("no-new-privileges");
    expect(create).toContain("--user");
    expect(create).toContain("65532:65532");
    expect(create).toContain("--network");
    expect(create).toContain("none");
    expect(create).toContain("--cpus");
    expect(create).toContain("1.5");
    expect(create).toContain("--memory");
    expect(create).toContain("512m");
    // N12 回归：runsc 同样必须下发 PID 上限，否则沙箱内进程数完全不设限
    // （实测不传时 900/900 个子进程均可创建成功）。
    expect(create).toContain("--pids-limit");
    expect(create).toContain("128");
    expect(create).toContain("type=bind,src=/srv/workspaces/tenant/workspace,dst=/workspace");
    expect(create.some((argument) => argument.includes(",rw"))).toBe(false);
    // N13 回归：Secret 明文不得出现在任何创建参数里（历史实现会在这里放明文，
    // 结果 docker inspect 可读出、argv 也可见）。
    expect(create).not.toContain("TOKEN=secret-value");
    expect(JSON.stringify(create)).not.toContain("secret-value");
    expect(JSON.stringify(create)).not.toContain("__HARNESS_SECRET_");
    expect(JSON.stringify(store.get(handle.id))).not.toContain("secret-value");
    expect(store.get(handle.id)?.secretNames).toEqual(["TOKEN"]);
    expect(store.get(handle.id)?.profile).toBe("default");
    expect(store.get(handle.id)?.runtime).toBe("runsc");
    expect(store.get(handle.id)?.runtimeEvidence).toMatchObject({
        adapter: "docker-runsc",
        requestedRuntime: "runsc",
        observedRuntime: "runsc",
        verified: true,
    });
    expect(handle.enforcement).toEqual({
        toolExecutionBoundary: "SANDBOX",
        filesystemIsolation: true,
        processIsolation: true,
        networkPolicyEnforced: true,
        cpuLimitEnforced: true,
        memoryLimitEnforced: true,
        diskLimitEnforced: false,
        pidLimitEnforced: true,
        workspaceScope: "RUN",
    });

    await provider.execute(handle.id, ["sh", "-lc", "id"]);
    // N13：exec 只带 Secret 名字，明文经子进程环境传入（不进 argv）。
    expect(docker.calls[2]).toEqual([
        "docker", "exec", "--workdir", "/workspace", "--env", "TOKEN",
        "agent-harness-sandbox-1", "sh", "-lc", "id",
    ]);
    expect(docker.environments[2]).toEqual({ TOKEN: "secret-value" });
    expect(JSON.stringify(docker.calls[2])).not.toContain("secret-value");
    await provider.terminate(handle.id);
    expect(store.get(handle.id)?.status).toBe("TERMINATED");
});

test("docker exec 发现容器消失时发出 LOST，而不是把它当成普通工具失败", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null }, { image: "agent-sandbox:test" }, docker,
    );
    const events: unknown[] = [];
    provider.subscribe((event) => events.push(event));
    const handle = await provider.create({
        id: "sandbox-lost", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });
    docker.nextExecResult = { exitCode: 1, stdout: "", stderr: "Error response from daemon: No such container: agent-harness-sandbox-lost" };
    await provider.execute(handle.id, ["sh", "-lc", "pwd"]);
    expect(store.get(handle.id)).toMatchObject({ status: "LOST" });
    expect(events).toMatchObject([{ sandboxId: handle.id, status: "LOST", runId: "run" }]);
    await expect(provider.execute(handle.id, ["sh", "-lc", "pwd"])).rejects.toThrow("不可执行");
});

test("gVisor 沙箱被资源上限终结的报错同样判为失联，不必等下一次工具调用", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null }, { image: "agent-sandbox:test" }, docker,
    );
    const events: unknown[] = [];
    provider.subscribe((event) => events.push(event));
    const handle = await provider.create({
        id: "sandbox-oom", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });
    // 真机原文：A6000 上 32MiB 限额容器分配 ~200MB 时，触发那一次 exec 的 stderr
    // 与退出码（exit=128，容器随后被 --rm 回收）。
    docker.nextExecResult = {
        exitCode: 128,
        stdout: "",
        stderr: 'waiting on pid 2: waiting on PID 2 in sandbox "abff744223c73cefe835480ccc07d1ecbf927fe38885b0d823c35ba37163e370": urpc method "containerManager.WaitPID" failed: EOF',
    };
    const result = await provider.execute(handle.id, ["sh", "-lc", "burst"]);
    expect(result.exitCode).toBe(128);
    expect(store.get(handle.id)).toMatchObject({ status: "LOST" });
    expect(events).toMatchObject([{ sandboxId: handle.id, status: "LOST" }]);
});

test("启动对账可按持久化 Sandbox ID 回收旧进程未登记的容器", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null }, { image: "agent-sandbox:test" }, docker,
    );
    const handle = await provider.create({
        id: "sandbox-stale", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });
    await provider.cleanupStale(store.get(handle.id)!);
    expect(docker.calls.at(-1)).toEqual([
        "docker", "rm", "--force", "agent-harness-sandbox-stale",
    ]);
    await expect(provider.execute(handle.id, ["true"])).rejects.toThrow("不可执行");
});

test("无法强制 bind mount 磁盘配额或越出 Workspace 根时拒绝执行", async () => {
    const provider = new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore, { get: () => null },
        { image: "agent-sandbox:test" }, new FakeDocker(),
    );
    await expect(provider.create({
        id: "sandbox-disk", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace",
        policy: policy({ resourceLimits: { cpuCores: null, memoryMiB: null, diskMiB: 10 } }),
    })).rejects.toThrow("磁盘配额");
    await expect(provider.create({
        id: "sandbox-escape", runId: "run", instanceId: "instance",
        workspacePath: "/etc", policy: policy(),
    })).rejects.toThrow("超出策略范围");
});

test("预热容器命中后补上本次策略的资源限额，并立即补货", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", warmPoolSize: 2, warmPoolOwner: "test" },
        docker,
    );
    const input = (id: string) => ({
        id, runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });

    const first = await provider.create(input("sandbox-warm-1"));
    expect(first.acquisition?.warmHit).toBe(false);
    // 冷启动的 Run 结束后才补货（低频负载下这一步由止损兜底）。
    await provider.terminate(first.id);
    await waitUntil(() => warmContainers(docker) === 1);

    const second = await provider.create(input("sandbox-warm-2"));
    expect(second.acquisition?.warmHit).toBe(true);
    // 池化容器是裸规格（不含限额）创建的，租用后必须补上本次策略的限额，
    // 否则等于悄悄放大了资源上限。
    const update = docker.calls.find((call) => call[1] === "update");
    expect(update).toBeDefined();
    expect(update).toContain("--cpus");
    expect(update).toContain("1.5");
    // 真机验证（A6000 / runsc）：只下发 --memory 会被 daemon 拒绝——
    // "Memory limit should be smaller than already set memoryswap limit"，
    // 必须同时把 --memory-swap 写成同值（等价禁用 swap）。
    expect(update).toContain("--memory");
    expect(update).toContain("--memory-swap");
    expect(update!.filter((argument) => argument === "512m")).toHaveLength(2);
    expect(update).toContain("agent-harness-sandbox-warm-2");
    // 命中即补货：池里立刻又有一个，不必等这次 Run 结束。
    await waitUntil(() => warmContainers(docker) === 2);
    await provider.terminate(second.id);
});

test("命中后仍会走过 runtime 举证，复用不等于免检", async () => {
    const docker = new FakeDocker();
    const provider = new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", warmPoolSize: 2, warmPoolOwner: "test" },
        docker,
    );
    const input = (id: string) => ({
        id, runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/workspace", policy: policy(),
    });
    const first = await provider.create(input("sandbox-proof-1"));
    await provider.terminate(first.id);
    await waitUntil(() => warmContainers(docker) === 1);

    const before = docker.calls.length;
    const second = await provider.create(input("sandbox-proof-2"));
    expect(second.acquisition?.warmHit).toBe(true);
    const verifications = docker.calls.slice(before).filter(
        (call) => call[1] === "inspect" && call.includes("{{.HostConfig.Runtime}}"),
    );
    expect(verifications).toHaveLength(1);
    await provider.terminate(second.id);
});

test("TENANT 视野：容器挂租户根，工具工作目录落到本 Run 的工作区子目录", async () => {
    const docker = new FakeDocker();
    const store = new MemorySandboxStore();
    const provider = new ContainerSandboxProvider(
        store as unknown as SandboxStore,
        { get: () => null },
        {
            image: "agent-sandbox:test",
            workspaceScope: "tenant",
            tenantWorkspaceRoot: "/srv/workspaces",
        },
        docker,
    );
    const handle = await provider.create({
        id: "sandbox-tenant", runId: "run", instanceId: "instance",
        workspacePath: "/srv/workspaces/tenant/ws-1",
        policy: policy({ workspaceRoots: ["/srv/workspaces/tenant"] }),
    });
    const create = docker.calls[0]!;
    expect(create.join(" ")).toContain("type=bind,src=/srv/workspaces/tenant,dst=/workspace");
    expect(create.join(" ")).not.toContain("src=/srv/workspaces/tenant/ws-1");
    expect(handle.mountRoot).toBe("/srv/workspaces/tenant");
    expect(handle.enforcement.workspaceScope).toBe("TENANT");
    // 视野放宽到租户根，但 bash 的 cwd 必须落回本 Run 自己的工作区。
    expect(handle.containerWorkdir).toBe("/workspace/ws-1");

    await provider.execute(handle.id, ["sh", "-lc", "pwd"], { workdir: handle.containerWorkdir });
    const exec = docker.calls.filter((call) => call[1] === "exec").at(-1);
    expect(exec).toEqual([
        "docker", "exec", "--workdir", "/workspace/ws-1",
        "agent-harness-sandbox-tenant", "sh", "-lc", "pwd",
    ]);
    await provider.terminate(handle.id);
});

test("TENANT 视野下同租户不同工作区命中同一个预热容器", async () => {
    const docker = new FakeDocker();
    const provider = new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
        {
            image: "agent-sandbox:test", warmPoolSize: 2, warmPoolOwner: "test",
            workspaceScope: "tenant", tenantWorkspaceRoot: "/srv/workspaces",
        },
        docker,
    );
    const input = (id: string, workspace: string) => ({
        id, runId: "run", instanceId: "instance",
        workspacePath: workspace,
        policy: policy({ workspaceRoots: ["/srv/workspaces/tenant"] }),
    });

    const a = await provider.create(input("sandbox-multi-a", "/srv/workspaces/tenant/ws-a"));
    expect(a.acquisition?.warmHit).toBe(false);
    await provider.terminate(a.id);
    await waitUntil(() => warmContainers(docker) === 1);

    // 换了工作区、但同租户：RUN 视野下必然落空，TENANT 视野下应当命中。
    const b = await provider.create(input("sandbox-multi-b", "/srv/workspaces/tenant/ws-b"));
    expect(b.acquisition?.warmHit).toBe(true);
    expect(b.containerWorkdir).toBe("/workspace/ws-b");
    await provider.terminate(b.id);
});
