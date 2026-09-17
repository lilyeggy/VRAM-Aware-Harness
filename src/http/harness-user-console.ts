/**
 * User-facing conversation console, styled after a calm "chat-first" product
 * surface: cream paper background, serif display type, clay accent, a sidebar
 * of conversations and a centered rounded composer.
 *
 * It is a pure same-origin static page: no framework, no build step, and the
 * session token lives only in this browser's localStorage.  All privileged
 * operations still derive their Tenant from the Bearer credential on the
 * server, never from the page.
 */
export function userConsoleResponse(): Response {
    return new Response(USER_CONSOLE_HTML, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
                "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        },
    });
}

// Do not use String.raw here: Bun may emit non-ASCII source literals as
// \uXXXX escapes, and a raw template would send those escape sequences to the
// browser as visible text instead of decoding them into Chinese characters.
import { readFileSync } from "node:fs";

const USER_CONSOLE_CLIENT_JS = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const USER_CONSOLE_CSS = readFileSync(new URL("../../web/app.css", import.meta.url), "utf8");

const USER_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#FAF9F5"><title>Harness · 用户工作台</title>
<style>
${USER_CONSOLE_CSS}
</style></head><body>

<!-- 登录 / 注册 -->
<div id="auth" class="authwrap hidden">
  <div class="authcard">
    <div class="authbrand">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="2.2" x2="12" y2="7.4"/><line x1="12" y1="16.6" x2="12" y2="21.8"/><line x1="2.2" y1="12" x2="7.4" y2="12"/><line x1="16.6" y1="12" x2="21.8" y2="12"/><line x1="5.1" y1="5.1" x2="8.7" y2="8.7"/><line x1="15.3" y1="15.3" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="8.7" y2="15.3"/><line x1="15.3" y1="8.7" x2="18.9" y2="5.1"/></g></svg></div>
      <h1>VRAM-Aware Harness</h1>
      <p>把任务交给 Agent，在团队共享的本地模型上完成。</p>
    </div>
    <div class="authtabs">
      <button id="tabLogin" class="on" type="button">登录</button>
      <button id="tabRegister" type="button">注册</button>
    </div>
    <div class="field"><label>邮箱</label><input id="authEmail" type="email" autocomplete="username" placeholder="you@team.local"></div>
    <div class="field"><label>密码</label><input id="authPassword" type="password" autocomplete="current-password" placeholder="至少 8 位"></div>
    <div id="authError" class="autherr"></div>
    <button id="authSubmit" class="authbtn" type="button">登录</button>
    <div class="authalt">或</div>
    <div class="field"><label>API Key（可选）</label><input id="authApiKey" type="password" autocomplete="off" placeholder="使用租户签发的 API Key 直接进入"></div>
    <button id="keySubmit" class="ghostbtn" type="button">使用 API Key 进入</button>
    <div id="demoEntry" class="demoentry hidden"><button id="demoSubmit" class="ghostbtn" type="button">本地模式进入（未启用账户服务）</button></div>
  </div>
</div>

<!-- 用户工作台 -->
<div id="app" class="app hidden">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="2.2" x2="12" y2="7.4"/><line x1="12" y1="16.6" x2="12" y2="21.8"/><line x1="2.2" y1="12" x2="7.4" y2="12"/><line x1="16.6" y1="12" x2="21.8" y2="12"/><line x1="5.1" y1="5.1" x2="8.7" y2="8.7"/><line x1="15.3" y1="15.3" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="8.7" y2="15.3"/><line x1="15.3" y1="8.7" x2="18.9" y2="5.1"/></g></svg></div>
      <div><b>Harness</b><small>用户工作台</small></div>
    </div>
    <button id="newChat" class="newchat" type="button"><svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>新对话</button>
    <div class="wspick">
      <select id="workspaceSel" title="选择 Workspace"></select>
      <button id="addWorkspace" title="新建 Workspace" type="button">＋</button>
    </div>
    <div class="convlabel">对话</div>
    <div id="convList" class="convlist"></div>
    <div class="sidefoot">
      <div class="avatar" id="userInitial">U</div>
      <div class="uinfo"><b id="userEmail">未登录</b><small id="modeTag">会话登录</small></div>
      <button id="logoutBtn" class="footbtn" title="退出登录" type="button">⎋</button>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">
    <header class="topbar">
      <button id="menuBtn" class="menuBtn" type="button">☰</button>
      <div class="titlewrap"><b id="convTitle">新对话</b><span id="convSub">选择或创建一条对话开始任务</span></div>
      <a class="oplink" href="/" target="_blank" title="打开运营/开发者控制台"><span>运营控制台 </span>↗</a>
    </header>
    <div class="stage" id="stage">
      <div class="hero" id="hero">
        <div class="herospace">
          <div class="greet">
            <svg class="gmark" viewBox="0 0 24 24" fill="none"><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2.2" x2="12" y2="7.4"/><line x1="12" y1="16.6" x2="12" y2="21.8"/><line x1="2.2" y1="12" x2="7.4" y2="12"/><line x1="16.6" y1="12" x2="21.8" y2="12"/><line x1="5.1" y1="5.1" x2="8.7" y2="8.7"/><line x1="15.3" y1="15.3" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="8.7" y2="15.3"/><line x1="15.3" y1="8.7" x2="18.9" y2="5.1"/></g></svg>
            <div><h2 id="greetText">你好</h2><p>描述一个任务，Agent 会在隔离环境中执行，并交付回答、文件变更与产物。</p></div>
          </div>
        </div>
      </div>
      <div class="thread hidden" id="thread"><div class="threadinner" id="threadInner"></div></div>
      <div class="composerzone">
        <div class="composer">
          <textarea id="input" rows="1" placeholder="给 Agent 输入任务…（Enter 发送，Shift+Enter 换行）"></textarea>
          <div class="cfoot">
            <span class="chip"><span class="dot"></span><b id="wsChip">未选择 Workspace</b></span>
            <span class="chiphint" id="modeHint"></span>
            <select id="thinkingLevel" class="thinking-select" title="选择模型思考深度"><option value="off">不思考</option><option value="minimal">快速思考</option><option value="low">低深度</option><option value="medium" selected>中等深度</option><option value="high">高深度</option></select>
            <div class="cbtns">
              <button id="stopBtn" class="stopbtn hidden" title="中断任务" type="button"><i></i></button>
              <button id="sendBtn" class="sendbtn" title="发送" type="button"><svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
        </div>
        <p class="disclaimer">Agent 在按 Run 隔离的沙箱中执行 · 工具副作用先记账后执行 · 共享 GPU 公平调度，资源紧张时任务会排队</p>
      </div>
      <div class="hero" id="suggestZone" style="flex:0 0 auto;padding-top:0">
        <div class="herospace" style="margin:0">
          <div class="suggests" id="suggests"></div>
        </div>
      </div>
    </div>
  </main>
</div>

<div id="netBanner" class="netbanner" role="status" aria-live="polite"></div>
<div id="toast" class="toast"></div>

<script>
${USER_CONSOLE_CLIENT_JS}
</script></body></html>`;
