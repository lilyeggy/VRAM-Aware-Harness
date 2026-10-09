
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BrokerSandboxProvider } from "../../src/sandbox/broker/broker-sandbox-provider.ts";
import { SandboxBrokerServer } from "../../src/sandbox/broker/sandbox-broker-server.ts";
import type {
    SandboxCommandExecutor,
    SandboxProvider,
    SandboxRecord,
} from "../../src/sandbox/sandbox-provider.ts";

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
    }) => Promise<void>,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "broker-test-"));
    const socketPath = join(dir, "broker.sock");
    const fake = createFakeProvider();
    const server = new SandboxBrokerServer({
        socketPath,
        provider: fake.provider,
        readRecord: (sandboxId) => fake.records.get(sandboxId) ?? null,
    });
    await server.start();
    const client = new BrokerSandboxProvider({ socketPath, requestTimeoutMs: 5000 });
    try {
        await fn({ client, terminated: fake.terminated });
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
            policy: {} as never,
        });
        expect(handle.id).toBe("sandbox-1");
        expect(handle.workspacePath).toBe("/tmp/workspace-1");
        expect(handle.enforcement.workspaceScope).toBe("RUN");
        expect(handle.secretNames).toEqual([]);

        const result = await client.execute("sandbox-1", ["uname", "-r"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("uname -r");

        await client.terminate("sandbox-1");
        expect(terminated).toEqual(["sandbox-1"]);
    });
});

test("Broker 客户端把 Broker 错误转成 reject", async () => {
    await withBroker(async ({ client }) => {
        await expect(client.execute("missing-sandbox", ["echo", "hi"])).rejects.toThrow(
            "unknown sandbox: missing-sandbox",
        );
    });
});
