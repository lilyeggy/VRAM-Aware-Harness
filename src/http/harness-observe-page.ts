/**
 * 方向 B：观测驾驶舱页面（产品级 dashboard，单页布局）。
 *
 * 自包含只读观测视图（独立页 /observe，不影响任务操作台 /）：
 * 顶部精简导航条（品牌 + 多租户切换 + Live），内容居中、以图表为主体：
 * 任务状态环形图、租户对比条形、完成度条、资源背压分布条。
 * 数据来自 GET /eval（支持 ?tenant=），3s 自动刷新。
 */

const OBSERVE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>观测驾驶舱 · VRAM-Aware Harness</title><style>
:root{
  --bg:#f5f6f8; --card:#ffffff; --line:#e6e8eb; --line2:#eef0f3;
  --txt:#101828; --dim:#667085; --faint:#98a2b3;
  --accent:#4f46e5; --accent2:#7c9eff;
  --ok:#12b76a; --warn:#f79009; --bad:#f04438; --info:#2e90fa;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Inter","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}

/* ---------- 顶部导航条 ---------- */
.topnav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.tn-inner{max-width:1220px;margin:0 auto;padding:13px 30px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px}
.logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;box-shadow:var(--shadow)}
.t1{font-weight:700;font-size:15px;letter-spacing:-.01em}
.t2{font-size:11.5px;color:var(--dim)}
.navright{display:flex;align-items:center;gap:14px}
.segwrap{display:flex;background:#e7eaef;border-radius:9px;padding:3px;gap:2px;max-width:46vw;overflow:auto}
.seg{border:0;background:transparent;color:var(--dim);font:inherit;font-size:13px;padding:6px 14px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:all .15s}
.seg:hover{color:var(--txt)}
.seg.on{background:#fff;color:var(--txt);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.14)}
.live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--ok);animation:pl 2s infinite}
@keyframes pl{0%{box-shadow:0 0 0 0 rgba(18,183,106,.4)}70%{box-shadow:0 0 0 7px rgba(18,183,106,0)}100%{box-shadow:0 0 0 0 rgba(18,183,106,0)}}

/* ---------- 内容 ---------- */
.content{max-width:1220px;margin:0 auto;padding:26px 30px 64px}
.pagehead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.pagehead h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0}
.meta{font-size:13px;color:var(--dim)}
section{margin-bottom:30px}
.sec-h{font-size:12px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.1em;margin:0 0 14px}

/* Hero KPI */
.hero{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--shadow);position:relative;overflow:hidden;transition:transform .12s,box-shadow .12s}
.kpi:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(16,24,40,.1)}
.kpi::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
.kpi.ok::before{background:var(--ok)}.kpi.warn::before{background:var(--warn)}.kpi.bad::before{background:var(--bad)}
.kpi .lb{font-size:13px;color:var(--dim);font-weight:500}
.kpi .vl{font-size:33px;font-weight:700;letter-spacing:-.03em;margin-top:8px;font-variant-numeric:tabular-nums}
.kpi .vl.ok{color:var(--ok)}.kpi .vl.warn{color:var(--warn)}.kpi .vl.bad{color:var(--bad)}.kpi .vl.accent{color:var(--accent)}
.kpi .ft{font-size:12px;color:var(--faint);margin-top:4px}

