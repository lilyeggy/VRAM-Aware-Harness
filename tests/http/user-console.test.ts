import { expect, test } from "bun:test";

import { HarnessHttpApi, type HarnessHttpApplication } from "../../src/http/harness-http-api.ts";
import { userConsoleResponse } from "../../src/http/harness-user-console.ts";

test("userConsoleResponse 返回带 CSP 的中文 HTML 页面", () => {
    const response = userConsoleResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");

    return response.text().then((html) => {
        // 用户视角的关键界面元素：登录卡片、对话侧栏、居中输入区。
        expect(html).toContain("VRAM-Aware Harness");
        expect(html).toContain("authEmail");
        expect(html).toContain("convList");
        expect(html).toContain("新对话");
        // 页面绝不接受客户端自报 tenantId：租户只能由服务端凭证派生。
        expect(html).not.toMatch(/tenantId\s*[=:]/);
        // 模板字符串必须完整闭合，防止把 TS 源码片段发给浏览器。
        expect(html.trim().endsWith("</html>")).toBe(true);
    });
});

// N1 回归：2026-09-10 真机发现 /app 内联脚本在浏览器中解析即失败
// （模板字面量把 /\r\n?/g 编成真实 CR/LF，auth/app 双 hidden 白屏）。
// 既有冒烟只查字符串，抓不到这个类；这里对每段内联脚本做浏览器级解析断言。
test("用户工作台的内联脚本必须能被浏览器引擎解析（N1 回归）", async () => {
    const html = await userConsoleResponse().text();
    const scripts: string[] = [];
    let pos = 0;
    while (true) {
        const start = html.indexOf("<script>", pos);
        if (start < 0) break;
        const end = html.indexOf("</script>", start);
        expect(end).toBeGreaterThan(start);
        scripts.push(html.slice(start + "<script>".length, end));
        pos = end + "</script>".length;
    }
    expect(scripts.length).toBeGreaterThan(0);
    for (const [index, script] of scripts.entries()) {
        let parseError: Error | null = null;
        try {
            // 只解析不执行：等价于浏览器打开页面时对脚本的首次判定。
            new Function(script);
        } catch (error) {
            parseError = error as Error;
        }
        expect(parseError).toBeNull();
        if (parseError) {
            throw new Error(`内联脚本 ${index} 解析失败：${parseError.message}`);
        }
    }
    // 关键引导函数必须以可解析的函数体形式存在（而非残缺字符串）。
    expect(html).toContain("function showAuth");
    expect(html).toContain("function enterApp");
    // markdown 渲染里不得残留模板级吃掉的裸 CR/LF（曾经的白屏根因）。
    expect(html).not.toContain("replace(/\r\n?/g");
});

// N7 回归：2026-09-10 真机发现连点两次"发送"会提交两个任务并都执行。
// 这里断言工作台脚本存在"在途提交防重"：置位前先判、提交结束时复位、
// 并在在途期间禁用发送按钮。
test("用户工作台必须在提交在途时防重（N7 回归）", async () => {
    const html = await userConsoleResponse().text();
    const script = html.slice(
        html.indexOf("var S = {"),
        html.indexOf("function interruptRun("),
    );
    expect(script.length).toBeGreaterThan(0);

    // 状态位存在且初始为 false
    expect(html).toContain("sending: false");
    // 进入提交前先判、再置位
    const guardIndex = script.indexOf("if(S.sending) return;");
    const flagIndex = script.indexOf("S.sending = true;");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeGreaterThan(guardIndex);
    // 无论成功失败都要复位（挂在 catch 之后的 then 上）
    expect(script).toContain("S.sending = false; setSendBusy(false);");
    // 在途期间禁用按钮
    expect(script).toContain("btn.disabled = !!busy;");
});

