import { expect, test } from "bun:test";
import { WorkerSandboxRequester } from "../../src/worker/worker-sandbox-requester.ts";
import { isMasterToWorkerMessage, isWorkerToMasterMessage, type SandboxAcquireResponseMessage, type WorkerToMasterMessage } from "../../src/worker/worker-protocol.ts";

const grant: SandboxAcquireResponseMessage["result"] = { ok: true, sandboxId: "sbx", token: "token",
    mountRoot: "/workspace", workdir: "/workspace", enforcement: {
        toolExecutionBoundary: "SANDBOX", filesystemIsolation: true, processIsolation: true,
        networkPolicyEnforced: true, cpuLimitEnforced: true, memoryLimitEnforced: true,
        diskLimitEnforced: false, pidLimitEnforced: false, workspaceScope: "RUN",
    } };

test("Worker 并发申请只发一次请求，只接受匹配 Run 和请求 ID 的授权", async () => {
    const sent: WorkerToMasterMessage[] = [];
    const requester = new WorkerSandboxRequester("run", (message) => sent.push(message));
    const first = requester.getOrRequest(); const second = requester.getOrRequest();
    expect(sent).toHaveLength(1);
    requester.handle({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "other", requestId: 1, result: grant });
    requester.handle({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "run", requestId: 2, result: grant });
    requester.handle({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "run", requestId: 1, result: grant });
    expect(await Promise.all([first, second])).toEqual([grant, grant]);
    expect(await requester.getOrRequest()).toEqual(grant);
    expect(sent).toHaveLength(1);
    requester.close();
    await expect(requester.getOrRequest()).rejects.toThrow("已关闭");
});

test("Master 拒绝或 IPC 关闭时工具不能取得 Sandbox", async () => {
    const requester = new WorkerSandboxRequester("run", () => {});
    const denied = requester.getOrRequest();
    requester.handle({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "run", requestId: 1, result: { ok: false, error: "拒绝" } });
    await expect(denied).rejects.toThrow("拒绝");
    const pending = requester.getOrRequest();
    requester.close();
    await expect(pending).rejects.toThrow("已关闭");
});

test("Sandbox IPC 拒绝缺失身份或无效载荷", () => {
    expect(isWorkerToMasterMessage({ type: "SANDBOX_ACQUIRE_REQUEST", runId: "run", requestId: 1 })).toBe(true);
    expect(isWorkerToMasterMessage({ type: "SANDBOX_ACQUIRE_REQUEST", runId: "", requestId: 1 })).toBe(false);
    expect(isWorkerToMasterMessage({ type: "SANDBOX_ACQUIRE_REQUEST", runId: "run", requestId: -1 })).toBe(false);
    expect(isMasterToWorkerMessage({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "run", requestId: 1, result: grant })).toBe(true);
    expect(isMasterToWorkerMessage({ type: "SANDBOX_ACQUIRE_RESPONSE", runId: "run", requestId: 1, result: { ok: true } })).toBe(false);
});
