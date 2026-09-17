import { expect, test } from "bun:test";
import { ContainerSandboxProvider } from "../../src/sandbox/container-sandbox-provider.ts";
import type { SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import type { SandboxStore } from "../../src/sandbox/sandbox-store.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void { this.records.set(record.id, record); }
    get(id: string): SandboxRecord | null { return this.records.get(id) ?? null; }
    update(record: SandboxRecord): void { this.records.set(record.id, record); }
}

class RecordingDocker {
    readonly calls: string[][] = [];
    async run(args: readonly string[]) {
        this.calls.push([...args]);
        if (args[1] === "ps") {
            return { exitCode: 0, stdout: "agent-harness-warm-aa\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
    }
}

/** 让出一次事件循环，等构造期发起的异步清场落地。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("N29：Provider 构造期就发起预热池清场，不必等第一次取用", async () => {
    const docker = new RecordingDocker();
    const provider = new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test", warmPoolSize: 2, warmPoolOwner: "dep-a" },
        docker,
    );

    await settle();

    const psCalls = docker.calls.filter((call) => call[1] === "ps");
    expect(psCalls).toHaveLength(1);
    expect(psCalls[0]).toContain("label=agent-harness.warm-owner=dep-a");
    // 遗留的预热容器在任何人取用之前就被清掉了。
    expect(docker.calls.filter((call) => call[1] === "rm")).toHaveLength(1);
    await provider.close();
});

test("N29：没配预热池时不发起清场", async () => {
    const docker = new RecordingDocker();
    const provider = new ContainerSandboxProvider(
        new MemorySandboxStore() as unknown as SandboxStore,
        { get: () => null },
        { image: "agent-sandbox:test" },
        docker,
    );

    await settle();

    expect(docker.calls.filter((call) => call[1] === "ps")).toHaveLength(0);
    await provider.close();
});
