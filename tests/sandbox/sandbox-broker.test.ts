
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
    BrokerSandboxProvider,
    type BrokerSandboxProviderOptions,
} from "../../src/sandbox/broker/broker-sandbox-provider.ts";
import {
    SandboxBrokerServer,
    type SandboxBrokerServerOptions,
} from "../../src/sandbox/broker/sandbox-broker-server.ts";
import type {
    SandboxCommandExecutor,
    SandboxProvider,
    SandboxRecord,
} from "../../src/sandbox/sandbox-provider.ts";

const CONTROL_TOKEN = "broker-control-secret";

function createFakeProvider(): {
    readonly provider: SandboxProvider & SandboxCommandExecutor;
    readonly records: Map<string, SandboxRecord>;
    readonly terminated: string[];
} {
    const records = new Map<string, SandboxRecord>();
    const terminated: string[] = [];
    const provider: SandboxProvider & SandboxCommandExecutor = {
        async create(input) {
            const record = {
                id: input.id,
                runId: input.runId,
                status: "ACTIVE",
                workspacePath: input.workspacePath,
                secretNames: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            } as unknown as SandboxRecord;
            records.set(input.id, record);
            return {
                id: input.id,
                workspacePath: input.workspacePath,
                secretNames: [],
                enforcement: {
                    toolExecutionBoundary: "SANDBOX",
                    filesystemIsolation: true,
                    processIsolation: true,
                    networkPolicyEnforced: true,
                    cpuLimitEnforced: true,
                    memoryLimitEnforced: true,
                    diskLimitEnforced: false,
                    pidLimitEnforced: false,
                    workspaceScope: "RUN",
                },
                mountRoot: input.workspacePath,
                containerWorkdir: "/workspace",
                withSecrets: (callback) => callback({}),
            };
        },
        async terminate(sandboxId) {
            terminated.push(sandboxId);
        },
        async execute(sandboxId, command) {
            if (records.has(sandboxId) === false) {
                throw new Error("unknown sandbox: " + sandboxId);
            }
            return { exitCode: 0, stdout: command.join(" "), stderr: "" };
        },
        subscribe() {
            return () => undefined;
        },
        async close() {},
    };
    return { provider, records, terminated };
}

async function withBroker(
    fn: (context: {
        readonly client: BrokerSandboxProvider;
        readonly terminated: string[];
        readonly makeClient: (
            tenantId: string,
            extra?: Partial<BrokerSandboxProviderOptions>,
        ) => BrokerSandboxProvider;
    }) => Promise<void>,
    options: { readonly tenantId?: string } = {},
    serverOptions: Partial<SandboxBrokerServerOptions> = {},
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "broker-test-"));
    const socketPath = join(dir, "broker.sock");
    const fake = createFakeProvider();
    const server = new SandboxBrokerServer({
        socketPath,
        provider: fake.provider,
        readRecord: (sandboxId) => fake.records.get(sandboxId) ?? null,
        controlToken: CONTROL_TOKEN,
        ...serverOptions,
    });
    await server.start();
    const makeClient = (
        tenantId: string,
        extra: Partial<BrokerSandboxProviderOptions> = {},
    ): BrokerSandboxProvider => new BrokerSandboxProvider({
        socketPath,
        requestTimeoutMs: 5000,
        tenantId,
        ...extra,
    });
    const client = makeClient(options.tenantId ?? "tenant-1", { controlToken: CONTROL_TOKEN });
    try {
        await fn({ client, terminated: fake.terminated, makeClient });
    } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

