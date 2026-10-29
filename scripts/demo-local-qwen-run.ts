import { startHarnessProcess } from "../src/main.ts";

console.log("=================================================");
console.log("🚀 启动 Harness Master 并接入本地 Qwen3-1.7B (GPU 0)");
console.log("=================================================");

process.env.HARNESS_PORT = "3300";
process.env.PI_PROVIDER = "local-vllm";
process.env.PI_MODEL_ID = "qwen3-1.7b";
process.env.VLLM_MODEL_ID = "qwen3-1.7b";
process.env.PI_MODELS_PATH = "/home/cxr/.pi/agent/models.json";
process.env.PI_AUTH_PATH = "/home/cxr/.pi/agent/auth.json";
process.env.HARNESS_WORKER_PI_MODELS_PATH = "/home/cxr/.pi/agent/models.json";
process.env.HARNESS_WORKER_PI_AUTH_PATH = "/home/cxr/.pi/agent/auth.json";
process.env.HARNESS_DATABASE_PATH = "/data/harness/test-local/harness.sqlite";
process.env.HARNESS_WORKSPACE_ROOT = "/data/harness/test-local/workspaces";
process.env.HARNESS_VM_RUNTIME_ROOT = "/data/harness/test-local/vm-runtime";
process.env.HARNESS_BOOTSTRAP_API_KEY = "local-test-key-2026";
process.env.HARNESS_REGISTRATION_MODE = "open";

const app = await startHarnessProcess();

const BASE_URL = app.baseUrl;
console.log(`[1] Harness Master 已成功监听: ${BASE_URL}`);

// 注册用户
const email = `test-${Date.now()}@lab.local`;
const password = "Password123!";
console.log(`[2] 注册新用户: ${email}`);

const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
});
if (regRes.status !== 201) {
    throw new Error(`注册失败: ${await regRes.text()}`);
}

const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
});
const { token, userId } = await loginRes.json() as { token: string; userId: string };
console.log(`[3] 登录成功: userId=${userId}`);

// 创建工作区
const wsRes = await fetch(`${BASE_URL}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "gpu-demo-workspace" })
});
const { workspace } = await wsRes.json() as { workspace: { id: string } };
console.log(`[4] 创建持久化工作区: workspaceId=${workspace.id}`);

// 提交任务
const prompt = "请使用 bash 工具执行 echo 'HELLO FROM BLACKWELL GPU'，并只回答完成。";
console.log(`[5] 提交用户任务: "${prompt}"`);

const runRes = await fetch(`${BASE_URL}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
        workspaceId: workspace.id,
        userInput: prompt
    })
});
const { run } = await runRes.json() as { run: { id: string; status: string } };
console.log(`[6] 任务已入队: runId=${run.id}, 初始状态=${run.status}`);

// 轮询等待任务完成
console.log(`[7] 等待调度器分配沙箱、启动 MicroVM 并由本地 Qwen 推理...`);
const startTime = Date.now();
let finalRun: { status: string; finalText?: string } = { status: "QUEUED" };

while (Date.now() - startTime < 60000) {
    await new Promise((r) => setTimeout(r, 800));
    const query = await fetch(`${BASE_URL}/runs/${run.id}`, {
        headers: { authorization: `Bearer ${token}` }
    });
    const queryData = await query.json() as { run: { status: string; finalText?: string } };
    finalRun = queryData.run;
    process.stdout.write(`...当前状态: ${finalRun.status}\n`);
    if (finalRun.status === "COMPLETED" || finalRun.status === "FAILED" || finalRun.status === "INTERRUPTED") {
        break;
    }
}

console.log("\n=================================================");
console.log(`🎉 任务执行终态: ${finalRun.status}`);
if (finalRun.finalText) {
    console.log(`💬 Agent 最终回答:\n${finalRun.finalText}`);
}
console.log("=================================================");

// 打印 run 事件流
const eventsRes = await fetch(`${BASE_URL}/runs/${run.id}/events`, {
    headers: { authorization: `Bearer ${token}` }
});
if (eventsRes.ok) {
    const eventsData = await eventsRes.json() as { events: Array<{ type: string; payloadJson?: string; timestamp: string }> };
    console.log("\n📜 全链路 RunEvents 执行证据链:");
    for (const ev of eventsData.events || []) {
        console.log(` - [${ev.timestamp.slice(11, 19)}] ${ev.type} ${ev.payloadJson ? `=> ${ev.payloadJson}` : ""}`);
    }
}

await app.close();
console.log("\n✅ Master 实例安全退出，沙箱与临时资源无残留。");
