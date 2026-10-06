import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { FirecrackerSerialBridge } from "../../src/sandbox/microvm/firecracker-serial-bridge.ts";
import { MicrovmSandboxProvider } from "../../src/sandbox/microvm/microvm-sandbox-provider.ts";
import { MockMicrovmDriver } from "../../src/sandbox/microvm/mock-microvm-driver.ts";
import type { SecretProvider, SandboxRecord } from "../../src/sandbox/sandbox-provider.ts";
import type { EffectivePolicySnapshot } from "../../src/policies/effective-policy.ts";

class MemorySandboxStore {
    readonly records = new Map<string, SandboxRecord>();
    create(record: SandboxRecord): void {
        this.records.set(record.id, record);
    }
    get(id: string): SandboxRecord | null {
        return this.records.get(id) ?? null;
    }
    update(record: SandboxRecord, _previousStatus: string): void {
        this.records.set(record.id, record);
    }
    listActive(): SandboxRecord[] {
        return Array.from(this.records.values()).filter((r) => r.status === "ACTIVE");
    }
    listOrphans(): SandboxRecord[] {
        return [];
    }
}

describe("MicroVM 架构与系统边界隔离测试 (Inside vs Outside Boundaries)", () => {
    describe("全双工串口通信桥梁 (FirecrackerSerialBridge)", () => {
        test("标准输入命令注入与哨兵返回码准确解析 (Exit Code = 0)", async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const bridge = new FirecrackerSerialBridge(stdin, stdout, { defaultTimeoutMs: 1000 });

            // 模拟虚拟机在收到命令后，通过虚拟串口返回内容与结束标记
            stdin.on("data", (chunk: Buffer) => {
                const input = chunk.toString();
                const match = input.match(/echo "(__HARNESS_DONE_[^"]+__):\$\?"/);
                if (match) {
                    const marker = match[1];
                    // 模拟 guest 返回终端输出与哨兵
                    setTimeout(() => {
                        stdout.write(`Executing command...\nOutput line 1\nOutput line 2\n${marker}:0\n`);
                    }, 10);
                }
            });

            const result = await bridge.execute(["echo", "hello"]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("Output line 1");
            expect(result.stdout).toContain("Output line 2");

            bridge.close();
        });

        test("命令执行失败时正确捕获非零退出码 (Exit Code = 127)", async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const bridge = new FirecrackerSerialBridge(stdin, stdout, { defaultTimeoutMs: 1000 });

            stdin.on("data", (chunk: Buffer) => {
                const input = chunk.toString();
                const match = input.match(/echo "(__HARNESS_DONE_[^"]+__):\$\?"/);
                if (match) {
                    const marker = match[1];
                    setTimeout(() => {
                        stdout.write(`sh: command not found: unknown_cmd\n${marker}:127\n`);
                    }, 10);
                }
            });

            const result = await bridge.execute(["unknown_cmd"]);
            expect(result.exitCode).toBe(127);
            expect(result.stdout).toContain("command not found");

            bridge.close();
        });

        test("多轮工具调用时保持单通道排队串行，不发生交错污染", async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const bridge = new FirecrackerSerialBridge(stdin, stdout, { defaultTimeoutMs: 2000 });

            let counter = 0;
            stdin.on("data", (chunk: Buffer) => {
                const input = chunk.toString();
                const match = input.match(/echo "(__HARNESS_DONE_[^"]+__):\$\?"/);
                if (match) {
                    const marker = match[1];
                    counter += 1;
                    const thisCount = counter;
                    setTimeout(() => {
                        stdout.write(`Turn ${thisCount} Done\n${marker}:0\n`);
                    }, 20);
                }
            });

            const [r1, r2] = await Promise.all([
                bridge.execute(["turn_1"]),
                bridge.execute(["turn_2"]),
            ]);

            expect(r1.exitCode).toBe(0);
            expect(r1.stdout).toContain("Turn 1 Done");
            expect(r2.exitCode).toBe(0);
            expect(r2.stdout).toContain("Turn 2 Done");

            bridge.close();
        });

        test("长时间挂起未结束触发超时安全熔断并发送打断信号", async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const bridge = new FirecrackerSerialBridge(stdin, stdout, { defaultTimeoutMs: 100 });

            let receivedInterrupt = false;
            stdin.on("data", (chunk: Buffer) => {
                if (chunk.toString().includes("\x03")) {
                    receivedInterrupt = true;
                }
            });

            // 不向 stdout 写入任何哨兵，模拟死锁或死循环
            await expect(bridge.execute(["sleep", "999"])).rejects.toThrow("执行超时");
            expect(receivedInterrupt).toBe(true);

            bridge.close();
        });
    });

    describe("虚拟机内部与外部的零信任安全与凭据边界 (Zero-Trust Security Boundary)", () => {
        function setupProvider() {
            const store = new MemorySandboxStore();
            const secrets: SecretProvider = {
                get(tenantId, name) {
                    if (name === "ALLOWED_CLIENT_TOKEN") return `secret_val_for_${tenantId}`;
                    return null;
                },
            };
            const driver = new MockMicrovmDriver();
            const provider = new MicrovmSandboxProvider(store as unknown as import("../../src/sandbox/sandbox-store.ts").SandboxStore, secrets, { driver });
            return { store, secrets, driver, provider };
        }

        test("宿主机大模型 API Key 绝对不下发至虚拟机内部，仅透传显式声明的业务 Secret", async () => {
            const { store, driver, provider } = setupProvider();

            // 模拟宿主机环境变量包含敏感凭证
            process.env.VLLM_API_KEY = "super_secret_host_vllm_key_never_leak";

            const mockPolicy: EffectivePolicySnapshot = {
                id: "policy-1",
                runId: "run-1",
                tenantId: "tenant-corp-a",
                layers: [],
                allowedTools: null,
                allowedSkills: null,
                allowedModels: null,
                workspaceRoots: null,
                // P0 修复：MicrovmSandboxProvider 现在拒绝 allowNetwork=true
                //（受控出口未实现），桩驱动的测试同样必须禁网。
                allowNetwork: false,
                allowProcess: true,
                allowedSecrets: ["ALLOWED_CLIENT_TOKEN"], // 仅显式允许一个业务 Secret
                resourceLimits: { cpuCores: 2, memoryMiB: 512, diskMiB: 1024 },
                createdAt: new Date().toISOString(),
            };

            const handle = await provider.create({
                id: "sandbox-boundary-1",
                runId: "run-1",
                workspacePath: "/data/workspaces/tenant-corp-a/run-1",
                policy: mockPolicy,
            });

            // 检查 Driver 实际收到的 environment
            const createdInstance = driver.instances.get("sandbox-boundary-1");
            expect(createdInstance).toBeDefined();

            // 1. 业务 Secret 成功送达
            expect(createdInstance?.environment["ALLOWED_CLIENT_TOKEN"]).toBe("secret_val_for_tenant-corp-a");

            // 2. 宿主机的敏感大模型凭证绝对不存在于虚拟机的环境中
            expect(createdInstance?.environment["VLLM_API_KEY"]).toBeUndefined();
            expect(createdInstance?.environment["OPENAI_API_KEY"]).toBeUndefined();

            // 3. 虚拟机内部拥有 UID 0 (root) 权限，确保能自由装包
            const spec = store.get("sandbox-boundary-1")?.spec;
            expect(spec?.userId).toBe(0);

            // 4. 工作区与硬件配额绑定
            expect(handle.containerWorkdir).toBe("/workspace");

            await provider.terminate("sandbox-boundary-1");
        });
    });
});
