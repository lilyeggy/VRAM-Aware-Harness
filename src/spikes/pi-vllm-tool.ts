// 把相对路径变成绝对路径
import {resolve} from "node:path"

// 导入pi SDK
import {
  createAgentSession,   // 创建单次 pi agent 对话，pi agent 的 agent loop 跑在对应的 session 里面
  ModelRuntime, // 负责加载模型配置，比如 vllm 地址、模型 ID 等
  SessionManager,   // 管理 session 历史。这里我们用的是内存版，这就代表着一旦进程结束历史就没有了
} from "@earendil-works/pi-coding-agent";

// 说明当前工作目录以及模型 ID
const cwd = process.cwd();
const modelsPath = resolve(cwd,".pi/spike.models.json")
const modelId = process.env.VLLM_MODEL_ID
// 不写死 model ID，根据 vllm 实际返回的 /v1/models为准

if (!modelId){
    throw new Error("请先设置 VLLM_MODEL_ID环境变量")
}

const modelRuntime = await ModelRuntime.create({modelsPath})
const model = modelRuntime.getModel("local-vllm",modelId)

if (!model) {
    throw new Error (`在 ${modelsPath} 中没有找到 local-vllm/${modelId}`)
}

// 创建pi agent session
const {session} = await createAgentSession({
    cwd,
    modelRuntime,
    model,
    tools:["read"],
    sessionManager:SessionManager.inMemory(cwd),
});
// 1. cwd:告诉pi agent 项目根目录在哪里
// 2. modelRuntime:刚刚创建的
// 3. model：告诉 pi 用什么 model
// 4. 告诉 pi 能够使用什么工具
// 5. session 历史只放在内存里
// const {session} = createAgentSession: createAgentSession会返回很多字段，但是我们只用 session 这个字段
// 我们创建的agentsession 其实就是pi agent session，里面不仅包括 pi agent，还有 model， tools, session manager等等运行所需要的对象
// 但是这个时候 agent 还没有开始干活，只是准备好了。真正让 agent 开始干活的是 session.prompt()


// 开始监听 pi 事件
// pi 运行阶段，会不断地有事件发生
const unsubsribe = session.subscribe((event) => {
    // session 内部会有一个subsribe方法，subsribe返回的是一个函数，这个返回函数就被保存到const unsubsribe里面
    // 所以 session.subsribe是注册监听，unsubscribe是把监听移除
    // 这个在 typescript 里面很常见，是一个 cleanup 函数，就是比如session.subscribe会返回一个 cleanup 函数，运行结束时调用即可
    switch (event.type) {
        // message_update 事件：模型正在输出文字
        case "message_update":
            // 处理流式输出
            if (event.assistantMessageEvent.type === "text_delta"){
                process.stdout.write(event.assistantMessageEvent.delta);
            } // write这里就会按照流式输出，不自动换行
            break;
        
        // tool_execution_start:工具开始执行
        case "tool_execution_start":
            console.log(`\n[tool started] ${event.toolName}`);
            console.log(`[tool arguments] ${JSON.stringify(event.args)}`);
            break;

        case "tool_execution_end":
            console.log(`\n[tool completed] ${event.toolName}`);
            console.log(`[tool error] ${event.isError}`);
            break;
        
        // 这次 agent 运行结束
        case "agent_end":
            console.log(`\n[agent ended] willRetry=${event.willRetry}`);
            break;
    }
});

try {
    // 把用户 prompt 交给 pi agent。Pi 会自己决定调用模型、调用工具、再把工具结果交给模型。
    await session.prompt(
    "你必须使用 read 工具读取当前项目的 README.md。不要凭记忆回答。读取后，只回答 README.md 的第一行。",
  );
} finally {
    unsubsribe();   // 结束监听
    session.dispose();  // 释放 pi session 资源
}