test("Broker 服务器只暴露 create/execute/terminate，客户端可完成一轮调用", async () => {
    await withBroker(async ({ client, terminated }) => {
        const handle = await client.create({
            id: "sandbox-1",
            runId: "run-1",
            workspacePath: "/tmp/workspace-1",
            policy: { tenantId: "tenant-1" } as never,
        });
        expect(handle.id).toBe("sandbox-1");
        expect(handle.workspacePath).toBe("/tmp/workspace-1");
        expect(handle.enforcement.workspaceScope).toBe("RUN");
        expect(handle.secretNames).toEqual([]);
        expect(typeof handle.capabilityToken).toBe("string");

        const result = await client.execute("sandbox-1", ["uname", "-r"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("uname -r");

        await client.terminate("sandbox-1");
        expect(terminated).toEqual(["sandbox-1"]);
    });
});

test("Broker 客户端把 Broker 错误转成 reject", async () => {
    await withBroker(async ({ makeClient }) => {
        const client = makeClient("tenant-1", { capabilityToken: "token-for-missing" });
        await expect(client.execute("missing-sandbox", ["echo", "hi"])).rejects.toThrow(
            "Broker 不认识 sandbox：missing-sandbox",
        );
    });
});

test("Broker 拒绝跨租户 execute/terminate", async () => {
    await withBroker(async ({ client, makeClient }) => {
        const handle = await client.create({
            id: "sandbox-cross",
            runId: "run-cross",
            workspacePath: "/tmp/workspace-cross",
            policy: { tenantId: "tenant-1" } as never,
        });

        const otherTenant = makeClient("tenant-2", {
            capabilityToken: handle.capabilityToken,
        });
        await expect(otherTenant.execute("sandbox-cross", ["echo", "hi"])).rejects.toThrow(
            "Broker 拒绝跨租户操作",
        );
        await expect(otherTenant.terminate("sandbox-cross")).rejects.toThrow(
            "Broker 拒绝跨租户操作",
        );
    });
});

test("Broker 拒绝 capability token 不匹配的 execute", async () => {
    await withBroker(async ({ client, makeClient }) => {
        await client.create({
            id: "sandbox-token",
            runId: "run-token",
            workspacePath: "/tmp/workspace-token",
            policy: { tenantId: "tenant-1" } as never,
        });

        const wrongToken = makeClient("tenant-1", { capabilityToken: "wrong-token" });
        await expect(wrongToken.execute("sandbox-token", ["echo", "hi"])).rejects.toThrow(
            "capability token 不匹配",
        );
    });
});

test("Broker 拒绝 control token 不匹配的 create", async () => {
    await withBroker(async ({ makeClient }) => {
        const badMaster = makeClient("tenant-1", { controlToken: "wrong-control" });
        await expect(badMaster.create({
            id: "sandbox-bad-create",
            runId: "run-bad-create",
            workspacePath: "/tmp/workspace-bad-create",
            policy: { tenantId: "tenant-1" } as never,
        })).rejects.toThrow("Broker 拒绝 create：control token 不匹配");
    });
});

test("Worker 侧缺少 control token 时拒绝 create", async () => {
    await withBroker(async ({ makeClient }) => {
        const worker = makeClient("tenant-1");
        await expect(worker.create({
            id: "sandbox-worker-create",
            runId: "run-worker-create",
            workspacePath: "/tmp/workspace-worker-create",
            policy: { tenantId: "tenant-1" } as never,
        })).rejects.toThrow("缺少 controlToken");
    });
});

test("Master 丢失 per-sandbox token 后可用 control token terminate", async () => {
    await withBroker(async ({ client, terminated, makeClient }) => {
        await client.create({
            id: "sandbox-recover",
            runId: "run-recover",
            workspacePath: "/tmp/workspace-recover",
            policy: { tenantId: "tenant-1" } as never,
        });

        const recoveredMaster = makeClient("tenant-1", { controlToken: CONTROL_TOKEN });
        await recoveredMaster.terminate("sandbox-recover");
        expect(terminated).toEqual(["sandbox-recover"]);
    });
});

test("control token 不能替代 per-sandbox token 执行命令", async () => {
    await withBroker(async ({ client, makeClient }) => {
        await client.create({
            id: "sandbox-exec-control",
            runId: "run-exec-control",
            workspacePath: "/tmp/workspace-exec-control",
            policy: { tenantId: "tenant-1" } as never,
        });

        const recoveredMaster = makeClient("tenant-1", { controlToken: CONTROL_TOKEN });
        await expect(recoveredMaster.execute("sandbox-exec-control", ["echo", "hi"]))
            .rejects.toThrow("capability token");
    });
});

test("Broker 用 SO_PEERCRED 把 create/terminate 绑定到 Master UID、execute 绑定到 Worker UID", async () => {
    const peer = { pid: 1, uid: 1004, gid: 1004 };
    await withBroker(async ({ client, terminated, makeClient }) => {
        const handle = await client.create({
            id: "sandbox-peer",
            runId: "run-peer",
            workspacePath: "/tmp/workspace-peer",
            policy: { tenantId: "tenant-1" } as never,
        });

        // 同一连接/UID 1004 是 Master：execute 要求 Worker UID 998，拒绝。
        await expect(client.execute("sandbox-peer", ["echo", "hi"])).rejects.toThrow(
            "Broker 拒绝 execute：对端 uid=1004，要求 uid=998",
        );

        // 切到 Worker UID 998：execute 通过，create 被拒绝。
        peer.uid = 998;
        peer.gid = 998;
        const worker = makeClient("tenant-1", {
            capabilityToken: handle.capabilityToken,
            controlToken: CONTROL_TOKEN,
        });
        const result = await worker.execute("sandbox-peer", ["echo", "hi"]);
        expect(result.exitCode).toBe(0);
        await expect(worker.create({
            id: "sandbox-peer-worker-create",
            runId: "run-peer-worker-create",
            workspacePath: "/tmp/workspace-peer-worker-create",
            policy: { tenantId: "tenant-1" } as never,
        })).rejects.toThrow("Broker 拒绝 create：对端 uid=998，要求 uid=1004");

        // 切回 Master UID 1004：terminate 通过。
        peer.uid = 1004;
        peer.gid = 1004;
        const master = makeClient("tenant-1", { controlToken: CONTROL_TOKEN });
        await master.terminate("sandbox-peer");
        expect(terminated).toEqual(["sandbox-peer"]);
    }, {}, {
        readPeerCredentials: () => ({ ...peer }),
        masterPeerUid: 1004,
        workerPeerUid: 998,
    });
});

test("Broker 在配置 peer UID 但读不到 SO_PEERCRED 时 fail-closed", async () => {
    await withBroker(async ({ client }) => {
        await expect(client.create({
            id: "sandbox-peer-null",
            runId: "run-peer-null",
            workspacePath: "/tmp/workspace-peer-null",
            policy: { tenantId: "tenant-1" } as never,
        })).rejects.toThrow("无法读取对端 SO_PEERCRED 凭据");
    }, {}, {
        readPeerCredentials: () => null,
        masterPeerUid: 1004,
    });
});

test("Broker 连接白名单拒绝非授权 UID", async () => {
    await withBroker(async ({ client }) => {
        await expect(client.create({
            id: "sandbox-peer-denied",
            runId: "run-peer-denied",
            workspacePath: "/tmp/workspace-peer-denied",
            policy: { tenantId: "tenant-1" } as never,
        })).rejects.toThrow();
    }, {}, {
        readPeerCredentials: () => ({ pid: 1, uid: 998, gid: 998 }),
        allowedPeerUids: new Set([1004]),
    });
});
