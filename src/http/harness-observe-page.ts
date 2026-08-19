/**
 * 方向 B：观测驾驶舱页面。
 *
 * 一个自包含的只读观测视图（独立页 /observe，不影响现有任务操作台 /），
 * 把方向 A 算出的评测指标 + 资源准入 + 每个任务的明细渲染出来，
 * 让「可靠的执行」变成「看得见的执行」。数据来自 GET /eval。
 */

const OBSERVE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VRAM-Aware Harness · 观测驾驶舱</title><style>
:root{--bg:#0b1220;--card:#131c2e;--line:#22304a;--txt:#e6edf7;--dim:#8ea0bd;--teal:#2dd4bf;--amber:#fbbf24;--red:#f87171;--blue:#60a5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:26px 0 10px}
.sub{color:var(--dim);font-size:13px;margin-bottom:8px}.dot{color:var(--teal)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card .v{font-size:24px;font-weight:700;color:var(--teal)}.card .l{color:var(--dim);font-size:12px;margin-top:4px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.bar{display:flex;align-items:center;gap:10px;margin:8px 0}.bar span{width:84px;color:var(--dim);font-size:13px}
.track{flex:1;height:10px;background:#0a1322;border-radius:6px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,var(--teal),var(--blue))}
.bar b{width:56px;text-align:right;font-size:13px}
.tag{display:inline-block;background:#0a1322;border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:4px 6px 0 0;font-size:12px;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:12px}td.mono{font-family:ui-monospace,monospace}
.ok{color:var(--teal)}.bad{color:var(--red)}.warn{color:var(--amber)}
.err{color:var(--red);padding:12px;background:#2a1420;border-radius:8px}
a{color:var(--blue)}
</style></head><body>
<h1>观测驾驶舱 <span class="dot">●</span></h1>
<div class="sub" id="scope">加载中…</div>
<div id="err"></div>

<h2>执行质量（行业标准：成功 / 成本 / 延迟 + 自治）</h2>
<div class="grid" id="cards"></div>

<h2>完成度（任务是否真的产出了可用的东西）</h2>
<div class="panel" id="completion"></div>

<h2>工具副作用治理</h2>
<div class="grid" id="tools"></div>

<h2>资源准入与背压（VRAM-Aware 核心）</h2>
<div class="grid" id="resource"></div>
<div class="panel" style="margin-top:12px"><div class="sub">排队原因分布</div><div id="reasons"></div></div>

<h2>任务明细</h2>
<div class="panel"><table><thead><tr><th>Run</th><th>状态</th><th>尝试</th><th>排队</th><th>耗时</th><th>工具</th><th>危险拦截</th><th>Token</th><th>成本</th></tr></thead><tbody id="runs"></tbody></table></div>

<script>
function $(id){return document.getElementById(id)}
function pct(x){return x==null?'—':(x*100).toFixed(1)+'%'}
function ms(x){return x==null?'—':Math.round(x)+'ms'}
function money(x){return x==null?'—':'$'+x.toFixed(4)}
function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function card(label,value,cls){return '<div class="card"><div class="v '+(cls||'')+'">'+value+'</div><div class="l">'+label+'</div></div>'}
function bar(label,rate){return '<div class="bar"><span>'+label+'</span><div class="track"><div class="fill" style="width:'+(rate*100)+'%"></div></div><b>'+pct(rate)+'</b></div>'}
function statusCls(s){return s==='COMPLETED'?'ok':(s==='FAILED'?'bad':'warn')}

async function load(){
  try{
    const r=await fetch('/eval');if(!r.ok)throw new Error('GET /eval → '+r.status);
    const d=await r.json();$('err').innerHTML='';render(d);
  }catch(e){$('err').innerHTML='<div class="err">观测数据加载失败：'+esc(e.message)+'（若服务开启认证，请用无认证模式或为 /eval 配置访问）</div>'}
}
function render(d){
  const q=d.executionQuality,res=d.resourceAdmission,llm=q.llmTotals;
  $('scope').textContent='范围：'+d.scope+' · 任务 '+q.totalRuns+' · 决策 '+res.totalDecisions+' · '+new Date().toLocaleTimeString();
  $('cards').innerHTML=
    card('成功率',pct(q.successRate))+
    card('无人值守率',pct(q.unattendedRate))+
    card('KV cache 命中率',llm.cacheHitRate==null?'—':pct(llm.cacheHitRate))+
    card('总成本',money(llm.totalCost))+
    card('总 Token',llm.totalTokens)+
    card('平均尝试',q.avgAttemptCount.toFixed(2))+
    card('排队 P95',ms(q.queueWaitMs.p95))+
    card('执行 P95',ms(q.runDurationMs.p95));
  $('completion').innerHTML=
    bar('文件 Diff',q.completion.diffRate)+
    bar('Artifact',q.completion.artifactRate)+
    bar('最终回答',q.completion.finalTextRate);
  $('tools').innerHTML=
    card('只读',q.toolEffectTotals.readOnly)+
    card('幂等写',q.toolEffectTotals.idempotentWrite)+
    card('未知副作用',q.toolEffectTotals.unknownEffect,'warn')+
    card('被拦危险',q.toolEffectTotals.blockedDangerous,q.toolEffectTotals.blockedDangerous>0?'bad':'');
  $('resource').innerHTML=
    card('START',res.actionCounts.START||0,'ok')+
    card('QUEUE',res.actionCounts.QUEUE||0,'warn')+
    card('背压触发率',pct(res.pressuredRate),res.pressuredRate>0?'warn':'')+
    card('观测失败率',pct(res.observationFailureRate),res.observationFailureRate>0?'bad':'');
  var rh='';Object.keys(res.reasonCounts).forEach(function(k){rh+='<span class="tag">'+esc(k)+' × '+res.reasonCounts[k]+'</span>'});
  $('reasons').innerHTML=rh||'<span class="tag">暂无决策</span>';
  var rows='';
  d.runs.forEach(function(r){
    rows+='<tr><td class="mono">'+esc(r.runId.slice(0,8))+'</td>'+
      '<td class="'+statusCls(r.finalStatus)+'">'+esc(r.finalStatus)+'</td>'+
      '<td>'+r.attemptCount+'</td><td>'+ms(r.queueWaitMs)+'</td><td>'+ms(r.runDurationMs)+'</td>'+
      '<td>'+r.toolCallCount+'</td>'+
      '<td class="'+(r.blockedDangerousToolCount>0?'bad':'')+'">'+r.blockedDangerousToolCount+'</td>'+
      '<td>'+(r.llmUsage?r.llmUsage.totalTokens:'—')+'</td>'+
      '<td>'+(r.llmUsage?money(r.llmUsage.costTotal):'—')+'</td></tr>';
  });
  $('runs').innerHTML=rows||'<tr><td colspan="9" style="color:var(--dim)">暂无任务</td></tr>';
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
