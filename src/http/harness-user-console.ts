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
const USER_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#FAF9F5"><title>Harness · 用户工作台</title>
<style>
:root{
  --bg:#FAF9F5; --side:#F0EEE6; --side-hover:#E8E4D8; --side-on:#E3DFD2;
  --ink:#29261B; --ink2:#3D3B35; --muted:#7C7A70; --faint:#A5A296;
  --line:#E6E3D8; --line2:#D9D5C8;
  --accent:#D97757; --accent-h:#C05B3C; --accent-soft:#F6E8E1;
  --ok:#5F7C4C; --ok-bg:#EDF2E2; --warn:#9A6A1F; --warn-bg:#F7EEDA;
  --bad:#A63A2B; --bad-bg:#F8E9E4; --info:#5A6B9C; --info-bg:#EAEDF6;
  --code:#26251F; --codeink:#EDEBE0;
  --serif:Georgia,"Times New Roman","Songti SC","STSong",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 var(--sans);-webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:0;background:none}
a{color:var(--accent)}
.hidden{display:none!important}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#D8D4C6;border-radius:8px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}

/* ---------- 登录 ---------- */
.authwrap{min-height:100%;display:grid;place-items:center;padding:24px;background:
  radial-gradient(1200px 500px at 70% -10%, #F3EEE2 0%, transparent 60%), var(--bg)}
.authcard{width:min(400px,100%);background:#fff;border:1px solid var(--line);border-radius:20px;
  box-shadow:0 24px 60px rgba(60,52,35,.08);padding:34px 32px 28px}
.authbrand{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;margin-bottom:24px}
.mark{width:44px;height:44px;border-radius:14px;background:var(--accent);color:#fff;display:grid;place-items:center}
.mark svg{width:24px;height:24px}
.authbrand h1{font:600 24px/1.3 var(--serif);margin:0;letter-spacing:.01em}
.authbrand p{margin:0;color:var(--muted);font-size:13px}
.authtabs{display:flex;background:var(--side);border-radius:11px;padding:4px;margin-bottom:18px}
.authtabs button{flex:1;padding:8px 0;border-radius:8px;color:var(--muted);font-weight:600;font-size:13px}
.authtabs button.on{background:#fff;color:var(--ink);box-shadow:0 1px 4px rgba(50,45,30,.12)}
.field{margin-bottom:13px}
.field label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.field input{width:100%;border:1px solid var(--line2);border-radius:11px;padding:11px 13px;background:var(--bg);outline:none;transition:.15s}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(217,119,87,.14);background:#fff}
.authbtn{width:100%;border-radius:12px;padding:12px;background:var(--accent);color:#fff;font-weight:700;font-size:14px;transition:.15s}
.authbtn:hover{background:var(--accent-h)}
.authalt{display:flex;align-items:center;gap:12px;color:var(--faint);font-size:11px;margin:18px 0 12px;letter-spacing:.08em}
.authalt::before,.authalt::after{content:"";flex:1;height:1px;background:var(--line)}
.autherr{min-height:19px;font-size:12px;color:var(--bad);margin:4px 0 2px;text-align:center}
.ghostbtn{width:100%;border:1px solid var(--line2);border-radius:12px;padding:11px;background:#fff;font-weight:600;font-size:13px;color:var(--ink2)}
.ghostbtn:hover{background:var(--side)}
.demoentry{margin-top:10px}

/* ---------- 应用骨架 ---------- */
.app{display:grid;grid-template-columns:272px 1fr;height:100vh}
.sidebar{background:var(--side);display:flex;flex-direction:column;padding:16px 12px 12px;min-width:0}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px}
.brand .mark{width:34px;height:34px;border-radius:11px}
.brand .mark svg{width:19px;height:19px}
.brand b{font:600 16px var(--serif)}
.brand small{display:block;color:var(--muted);font-size:10.5px;letter-spacing:.06em;margin-top:1px}
.newchat{display:flex;align-items:center;gap:9px;border:1px solid var(--line2);background:#fff;
  border-radius:12px;padding:9px 12px;font-weight:600;font-size:13.5px;box-shadow:0 1px 3px rgba(60,52,35,.05);transition:.15s}
.newchat:hover{background:var(--accent-soft);border-color:#E5C4B4}
.newchat svg{width:15px;height:15px;color:var(--accent)}
.wspick{display:flex;gap:6px;margin:12px 2px 4px}
.wspick select{flex:1;min-width:0;border:1px solid transparent;border-radius:9px;background:transparent;padding:7px 8px;color:var(--ink2);font-size:12.5px;outline:none;cursor:pointer;text-overflow:ellipsis}
.wspick select:hover,.wspick select:focus{background:#fff;border-color:var(--line2)}
.wspick button{width:30px;height:30px;border-radius:9px;color:var(--muted);font-size:16px;line-height:1}
.wspick button:hover{background:var(--side-hover);color:var(--ink)}
.convlabel{font-size:10.5px;font-weight:700;letter-spacing:.14em;color:var(--faint);padding:14px 10px 6px}
.convlist{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-bottom:8px}
.convitem{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;border-radius:10px;padding:8px 10px;transition:.12s}
.convitem:hover{background:var(--side-hover)}
.convitem.on{background:var(--side-on)}
.convitem b{font-size:13px;font-weight:550;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.convitem span{font-size:11px;color:var(--faint)}
.convempty{color:var(--faint);font-size:12px;padding:10px;line-height:1.7}
.sidefoot{border-top:1px solid var(--line2);padding-top:10px;display:flex;align-items:center;gap:10px}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.uinfo{min-width:0;flex:1}
.uinfo b{display:block;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.uinfo small{display:block;font-size:10.5px;color:var(--faint)}
.footbtn{width:30px;height:30px;border-radius:8px;color:var(--muted);font-size:14px;flex:none}
.footbtn:hover{background:var(--side-hover);color:var(--bad)}

/* ---------- 主区 ---------- */
.main{display:flex;flex-direction:column;min-width:0;height:100vh}
.topbar{height:56px;flex:none;display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid var(--line)}
.menuBtn{display:none;width:34px;height:34px;border-radius:9px;font-size:17px;color:var(--muted)}
.menuBtn:hover{background:var(--side)}
.titlewrap{min-width:0;flex:1}
.titlewrap b{display:block;font:600 15px var(--serif);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.titlewrap span{display:block;font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oplink{font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:99px;padding:6px 12px;white-space:nowrap}
.oplink:hover{background:var(--side);color:var(--ink)}

.stage{flex:1;display:flex;flex-direction:column;min-height:0}
.hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px 8px;overflow-y:auto}
.herospace{width:min(760px,100%);display:flex;flex-direction:column;align-items:center;gap:26px;margin:auto}
.greet{display:flex;align-items:center;gap:14px}
.greet .gmark{width:40px;height:40px;color:var(--accent)}
.greet h2{font:500 32px/1.25 var(--serif);margin:0;letter-spacing:.01em}
.greet p{margin:2px 0 0;color:var(--muted);font-size:13.5px}
.suggests{display:grid;grid-template-columns:1fr 1fr;gap:10px;width:100%}
.sugcard{display:flex;align-items:center;gap:11px;text-align:left;border:1px solid var(--line);background:#fff;border-radius:14px;padding:13px 15px;font-size:13px;color:var(--ink2);transition:.15s;box-shadow:0 1px 3px rgba(60,52,35,.04)}
.sugcard:hover{border-color:#E0C6B8;background:var(--accent-soft)}
.sugcard .ico{width:32px;height:32px;border-radius:9px;background:var(--side);display:grid;place-items:center;font-size:15px;flex:none}

/* ---------- 对话线程 ---------- */
.thread{flex:1;min-height:0;overflow-y:auto;padding:30px 20px 12px}
.threadinner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:26px}
.msg-user{align-self:flex-end;max-width:82%;background:var(--side);border-radius:18px;padding:12px 17px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14.5px}
.msg-agent{display:flex;flex-direction:column;gap:9px;max-width:100%}
.agenthead{display:flex;align-items:center;gap:8px}
.agenthead .amark{width:22px;height:22px;border-radius:7px;background:var(--accent);color:#fff;display:grid;place-items:center;flex:none}
.agenthead .amark svg{width:13px;height:13px}
.agenthead small{color:var(--faint);font-size:11px}
.agentbody{overflow-wrap:anywhere;font-size:14.5px;color:var(--ink)}
.agentbody p{margin:0 0 11px}.agentbody p:last-child{margin-bottom:0}.agentbody h1,.agentbody h2,.agentbody h3{font-family:var(--serif);line-height:1.3;margin:16px 0 8px}.agentbody h1{font-size:23px}.agentbody h2{font-size:20px}.agentbody h3{font-size:17px}.agentbody ul,.agentbody ol{margin:7px 0 11px;padding-left:24px}.agentbody li{margin:3px 0}.agentbody blockquote{border-left:3px solid var(--line2);margin:10px 0;padding:3px 12px;color:var(--muted)}.agentbody code{background:#f1eee5;border-radius:4px;padding:2px 5px;font:12px var(--mono)}.agentbody pre{background:var(--code);color:var(--codeink);border-radius:10px;padding:12px 14px;overflow:auto;margin:10px 0}.agentbody pre code{background:transparent;padding:0;color:inherit;white-space:pre;font:12px/1.65 var(--mono)}.agentbody a{color:var(--accent);text-decoration:underline}
.reasoning{border:1px solid var(--line);border-radius:11px;background:#fff;overflow:hidden}
.reasoning summary{cursor:pointer;padding:8px 12px;color:var(--muted);font-size:12px;font-weight:600}
.reasoning pre{margin:0;padding:10px 13px;border-top:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);font:12px/1.7 var(--mono);max-height:280px;overflow:auto}
.thinking-select{border:1px solid var(--line2);border-radius:9px;background:var(--bg);padding:4px 7px;color:var(--muted);font-size:12px}
.agentbody.empty::before{content:"…";color:var(--faint)}
.thinking{display:inline-flex;align-items:center;gap:9px;color:var(--muted);font-size:13px}
.thinking .dotpulse{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.1)}}
.partial{background:var(--code);color:var(--codeink);border-radius:12px;padding:12px 14px;font:12px/1.7 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow-y:auto}
.runnote{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:99px;padding:3px 10px;font-size:11px;font-weight:700}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.queued{color:var(--warn);background:var(--warn-bg)}
.pill.running{color:var(--info);background:var(--info-bg)}
.pill.completed{color:var(--ok);background:var(--ok-bg)}
.pill.failed{color:var(--bad);background:var(--bad-bg)}
.pill.interrupted{color:var(--muted);background:var(--side)}
.runactions{display:flex;gap:8px;flex-wrap:wrap}
.mini{border:1px solid var(--line2);background:#fff;border-radius:9px;padding:6px 12px;font-size:12px;font-weight:600;color:var(--ink2);transition:.13s}
.mini:hover{background:var(--side)}
.mini.danger{color:var(--bad)}
.mini.danger:hover{background:var(--bad-bg);border-color:#E5C4B4}
.factrow{display:flex;gap:8px;flex-wrap:wrap}
.fact{border:1px solid var(--line);background:#fff;border-radius:11px;padding:8px 12px;font-size:12px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:.13s}
.fact:hover{background:var(--side)}
.fact .cnt{font-weight:800}
.fact .cnt.add{color:var(--ok)}.fact .cnt.mod{color:var(--warn)}.fact .cnt.del{color:var(--bad)}
.fact .ico{font-size:13px}
.diffbox,.eventbox{border:1px solid var(--line);border-radius:12px;background:#fff;overflow:hidden}
.diffbox .boxhead,.eventbox .boxhead{padding:9px 13px;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--faint);border-bottom:1px solid var(--line)}
.diffline{display:flex;align-items:center;gap:9px;padding:7px 13px;font:12px var(--mono);border-bottom:1px solid #F2F0E8}
.diffline:last-child{border-bottom:0}
.diffline .tag{flex:none;font-weight:800;font-size:10px;border-radius:5px;padding:2px 6px}
.tag.add{color:var(--ok);background:var(--ok-bg)}
.tag.mod{color:var(--warn);background:var(--warn-bg)}
.tag.del{color:var(--bad);background:var(--bad-bg)}
.diffline .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.eventline{display:flex;gap:10px;padding:6px 13px;font-size:11.5px;border-bottom:1px solid #F2F0E8}
.eventline:last-child{border-bottom:0}
.eventline b{color:var(--info);font-weight:700;flex:none}
.eventline span{color:var(--faint)}
.artifacts{display:flex;gap:8px;flex-wrap:wrap}
.artifact{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:7px 12px;font-size:12px;font-weight:600;color:var(--ink2)}
.artifact:hover{border-color:#E0C6B8;background:var(--accent-soft)}
.failednote{color:var(--bad);font-size:13px;background:var(--bad-bg);border-radius:10px;padding:9px 13px}
.daysep{display:flex;align-items:center;gap:12px;color:var(--faint);font-size:11px}
.daysep::before,.daysep::after{content:"";flex:1;height:1px;background:var(--line)}

/* ---------- 输入区 ---------- */
.composerzone{flex:none;padding:10px 20px 18px}
.composer{max-width:760px;margin:0 auto;background:#fff;border:1px solid var(--line2);border-radius:22px;
  box-shadow:0 8px 28px rgba(60,52,35,.07);padding:13px 15px 10px;transition:border-color .15s, box-shadow .15s}
.composer:focus-within{border-color:#D8AC97;box-shadow:0 8px 30px rgba(196,99,63,.12)}
.composer textarea{width:100%;border:0;outline:none;resize:none;background:transparent;max-height:180px;min-height:26px;font-size:14.5px;line-height:1.6}
.cfoot{display:flex;align-items:center;gap:10px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:99px;padding:5px 11px;font-size:11.5px;color:var(--muted);background:var(--bg)}
.chip b{color:var(--ink2);font-weight:600;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
.chiphint{font-size:11px;color:var(--faint)}
.cbtns{margin-left:auto;display:flex;gap:8px;align-items:center}
.sendbtn{width:36px;height:36px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;transition:.15s;box-shadow:0 3px 10px rgba(217,119,87,.3)}
.sendbtn:hover{background:var(--accent-h)}
.sendbtn:disabled{background:var(--line2);box-shadow:none;cursor:not-allowed}
.sendbtn svg{width:17px;height:17px}
.stopbtn{width:36px;height:36px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center}
.stopbtn:hover{background:#000}
.stopbtn i{width:10px;height:10px;background:#fff;border-radius:2px;display:block}
.disclaimer{max-width:760px;margin:9px auto 0;text-align:center;font-size:11px;color:var(--faint)}

/* ---------- 其它 ---------- */
.scrim{display:none}
.toast{position:fixed;top:18px;left:50%;transform:translate(-50%,-12px);background:var(--ink);color:#FAF9F5;
  padding:10px 18px;border-radius:12px;font-size:13px;box-shadow:0 10px 30px rgba(30,26,16,.25);opacity:0;pointer-events:none;transition:.22s;z-index:60;max-width:86vw}
.toast.on{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--bad)}

@media (max-width:860px){
  .app{grid-template-columns:1fr}
  .sidebar{position:fixed;inset:0 auto 0 0;width:280px;z-index:40;transform:translateX(-102%);transition:.22s;box-shadow:0 0 60px rgba(30,26,16,.18)}
  .sidebar.open{transform:none}
  .scrim{display:block;position:fixed;inset:0;background:rgba(35,30,20,.3);z-index:35;opacity:0;pointer-events:none;transition:.2s}
  .scrim.on{opacity:1;pointer-events:auto}
  .menuBtn{display:grid;place-items:center}
  .oplink span{display:none}
  .suggests{grid-template-columns:1fr}
  .greet h2{font-size:26px}
  .msg-user{max-width:92%}
  .chiphint{display:none}
}
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

<div id="toast" class="toast"></div>

<script>
var S = {
  token: localStorage.getItem('vh-user-token') || '',
  email: localStorage.getItem('vh-user-email') || '',
  demo: localStorage.getItem('vh-user-demo') === '1',
  workspaces: [],
  conversations: [],
  conversationId: null,
  conversation: null,
  runs: [],
  outputs: {}, thinking: {}, outputStatuses: {}, diffs: {}, artifacts: {}, events: {}, expanded: {},
  queue: [],
  pollTimer: null, activeRunId: null, suggestion: ''
};
var $ = function(id){ return document.getElementById(id); };
var ACTIVE = ['QUEUED','RUNNING','WAITING_TOOL'];
var TERMINAL = ['COMPLETED','FAILED','INTERRUPTED'];
var STATUS_ZH = { QUEUED:'排队中', RUNNING:'运行中', WAITING_TOOL:'调用工具', COMPLETED:'已完成', FAILED:'失败', INTERRUPTED:'已中断' };
var SUGGESTIONS = [
  { ico:'🧪', text:'检查项目中的测试失败原因，修复后运行测试并总结变更。' },
  { ico:'📐', text:'阅读这个 Workspace 的代码结构，输出一份简明架构说明。' },
  { ico:'🧱', text:'为核心模块补充单元测试，运行并汇报覆盖情况。' },
  { ico:'🚀', text:'排查当前实现的性能问题，给出可执行的优化建议。' }
];

function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function markdown(v){
  var lines = String(v == null ? '' : v).replace(/\r\n?/g,'\n').split('\n'), out = [], para = [], fenced = false, code = [];
  function flush(){ if(para.length){ out.push('<p>' + inlineMd(para.join('<br>')) + '</p>'); para=[]; } }
  lines.forEach(function(raw){
    if(/^\s*\`\`\`/.test(raw)){ if(fenced){ out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code=[]; fenced=false; } else { flush(); fenced=true; } return; }
    if(fenced){ code.push(raw); return; }
    var line = esc(raw), m;
    if(!line.trim()){ flush(); return; }
    if((m=line.match(/^###\s+(.+)$/))){ flush(); out.push('<h3>' + inlineMd(m[1]) + '</h3>'); return; }
    if((m=line.match(/^##\s+(.+)$/))){ flush(); out.push('<h2>' + inlineMd(m[1]) + '</h2>'); return; }
    if((m=line.match(/^#\s+(.+)$/))){ flush(); out.push('<h1>' + inlineMd(m[1]) + '</h1>'); return; }
    if((m=line.match(/^\s*[-*]\s+(.+)$/))){ flush(); out.push('<ul><li>' + inlineMd(m[1]) + '</li></ul>'); return; }
    if((m=line.match(/^\s*\d+\.\s+(.+)$/))){ flush(); out.push('<ol><li>' + inlineMd(m[1]) + '</li></ol>'); return; }
    if((m=line.match(/^\s*&gt;\s?(.+)$/))){ flush(); out.push('<blockquote>' + inlineMd(m[1]) + '</blockquote>'); return; }
    if(/^\s*([-*_])(?:\s*\\1){2,}\s*$/.test(raw)){ flush(); out.push('<hr>'); return; }
    para.push(line);
  });
  if(fenced) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flush();
  return out.join('');
}
function inlineMd(s){
  return s.replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/__([^_]+)__/g,'<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g,'$1<em>$2</em>')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g,'$1<em>$2</em>');
}
function toast(msg, bad){
  var t = $('toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(t._tm); t._tm = setTimeout(function(){ t.className = 'toast'; }, 2800);
}
function shortAge(iso){
  if(!iso) return '';
  var ms = Date.now() - Date.parse(iso);
  if(isNaN(ms)) return '';
  if(ms < 60000) return '刚刚';
  if(ms < 3600000) return Math.round(ms/60000) + ' 分钟前';
  if(ms < 86400000) return Math.round(ms/3600000) + ' 小时前';
  return Math.round(ms/86400000) + ' 天前';
}
function fmtTime(iso){
  if(!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch(e){ return iso; }
}
function autoGrow(){
  var ta = $('input'); ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
}

/* ---------- API ---------- */
function api(path, opts){
  opts = opts || {};
  var headers = opts.headers || {};
  if(S.token) headers['authorization'] = 'Bearer ' + S.token;
  if(opts.body !== undefined && opts.body !== null && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body == null ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) })
    .then(function(res){
      return res.json().catch(function(){ return { error:'服务返回了非 JSON 内容' }; }).then(function(body){
        if(!res.ok){
          if(res.status === 401 && !S.demo){ logout(); }
          var err = new Error(body && body.error ? body.error : ('HTTP ' + res.status));
          err.status = res.status; throw err;
        }
        return body;
      });
    });
}

/* ---------- 登录 ---------- */
var authMode = 'login';
function setAuthMode(mode){
  authMode = mode;
  $('tabLogin').className = mode === 'login' ? 'on' : '';
  $('tabRegister').className = mode === 'register' ? 'on' : '';
  $('authSubmit').textContent = mode === 'login' ? '登录' : '注册并进入';
  $('authError').textContent = '';
}
function showAuth(){
  $('auth').classList.remove('hidden'); $('app').classList.add('hidden');
  if(S.email) $('authEmail').value = S.email;
}
function logout(){
  var token = S.token;
  S.token = ''; S.demo = false;
  localStorage.removeItem('vh-user-token'); localStorage.removeItem('vh-user-email'); localStorage.removeItem('vh-user-demo');
  if(token && !S.demo) fetch('/auth/logout', { method:'POST', headers:{ 'authorization':'Bearer ' + token } }).catch(function(){});
  stopPoll(); showAuth();
}
function enterApp(){
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('userEmail').textContent = S.demo ? '本地模式' : (S.email || '已连接');
  $('userInitial').textContent = (S.demo ? 'L' : (S.email || 'U').charAt(0).toUpperCase());
  $('modeTag').textContent = S.demo ? '未认证（legacy principal）' : '会话登录 · 7 天有效';
  $('modeHint').textContent = S.demo ? '本地模式：请求不带凭证' : '';
  loadWorkspaces().then(renderSuggests).catch(function(e){ toast(e.message, true); });
}
function doAuthLogin(){
  var email = $('authEmail').value.trim(), password = $('authPassword').value;
  if(!email || !password){ $('authError').textContent = '请填写邮箱和密码'; return; }
  $('authError').textContent = '';
  var path = authMode === 'login' ? '/auth/login' : '/auth/register';
  api(path, { method:'POST', body:{ email: email, password: password } }).then(function(body){
    if(authMode === 'register'){ return api('/auth/login', { method:'POST', body:{ email: email, password: password } }); }
    return body;
  }).then(function(body){
    S.token = body.token; S.email = email; S.demo = false;
    localStorage.setItem('vh-user-token', S.token);
    localStorage.setItem('vh-user-email', S.email);
    localStorage.removeItem('vh-user-demo');
    enterApp();
  }).catch(function(e){
    if(e.status === 503 || /未启用/.test(e.message)){ $('demoEntry').classList.remove('hidden'); }
    $('authError').textContent = e.message;
  });
}
function doKeyLogin(){
  var key = $('authApiKey').value.trim();
  if(!key){ $('authError').textContent = '请输入 API Key'; return; }
  var prev = S.token; S.token = key;
  api('/workspaces').then(function(){
    S.demo = false; S.email = '';
    localStorage.setItem('vh-user-token', key); localStorage.setItem('vh-user-demo', '0');
    localStorage.removeItem('vh-user-email');
    enterApp();
  }).catch(function(e){
    S.token = prev; $('authError').textContent = 'API Key 无效：' + e.message;
  });
}
function doDemoLogin(){
  S.token = ''; S.demo = true; S.email = '';
  localStorage.setItem('vh-user-demo', '1');
  localStorage.removeItem('vh-user-token'); localStorage.removeItem('vh-user-email');
  enterApp();
}

/* ---------- 数据加载 ---------- */
function loadWorkspaces(){
  return api('/workspaces').then(function(body){
    S.workspaces = body.workspaces || [];
    var sel = $('workspaceSel');
    var current = sel.value;
    var signature = S.workspaces.map(function(w){ return w.id + ':' + w.name; }).join('|');
    if(signature !== sel.dataset.sig){
      sel.dataset.sig = signature;
      sel.innerHTML = S.workspaces.length
        ? S.workspaces.map(function(w){ return '<option value="' + esc(w.id) + '">' + esc(w.name) + '</option>'; }).join('')
        : '<option value="">暂无 Workspace</option>';
    }
    var wanted = current || S.workspaces.length && S.workspaces[0].id || '';
    if(wanted && S.workspaces.some(function(w){ return w.id === wanted; })) sel.value = wanted;
    updateWsChip();
    if(sel.value) return loadConversations();
  });
}
function loadConversations(){
  var wsId = $('workspaceSel').value;
  if(!wsId){ S.conversations = []; renderConversations(); return Promise.resolve(); }
  return api('/workspaces/' + encodeURIComponent(wsId) + '/conversations').then(function(body){
    S.conversations = (body.conversations || []).slice().sort(function(a,b){ return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    renderConversations();
  });
}
function updateWsChip(){
  var ws = S.workspaces.find(function(w){ return w.id === $('workspaceSel').value; });
  $('wsChip').textContent = ws ? ws.name : '未选择 Workspace';
}
function openConversation(id, pushState){
  S.conversationId = id;
  S.outputs = {}; S.thinking = {}; S.outputStatuses = {}; S.diffs = {}; S.artifacts = {}; S.events = {}; S.expanded = {}; S.queue = [];
  $('hero').classList.add('hidden'); $('suggestZone').classList.add('hidden'); $('thread').classList.remove('hidden');
  renderConversations();
  return refreshConversation(true).then(function(){
    if(pushState !== false && history.replaceState) history.replaceState(null, '', '#c=' + encodeURIComponent(id));
    void loadConversations().catch(function(){});
    schedulePoll();
  }).catch(function(e){ toast(e.message, true); });
}
function refreshConversation(withOutputs){
  if(!S.conversationId) return Promise.resolve();
  return api('/conversations/' + encodeURIComponent(S.conversationId)).then(function(body){
    S.conversation = body.conversation || null;
    S.runs = (body.runs || []).slice().sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); });
    $('convTitle').textContent = S.conversation ? S.conversation.title : '对话';
    var ws = S.workspaces.find(function(w){ return w.id === (S.conversation && S.conversation.workspaceId); });
    $('convSub').textContent = ws ? ('Workspace · ' + ws.name) : '';
    var active = S.runs.filter(function(r){ return ACTIVE.indexOf(r.status) >= 0; });
    S.activeRunId = active.length ? active[active.length - 1].id : null;
    var chain = Promise.all(S.runs.map(function(r){
      var isActive = ACTIVE.indexOf(r.status) >= 0;
      var statusChanged = S.outputStatuses[r.id] !== r.status;
      if(isActive || withOutputs || statusChanged) {
        return loadOutput(r.id, isActive || statusChanged).then(function(){ S.outputStatuses[r.id] = r.status; }).catch(function(){ return null; });
      }
      return Promise.resolve();
    }));
    return chain.then(function(){
      var last = S.runs[S.runs.length - 1];
      var ready = last && last.status === 'COMPLETED' && S.diffs[last.id] === undefined ? loadFacts(last.id) : Promise.resolve();
      return ready.then(function(){ renderThread(); schedulePoll(); });
    });
  });
}
function loadOutput(runId, force){
  if(!force && S.outputs[runId] !== undefined) return Promise.resolve();
  return api('/runs/' + encodeURIComponent(runId) + '/output').then(function(body){
    S.outputs[runId] = body.finalText || '';
    S.thinking[runId] = body.thinkingText || '';
  });
}
function loadFacts(runId){
  return Promise.all([
    api('/runs/' + encodeURIComponent(runId) + '/workspace-diff').catch(function(){ return null; }),
    api('/runs/' + encodeURIComponent(runId) + '/artifacts').catch(function(){ return null; })
  ]).then(function(results){
    S.diffs[runId] = results[0] && results[0].diff ? results[0].diff : { added:[], modified:[], deleted:[] };
    S.artifacts[runId] = results[1] && results[1].artifacts ? results[1].artifacts : [];
  });
}
function loadEvents(runId){
  if(S.events[runId]) return Promise.resolve();
  return api('/runs/' + encodeURIComponent(runId) + '/events').then(function(body){
    S.events[runId] = body.events || [];
    renderThread();
  }).catch(function(e){ toast(e.message, true); });
}
function refreshQueue(){
  return api('/queue').then(function(body){ S.queue = body.queue || []; renderThread(); }).catch(function(){ S.queue = []; });
}

/* ---------- 发送 / 控制 ---------- */
function sendMessage(text){
  var input = $('input');
  var value = (text != null ? text : input.value).trim();
  if(!value) return;
  var wsId = $('workspaceSel').value;
  if(!wsId){ toast('请先选择或创建一个 Workspace', true); return; }
  var ensure = S.conversationId
    ? Promise.resolve(S.conversationId)
    : api('/workspaces/' + encodeURIComponent(wsId) + '/conversations', { method:'POST', body:{ title: value.slice(0, 48) } })
      .then(function(body){ return body.conversation.id; });
  ensure.then(function(conversationId){
    return api('/conversations/' + encodeURIComponent(conversationId) + '/messages', { method:'POST', body:{ userInput: value, thinkingLevel: $('thinkingLevel').value } })
      .then(function(body){
        input.value = ''; autoGrow();
        return openConversation(conversationId, true);
      });
  }).catch(function(e){ toast(e.message, true); });
}
function interruptRun(runId){
  api('/runs/' + encodeURIComponent(runId) + '/interrupt', { method:'POST', body:{} })
    .then(function(){ toast('已发送中断请求'); return refreshConversation(false); })
    .catch(function(e){ toast(e.message, true); });
}
function resumeRun(runId){
  api('/runs/' + encodeURIComponent(runId) + '/resume', { method:'POST', body:{} })
    .then(function(){ toast('恢复任务已进入队列'); return refreshConversation(false); })
    .catch(function(e){ toast(e.message, true); });
}
function createWorkspace(){
  var name = window.prompt('Workspace 名称（例如 my-project）');
  if(!name || !name.trim()) return;
  api('/workspaces', { method:'POST', body:{ name: name.trim() } }).then(function(body){
    toast('Workspace 已创建：' + body.workspace.name);
    return loadWorkspaces();
  }).then(function(){
    // loadWorkspaces 已刷新列表
  }).catch(function(e){ toast(e.message, true); });
}
function downloadArtifact(runId, path){
  api('/runs/' + encodeURIComponent(runId) + '/artifacts/' + encodeURIComponent(path))
    .then(function(buf){
      var blob = new Blob([buf]);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = path.split('/').pop() || 'artifact';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    }).catch(function(e){ toast(e.message, true); });
}

/* ---------- 轮询 ---------- */
function schedulePoll(){
  stopPoll();
  if(!S.conversationId) return;
  var hasActive = S.runs.some(function(r){ return ACTIVE.indexOf(r.status) >= 0; });
  if(!hasActive) return;
  S.pollTimer = setInterval(function(){
    if(document.hidden) return;
    refreshConversation(false).catch(function(){ /* 网络抖动忽略，下个周期重试 */ });
    refreshQueue();
  }, 1600);
  refreshQueue();
}
function stopPoll(){
  if(S.pollTimer){ clearInterval(S.pollTimer); S.pollTimer = null; }
}

/* ---------- 渲染 ---------- */
function renderSuggests(){
  $('suggests').innerHTML = SUGGESTIONS.map(function(s){
    return '<button class="sugcard" type="button" data-sug="' + esc(s.text) + '"><span class="ico">' + s.ico + '</span><span>' + esc(s.text) + '</span></button>';
  }).join('');
  var h = new Date().getHours();
  var word = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
  $('greetText').textContent = word + (S.email ? '，' + S.email.split('@')[0] : '');
}
function renderConversations(){
  var list = $('convList');
  if(!S.conversations.length){
    list.innerHTML = '<div class="convempty">这个 Workspace 还没有对话。<br>点击「新对话」或直接在下方输入任务。</div>';
    return;
  }
  list.innerHTML = S.conversations.map(function(c){
    return '<button class="convitem' + (c.id === S.conversationId ? ' on' : '') + '" data-conv="' + esc(c.id) + '" type="button">'
      + '<b>' + esc(c.title) + '</b><span>' + esc(shortAge(c.updatedAt) || fmtTime(c.createdAt)) + '</span></button>';
  }).join('');
}
function runFactsHtml(run){
  var diff = S.diffs[run.id], arts = S.artifacts[run.id] || [];
  if(!diff && !arts.length) return '';
  var add = diff ? (diff.added || []).length : 0, mod = diff ? (diff.modified || []).length : 0, del = diff ? (diff.deleted || []).length : 0;
  var html = '';
  if(diff){
    var open = !!S.expanded[run.id];
    html += '<div class="factrow">'
      + '<button class="fact" data-act="diff" data-run="' + esc(run.id) + '" type="button"><span class="ico">🗂</span>文件变更'
      + ' <span class="cnt add">+' + add + '</span><span class="cnt mod">~' + mod + '</span><span class="cnt del">-' + del + '</span></button>'
      + '</div>';
    if(open){
      var lines = []
        .concat((diff.added || []).map(function(f){ return '<div class="diffline"><span class="tag add">新增</span><span class="path">' + esc(f.path || f) + '</span></div>'; }))
        .concat((diff.modified || []).map(function(f){ return '<div class="diffline"><span class="tag mod">修改</span><span class="path">' + esc(f.path || f) + '</span></div>'; }))
        .concat((diff.deleted || []).map(function(f){ return '<div class="diffline"><span class="tag del">删除</span><span class="path">' + esc(f.path || f) + '</span></div>'; }));
      html += '<div class="diffbox"><div class="boxhead">WORKSPACE DIFF · 只包含路径、哈希与大小</div>'
        + (lines.length ? lines.join('') : '<div class="diffline"><span>没有文件改动</span></div>') + '</div>';
    }
  }
  if(arts.length){
    html += '<div class="artifacts">' + arts.map(function(a){
      return '<button class="artifact" data-act="artifact" data-run="' + esc(run.id) + '" data-path="' + esc(a.path) + '" type="button">📎 ' + esc(a.path.split('/').pop()) + '</button>';
    }).join('') + '</div>';
  }
  return html;
}
function eventsHtml(run){
  var evs = S.events[run.id];
  var open = !!S.expanded['ev:' + run.id];
  var head = '<button class="fact" data-act="events" data-run="' + esc(run.id) + '" type="button"><span class="ico">⏱</span>执行过程' + (evs ? ' · ' + evs.length + ' 个事件' : '') + '</button>';
  if(!open) return '<div class="factrow">' + head + '</div>';
  var lines = (evs || []).map(function(e){
    return '<div class="eventline"><b>#' + esc(e.sequence) + ' ' + esc(e.type) + '</b><span>' + esc(fmtTime(e.timestamp)) + '</span></div>';
  }).join('');
  return '<div class="factrow">' + head + '</div><div class="eventbox">'
    + (lines || '<div class="eventline"><span>暂无事件</span></div>') + '</div>';
}
function agentMessageHtml(run, isLast){
  var status = run.status;
  var parts = [];
  var head = '<div class="agenthead"><span class="amark"><svg viewBox="0 0 24 24" fill="none"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="2.2" x2="12" y2="7.4"/><line x1="12" y1="16.6" x2="12" y2="21.8"/><line x1="2.2" y1="12" x2="7.4" y2="12"/><line x1="16.6" y1="12" x2="21.8" y2="12"/><line x1="5.1" y1="5.1" x2="8.7" y2="8.7"/><line x1="15.3" y1="15.3" x2="18.9" y2="18.9"/><line x1="5.1" y1="18.9" x2="8.7" y2="15.3"/><line x1="15.3" y1="8.7" x2="18.9" y2="5.1"/></g></svg></span>'
    + '<small>Agent · ' + esc(fmtTime(run.createdAt)) + '</small></div>';
  parts.push(head);

  if(status === 'QUEUED'){
    var entry = S.queue.find(function(q){ return q.runId === run.id; });
    parts.push('<div class="thinking"><span class="dotpulse"></span>排队等待资源'
      + (entry ? ' · 全局位置 ' + esc(entry.position) + ' · ' + esc(entry.reasonCode) : '')
      + '</div>');
  } else if(status === 'RUNNING' || status === 'WAITING_TOOL'){
    parts.push('<div class="thinking"><span class="dotpulse"></span>' + (status === 'RUNNING' ? 'Agent 正在执行任务' : '正在调用工具并记账副作用') + '</div>');
    var liveThinking = S.thinking[run.id] || '';
    if(liveThinking) parts.push('<details class="reasoning"><summary>思考过程（实时）</summary><pre>' + esc(liveThinking) + '</pre></details>');
    var partial = S.outputs[run.id];
    if(partial) parts.push('<div class="partial">' + esc(partial) + '</div>');
  } else if(status === 'INTERRUPTED'){
    parts.push('<div class="runnote"><span class="pill interrupted">已中断</span>'
      + (run.checkpointId ? '已保存 Checkpoint，可从恢复点继续。' : '任务在安全边界停止。') + '</div>');
  } else if(status === 'FAILED'){
    parts.push('<div class="failednote">任务失败：' + esc(run.failureReason || '未知原因') + '</div>');
  } else if(status === 'COMPLETED'){
    var text = S.outputs[run.id];
    var thinking = S.thinking[run.id] || '';
    if(thinking) parts.push('<details class="reasoning"><summary>思考过程（点击展开）</summary><pre>' + esc(thinking) + '</pre></details>');
    parts.push('<div class="agentbody' + (text ? '' : ' empty') + '">' + markdown(text || '') + '</div>');
    if(isLast || S.diffs[run.id] !== undefined) parts.push(runFactsHtml(run));
    else parts.push('<div class="factrow"><button class="fact" data-act="loadfacts" data-run="' + esc(run.id) + '" type="button"><span class="ico">🗂</span>查看文件变更与产物</button></div>');
    parts.push(eventsHtml(run));
  }

  if(ACTIVE.indexOf(status) >= 0 || status === 'INTERRUPTED'){
    var acts = '';
    if(ACTIVE.indexOf(status) >= 0) acts += '<button class="mini danger" data-act="stop" data-run="' + esc(run.id) + '" type="button">■ 中断任务</button>';
    if(status === 'INTERRUPTED' && run.checkpointId) acts += '<button class="mini" data-act="resume" data-run="' + esc(run.id) + '" type="button">↻ 从 Checkpoint 恢复</button>';
    if(acts) parts.push('<div class="runactions">' + acts + '</div>');
  }
  return '<div class="msg-agent">' + parts.join('') + '</div>';
}
function renderThread(){
  if(!S.conversationId) return;
  var inner = $('threadInner');
  var nearBottom = inner.scrollHeight - inner.scrollTop - inner.clientHeight < 160;
  var html = '';
  S.runs.forEach(function(run, i){
    html += '<div class="msg-user">' + esc(run.userInput) + '</div>';
    html += agentMessageHtml(run, i === S.runs.length - 1);
  });
  inner.innerHTML = html || '<div class="daysep">对话开始</div>';
  var stop = $('stopBtn'), send = $('sendBtn');
  var isActive = S.runs.some(function(r){ return ACTIVE.indexOf(r.status) >= 0; });
  stop.classList.toggle('hidden', !isActive);
  send.classList.toggle('hidden', isActive);
  if(nearBottom){ $('thread').scrollTop = $('thread').scrollHeight; }
}
function showHeroMode(){
  S.conversationId = null; S.conversation = null; S.runs = [];
  stopPoll();
  $('hero').classList.remove('hidden'); $('suggestZone').classList.remove('hidden'); $('thread').classList.add('hidden');
  $('convTitle').textContent = '新对话'; $('convSub').textContent = '选择一个 Workspace，输入任务即可开始';
  renderConversations();
  if(history.replaceState) history.replaceState(null, '', location.pathname);
}

/* ---------- 事件绑定 ---------- */
$('tabLogin').onclick = function(){ setAuthMode('login'); };
$('tabRegister').onclick = function(){ setAuthMode('register'); };
$('authSubmit').onclick = doAuthLogin;
$('keySubmit').onclick = doKeyLogin;
$('demoSubmit').onclick = doDemoLogin;
$('authPassword').onkeydown = function(e){ if(e.key === 'Enter') doAuthLogin(); };
$('authApiKey').onkeydown = function(e){ if(e.key === 'Enter') doKeyLogin(); };
$('logoutBtn').onclick = logout;

$('workspaceSel').onchange = function(){
  updateWsChip();
  S.conversationId = null;
  loadConversations().then(showHeroMode).catch(function(e){ toast(e.message, true); });
};
// 在其它入口（如运营台）创建的 Workspace，点击选择器时自动重新拉取。
$('workspaceSel').onmousedown = function(){ loadWorkspaces().catch(function(){}); };
$('addWorkspace').onclick = createWorkspace;
$('newChat').onclick = function(){
  if(!$('workspaceSel').value){ toast('请先创建一个 Workspace', true); return; }
  showHeroMode();
  $('input').focus();
};
$('menuBtn').onclick = function(){ $('sidebar').classList.toggle('open'); $('scrim').classList.toggle('on'); };
$('scrim').onclick = function(){ $('sidebar').classList.remove('open'); $('scrim').classList.remove('on'); };
$('convList').onclick = function(e){
  var btn = e.target.closest('[data-conv]');
  if(!btn) return;
  $('sidebar').classList.remove('open'); $('scrim').classList.remove('on');
  openConversation(btn.getAttribute('data-conv'));
};
$('suggests').onclick = function(e){
  var btn = e.target.closest('[data-sug]');
  if(!btn) return;
  $('input').value = btn.getAttribute('data-sug'); autoGrow(); $('input').focus();
};
$('sendBtn').onclick = function(){ sendMessage(); };
$('stopBtn').onclick = function(){
  var active = S.runs.filter(function(r){ return ACTIVE.indexOf(r.status) >= 0; });
  if(active.length) interruptRun(active[active.length - 1].id);
};
$('input').onkeydown = function(e){
  if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }
};
$('input').oninput = autoGrow;
$('thread').onclick = function(e){
  var btn = e.target.closest('[data-act]');
  if(!btn) return;
  var act = btn.getAttribute('data-act'), runId = btn.getAttribute('data-run');
  if(act === 'stop') interruptRun(runId);
  else if(act === 'resume') resumeRun(runId);
  else if(act === 'diff'){ S.expanded[runId] = !S.expanded[runId]; renderThread(); }
  else if(act === 'events'){ S.expanded['ev:' + runId] = !S.expanded['ev:' + runId]; if(S.expanded['ev:' + runId]) loadEvents(runId); else renderThread(); }
  else if(act === 'loadfacts'){ loadFacts(runId).then(renderThread).catch(function(err){ toast(err.message, true); }); }
  else if(act === 'artifact') downloadArtifact(runId, btn.getAttribute('data-path'));
};

/* ---------- 启动 ---------- */
(function init(){
  renderSuggests();
  var hash = new URLSearchParams(location.hash.slice(1));
  var conv = hash.get('c');
  if(S.token || S.demo){
    enterApp();
    loadWorkspaces().then(function(){
      if(conv) return openConversation(conv);
    }).catch(function(){ /* enterApp 已提示 */ });
  } else {
    showAuth();
  }
})();
</script></body></html>`;