test("GET /app 路由返回用户工作台，而 / 仍然是运营控制台", async () => {
    const application: HarnessHttpApplication = {
        isStarted: () => true,
        submitRun: () => {
            throw new Error("not used");
        },
        getRun: () => null,
        getRunsForTenant: () => [],
        getRunEvents: () => [],
        getRunOutput: () => ({ chunks: [], finalText: "" }),
        getRunWorkspaceDiff: () => null,
        getRunArtifacts: () => [],
        getRunArtifact: async () => null,
        getRunDecisions: () => [],
        getQueue: () => [],
        observeResources: async () => ({
            ok: false as const,
            observedAt: "2026-01-01T00:00:00.000Z",
            attemptedSources: ["FAKE" as const],
            reason: "UNAVAILABLE" as const,
            message: "测试资源不可用",
        }),
        interruptRun: async () => {
            throw new Error("not used");
        },
        resumeRun: () => {
            throw new Error("not used");
        },
    };
    const api = new HarnessHttpApi(application, { get: () => null });

    const userPage = await api.fetch(new Request("http://localhost/app"));
    expect(userPage.status).toBe(200);
    expect(await userPage.text()).toContain("用户工作台");

    const operatorPage = await api.fetch(new Request("http://localhost/"));
    expect(operatorPage.status).toBe(200);
    expect(await operatorPage.text()).toContain("Agent Harbor");

    const missing = await api.fetch(new Request("http://localhost/app/nope"));
    expect(missing.status).toBe(404);
});

// N22 回归：2026-09-10 真机发现切换对话时"迟到的轮询响应无条件覆盖当前页"——
// 状态已是对话 B，页面却显示 A 的标题与 A 的消息（跨对话串扰），用户在正文里
// 点"中断/恢复"还可能作用到错误对象。
test("用户工作台必须丢弃迟到的会话刷新响应（N22 回归）", async () => {
    const html = await userConsoleResponse().text();

    // 每个刷新调用都要有"调用时的对话快照"与"请求序号"两个判据。
    // 只有对话 id 不够：A→B→A 快速切换时旧 A 的响应迟到会恰好对上 id。
    expect(html).toContain("refreshSeq");
    expect(html).toContain("var requestedId = S.conversationId;");
    expect(html).toContain("var seq = ++S.refreshSeq;");

    const refreshStart = html.indexOf("function refreshConversation(");
    const refreshEnd = html.indexOf("function loadOutput(");
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const refresh = html.slice(refreshStart, refreshEnd);

    // 快照必须早于发起请求
    const snapshotIndex = refresh.indexOf("var requestedId = S.conversationId;");
    const requestIndex = refresh.indexOf("return api('/conversations/'");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(snapshotIndex);

    // 守卫必须早于"写全局状态"（否则先污染再判断等于没判）
    const guardIndex = refresh.indexOf(
        "if(requestedId !== S.conversationId || seq !== S.refreshSeq) return;",
    );
    const assignIndex = refresh.indexOf("S.conversation = body.conversation");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(assignIndex).toBeGreaterThan(guardIndex);

    // 链式请求跨过切换窗口后，渲染前还要再确认一次
    expect(refresh).toContain("renderThread(); schedulePoll();");
    expect(refresh.lastIndexOf("seq !== S.refreshSeq"))
        .toBeGreaterThan(refresh.indexOf("renderThread(); schedulePoll();") - 400);

    // 切对话必须立刻停掉旧轮询，而不是等刷新完成后才重排定时器
    const openStart = html.indexOf("function openConversation(");
    const openBody = html.slice(openStart, html.indexOf("function refreshConversation("));
    expect(openBody.indexOf("stopPoll();"))
        .toBeLessThan(openBody.indexOf("S.conversationId = id;"));
});

