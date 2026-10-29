import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const key = process.env.HARNESS_BOOTSTRAP_API_KEY;
if (!key) throw new Error("缺少应用验证凭据");
const base = "http://127.0.0.1:3100";
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
async function call(path: string, body?: object): Promise<any> {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers,
        ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
}
const created = await call("/workspaces", { name: `parallel-live-${crypto.randomUUID()}` });
const workspace = created.workspace as { id: string; rootPath: string };
const inputs = ["请立即使用 write 工具创建文件 alpha.txt，内容必须恰好为 alpha。完成后简短回复。",
    "请立即使用 write 工具创建文件 beta.txt，内容必须恰好为 beta。完成后简短回复。"];
const runs = await Promise.all(inputs.map(async (userInput) => (await call("/runs", { workspaceId: workspace.id, userInput })).run as { id: string; harnessSessionId: string }));
assert.notEqual(runs[0]!.harnessSessionId, runs[1]!.harnessSessionId);
console.log(`APP TEST workspace=${workspace.id}, runs=${runs.map((run) => run.id).join(",")}`);
const deadline = Date.now() + 180_000;
let statuses: string[] = [];
while (Date.now() < deadline) {
    statuses = await Promise.all(runs.map(async (run) => (await call(`/runs/${run.id}`)).run.status as string));
    if (statuses.every((status) => ["COMPLETED", "FAILED", "INTERRUPTED"].includes(status))) break;
    await Bun.sleep(1000);
}
assert.deepEqual(statuses, ["COMPLETED", "COMPLETED"]);
assert.equal((await readFile(join(workspace.rootPath, "alpha.txt"), "utf8")).trim(), "alpha");
assert.equal((await readFile(join(workspace.rootPath, "beta.txt"), "utf8")).trim(), "beta");
console.log("APP LIVE PASS: one Workspace, two Sessions, two real Runs, both result files preserved");
