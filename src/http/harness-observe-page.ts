/**
 * 方向 B：观测驾驶舱页面（专业 SaaS 风格，含多租户维度）。
 *
 * 自包含只读观测视图（独立页 /observe，不影响任务操作台 /）：
 * - 顶部多租户切换（全部 / 各租户），数据来自 GET /eval（支持 ?tenant=）；
 * - 执行质量 / 完成度 / 工具副作用治理 / 资源准入背压 / 任务明细；
 * - 3s 自动刷新，呈现「可度量 + 可看见」的多租户执行控制面。
 */

const OBSERVE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>观测驾驶舱 · VRAM-Aware Harness</title><style>
:root{
  --bg:#f5f6f8; --card:#ffffff; --line:#e6e8eb; --line2:#eef0f3;
  --txt:#101828; --dim:#667085; --faint:#98a2b3;
  --accent:#4f46e5; --accent2:#7c9eff;
  --ok:#12b76a; --okbg:#ecfdf3; --warn:#f79009; --warnbg:#fffaeb; --bad:#f04438; --badbg:#fef3f2; --info:#2e90fa; --infobg:#eff8ff;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Inter","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
nav{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;box-shadow:var(--shadow)}
.t1{font-weight:700;font-size:15px;letter-spacing:-.01em}.t2{font-size:12px;color:var(--dim)}
.navright{display:flex;align-items:center;gap:14px}
.segwrap{display:flex;background:#eaecf0;border-radius:9px;padding:3px;gap:2px;max-width:46vw;overflow:auto}
.seg{border:0;background:transparent;color:var(--dim);font:inherit;font-size:13px;padding:6px 14px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:all .15s}
.seg:hover{color:var(--txt)}
.seg.on{background:#fff;color:var(--txt);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.12)}
.live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(18,183,106,.5);animation:pl 2s infinite}
@keyframes pl{0%{box-shadow:0 0 0 0 rgba(18,183,106,.4)}70%{box-shadow:0 0 0 7px rgba(18,183,106,0)}100%{box-shadow:0 0 0 0 rgba(18,183,106,0)}}
main{max-width:1180px;margin:0 auto;padding:26px 28px 60px}
.pagehead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0}
.meta{font-size:13px;color:var(--dim)}
h2{font-size:12px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.1em;margin:30px 0 12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
.kpis.small{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow);transition:transform .12s,box-shadow .12s}
.kpi:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(16,24,40,.1)}
.kpi .lb{font-size:12px;color:var(--dim);font-weight:500}
.kpi .vl{font-size:27px;font-weight:700;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.kpi .vl.ok{color:var(--ok)}.kpi .vl.warn{color:var(--warn)}.kpi .vl.bad{color:var(--bad)}.kpi .vl.accent{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow)}
.cols{display:grid;grid-template-columns:1fr 1.3fr;gap:0 26px}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.lbl{font-size:13px;color:var(--dim);font-weight:500;margin-bottom:6px}
.bar{display:flex;align-items:center;gap:12px;margin:12px 0}
.bar>span{width:88px;font-size:13px;color:var(--dim)}
.track{flex:1;height:9px;background:var(--line2);border-radius:6px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:6px;transition:width .5s}
.bar b{width:58px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums}
.tag{display:inline-block;background:#f2f4f7;border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:4px 12px;margin:5px 8px 0 0;font-size:12px;font-variant-numeric:tabular-nums}
.tablewrap{padding:6px 0;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{position:sticky;top:0;text-align:left;font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card)}
td{padding:11px 16px;border-bottom:1px solid var(--line2);font-variant-numeric:tabular-nums}
tbody tr:hover{background:#fafbfc}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dim)}
.pill{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.info{background:var(--infobg);color:var(--info)}
.tid{display:inline-block;padding:2px 9px;border-radius:6px;background:#eef2ff;color:var(--accent);font-size:12px;font-weight:600}
.err{margin:14px 0;padding:13px 16px;background:var(--badbg);border:1px solid #fecdca;color:var(--bad);border-radius:10px;font-size:13px}
.empty{color:var(--faint);text-align:center;padding:24px}
</style></head><body>
<nav>
  <div class="brand"><span class="logo">◆</span><div><div class="t1">VRAM-Aware Harness</div><div class="t2">多租户 Agent 观测驾驶舱</div></div></div>
  <div class="navright"><div class="segwrap" id="tenantSwitch"></div><span class="live"><span class="pulse"></span>Live</span></div>
</nav>
<main>
  <div class="pagehead"><h1>执行观测</h1><div class="meta" id="scope">加载中…</div></div>
  <div id="err"></div>

  <section><h2>执行质量 · 成功 / 成本 / 延迟 / 自治</h2><div class="kpis" id="cards"></div></section>

  <section><h2>完成度 · 任务是否产出可用结果</h2><div class="card"><div id="completion"></div></div></section>

  <div class="cols">
    <section><h2>工具副作用治理</h2><div class="kpis small" id="tools"></div></section>
    <section><h2>资源准入与背压</h2><div class="kpis small" id="resource"></div>
      <div class="card" style="margin-top:14px"><div class="lbl">排队原因分布</div><div id="reasons"></div></div></section>
  </div>

  <section><h2>任务明细</h2><div class="card tablewrap"><table>
    <thead><tr><th>租户</th><th>Run</th><th>状态</th><th>尝试</th><th>排队</th><th>耗时</th><th>工具</th><th>危险拦截</th><th>Token</th><th>成本</th></tr></thead>
    <tbody id="runs"></tbody>
  </table></div></section>
</main>
<script>
function $(id){return document.getElementById(id)}
function pct(x){return x==null?'—':(x*100).toFixed(1)+'%'}
function ms(x){return x==null?'—':Math.round(x)+'ms'}
function money(x){return x==null?'—':'$'+x.toFixed(4)}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
var currentTenant='';
function kpi(label,value,cls){return '<div class="kpi"><div class="lb">'+label+'</div><div class="vl '+(cls||'')+'">'+value+'</div></div>'}
function bar(label,rate){return '<div class="bar"><span>'+label+'</span><div class="track"><div class="fill" style="width:'+(rate*100)+'%"></div></div><b>'+pct(rate)+'</b></div>'}
function pill(status){
  var cls=status==='COMPLETED'?'ok':(status==='FAILED'?'bad':(status==='RUNNING'?'info':'warn'));
  return '<span class="pill '+cls+'">'+esc(status)+'</span>';
}
function rateCls(r,good,bad){return r==null?'':(r>=good?'ok':(r<bad?'bad':''))}

async function load(){
  try{
    var url='/eval'+(currentTenant?('?tenant='+encodeURIComponent(currentTenant)):'');
    const r=await fetch(url);if(!r.ok)throw new Error('GET '+url+' → '+r.status);
    const d=await r.json();$('err').innerHTML='';render(d);
  }catch(e){$('err').innerHTML='<div class="err">观测数据加载失败：'+esc(e.message)+'</div>'}
}
function renderSwitch(tenants){
  var h='<button class="seg '+(currentTenant===''?'on':'')+'" data-t="">全部租户</button>';
  (tenants||[]).forEach(function(t){h+='<button class="seg '+(currentTenant===t?'on':'')+'" data-t="'+esc(t)+'">'+esc(t)+'</button>'});
  $('tenantSwitch').innerHTML=h;
  Array.prototype.forEach.call(document.querySelectorAll('.seg'),function(b){
    b.onclick=function(){currentTenant=b.getAttribute('data-t');load();};
  });
}
function render(d){
  var q=d.executionQuality,res=d.resourceAdmission,llm=q.llmTotals;
  renderSwitch(d.tenants||[]);
  $('scope').textContent='范围：'+(d.scope==='all-tenants'?'全部租户':d.scope)+' · 任务 '+q.totalRuns+' · 准入决策 '+res.totalDecisions+' · 更新于 '+new Date().toLocaleTimeString();
  $('cards').innerHTML=
    kpi('成功率',pct(q.successRate),rateCls(q.successRate,0.9,0.5))+
    kpi('无人值守率',pct(q.unattendedRate),rateCls(q.unattendedRate,0.9,0.5))+
    kpi('KV cache 命中率',llm.cacheHitRate==null?'—':pct(llm.cacheHitRate),'accent')+
    kpi('总成本',money(llm.totalCost))+
    kpi('总 Token',llm.totalTokens)+
    kpi('平均尝试',q.avgAttemptCount.toFixed(2))+
    kpi('排队 P95',ms(q.queueWaitMs.p95))+
    kpi('执行 P95',ms(q.runDurationMs.p95));
  $('completion').innerHTML=
    bar('文件 Diff',q.completion.diffRate)+
    bar('Artifact',q.completion.artifactRate)+
    bar('最终回答',q.completion.finalTextRate);
  $('tools').innerHTML=
    kpi('只读',q.toolEffectTotals.readOnly)+
    kpi('幂等写',q.toolEffectTotals.idempotentWrite)+
    kpi('未知副作用',q.toolEffectTotals.unknownEffect,q.toolEffectTotals.unknownEffect>0?'warn':'')+
    kpi('被拦危险',q.toolEffectTotals.blockedDangerous,q.toolEffectTotals.blockedDangerous>0?'bad':'ok');
  $('resource').innerHTML=
    kpi('START',res.actionCounts.START||0,'ok')+
    kpi('QUEUE',res.actionCounts.QUEUE||0,(res.actionCounts.QUEUE||0)>0?'warn':'')+
    kpi('背压触发率',pct(res.pressuredRate),res.pressuredRate>0?'warn':'ok')+
    kpi('观测失败率',pct(res.observationFailureRate),res.observationFailureRate>0?'bad':'ok');
  var rh='';Object.keys(res.reasonCounts).forEach(function(k){rh+='<span class="tag">'+esc(k)+' × '+res.reasonCounts[k]+'</span>'});
  $('reasons').innerHTML=rh||'<span class="empty">暂无准入决策</span>';
  var rows='';
  d.runs.forEach(function(r){
    rows+='<tr><td><span class="tid">'+esc(r.tenantId)+'</span></td>'+
      '<td class="mono">'+esc(r.runId.slice(0,8))+'</td>'+
      '<td>'+pill(r.finalStatus)+'</td>'+
      '<td>'+r.attemptCount+'</td><td>'+ms(r.queueWaitMs)+'</td><td>'+ms(r.runDurationMs)+'</td>'+
      '<td>'+r.toolCallCount+'</td>'+
      '<td>'+(r.blockedDangerousToolCount>0?'<span class="pill bad">'+r.blockedDangerousToolCount+'</span>':'0')+'</td>'+
      '<td>'+(r.llmUsage?r.llmUsage.totalTokens:'—')+'</td>'+
      '<td>'+(r.llmUsage?money(r.llmUsage.costTotal):'—')+'</td></tr>';
  });
  $('runs').innerHTML=rows||'<tr><td colspan="10" class="empty">暂无任务</td></tr>';
}
load();setInterval(load,3000);
</script></body></html>`;

export function observePageResponse(): Response {
    return new Response(OBSERVE_HTML, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}