// N25 回归：2026-09-10 真机发现断网 30/120s 期间轮询错误被静默吞掉——界面既无
// 错误也无离线提示，还持续把过期状态当最新状态展示。
test("用户工作台必须把断网/请求失败显式呈现给用户（N25 回归）", async () => {
    const html = await userConsoleResponse().text();

    // 页面必须有承载降级提示的元素与样式
    expect(html).toContain('id="netBanner"');
    expect(html).toContain(".netbanner");
    expect(html).toContain(".netbanner.on");

    // 失败要让用户看见，且明确说明"显示的是最后一次成功获取的状态"
    expect(html).toContain("function showNetBanner(");
    expect(html).toContain("function noteNetFail(");
    expect(html).toContain("function noteNetOk(");
    expect(html).toContain("最后一次成功获取的状态");

    // api() 是唯一出口：网络失败必须经它登记，否则又会有"没走 api 的静默路径"
    const apiStart = html.indexOf("function api(");
    // 用 JS 独有的边界：`/* ---------- 登录 ---------- */` 在 CSS 里也有一份。
    const apiEnd = html.indexOf("function doAuthLogin(");
    expect(apiStart).toBeGreaterThan(-1);
    expect(apiEnd).toBeGreaterThan(apiStart);
    // 判定函数定义在 api() 之前，按整页断言；api() 内部只断言"用了它"。
    expect(html).toContain("function isNetworkError(");
    const api = html.slice(apiStart, apiEnd);
    expect(api).toContain("noteNetFail()");
    expect(api).toContain("noteNetOk()");

    // 离线/恢复事件要即时反映，不必等下一次轮询超时
    expect(html).toContain("window.addEventListener('offline'");
    expect(html).toContain("window.addEventListener('online'");

    // 队列拉取失败不得清空已知队列（原先会显示成"任务不在队列里"，属假数据）
    const queueStart = html.indexOf("function refreshQueue(");
    const queueEnd = html.indexOf("/* ---------- 发送 / 控制 ---------- */");
    const refreshQueue = html.slice(queueStart, queueEnd);
    expect(refreshQueue).not.toContain("S.queue = []; })");
    expect(refreshQueue).toContain("保留上次已知队列");
});

/**
 * 从内联脚本里取出一个函数的完整源码。
 * 用于对前端纯函数做**行为级**断言，而不只是断言字符串存在。
 */
function extractFunctionSource(html: string, signature: string): string {
    const start = html.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let index = html.indexOf("{", start);
    for (; index < html.length; index += 1) {
        if (html[index] === "{") depth += 1;
        else if (html[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                index += 1;
                break;
            }
        }
    }
    return html.slice(start, index);
}

// N21 回归：行内代码里的下划线被 Markdown 强调规则吃掉 —— `new_python_script.py`
// 渲染成 `<code>new<em>python</em>script.py</code>`，显示与复制都丢下划线，
// 文件名/路径/标识符（如 harness_instances）普遍受影响。
test("行内代码里的下划线必须原样保留（N21 回归）", async () => {
    const html = await userConsoleResponse().text();
    const inlineMd = new Function(
        "return (" + extractFunctionSource(html, "function inlineMd(") + ")",
    )() as (s: string) => string;

    const code = inlineMd("`new_python_script.py`");
    expect(code).toBe("<code>new_python_script.py</code>");
    expect(code).not.toContain("<em>");

    const mixed = inlineMd("`harness_instances` 与 **加粗** 混排");
    expect(mixed).toContain("<code>harness_instances</code>");
    expect(mixed).toContain("<strong>加粗</strong>");
    expect(mixed).not.toContain("<code>harness<em>");

    // 代码段之外的强调仍要生效（不能为了修 N21 把强调关掉）
    expect(inlineMd("这是 _斜体_ 文本")).toContain("<em>斜体</em>");
});

// N24 回归：`modified` 条目是 `{before:{path},after:{path}}`，前端原先统一按
// `f.path` 取值 → 「文件变更」面板把修改项渲染成 `[object Object]`。
test("文件变更的 modified 条目必须取到真实路径（N24 回归）", async () => {
    const html = await userConsoleResponse().text();
    const diffPath = new Function(
        "return (" + extractFunctionSource(html, "function diffPath(") + ")",
    )() as (f: unknown) => string;

    // API 的真实形态：modified 是 before/after 包装
    expect(diffPath({ before: { path: "src/a.ts" }, after: { path: "src/a.ts" } }))
        .toBe("src/a.ts");
    // added / deleted 的形态：顶层 path
    expect(diffPath({ path: "docs/b.md" })).toBe("docs/b.md");
    // 纯字符串
    expect(diffPath("c.txt")).toBe("c.txt");
    // 兜底：形状不认识时返回空串，而不是 "[object Object]"
    expect(diffPath({})).toBe("");
    expect(diffPath(null)).toBe("");

    // 渲染处必须用 diffPath，不能退回 f.path
    expect(html).not.toContain("esc(f.path || f)");
});