/* 图表卡片 */
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--shadow)}
.card .ch{font-size:14px;font-weight:600;margin-bottom:3px}
.card .cs{font-size:12px;color:var(--faint);margin-bottom:16px}
.donutwrap{display:flex;align-items:center;gap:24px}
.donutrel{position:relative;width:150px;height:150px;flex:none}
.donut{width:150px;height:150px}
.donut circle{transition:stroke-dasharray .5s}
.dc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.dc .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.dc .t{font-size:11px;color:var(--faint)}
.legend{display:flex;flex-direction:column;gap:9px}
.lg{display:flex;align-items:center;gap:9px;font-size:13px}
.lg .dot{width:10px;height:10px;border-radius:3px;flex:none}
.lg .c{margin-left:auto;color:var(--dim);font-variant-numeric:tabular-nums}
.bar{display:flex;align-items:center;gap:12px;margin:13px 0}
.bar>span{width:82px;font-size:13px;color:var(--dim)}
.track{flex:1;height:9px;background:var(--line2);border-radius:6px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:6px;transition:width .5s}
.bar b{width:58px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums}
.trow{display:flex;align-items:center;gap:12px;margin:13px 0}
.tname{width:82px;font-size:13px;color:var(--dim);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow b{width:130px;text-align:right;font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums;font-weight:500}
.stack{display:flex;height:12px;border-radius:7px;overflow:hidden;background:var(--line2)}
.stack .st{transition:width .5s}.stack .st.ok{background:var(--ok)}.stack .st.warn{background:var(--warn)}
.stacklg{display:flex;gap:18px;margin-top:11px;font-size:13px;color:var(--dim)}
.stacklg .dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.minirow{display:flex;gap:28px;margin-top:16px;flex-wrap:wrap}
.mini{font-size:12.5px;color:var(--dim)}
.mini b{display:block;font-size:20px;font-weight:700;color:var(--txt);font-variant-numeric:tabular-nums}
.mini b.warn{color:var(--warn)}.mini b.bad{color:var(--bad)}
.tag{display:inline-block;background:#f2f4f7;border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:3px 11px;margin:5px 7px 0 0;font-size:12px;font-variant-numeric:tabular-nums}

/* 副作用小卡 */
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.mini4{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.mini4 .lb{font-size:12.5px;color:var(--dim)}
.mini4 .vl{font-size:24px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}
.mini4 .vl.warn{color:var(--warn)}.mini4 .vl.bad{color:var(--bad)}.mini4 .vl.ok{color:var(--ok)}

/* 任务表 */
.tabcard{padding:8px 0;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;padding:11px 16px;border-bottom:1px solid var(--line)}
td{padding:12px 16px;border-bottom:1px solid var(--line2);font-variant-numeric:tabular-nums}
tbody tr:hover{background:#fafbfc}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--dim)}
.pill{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600}
.pill.ok{background:#ecfdf3;color:var(--ok)}.pill.bad{background:#fef3f2;color:var(--bad)}.pill.warn{background:#fffaeb;color:var(--warn)}.pill.info{background:#eff8ff;color:var(--info)}.pill.grey{background:#f2f4f7;color:var(--dim)}
.tid{display:inline-block;padding:2px 9px;border-radius:6px;background:#eef2ff;color:var(--accent);font-size:12px;font-weight:600}
.err{margin:0 0 16px;padding:13px 16px;background:#fef3f2;border:1px solid #fecdca;color:var(--bad);border-radius:10px;font-size:13px}
.empty{color:var(--faint);text-align:center;padding:24px}
@media(max-width:980px){.hero,.charts,.grid4{grid-template-columns:1fr 1fr}}
@media(max-width:640px){.hero,.charts,.grid4{grid-template-columns:1fr}}
</style></head><body>

<header class="topnav"><div class="tn-inner">
  <div class="brand"><span class="logo">◆</span><div><div class="t1">VRAM-Aware Harness</div><div class="t2">多租户 Agent 观测驾驶舱</div></div></div>
  <div class="navright"><div class="segwrap" id="tenantSwitch"></div><span class="live"><span class="pulse"></span>Live</span></div>
</div></header>

<main class="content">
  <div class="pagehead"><h1>执行观测总览</h1><div class="meta" id="scope">加载中…</div></div>
  <div id="err"></div>

  <section><div class="hero" id="hero"></div></section>

  <section>
    <div class="charts">
      <div class="card"><div class="ch">任务状态分布</div><div class="cs">各终态任务占比</div>
        <div class="donutwrap"><div class="donutrel" id="donut"></div><div class="legend" id="legend"></div></div>
      </div>
      <div class="card"><div class="ch">完成度</div><div class="cs">任务是否产出可用结果</div>
        <div id="completion"></div>
        <div class="minirow" id="miniStats"></div>
      </div>
      <div class="card"><div class="ch">租户对比</div><div class="cs">各租户任务规模与成功率</div>
        <div id="tenantBars"></div>
      </div>
      <div class="card"><div class="ch">资源准入与背压</div><div class="cs">START / QUEUE 与背压健康度</div>
        <div id="resStack"></div>
        <div class="minirow" id="resMini"></div>
        <div id="reasons" style="margin-top:12px"></div>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-h">工具副作用治理</div>
    <div class="grid4" id="tools"></div>
  </section>

  <section>
    <div class="sec-h">任务明细</div>
    <div class="card tabcard"><table>
      <thead><tr><th>租户</th><th>Run</th><th>状态</th><th>尝试</th><th>排队</th><th>耗时</th><th>工具</th><th>危险拦截</th><th>Token</th><th>成本</th></tr></thead>
      <tbody id="runRows"></tbody>
    </table></div>
  </section>
</main>

<script>
function $(id){return document.getElementById(id)}
function pct(x){return x==null?'—':(x*100).toFixed(1)+'%'}
function ms(x){return x==null?'—':Math.round(x)+'ms'}
function money(x){return x==null?'—':'$'+x.toFixed(4)}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
var currentTenant='';
var SCOL={COMPLETED:'#12b76a',RUNNING:'#2e90fa',FAILED:'#f04438',QUEUED:'#f79009',WAITING_TOOL:'#a78bfa',INTERRUPTED:'#94a3b8'};

function hero(label,value,cls,foot){return '<div class="kpi '+(cls||'')+'"><div class="lb">'+label+'</div><div class="vl '+(cls||'')+'">'+value+'</div>'+(foot?'<div class="ft">'+foot+'</div>':'')+'</div>'}
function bar(label,rate){return '<div class="bar"><span>'+label+'</span><div class="track"><div class="fill" style="width:'+(rate*100)+'%"></div></div><b>'+pct(rate)+'</b></div>'}
function pill(s){var cls=s==='COMPLETED'?'ok':(s==='FAILED'?'bad':(s==='RUNNING'?'info':(s==='QUEUED'?'warn':'grey')));return '<span class="pill '+cls+'">'+esc(s)+'</span>'}
function rateCls(r,g,b){return r==null?'':(r>=g?'ok':(r<b?'bad':''))}

function donut(statusCounts,total){
  var parts=Object.keys(statusCounts).map(function(k){return {label:k,value:statusCounts[k],color:SCOL[k]||'#94a3b8'}});
  var r=15.9155,out='',off=25,i,share;
  if(total===0){out='<circle cx="21" cy="21" r="'+r+'" fill="none" stroke="#eef0f3" stroke-width="4.5"></circle>';}
  for(i=0;i<parts.length;i++){share=parts[i].value/Math.max(total,1)*100;if(share<=0)continue;
    out+='<circle cx="21" cy="21" r="'+r+'" fill="none" stroke="'+parts[i].color+'" stroke-width="4.5" stroke-dasharray="'+share+' '+(100-share)+'" stroke-dashoffset="'+off+'"></circle>';
    off-=share;if(off<0)off+=100;}
  var legend='';parts.forEach(function(p){legend+='<div class="lg"><span class="dot" style="background:'+p.color+'"></span>'+esc(p.label)+'<span class="c">'+p.value+'</span></div>'});
  return {svg:'<svg viewBox="0 0 42 42" class="donut">'+out+'</svg><div class="dc"><div class="n">'+total+'</div><div class="t">任务</div></div>',legend:legend};
}
function tenantBars(perTenant){
  var max=1;perTenant.forEach(function(t){if(t.summary.totalRuns>max)max=t.summary.totalRuns});
  var h='';perTenant.forEach(function(t){
    var w=t.summary.totalRuns/max*100;
    h+='<div class="trow"><span class="tname">'+esc(t.tenant)+'</span><div class="track"><div class="fill" style="width:'+w+'%"></div></div><b>'+t.summary.totalRuns+' 任务 · '+pct(t.summary.successRate)+'</b></div>';
  });
  return h||'<div class="empty">暂无租户</div>';
}
function resStack(res){
  var s=res.actionCounts.START||0,q=res.actionCounts.QUEUE||0,t=Math.max(s+q,1);
  return '<div class="stack"><div class="st ok" style="width:'+(s/t*100)+'%"></div><div class="st warn" style="width:'+(q/t*100)+'%"></div></div>'+
    '<div class="stacklg"><span><span class="dot" style="background:var(--ok)"></span>START '+s+'</span><span><span class="dot" style="background:var(--warn)"></span>QUEUE '+q+'</span></div>';
}

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
  Array.prototype.forEach.call(document.querySelectorAll('.seg'),function(b){b.onclick=function(){currentTenant=b.getAttribute('data-t');load();}});
}
function render(d){
  var q=d.executionQuality,res=d.resourceAdmission,llm=q.llmTotals;
  renderSwitch(d.tenants||[]);
  $('scope').textContent='范围：'+(d.scope==='all-tenants'?'全部租户':d.scope)+' · 任务 '+q.totalRuns+' · 准入决策 '+res.totalDecisions+' · 更新于 '+new Date().toLocaleTimeString();

  $('hero').innerHTML=
    hero('成功率',pct(q.successRate),rateCls(q.successRate,0.9,0.5),'COMPLETED / 总任务')+
    hero('无人值守率',pct(q.unattendedRate),rateCls(q.unattendedRate,0.9,0.5),'无需人工介入')+
    hero('KV cache 命中率',llm.cacheHitRate==null?'—':pct(llm.cacheHitRate),'accent','成本效率')+
    hero('总成本',money(llm.totalCost),'','总 Token '+llm.totalTokens);

  var dn=donut(q.statusCounts,q.totalRuns);
  $('donut').innerHTML=dn.svg;$('legend').innerHTML=dn.legend||'<div class="empty">暂无任务</div>';

  $('completion').innerHTML=bar('文件 Diff',q.completion.diffRate)+bar('Artifact',q.completion.artifactRate)+bar('最终回答',q.completion.finalTextRate);
  $('miniStats').innerHTML=
    '<div class="mini"><b>'+ms(q.queueWaitMs.p95)+'</b>排队 P95</div>'+
    '<div class="mini"><b>'+ms(q.runDurationMs.p95)+'</b>执行 P95</div>'+
    '<div class="mini"><b>'+q.avgAttemptCount.toFixed(2)+'</b>平均尝试</div>';

  $('tenantBars').innerHTML=tenantBars(d.perTenant||[]);

  $('resStack').innerHTML=resStack(res);
  $('resMini').innerHTML=
    '<div class="mini"><b class="'+(res.pressuredRate>0?'warn':'')+'">'+pct(res.pressuredRate)+'</b>背压触发率</div>'+
    '<div class="mini"><b class="'+(res.observationFailureRate>0?'bad':'')+'">'+pct(res.observationFailureRate)+'</b>观测失败率</div>';
  var rh='';Object.keys(res.reasonCounts).forEach(function(k){rh+='<span class="tag">'+esc(k)+' × '+res.reasonCounts[k]+'</span>'});
  $('reasons').innerHTML=rh||'<span class="empty">暂无准入决策</span>';

  $('tools').innerHTML=
    '<div class="mini4"><div class="lb">只读</div><div class="vl">'+q.toolEffectTotals.readOnly+'</div></div>'+
    '<div class="mini4"><div class="lb">幂等写</div><div class="vl">'+q.toolEffectTotals.idempotentWrite+'</div></div>'+
    '<div class="mini4"><div class="lb">未知副作用</div><div class="vl '+(q.toolEffectTotals.unknownEffect>0?'warn':'')+'">'+q.toolEffectTotals.unknownEffect+'</div></div>'+
    '<div class="mini4"><div class="lb">被拦危险</div><div class="vl '+(q.toolEffectTotals.blockedDangerous>0?'bad':'ok')+'">'+q.toolEffectTotals.blockedDangerous+'</div></div>';

  var rows='';
  d.runs.forEach(function(r){
    rows+='<tr><td><span class="tid">'+esc(r.tenantId)+'</span></td>'+
      '<td class="mono">'+esc(r.runId.slice(0,8))+'</td><td>'+pill(r.finalStatus)+'</td>'+
      '<td>'+r.attemptCount+'</td><td>'+ms(r.queueWaitMs)+'</td><td>'+ms(r.runDurationMs)+'</td>'+
      '<td>'+r.toolCallCount+'</td>'+
      '<td>'+(r.blockedDangerousToolCount>0?'<span class="pill bad">'+r.blockedDangerousToolCount+'</span>':'0')+'</td>'+
      '<td>'+(r.llmUsage?r.llmUsage.totalTokens:'—')+'</td><td>'+(r.llmUsage?money(r.llmUsage.costTotal):'—')+'</td></tr>';
  });
  $('runRows').innerHTML=rows||'<tr><td colspan="10" class="empty">暂无任务</td></tr>';
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
