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

const USER_CONSOLE_CLIENT_JS = readFileSync(new URL("./user-console-client.js", import.meta.url), "utf8");

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

/* N25：断网/请求失败时页面必须有可见的降级提示。修复前轮询错误被静默吞掉，
   界面既没有错误也没有离线提示，还持续把过期状态当作最新状态展示。 */
.netbanner{position:fixed;top:0;left:0;right:0;background:var(--warn);color:#FFFDF8;
  font-size:12.5px;line-height:1.5;text-align:center;padding:7px 14px;
  transform:translateY(-102%);transition:transform .22s;z-index:70}
.netbanner.on{transform:none}
.netbanner .nbdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#FFE7B8;
  margin-right:7px;vertical-align:1px;animation:nbpulse 1.2s ease-in-out infinite}
@keyframes nbpulse{0%,100%{opacity:.35}50%{opacity:1}}

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

<div id="netBanner" class="netbanner" role="status" aria-live="polite"></div>
<div id="toast" class="toast"></div>

<script>
${USER_CONSOLE_CLIENT_JS}
</script></body></html>`;
