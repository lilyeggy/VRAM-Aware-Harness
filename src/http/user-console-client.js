
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
  pollTimer: null, activeRunId: null, suggestion: '', sending: false,
  /* N22：会话刷新请求序号。迟到的响应必须靠它识别并丢弃。 */
  refreshSeq: 0,
  /* N25：连续网络失败次数；用于把"静默重试"变成可见的降级提示。 */
  netFails: 0, netDown: false
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
    if(/^\s*```/.test(raw)){ if(fenced){ out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code=[]; fenced=false; } else { flush(); fenced=true; } return; }
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
  return s.replace(/`([^`]+)`/g,'<code>$1</code>')
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
/* N25：网络层健康度。修复前轮询失败被 `.catch(function(){})` 静默吞掉，
   用户看到的是一份过期状态却毫不知情。这里把「连不上」变成页面上可见、
   可恢复的状态，而不是让界面继续假装一切正常。 */
function isNetworkError(err){
  // fetch 本身失败（断网/DNS/连接被拒）抛的是 TypeError，没有我们附加的 status；
  // HTTP 4xx/5xx 是我们自己构造并带 status 的 Error。
  return !(err && typeof err.status === 'number');
}
function noteNetFail(){
  S.netFails += 1;
  if(!S.netDown) S.netDownSince = Date.now();
  var msg = navigator.onLine === false
    ? '当前设备已离线。'
    : '无法连接服务，正在重试。';
  showNetBanner(msg + '页面显示的是最后一次成功获取的状态，可能已过期（已失败 ' + S.netFails + ' 次）。');
}
function noteNetOk(){
  var wasDown = S.netDown;
  var downMs = wasDown && S.netDownSince ? Date.now() - S.netDownSince : 0;
  S.netFails = 0;
  if(!wasDown) return;
  S.netDown = false;
  hideNetBanner();
  // 只有真正持续了一小段时间的中断才提示"已恢复"；否则抖动一次就弹一次，
  // 横幅会来回跳、提示会刷屏，反而变成噪音。
  if(downMs >= 3000) toast('已恢复连接，正在同步最新状态');
  // 立刻补一次刷新，避免用户盯着断网期间的旧数据继续操作。
  if(S.conversationId) refreshConversation(false).catch(function(){});
  refreshQueue();
}
function showNetBanner(text){
  var el = $('netBanner');
  if(!el) return;
  S.netDown = true;
  el.innerHTML = '<span class="nbdot"></span>' + esc(text);
  el.classList.add('on');
}
function hideNetBanner(){
  var el = $('netBanner');
  if(el) el.classList.remove('on');
}
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
    })
    .then(function(body){ noteNetOk(); return body; },
      function(err){
        if(isNetworkError(err)) noteNetFail();
        throw err;
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
  stopPoll();
  // N25：登出后不得留下"断网中"的横幅，否则重新登录会看到过期提示。
  S.netFails = 0; S.netDown = false; hideNetBanner();
  showAuth();
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
  // N22：切对话时立刻停掉旧轮询。原先要等 refreshConversation 完成才重排定时器，
  // 这段窗口里旧的定时器仍会触发，而它的响应又会无条件写回全局状态。
  stopPoll();
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
  var requestedId = S.conversationId;
  if(!requestedId) return Promise.resolve();
  // N22：本次刷新的序号。轮询每 1600ms 一次，内部还有 loadOutput/loadFacts
  // 链式请求，响应窗口可达数百 ms 到数秒；期间用户完全可能切到别的对话
  // （或被 interrupt/resume 触发一次新刷新）。
  //
  // 修复前没有任何守卫：迟到的响应会直接覆盖 S.conversation / S.runs /
  // convTitle 并重渲染，于是"状态是对话 B、页面显示 A 的标题和消息"，
  // 用户在正文里点中断/恢复还可能作用到错误对象（真机 U04 实证）。
  //
  // 判据用两条：① 响应所属对话仍是当前对话；② 它是**最新**的一次刷新。
  // 只有 ① 不足以覆盖 A→B→A 的快速切换（旧 A 的响应迟到时 id 恰好又对上了）。
  var seq = ++S.refreshSeq;
  return api('/conversations/' + encodeURIComponent(requestedId)).then(function(body){
    if(requestedId !== S.conversationId || seq !== S.refreshSeq) return;
    var responseId = body.conversation && body.conversation.id;
    if(responseId !== undefined && responseId !== requestedId) return;
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
      // 链式请求同样可能跨过切换窗口，渲染前必须再确认一次。
      if(requestedId !== S.conversationId || seq !== S.refreshSeq) return;
      var last = S.runs[S.runs.length - 1];
      var ready = last && last.status === 'COMPLETED' && S.diffs[last.id] === undefined ? loadFacts(last.id) : Promise.resolve();
      return ready.then(function(){
        if(requestedId !== S.conversationId || seq !== S.refreshSeq) return;
        renderThread(); schedulePoll();
      });
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
  // N25：拉取失败时保留上一次的队列，**不要清空**。原实现在失败分支里把队列
  // 直接置空，一次网络抖动就会把"排队中"的任务显示成不在队列里 —— 那是用错误
  // 数据冒充最新状态。连接问题改由顶部横幅统一呈现。
  return api('/queue').then(function(body){ S.queue = body.queue || []; renderThread(); })
    .catch(function(){ /* 保留上次已知队列；可见性由 netBanner 负责 */ });
}

/* ---------- 发送 / 控制 ---------- */
function sendMessage(text){
  var input = $('input');
  // N7：在途提交完成前忽略后续触发，避免连点"发送"/连按 Enter 造出重复任务。
  if(S.sending) return;
  var value = (text != null ? text : input.value).trim();
  if(!value) return;
  var wsId = $('workspaceSel').value;
  if(!wsId){ toast('请先选择或创建一个 Workspace', true); return; }
  S.sending = true;
  setSendBusy(true);
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
  }).catch(function(e){ toast(e.message, true); })
    .then(function(){ S.sending = false; setSendBusy(false); });
}
function setSendBusy(busy){
  var btn = $('sendBtn');
  if(!btn) return;
  btn.disabled = !!busy;
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
    // N25：这里的异常仍然照旧吞掉（下一个周期重试是对的），但失败**不再无声**——
    // api() 会累计失败次数并点亮顶部降级横幅，用户能看见"数据可能已过期"。
    refreshConversation(false).catch(function(){});
    refreshQueue();
  }, 1600);
  refreshQueue();
}
function stopPoll(){
  if(S.pollTimer){ clearInterval(S.pollTimer); S.pollTimer = null; }
}
/* N25：浏览器离线/恢复立刻反映到横幅，不必等下一次轮询超时。 */
window.addEventListener('offline', function(){
  showNetBanner('当前设备已离线。页面显示的是最后一次成功获取的状态，可能已过期。');
});
window.addEventListener('online', function(){
  // 交给下一次真实请求确认是否真的恢复（online 事件不代表服务可达）。
  if(S.conversationId) refreshConversation(false).catch(function(){});
  refreshQueue();
});

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
