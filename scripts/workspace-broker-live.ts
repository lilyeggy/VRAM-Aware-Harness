import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

const token = process.env.HARNESS_SANDBOX_BROKER_CONTROL_TOKEN;
const socket = process.env.HARNESS_SANDBOX_BROKER_SOCKET;
if (!token || !socket) throw new Error("缺少 Broker 配置");
const root = await mkdtemp("/data/harness/workspace-broker-live-");
const helperDir = await mkdtemp("/tmp/harness-broker-client-");
await chmod(helperDir, 0o755);
const helper = join(helperDir, "request.ts");
await copyFile(join(import.meta.dir, "workspace-broker-request.ts"), helper);
await chmod(helper, 0o644);
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "shared"), "initial");
const policy = { ...unrestrictedPolicy, id: "live-policy", runId: "live-run", userId: "live-user",
    sandboxProfile: "strict", layers: [], createdAt: new Date().toISOString(), workspaceRoots: [workspace],
    allowNetwork: false, allowedSecrets: [] };
const items = Array.from({ length: 3 }, () => ({ id: crypto.randomUUID(), token: crypto.randomUUID() }));
const active = new Set<string>();

async function request(account: string, payload: object): Promise<unknown> {
    const child = Bun.spawn(["runuser", "-u", account, "--", process.execPath, helper], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: "/tmp", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    child.stdin.write(JSON.stringify({ socket, payload })); child.stdin.end();
    const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`Broker 客户端进程失败: ${error}`);
    const response = JSON.parse(output) as { ok: boolean; result?: unknown; error?: string };
    if (!response.ok) throw new Error(response.error ?? "Broker 请求失败");
    return response.result;
}
async function terminate(item: typeof items[number]): Promise<void> {
    await request("cxr", { id: crypto.randomUUID(), op: "terminate", sandboxId: item.id, userId: "live-user", token });
    active.delete(item.id);
}
let passed = false;
try {
    await Promise.all(items.map(async (item) => {
        await request("cxr", { id: crypto.randomUUID(), op: "create", input: {
            id: item.id, runId: item.id, workspacePath: workspace, policy, controlToken: token, token: item.token,
        } });
        active.add(item.id);
    }));
    const commands = ["printf A > /workspace/shared", "printf B > /workspace/other", "printf C > /workspace/shared; printf C > /workspace/partial"];
    const outcomes = await Promise.all(items.map((item, index) => request("harness-worker", {
        id: crypto.randomUUID(), op: "execute", sandboxId: item.id, userId: "live-user", token: item.token,
        command: ["/bin/sh", "-c", commands[index]],
    }) as Promise<{ exitCode: number }>));
    assert(outcomes.every((item) => item.exitCode === 0), "guest commands failed");
    await Promise.all([terminate(items[0]!), terminate(items[1]!)]);
    await assert.rejects(terminate(items[2]!), /提交冲突/);
    active.delete(items[2]!.id); // provider already stopped and disposed it while preserving the result
    const receipts = await Promise.all(items.map((item) => request("cxr", {
        id: crypto.randomUUID(), op: "commit_receipt", sandboxId: item.id,
        userId: "live-user", workspacePath: workspace, token,
    }) as Promise<{ status: string }>));
    assert.deepEqual(receipts.map((receipt) => receipt.status), ["COMMITTED", "COMMITTED", "CONFLICT"]);
    assert.equal(await readFile(join(workspace, "shared"), "utf8"), "A");
    assert.equal(await readFile(join(workspace, "other"), "utf8"), "B");
    await assert.rejects(readFile(join(workspace, "partial")));
    const captureRoot = process.env.HARNESS_WORKSPACE_CAPTURE_ROOT
        ?? resolve(process.env.HARNESS_VM_RUNTIME_ROOT ?? "/var/lib/harness/vm", "..", "workspace-captures");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const result = join(captureRoot, hash("live-user"), hash(workspace), hash(items[2]!.id), "result", "files");
    assert.equal(await readFile(join(result, "shared"), "utf8"), "C");
    assert.equal(await readFile(join(result, "partial"), "utf8"), "C");
    assert((await stat(join(captureRoot, "raw-disks", `${items[2]!.id}.ext4`))).isFile());
    console.log("BROKER LIVE PASS: master/worker UIDs, three real VMs, disjoint commits, same-file conflict, no partial commit");
    passed = true;
} finally {
    for (const item of items) if (active.has(item.id)) await terminate(item).catch(() => undefined);
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`Broker live test evidence retained: ${root}`);
    await rm(helperDir, { recursive: true, force: true });
}
