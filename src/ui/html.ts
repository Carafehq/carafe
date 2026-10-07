export const HTML = /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>carafe</title>
<style>
:root{--bg:#efeee8;--panel:#fff;--panel2:#f6f5f0;--tx:#1d1c1a;--tx2:#605e58;--tx3:#908e85;--bd:rgba(0,0,0,.12);--info:#185fa5;--infobg:#e6f1fb;--cc:#D85A30;--cx:#1D9E75;--cu:#7F77DD}
@media(prefers-color-scheme:dark){:root{--bg:#1a1916;--panel:#232220;--panel2:#2b2a26;--tx:#ece9e3;--tx2:#a8a69d;--tx3:#7c7a72;--bd:rgba(255,255,255,.14);--info:#85b7eb;--infobg:#133352}}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--tx);height:100vh;display:flex;flex-direction:column}
header{padding:12px 16px;border-bottom:.5px solid var(--bd);background:var(--panel);display:flex;align-items:center;gap:12px;flex-shrink:0}
.logo{width:22px;height:22px;border-radius:6px;background:var(--tx);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500}
#q{flex:1;height:36px;border-radius:8px;border:.5px solid var(--bd);background:var(--panel2);color:var(--tx);padding:0 12px;font:inherit;outline:none}
#q:focus{border-color:var(--info)}
.chip{font-size:12px;padding:5px 10px;border-radius:8px;border:.5px solid var(--bd);background:transparent;color:var(--tx2);cursor:pointer}
.chip.on{background:var(--panel2);color:var(--tx);border-color:var(--info)}
main{flex:1;display:flex;min-height:0}
#tabs{display:flex;gap:6px;margin-right:4px}
#list{width:38%;max-width:480px;border-right:.5px solid var(--bd);overflow:auto;background:var(--panel)}
#detail{flex:1;overflow:auto;padding:18px 24px;overflow-anchor:auto}
#analytics{display:none;flex:1;overflow:auto;padding:22px 24px}
#analytics .ahead{display:flex;align-items:center;gap:10px;margin-bottom:14px}
#analytics h2{margin:0;font-size:22px}
.aspacer{flex:1}
.anote{font-size:12px;color:var(--tx3)}
.agrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0 18px}
.ablock{margin-top:22px}
.alabel{font-size:11px;color:var(--tx3);margin-bottom:8px;text-transform:lowercase}
.daily{display:flex;gap:7px;align-items:flex-end;height:142px;border-bottom:.5px solid var(--bd);padding-top:22px}
.dcol{flex:1;min-width:0;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative}
.dval{position:absolute;bottom:calc(var(--bar-h,0px) + 27px);font-size:11px;color:#E24B4A;white-space:nowrap}
.dbar{width:100%;max-width:22px;border-radius:5px 5px 0 0;background:var(--tx3);min-height:0}
.dbar.hot{background:#E24B4A}
.dday{font-size:11px;color:var(--tx3);height:18px;margin-top:6px}
.toolbar{display:grid;grid-template-columns:minmax(100px,150px) 1fr 64px;gap:10px;align-items:center;margin:9px 0;font-size:13px}
.toolname{display:flex;align-items:center;gap:7px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trackbar{height:10px;border-radius:5px;background:var(--panel2);overflow:hidden}
.trackbar span{display:block;height:100%;border-radius:5px}
.money{text-align:right;color:var(--tx2);font-variant-numeric:tabular-nums}
.arow{padding:10px 12px;border:.5px solid var(--bd);border-radius:8px;margin:8px 0;cursor:pointer;display:flex;align-items:center;gap:9px;background:var(--panel)}
.arow:hover{background:var(--panel2)}
.arow .at{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.arow .am{font-size:12px;color:var(--tx3);flex-shrink:0}
.modeline{font-size:13px;color:var(--tx2);line-height:1.5}
@media(max-width:760px){.agrid{grid-template-columns:repeat(2,minmax(0,1fr))}#q{min-width:0}.anote{display:none}}
.row{padding:11px 14px;border-bottom:.5px solid var(--bd);cursor:pointer}
.row:hover{background:var(--panel2)}
.row.sel{background:var(--infobg)}
.row .t{font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .m{font-size:12px;color:var(--tx3);margin-top:2px;display:flex;gap:7px;align-items:center}
.row .s{font-size:12px;color:var(--tx2);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.child{padding:8px 14px 8px 30px;border-left:2px solid var(--infobg)}
.subchip{color:var(--info);cursor:pointer;user-select:none}
.sublist{max-height:280px;overflow:auto;margin-top:4px;overscroll-behavior:contain}
.subbox{border:.5px solid var(--bd);border-radius:10px;margin:8px 0 8px 15px;background:var(--panel)}
.subbox .sbh{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;font-size:13px}
.subbox .sbc{max-height:420px;overflow:auto;padding:4px 14px 12px;border-top:.5px solid var(--bd);overscroll-behavior:contain}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
mark{background:var(--infobg);color:var(--info);padding:0 2px;border-radius:3px}
h2{font-size:18px;font-weight:500;margin:2px 0 0}
.meta{font-size:12px;color:var(--tx3);display:flex;gap:7px;align-items:center}
.mstrip{display:flex;gap:10px;margin:14px 0}
.mcard{background:var(--panel2);border-radius:8px;padding:9px 12px;flex:1}
.mcard .k{font-size:11px;color:var(--tx3)}
.mcard .v{font-size:19px;font-weight:500;margin-top:1px}
.spendbar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--panel2)}
.spendbar>span{height:100%}
.spendleg{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:12px;color:var(--tx2)}
.spendleg span{display:inline-flex;align-items:center;gap:6px}
.hoff{border:.5px solid var(--bd);border-radius:12px;padding:14px;margin:14px 0}
.panel{border:.5px solid var(--bd);border-radius:8px;background:var(--panel);padding:12px;margin-top:12px}
.panel.drag{border-color:var(--info);background:var(--infobg)}
.ok{color:var(--cx)}
.warn{color:#A86400;background:rgba(239,159,39,.14);border:.5px solid rgba(239,159,39,.45);border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.45}
.err{color:#D0473F;background:rgba(224,75,74,.12);border:.5px solid rgba(224,75,74,.38);border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.45}
.kv{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;font-size:13px;line-height:1.45}
.kv .k{color:var(--tx3)}
.egroup{margin-top:10px}
.erow{display:grid;grid-template-columns:minmax(90px,1fr) 88px 54px minmax(120px,2fr);gap:8px;align-items:start;font-size:12.5px;padding:6px 0;border-top:.5px solid var(--bd)}
.badge{display:inline-flex;border:.5px solid var(--bd);border-radius:8px;padding:2px 6px;color:var(--tx2);font-size:11px;width:max-content}
.badge.red{color:#D0473F;border-color:rgba(224,75,74,.45)}
.badge.amber{color:#A86400;border-color:rgba(239,159,39,.55)}
code.path,.sample{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--panel2);padding:2px 5px;border-radius:4px;word-break:break-all;color:var(--tx2);cursor:pointer}
#receivePanel{position:absolute;right:16px;top:58px;width:min(520px,calc(100vw - 32px));z-index:15;display:none;box-shadow:0 10px 32px rgba(0,0,0,.22)}
#modalRoot{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:30;display:none;align-items:center;justify-content:center;padding:18px}
.modal{width:min(760px,100%);max-height:calc(100vh - 44px);overflow:auto;background:var(--panel);border:.5px solid var(--bd);border-radius:10px;padding:16px;box-shadow:0 16px 44px rgba(0,0,0,.32)}
.bucket{margin-top:12px}
.bucket h3{font-size:13px;margin:0 0 6px;font-weight:500;color:var(--tx2)}
.bucket div{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.45;color:var(--tx2);padding:2px 0;word-break:break-word}
.ledger{margin:14px 0 16px;padding:2px 0}
.ledger-head{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500}
.ledger-head a{font-size:12px;color:var(--tx3);text-decoration:none;margin-left:auto}
.ledger-head a:hover{color:var(--info)}
.ledger-list{border-left:.5px solid var(--bd);margin:10px 0 0 7px}
.lnode{position:relative;padding:0 0 13px 18px;cursor:pointer}
.lnode:hover .ltitle{color:var(--info)}
.undo-link{float:right;opacity:0;font-size:11px;color:var(--tx3);border:0;background:transparent;cursor:pointer;padding:0 0 0 8px}
.lnode:hover .undo-link{opacity:1}
.undo-link:hover{color:var(--info)}
.ldot{position:absolute;left:-5px;top:4px;width:9px;height:9px;border-radius:50%;background:var(--tx3)}
.ltype{font-size:10px;text-transform:lowercase;font-weight:500;margin-bottom:2px}
.ltitle{font-size:14px;font-weight:500;line-height:1.35}
.lwhy{font-size:13px;color:var(--tx2);line-height:1.45;margin-top:2px}
.kmchapter{font-size:12px;color:var(--tx3);line-height:1.45;margin:14px 0 4px;padding-top:8px;border-top:.5px solid var(--bd)}
.hgrid{margin-top:12px;background:var(--panel2);border-radius:8px;padding:11px 13px}
.hg-row{display:flex;gap:10px;font-size:13px;margin:5px 0;line-height:1.5}
.hg-k{color:var(--tx3);width:52px;flex-shrink:0}
.toast{position:absolute;left:50%;transform:translateX(-50%);top:14px;background:var(--tx);color:var(--bg);font-size:13px;padding:8px 14px;border-radius:8px;z-index:20;box-shadow:0 2px 12px rgba(0,0,0,.25)}
.hrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
select{font:inherit;font-size:13px;height:32px;border-radius:8px;border:.5px solid var(--bd);background:var(--panel2);color:var(--tx);padding:0 8px}
.tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--tx2);border:.5px solid var(--bd);border-radius:8px;padding:4px 9px}
button.act{font:inherit;font-size:13px;padding:7px 13px;border-radius:8px;border:.5px solid var(--info);background:var(--infobg);color:var(--info);cursor:pointer;font-weight:500}
button.act:hover{filter:brightness(.97)}
.note{background:var(--panel2);border-radius:8px;padding:10px 12px;font-size:13px;margin-top:11px;line-height:1.5}
.note b{color:var(--tx2);font-weight:500;margin-right:4px}
.handoff-out{border-radius:8px;padding:0;margin-top:11px;font-size:13px;display:none}
.handoff-out code{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;background:var(--panel2);padding:2px 5px;border-radius:4px}
#insearch{width:100%;height:34px;border-radius:8px;border:.5px solid var(--bd);background:var(--panel2);color:var(--tx);padding:0 11px;font:inherit;margin:6px 0 14px;outline:none}
#trace{padding-bottom:40px}
.turn{padding:11px 0;border-top:.5px solid var(--bd)}
.turn.user{border-left:3px solid var(--info);padding:11px 0 11px 13px;margin-left:-13px}
.role{font-size:11px;letter-spacing:.04em;color:var(--tx3);font-weight:500;margin-bottom:3px}
.turn.user .role{color:var(--info)}
.body{font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.toolchip{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--tx2);background:var(--panel2);border-radius:6px;padding:5px 9px;display:inline-block;margin:5px 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolchip b{color:var(--tx)}
details.col{margin:5px 0;font-size:12.5px}
details.col summary{cursor:pointer;color:var(--tx3);font-family:ui-monospace,Menlo,monospace;font-size:12px;list-style:none}
details.col summary::-webkit-details-marker{display:none}
details.col summary:before{content:"▸ ";color:var(--tx3)}
details.col[open] summary:before{content:"▾ "}
details.col>div{white-space:pre-wrap;word-break:break-word;color:var(--tx2);font-family:ui-monospace,Menlo,monospace;font-size:12px;margin:6px 0 6px 12px;padding-left:10px;border-left:2px solid var(--bd)}
.empty{color:var(--tx3);padding:44px 20px;text-align:center}
.gsub{font-size:12px;color:var(--tx3)}
.scrub{position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0 8px;margin-bottom:6px}
.track{position:relative;height:8px;border-radius:4px;background:var(--panel2);border:.5px solid var(--bd);cursor:pointer}
.seg{position:absolute;top:0;height:100%;border-radius:4px;background:var(--infobg);border:.5px solid var(--info);min-width:4px}
.cur{position:absolute;top:-3px;width:2px;height:14px;background:var(--info);border-radius:1px}
.posrow{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--tx3)}
.time{font-weight:400;color:var(--tx3);margin-left:8px;font-size:11px}
.daydiv{text-align:center;color:var(--tx3);font-size:11px;letter-spacing:.06em;margin:16px 0 6px}
.daydiv:before,.daydiv:after{content:"——";margin:0 8px;color:var(--bd)}
.bound{text-align:center;font-size:12px;font-weight:500;color:var(--tx2);margin:14px 0;padding:8px;border:.5px dashed var(--bd);border-radius:8px;background:var(--panel)}
.bound .sub{font-weight:400;color:var(--tx3);font-size:11px;margin-left:6px}
</style></head><body>
<header>
  <div class="logo">C</div>
  <div id="tabs">
    <button class="chip on" data-view="sessions">Sessions</button>
    <button class="chip" data-view="analytics">Analytics</button>
  </div>
  <button class="chip" id="receiveTop">Receive</button>
  <input id="q" placeholder="Search every session across your tools… (decisions, topics, files)" autofocus/>
  <button class="chip on" data-tool="">All</button>
  <button class="chip" data-tool="claude-code">CC</button>
  <button class="chip" data-tool="codex">CX</button>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><div class="empty">Search or pick a session. Then hand it off to an agent or a teammate.</div></div>
</main>
<div class="panel" id="receivePanel"></div>
<div id="analytics"></div>
<div id="modalRoot"></div>
<script>
// Carafe Pro features this build lacks (set by the server; absent = all present).
const OFF=new Set((document.body.getAttribute("data-off")||"").split(" ").filter(Boolean));
const TAG={"claude-code":["CC","var(--cc)"],codex:["CX","var(--cx)"]};
let tool="",activeView="sessions",analyticsDays=7;
const el=(h)=>{const d=document.createElement("div");d.innerHTML=h.trim();return d.firstChild};
const esc=(s)=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const hi=(s)=>esc(s).split("»").join("\\u0001").split("«").join("\\u0002").split("\\u0001").join("<mark>").split("\\u0002").join("</mark>");
const fmt=(n)=>n>=1e9?(n/1e9).toFixed(1).replace(/\\.0$/,"")+"B":n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"K":(""+n);
const money=(n)=>"$"+(n>=100?Math.round(n):n.toFixed(2));
const rateNote=(m)=>m.matched?"":m.pricedAs?" (no rate of its own: priced as "+esc(m.pricedAs)+")":" (unpriced model, blended rate)";

function toolLabel(tool){return({ "claude-code":"Claude Code",codex:"Codex" }[tool]||tool)}
function toolColor(tool){return(TAG[tool]&&TAG[tool][1])||"var(--cu)"}
function renderAnalytics(a){
  const root=document.getElementById("analytics");
  const est=a.totals.estimatedUsdShare>.05?" · "+Math.round(a.totals.estimatedUsdShare*100)+"% estimated":"";
  const unp=a.totals.unpricedUsdShare>0?" · "+(a.totals.unpricedUsdShare<.01?"<1":Math.round(a.totals.unpricedUsdShare*100))+"% at a guessed model rate":"";
  let h='<div class="ahead"><h2>Spend</h2>'
    +'<button class="chip '+(analyticsDays===7?'on':'')+'" data-days="7">7d</button>'
    +'<button class="chip '+(analyticsDays===30?'on':'')+'" data-days="30">30d</button>'
    +'<span class="aspacer"></span><span class="anote">API-equivalent, from real usage records'+est+unp+'</span></div>';
  h+='<div class="agrid">'+mc("spend",money(a.totals.usd))+mc("new tokens (in+out)",fmt(a.totals.tokens))+mc("sessions",fmt(a.totals.sessions))+mc("sub-agent runs",fmt(a.totals.subRuns))+'</div>';
  const maxDay=Math.max(0,...a.daily.map(d=>d.usd));
  const hot=a.daily.findIndex(d=>d.usd===maxDay&&maxDay>0);
  h+='<div class="ablock"><div class="alabel">daily spend</div><div class="daily">';
  a.daily.forEach((d,i)=>{
    const ht=maxDay>0&&d.usd>0?Math.max(3,Math.round(d.usd/maxDay*96)):0;
    const day=new Date(d.date+"T00:00:00").toLocaleDateString([],{weekday:"short"}).slice(0,1);
    h+='<div class="dcol" style="--bar-h:'+ht+'px">'+(i===hot?'<div class="dval">'+money(d.usd)+'</div>':'')+'<div class="dbar '+(i===hot?'hot':'')+'" style="height:'+ht+'px"></div><div class="dday">'+esc(day)+'</div></div>';
  });
  h+='</div></div>';
  const maxTool=Math.max(0,...a.byTool.map(t=>t.usd));
  h+='<div class="ablock"><div class="alabel">cost by tool</div>';
  if(a.byTool.length){
    a.byTool.forEach(t=>{
      const pct=maxTool>0?Math.max(2,t.usd/maxTool*100):0;
      h+='<div class="toolbar"><div class="toolname"><span class="dot" style="background:'+toolColor(t.tool)+'"></span>'+esc(toolLabel(t.tool))+'</div>'
        +'<div class="trackbar"><span style="width:'+pct+'%;background:'+toolColor(t.tool)+'"></span></div><div class="money">'+money(t.usd)+'</div></div>';
    });
  }else h+='<div class="empty" style="padding:18px">no spend in this window</div>';
  h+='</div>';
  h+='<div class="ablock"><div class="alabel">biggest drains</div>';
  if(a.topDrains.length){
    a.topDrains.forEach(d=>{
      h+='<div class="arow" data-id="'+esc(d.id)+'"><span class="dot" style="background:'+toolColor(d.tool)+'"></span>'
        +'<div class="at">'+esc(d.title||d.id)+'</div>'+(d.subs>0?'<div class="am">'+d.subs+' subs</div>':'')+'<div class="money">'+money(d.usd)+'</div></div>';
    });
  }else h+='<div class="empty" style="padding:18px">no sessions in this window</div>';
  h+='</div>';
  if(a.maxFanout&&a.maxFanout.count>=10){
    h+='<div class="bound" style="border-color:var(--cc)">⚠ &#39;'+esc(a.maxFanout.title||a.maxFanout.id)+'&#39; fanned out to '+a.maxFanout.count+' sub-agents · '+money(a.maxFanout.usd)+' including children</div>';
  }
  h+='<div class="ablock"><div class="alabel">cost by model</div><div class="modeline">';
  if(a.byModel.length){
    h+=a.byModel.map(m=>esc(m.model)+' '+money(m.usd)+rateNote(m)).join(" · ");
  }else h+='no priced model usage in this window';
  h+='</div></div>';
  root.innerHTML=h;
  root.querySelectorAll("[data-days]").forEach(b=>b.onclick=()=>{analyticsDays=Number(b.getAttribute("data-days"));loadAnalytics()});
  root.querySelectorAll(".arow").forEach(r=>r.onclick=()=>{switchView("sessions");openSession(r.getAttribute("data-id"),null)});
}
async function loadAnalytics(){
  const root=document.getElementById("analytics");
  root.innerHTML='<div class="empty">loading…</div>';
  const r=await fetch("/api/analytics?days="+analyticsDays).then(r=>r.json());
  if(r.error){root.innerHTML='<div class="empty">'+esc(r.error)+'</div>';return;}
  renderAnalytics(r);
}
function switchView(v){
  activeView=v;
  document.querySelectorAll("#tabs .chip").forEach(c=>c.classList.toggle("on",c.getAttribute("data-view")===v));
  document.querySelector("main").style.display=v==="sessions"?"flex":"none";
  document.getElementById("analytics").style.display=v==="analytics"?"block":"none";
  if(v==="analytics")loadAnalytics();
}

async function load(){
  const q=document.getElementById("q").value.trim();
  const r=await fetch("/api/sessions?limit=40&q="+encodeURIComponent(q)+(tool?"&tool="+tool:"")).then(r=>r.json());
  const list=document.getElementById("list");list.innerHTML="";
  if(!r.results.length){list.appendChild(el('<div class="empty">no matches</div>'));return;}
  for(const s of r.results){
    const[tg,col]=TAG[s.tool]||[s.tool,"var(--tx3)"];
    const when=(s.endTs||"").slice(0,10);
    const extra=(s.subCount?' · <span class="subchip">▸ '+s.subCount+' sub</span>':'')+(s.sub?' · <span style="color:var(--info)">sub</span>':'');
    const row=el('<div class="row" data-id="'+s.id+'"><div class="t">'+esc(s.title||s.id)+'</div><div class="m"><span class="dot" style="background:'+col+'"></span>'+tg+' · '+when+' · '+(s.events||0)+' events'+(s.branch?' · '+esc(s.branch):'')+extra+'</div>'+(s.snippet?'<div class="s">'+hi(s.snippet)+'</div>':'')+'</div>');
    row.onclick=()=>openSession(s.id,row);
    list.appendChild(row);
    // expandable children: the connection to the master session, visible in the list
    if(s.subs&&s.subs.length){
      const wrap=el('<div style="display:none"></div>');
      for(const c of s.subs){
        const crow=el('<div class="row child" data-id="'+c.id+'"><div class="t" style="font-weight:400;font-size:13px">↳ '+esc((c.title||c.id).slice(0,70))+'</div><div class="m"><span class="dot" style="background:var(--cx)"></span>CX · '+(c.endTs||"").slice(5,16).replace("T"," ")+' · '+(c.events||0)+' ev</div></div>');
        crow.onclick=()=>openSession(c.id,crow);
        wrap.appendChild(crow);
      }
      list.appendChild(wrap);
      const chip=row.querySelector(".subchip");
      if(chip)chip.onclick=(e)=>{e.stopPropagation();const open=wrap.style.display==="none";wrap.style.display=open?"block":"none";chip.textContent=(open?"▾ ":"▸ ")+s.subCount+" sub"};
    }
  }
}

async function openSession(id,row,view){
  document.querySelectorAll(".row.sel").forEach(r=>r.classList.remove("sel"));if(row)row.classList.add("sel");
  const d=document.getElementById("detail");d.innerHTML='<div class="empty">loading…</div>';
  const r=await fetch("/api/session/"+encodeURIComponent(id)+(view?"?view="+view:"")).then(r=>r.json());
  if(r.error){d.innerHTML='<div class="empty">'+r.error+'</div>';return;}
  const m=r.meta,a=r.analytics,n=r.notes;const[tg,col]=TAG[m.tool]||[m.tool,"var(--tx3)"];
  const TNAME={"claude-code":"Claude Code",codex:"Codex"};
  const subCount=(a.agentSpawns||0)+(r.subsessions?r.subsessions.length:0);
  let h='<div class="meta"><span class="dot" style="background:'+col+'"></span> '+(TNAME[m.tool]||tg)+' · '+esc(m.cwd||"?")+' · '+esc(m.branch||"?")+'</div>';
  if(r.parent)h+='<div class="meta" style="margin-top:3px">↳ sub-session of <a href="#" id="plink" style="color:var(--info);text-decoration:none">'+esc(r.parent.title||r.parent.id)+'</a></div>';
  if(r.checkpoints&&r.checkpoints.count)h+='<div class="meta" style="margin-top:3px">'+r.checkpoints.count+' checkpoints · latest seq '+r.checkpoints.latestSeq+'</div>';
  h+='<div style="display:flex;align-items:flex-start;gap:12px;margin-top:2px"><h2 style="flex:1;min-width:0">'+esc(m.title||m.id)+'</h2>'
    +'<button class="btn" id="openin" style="flex-shrink:0" title="copy the command to reopen this session">Open in '+(TNAME[m.tool]||tg)+' ↗</button></div>';
  if(a.runs>1)h+='<div class="meta" style="margin-top:4px;color:var(--tx3)">↻ '+a.runs+' runs across '+a.activeDays+' active days — one session id, resumed</div>';
  // stat cards — the numbers that matter: money + fan-out
  const costLabel=a.costSource==="usage"?"cost (API-equiv)":"cost (rough est)";
  const costVal=(a.costSource==="usage"?"$":"~$")+(a.costEst>=100?Math.round(a.costEst):a.costEst.toFixed(2));
  h+='<div class="mstrip">'+mc("new tokens (in+out)",fmt(a.tokensEst))+mc(costLabel,costVal)+mc("tool calls",fmt(a.tools))+mc("sub-agents",subCount)+'</div>';
  // where the tokens went
  if(a.spend){const s=a.spend;
    h+='<div style="margin:2px 0 16px"><div style="font-size:11px;color:var(--tx3);margin-bottom:6px">where the tokens went</div>'
      +'<div class="spendbar">'
      +seg(s.output,"var(--cc)")+seg(s.tools,"#888780")+seg(s.reasoning,"#7F77DD")+seg(s.input,"#B4B2A9")
      +'</div><div class="spendleg">'
      +legdot("var(--cc)","output "+s.output+"%")+legdot("#888780","tool i/o "+s.tools+"%")+legdot("#7F77DD","reasoning "+s.reasoning+"%")+legdot("#B4B2A9","input "+s.input+"%")
      +'</div></div>';}
  // handoff — a real card
  h+='<div class="hoff"><div class="hrow"><span style="font-weight:500">Hand off from '+esc(TNAME[m.tool]||m.tool)+'</span>'
    +(OFF.has("share")?'<span style="margin-left:auto"></span>':'<button class="chip" id="shareBtn" style="margin-left:auto">Share to person…</button>')
    +'<button class="act" id="go">Hand Off ↗</button></div>';
  h+='<div class="hgrid">';
  h+='<div class="hg-row"><span class="hg-k">goal</span><span>'+(n.goal?esc(n.goal):'—')+'</span></div>';
  if(n.state)h+='<div class="hg-row"><span class="hg-k">state</span><span>'+esc(n.state)+'</span></div>';
  h+='<div class="hg-row"><span class="hg-k">carries</span><span>'+a.events+' events · '+(n.topFiles?n.topFiles.length:0)+' files'+(n.prLinks&&n.prLinks.length?' · '+n.prLinks.length+' PRs':'')+' · '+(r.view==="full"?"full trace":"auto-layered")+'</span></div>';
  if(n.topFiles&&n.topFiles.length)h+='<div class="hg-row"><span class="hg-k">files</span><span style="color:var(--tx2)">'+n.topFiles.slice(0,6).map(f=>esc(f.name)+' ('+f.count+')').join(", ")+'</span></div>';
  if(a.costByModel&&a.costByModel.length)h+='<div class="hg-row"><span class="hg-k">cost</span><span style="color:var(--tx2)">'+a.costByModel.slice(0,4).map(b=>esc(b.model)+' $'+(b.usd>=100?Math.round(b.usd):b.usd.toFixed(2))+rateNote(b)).join(" · ")+' — from real usage records, API-equivalent</span></div>';
  h+='</div>';
  h+='<div class="handoff-out" id="hout"></div><div id="sharePanel"></div></div>';
  if(!OFF.has("distill"))h+='<div class="ledger" id="ledger"><div class="ledger-head">✦ decision timeline</div><div class="gsub" style="margin-top:8px">loading…</div></div>';
  h+='<div class="ledger" id="keymoments"><div class="ledger-head">◆ key moments</div><div class="gsub" style="margin-top:8px">loading…</div></div>';
  h+='<input id="insearch" placeholder="search within this session…"/>';
  if(r.subsessions&&r.subsessions.length){
    h+='<div class="note" style="margin:0 0 14px"><b>sub-sessions</b> '+r.subsessions.length+' spawned from this session — click to expand inline<div class="sublist">';
    for(const c of r.subsessions){
      h+='<div class="subrow" data-id="'+c.id+'" data-title="'+esc((c.title||c.id).slice(0,90))+'" style="cursor:pointer;margin-top:6px;display:flex;gap:7px;align-items:center">'
        +'<span class="dot" style="background:var(--cx)"></span>'
        +'<span style="color:var(--info);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">▸ '+esc((c.title||c.id).slice(0,90))+'</span>'
        +'<span style="color:var(--tx3);font-size:11px;flex-shrink:0">'+(c.endTs||"").slice(5,16).replace("T"," ")+' · '+c.events+' ev</span></div>';
    }
    h+='</div></div>';
  }
  if(r.view!=="full"){
    h+='<div class="scrub"><div class="track" id="track"><div class="seg" id="seg"></div><div class="cur" id="cur"></div></div>'
      +'<div class="posrow"><span id="posinfo"></span><span style="flex:1"></span><span id="wininfo"></span>'
      +'<button class="chip" id="vstart">⇤ start</button>'
      +'<button class="chip" id="vtail">tail ⇥</button></div></div>';
  }
  h+='<div class="bound" id="startmark" style="display:none">⟡ session start<span class="sub" id="startmark-ts"></span></div>';
  h+='<button class="chip" id="loadup" style="display:none;width:100%;margin-bottom:8px">▲ load earlier turns</button>';
  h+='<div id="trace"></div>';
  h+='<button class="chip" id="loaddown" style="display:none;width:100%;margin:8px 0 20px">▼ load later turns</button>';
  h+='<div class="bound" id="endmark" style="display:none;margin-bottom:28px">⟡ end of session — last captured message<span class="sub" id="endmark-ts"></span></div>';
  d.innerHTML=h;d.scrollTop=0;
  // continuation state: the loaded window can GROW in both directions
  const st={pieces:r.pieces.slice(),hasBefore:!!r.hasBefore,hasAfter:!!r.hasAfter,total:r.total,loading:false,grepMode:false};
  const win=()=>({a:st.pieces.length?st.pieces[0].seq:0,b:st.pieces.length?st.pieces[st.pieces.length-1].seq:0});
  const idxWin=()=>({a:st.pieces.length?(st.pieces[0].idx||0):0,b:st.pieces.length?(st.pieces[st.pieces.length-1].idx||0):0});
  const edges=()=>{
    document.getElementById("loadup").style.display=(st.hasBefore&&!st.grepMode)?"block":"none";
    document.getElementById("loaddown").style.display=(st.hasAfter&&!st.grepMode)?"block":"none";
    // bookends: when the loaded window touches a boundary, SAY so
    const sm=document.getElementById("startmark"),em=document.getElementById("endmark");
    sm.style.display=(!st.hasBefore&&!st.grepMode)?"block":"none";
    em.style.display=(!st.hasAfter&&!st.grepMode)?"block":"none";
    if(m.startTs)document.getElementById("startmark-ts").textContent="· "+fmtD(m.startTs)+" "+fmtT(m.startTs);
    if(m.endTs)document.getElementById("endmark-ts").textContent="· "+fmtD(m.endTs)+" "+fmtT(m.endTs);
    const wi=document.getElementById("wininfo");
    if(wi){const w=idxWin();wi.textContent="loaded "+(w.a+1)+"–"+(w.b+1)+" of "+st.total;
      const seg=document.getElementById("seg");
      if(seg&&st.total){seg.style.left=(w.a/st.total*100)+"%";seg.style.width=(Math.max(1,w.b-w.a+1)/st.total*100)+"%"}}
  };
  const rerender=()=>{renderTrace(st.pieces);edges();trackPos()};
  const loadMore=async(dir)=>{
    if(st.loading)return;
    if(st.lastLoad&&Date.now()-st.lastLoad<250)return; // cooldown: no rapid-fire chains
    st.loading=true;
    try{
      const w=win();
      const qs=dir==="up"?("before="+w.a):("after="+(w.b+1));
      const c=await fetch("/api/session/"+encodeURIComponent(id)+"?"+qs).then(x=>x.json());
      if(c.error||!c.pieces||!c.pieces.length){if(dir==="up")st.hasBefore=false;else st.hasAfter=false;edges();return;}
      // INCREMENTAL insert — never rebuild the trace (rebuilds reset open boxes
      // and cause scroll teleports). Measure the exact height delta and offset
      // the viewport by it only when the reader sits below the insertion point.
      const tr=document.getElementById("trace");
      const b=buildNodes(c.pieces);
      if(dir==="up"){
        // ZERO manual scrollTop writes: any JS write races the compositor's
        // threaded trackpad scrolling (momentum tails outlive any settle timer)
        // and reads as a violent jump. The browser's native scroll anchoring
        // (overflow-anchor:auto) pins the visible content ATOMICALLY inside
        // layout when we insert above — the only jump-proof mechanism.
        tr.insertBefore(b.frag,tr.firstChild);
        traceNodes=b.nodes.concat(traceNodes);
        st.pieces=c.pieces.concat(st.pieces);st.hasBefore=!!c.hasBefore;
      }else{
        tr.appendChild(b.frag);
        traceNodes=traceNodes.concat(b.nodes);
        st.pieces=st.pieces.concat(c.pieces);st.hasAfter=!!c.hasAfter;
      }
      edges();
    }finally{st.loading=false;st.lastLoad=Date.now()}
  };
  const jumpQs=async(qs,where)=>{
    const c=await fetch("/api/session/"+encodeURIComponent(id)+"?"+qs).then(x=>x.json());
    if(c.error)return;
    st.pieces=c.pieces;st.hasBefore=!!c.hasBefore;st.hasAfter=!!c.hasAfter;st.grepMode=false;
    document.getElementById("insearch").value="";
    rerender();
    if(where==="bottom"){d.scrollTop=d.scrollHeight}
    else{const tr=document.getElementById("trace");d.scrollTop=Math.max(0,tr.offsetTop-120)}
    trackPos();
  };
  const jumpTo=(seq)=>jumpQs("after="+seq);
  window.__jump=jumpTo;
  document.getElementById("loadup").onclick=()=>loadMore("up");
  document.getElementById("loaddown").onclick=()=>loadMore("down");
  // scrubber: click anywhere on the track to jump to that fraction of the session
  const track=document.getElementById("track");
  if(track)track.onclick=(e)=>{const rc=track.getBoundingClientRect();jumpQs("at="+((e.clientX-rc.left)/rc.width).toFixed(4))};
  // position tracking: as you scroll, know WHERE you are (turn + timestamp + cursor)
  const trackPos=()=>{
    const pi=document.getElementById("posinfo"),cu=document.getElementById("cur");
    if(!pi||st.grepMode||!traceNodes.length)return;
    const y=d.scrollTop+140;
    let lo=0,hi=traceNodes.length-1,best=0;
    while(lo<=hi){const mid=(lo+hi)>>1;if(traceNodes[mid].el.offsetTop<=y){best=mid;lo=mid+1}else hi=mid-1}
    const n=traceNodes[best];
    pi.textContent="turn "+((n.idx||0)+1)+" of "+st.total+(n.ts?" · "+fmtD(n.ts)+" "+fmtT(n.ts):"");
    if(cu&&st.total)cu.style.left=((n.idx||0)/st.total*100)+"%";
  };
  let rafPend=false;
  d.onscroll=()=>{
    if(rafPend)return;rafPend=true;
    requestAnimationFrame(()=>{
      rafPend=false;trackPos();
      if(st.grepMode)return;
      // DESIGN RULE: passive scrolling NEVER mutates content above the viewport —
      // that is the only physically jump-proof behavior (three rounds of auto-
      // load-up tuning still glitched on real trackpads). Earlier turns load via
      // the explicit ▲ button (instant, cached). Downward append is safe: content
      // added below you cannot move what you are reading.
      const nearBot=(d.scrollHeight-d.scrollTop-d.clientHeight)<600;
      if(st.hasAfter&&nearBot)loadMore("down");
    });
  };
  rerender();
  document.getElementById("go").onclick=()=>doHandoff(id);
  const sb=document.getElementById("shareBtn");if(sb)sb.onclick=()=>openSharePanel(id);
  loadLedger(id);
  loadKeyMoments(id);
  const oi=document.getElementById("openin");
  if(oi)oi.onclick=()=>copyCmd(m.tool,m.cwd,r.resumeId||m.id);
  const pl=document.getElementById("plink");
  if(pl&&r.parent)pl.onclick=(e)=>{e.preventDefault();openSession(r.parent.id,null)};
  // sub-sessions expand INLINE as minimizable boxes in this same window
  document.querySelectorAll(".subrow").forEach(sr=>{sr.onclick=()=>toggleSubBox(sr)});
  if(r.view!=="full"){
    // one-click in-place jumps (no pane rebuild): start = very first turn,
    // tail = scrolled to the very LAST turn
    const vs=document.getElementById("vstart"),vt=document.getElementById("vtail");
    const mark=(on)=>{if(vs)vs.classList.toggle("on",on==="start");if(vt)vt.classList.toggle("on",on==="tail")};
    if(vs)vs.onclick=()=>{mark("start");jumpQs("view=start","top")};
    if(vt)vt.onclick=()=>{mark("tail");jumpQs("view=tail","bottom")};
    const track2=document.getElementById("track");
    if(track2)track2.addEventListener("click",()=>mark(""));
  }
  const is=document.getElementById("insearch");
  is.oninput=deb(async()=>{
    const q=is.value.trim();
    if(!q){st.grepMode=false;rerender();return;}
    st.grepMode=true;
    const g=await fetch("/api/session/"+encodeURIComponent(id)+"/grep?q="+encodeURIComponent(q)).then(x=>x.json());
    const t=document.getElementById("trace");t.innerHTML="";edges();
    if(!g.hits.length){t.appendChild(el('<div class="empty">no matches in this session</div>'));return;}
    for(const x of g.hits){
      const hit=el('<div class="turn" style="cursor:pointer"><div class="role">seq '+x.seq+' · click to jump</div><div class="body" style="font-family:ui-monospace,Menlo,monospace;font-size:12px">'+esc(x.snippet)+'</div></div>');
      hit.onclick=()=>jumpTo(x.seq);
      t.appendChild(hit);
    }
  },200);
}

function mc(k,v){return '<div class="mcard"><div class="k">'+k+'</div><div class="v">'+esc(""+v)+'</div></div>'}
function seg(p,c){return p>0?'<span style="width:'+p+'%;background:'+c+'"></span>':''}
function legdot(c,t){return '<span><span class="dot" style="background:'+c+'"></span>'+t+'</span>'}
function toast(msg){const t=el('<div class="toast">'+esc(msg)+'</div>');document.body.appendChild(t);setTimeout(()=>t.remove(),1900)}
function fmtBytes(n){return n>=1024*1024?(n/1024/1024).toFixed(1)+"MB":n>=1024?(n/1024).toFixed(1)+"KB":n+"B"}
function copyText(s,msg){navigator.clipboard.writeText(s).then(()=>toast(msg||"copied")).catch(()=>toast("copy failed"))}
function copyCmd(tool,cwd,id){
  const q=(cwd||".").replace(/"/g,'\\\\"');
  const cmd=tool==="codex"?('cd "'+q+'" && codex resume '+id):('cd "'+q+'" && claude --resume '+id);
  navigator.clipboard.writeText(cmd).then(()=>toast("copied — paste in a terminal to reopen")).catch(()=>toast("copy failed"));
}

function classify(line){
  if(line.startsWith("**system:**"))return{r:"system",t:line.slice(11).trim()};
  if(line.startsWith("**user:**"))return{r:"user",t:line.slice(9).trim()};
  if(line.startsWith("**assistant:**"))return{r:"assistant",t:line.slice(14).trim()};
  if(line.startsWith("→ **")){const m=line.match(/^→ \\*\\*(.+?)\\*\\*\\s*([\\s\\S]*)$/);return{r:"tool",name:m?m[1]:"tool",t:m?m[2]:line}}
  if(line.trimStart().startsWith("⤷"))return{r:"result",t:line.replace(/^\\s*⤷\\s*/,"")};
  if(line.startsWith("_(thinking)_"))return{r:"think",t:line.slice(12).trim()};
  return{r:"other",t:line};
}
function detailsBlock(label,cls,text){
  const first=text.replace(/\\n/g," ").slice(0,88);
  return el('<details class="col '+cls+'"><summary>'+label+' · '+esc(first)+'…</summary><div>'+esc(text)+'</div></details>');
}
const fmtT=(ts)=>{try{return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch(e){return""}};
const fmtD=(ts)=>{try{return new Date(ts).toLocaleDateString([],{month:"short",day:"numeric"})}catch(e){return""}};
let traceNodes=[];
/** Build DOM for pieces WITHOUT touching the live trace — used for full renders,
 *  incremental prepend/append (no rebuild = no scroll glitches, open boxes stay
 *  open), and inline sub-session boxes. */
function buildNodes(pieces){
  const frag=document.createDocumentFragment();const nodes=[];
  let lastDay=null,lastTs=null;
  for(const p of pieces){
    const ts=p.ts||lastTs;lastTs=ts;
    if(ts){const day=new Date(ts).toDateString();
      if(day!==lastDay){lastDay=day;frag.appendChild(el('<div class="daydiv">'+fmtD(ts)+'</div>'))}}
    for(const line of p.lines){
      const c=classify(line);let node;
      const tlabel=p.ts?'<span class="time">'+fmtT(p.ts)+'</span>':'';
      if(c.r==="system")node=detailsBlock("system","",c.t);
      else if(c.r==="user")node=c.t.length>1200?detailsBlock("user","utl",c.t):el('<div class="turn user"><div class="role">user'+tlabel+'</div><div class="body">'+esc(c.t)+'</div></div>');
      else if(c.r==="assistant")node=c.t.length>1200?detailsBlock("assistant","",c.t):el('<div class="turn"><div class="role">assistant'+tlabel+'</div><div class="body">'+esc(c.t)+'</div></div>');
      else if(c.r==="tool")node=el('<div class="toolchip">→ <b>'+esc(c.name)+'</b> '+esc(c.t.slice(0,140))+'</div>');
      else if(c.r==="result")node=detailsBlock("⤷ result","",c.t);
      else if(c.r==="think")node=detailsBlock("thinking","",c.t);
      else node=el('<div class="turn"><div class="body">'+esc(c.t)+'</div></div>');
      frag.appendChild(node);
      nodes.push({el:node,idx:p.idx,ts:ts});
    }
  }
  return {frag,nodes};
}
function renderTrace(pieces){
  const t=document.getElementById("trace");t.innerHTML="";
  const b=buildNodes(pieces);
  t.appendChild(b.frag);traceNodes=b.nodes;
}
async function doHandoff(id){
  const out=document.getElementById("hout");out.style.display="block";out.innerHTML='<div class="note">handing off…</div>';
  const r=await fetch("/api/handoff",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id})}).then(x=>x.json());
  if(r.error){out.innerHTML='<div class="note">error: '+esc(r.error)+'</div>';return;}
  // The whole sentence the owner pastes to the other agent — one button, one clipboard payload.
  const instruction='Read '+r.file+' and continue the work';
  out.innerHTML='<div class="note"><button class="act" id="hcopy" style="float:right;margin-top:-4px">⧉ Copy</button>handoff ready → <b style="color:var(--tx)">any agent</b> · '+esc(r.tokenLabel||('~'+Number(r.tokens||0).toLocaleString()+' tokens'))+'<br>Paste into any agent: <code>'+esc(instruction)+'</code></div>';
  out.querySelector("#hcopy").onclick=()=>copyText(instruction,"instruction copied — paste into any agent");
  // The click on "send handoff" is the user gesture, so this one is allowed;
  // if the browser refuses, the button above is still the way.
  try{navigator.clipboard.writeText(instruction).then(()=>toast("instruction copied — paste into any agent")).catch(()=>{})}catch(e){}
}
function renderPin(pin,warning){
  if(!pin)return '<div class="kv"><div class="k">pin</div><div>none (session cwd was not a readable git repo)</div></div>';
  let h='<div class="kv"><div class="k">remote</div><div>'+esc(pin.remote)+'</div>'
    +'<div class="k">branch</div><div>'+esc(pin.branch||"(detached)")+'</div>'
    +'<div class="k">HEAD</div><div>'+esc((pin.head||"").slice(0,12))+'</div>';
  if(pin.pr)h+='<div class="k">PR</div><div><a href="'+esc(pin.pr.url)+'" style="color:var(--info)" target="_blank">#'+pin.pr.number+' '+esc(pin.pr.title||"")+'</a></div>';
  h+='</div>';
  if(warning)h+='<div class="warn" style="margin-top:10px">⚠ '+esc(warning)+'</div>';
  return h;
}
function renderEgress(report){
  if(!report||!report.findings||!report.findings.length)return '<div class="ok" style="font-size:13px;margin-top:8px">nothing sensitive detected</div>';
  const rows=(action)=>report.findings.filter(f=>f.action===action).map(f=>'<div class="erow"><div>'+esc(f.kind)+'</div><div><span class="badge '+(action==="borderline"?"amber":"red")+'">'+action+'</span></div><div>'+f.count+'</div><code class="sample">'+esc((f.samples&&f.samples[0])||"")+'</code></div>').join("");
  let h='<div class="egroup"><div class="alabel">redacted</div>'+rows("redacted")+'</div>';
  if(report.borderlineCount>0)h+='<div class="egroup"><div class="alabel">needs review — masked anyway (fail-closed)</div>'+rows("borderline")+'</div>';
  return h;
}
async function openSharePanel(id){
  const root=document.getElementById("sharePanel");
  if(root.innerHTML){root.innerHTML="";return;}
  root.innerHTML='<div class="panel"><div class="gsub">building local preview…</div></div>';
  const r=await fetch("/api/session/"+encodeURIComponent(id)+"/share/preview",{method:"POST"}).then(x=>x.json());
  if(r.error){root.innerHTML='<div class="panel"><div class="err">'+esc(r.error)+'</div></div>';return;}
  let h='<div class="panel"><div class="hrow"><b style="font-weight:500">Share review</b><span style="flex:1"></span><button class="chip" id="shareCancel">Cancel</button></div>';
  h+='<div class="alabel" style="margin-top:12px">what\\'s being sent</div><div class="kv">'
    +'<div class="k">session</div><div>'+esc(r.title)+'</div>'
    +'<div class="k">contents</div><div>'+r.sessions+' sub-sessions · '+fmt(r.events)+' events · '+fmtBytes(r.gzBytes)+'</div></div>';
  h+='<div class="alabel" style="margin-top:14px">egress report</div>'+renderEgress(r.report);
  h+='<div class="alabel" style="margin-top:14px">pin</div>'+renderPin(r.pin,r.warning);
  h+='<div class="hrow" style="margin-top:14px"><button class="act" id="shareWrite">Write package</button><span class="gsub">local file only; carafe never transmits</span></div></div>';
  root.innerHTML=h;
  root.querySelector("#shareCancel").onclick=()=>{root.innerHTML=""};
  root.querySelector("#shareWrite").onclick=async()=>{
    root.querySelector("#shareWrite").textContent="writing…";
    const w=await fetch("/api/session/"+encodeURIComponent(id)+"/share/write",{method:"POST"}).then(x=>x.json());
    if(w.error){root.innerHTML='<div class="panel"><div class="err">'+esc(w.error)+'</div></div>';return;}
    root.innerHTML='<div class="panel"><div class="ok" style="font-weight:500">package written</div>'
      +'<div class="note"><code class="path" id="sharePath">'+esc(w.path)+'</code><br>'+fmtBytes(w.bytes)+'</div>'
      +'<div class="gsub">send this file yourself — carafe never transmits. They run: <code class="path">carafe receive '+esc(w.path.split("/").pop())+'</code></div></div>';
    root.querySelector("#sharePath").onclick=()=>copyText(w.path,"path copied");
  };
}
function ledgerColor(t){return({idea:"#888780",reframe:"var(--cc)",decision:"var(--cc)",signal:"#378ADD",outcome:"var(--cx)",open:"#EF9F27"}[t]||"var(--tx3)")}
function renderLedger(root,ledger){
  let h='<div class="ledger-head">✦ decision timeline <a href="#" id="redistill">re-distill</a></div><div class="ledger-list">';
  for(const n of ledger.nodes||[]){
    const c=ledgerColor(n.type);
    h+='<div class="lnode" data-seq="'+Number(n.seq&&n.seq[0]||0)+'"><span class="ldot" style="background:'+c+'"></span>'
      +'<button class="undo-link" data-seq="'+Number(n.seq&&n.seq[0]||0)+'">⟲ undo to here</button>'
      +'<div class="ltype" style="color:'+c+'">'+esc(n.type)+'</div><div class="ltitle">'+esc(n.title)+'</div><div class="lwhy">'+esc(n.why)+'</div></div>';
  }
  h+='</div>';
  root.innerHTML=h;
  root.querySelectorAll(".lnode").forEach(n=>n.onclick=()=>window.__jump&&window.__jump(Number(n.getAttribute("data-seq"))));
  root.querySelectorAll(".undo-link").forEach(b=>b.onclick=(e)=>{e.stopPropagation();openUndoPlan(root.getAttribute("data-id"),Number(b.getAttribute("data-seq")))});
  const rd=root.querySelector("#redistill");
  if(rd)rd.onclick=(e)=>{e.preventDefault();distillLedger(root,root.getAttribute("data-id"),true)};
}
async function loadLedger(id){
  const root=document.getElementById("ledger");if(!root)return;root.setAttribute("data-id",id);
  const r=await fetch("/api/session/"+encodeURIComponent(id)+"/ledger").then(x=>x.json());
  if(r.error){root.innerHTML='<div class="ledger-head">✦ decision timeline</div><div class="note">error: '+esc(r.error)+'</div>';return;}
  if(r.nodes){renderLedger(root,r);return;}
  const p=r.preview||{approxTokens:0,estUsd:0};
  root.innerHTML='<div class="ledger-head">✦ decision timeline</div><button class="act" id="distillbtn" style="margin-top:10px">✦ Distill decision timeline (~$'+Number(p.estUsd||0).toFixed(2)+' · '+fmt(Math.round(p.approxTokens||0))+' tokens)</button>';
  root.querySelector("#distillbtn").onclick=()=>distillLedger(root,id,false);
}
function kmColor(kind){return({goal:"#378ADD",ask:"#378ADD",decision:"var(--cc)",rule:"var(--cc)",breakthrough:"var(--cx)",finding:"var(--cx)",deadend:"#EF9F27",artifact:"var(--cx)",wip:"#888780"}[kind]||"var(--tx3)")}
function kmLabel(m){if(m.kind==="ask")return"steering";if(m.kind==="breakthrough")return"breakthrough";if(m.kind==="rule")return"rule";if(m.kind==="deadend")return"dead end";if(m.kind==="artifact")return /pr-link|gh pr|\\/pull\\//i.test(m.text||"")?"pr":"commit";return m.kind}
function kmChapterHeadline(ch){
  const f=["Ch "+Number(ch.index||0)],sd=(ch.startTs||"").slice(0,10),ed=(ch.endTs||"").slice(0,10);
  if(sd&&ed)f.push(sd===ed?sd:sd+" → "+(sd.slice(0,5)===ed.slice(0,5)?ed.slice(5):ed));else if(sd||ed)f.push(sd||ed);
  const cnt=(n,s)=>Number(n||0)+" "+s+(Number(n)===1?"":"s");if(ch.branch)f.push(ch.branch);f.push(cnt(ch.turns,"turn"));
  if(ch.commits)f.push(cnt(ch.commits,"commit"));if(ch.failures)f.push(cnt(ch.failures,"failure"));
  if((ch.files||[]).length)f.push(ch.files.map(x=>x.name).join(", "));f.push("[seq "+Number(ch.startSeq||0)+"–"+Number(ch.endSeq||0)+"]");return f.join(" · ");
}
function renderKeyMoments(root,data){
  let h='<div class="ledger-head">◆ key moments <button class="act" id="kmcopy" style="float:right;margin-top:-4px">⧉ Copy resume block</button></div><div class="ledger-list">';
  const rules=(data.moments||[]).filter(x=>x.kind==="rule");
  if(rules.length){
    h+='<div class="kmchapter">Standing rules</div>';
    for(const m of rules){
      const c=kmColor(m.kind),seq=Number(m.seq||0);
      h+='<div class="lnode" data-seq="'+seq+'"><span class="ldot" style="background:'+c+'"></span>'
        +'<button class="undo-link" data-seq="'+seq+'">⟲ undo to here</button>'
        +'<div class="ltype" style="color:'+c+'">'+esc(kmLabel(m))+'</div><div class="ltitle">'+esc(m.text||"")+'</div>'
        +(m.note?'<div class="lwhy">'+esc(m.note)+'</div>':'')+'</div>';
    }
  }
  for(const ch of data.chapters||[]){
    h+='<div class="kmchapter">'+esc(kmChapterHeadline(ch))+'</div>';
    for(const m of (data.moments||[]).filter(x=>Number(x.chapter)===Number(ch.index))){
      const c=kmColor(m.kind),seq=Number(m.seq||0);
      h+='<div class="lnode" data-seq="'+seq+'"><span class="ldot" style="background:'+c+'"></span>'
        +'<button class="undo-link" data-seq="'+seq+'">⟲ undo to here</button>'
        +'<div class="ltype" style="color:'+c+'">'+esc(kmLabel(m))+'</div><div class="ltitle">'+esc(m.text||"")+'</div>'
        +(m.note?'<div class="lwhy">'+esc(m.note)+'</div>':'')+'</div>';
    }
  }
  if(!(data.moments||[]).length)h+='<div class="empty">no key moments yet</div>';
  h+='</div>';
  if(data.trimmed)h+='<div class="gsub" style="margin-top:8px">'+Number(data.trimmed)+' moment(s) trimmed across chapters; raise with --budget</div>';
  root.innerHTML=h;
  root.querySelector("#kmcopy").onclick=()=>copyText(data.resumeBlock||"","resume block copied");
  root.querySelectorAll(".lnode").forEach(n=>n.onclick=()=>window.__jump&&window.__jump(Number(n.getAttribute("data-seq"))));
  root.querySelectorAll(".undo-link").forEach(b=>b.onclick=(e)=>{e.stopPropagation();openUndoPlan(root.getAttribute("data-id"),Number(b.getAttribute("data-seq")))});
}
async function loadKeyMoments(id){
  const root=document.getElementById("keymoments");if(!root)return;root.setAttribute("data-id",id);
  const r=await fetch("/api/session/"+encodeURIComponent(id)+"/key-moments").then(x=>x.json());
  if(r.error){root.innerHTML='<div class="ledger-head">◆ key moments</div><div class="note">error: '+esc(r.error)+'</div>';return;}
  renderKeyMoments(root,r);
}
async function distillLedger(root,id,force){
  const btn=root.querySelector("#distillbtn");
  if(btn)btn.textContent="distilling… (may take a minute)";
  else root.innerHTML='<div class="ledger-head">✦ decision timeline</div><div class="note">distilling… (may take a minute)</div>';
  const r=await fetch("/api/session/"+encodeURIComponent(id)+"/distill"+(force?"?force=1":""),{method:"POST"}).then(x=>x.json());
  if(r.error){root.innerHTML='<div class="ledger-head">✦ decision timeline</div><div class="note">error: '+esc(r.error)+'</div>';return;}
  renderLedger(root,r);
}
async function toggleSubBox(sr){
  const cid=sr.getAttribute("data-id"),title=sr.getAttribute("data-title")||cid;
  const arrow=sr.querySelector("span:nth-child(2)");
  let box=sr.nextElementSibling;
  if(box&&box.classList.contains("subbox")){
    const show=box.style.display==="none";
    box.style.display=show?"block":"none";
    if(arrow)arrow.textContent=(show?"▾ ":"▸ ")+title;
    return;
  }
  box=el('<div class="subbox"><div class="sbh"><span class="dot" style="background:var(--cx)"></span>'
    +'<span style="flex:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(title)+'</span>'
    +'<a href="#" class="sbfull" style="color:var(--info);font-size:12px;text-decoration:none;flex-shrink:0">open full ↗</a>'
    +'<span class="sbmin" style="color:var(--tx3);font-size:12px;flex-shrink:0">minimize —</span></div>'
    +'<div class="sbc"><div class="empty">loading…</div></div></div>');
  sr.after(box);
  if(arrow)arrow.textContent="▾ "+title;
  const sbc=box.querySelector(".sbc");
  const minify=()=>{const show=sbc.style.display==="none";sbc.style.display=show?"block":"none";box.querySelector(".sbmin").textContent=show?"minimize —":"expand +"};
  box.querySelector(".sbmin").onclick=(e)=>{e.stopPropagation();minify()};
  box.querySelector(".sbh").onclick=(e)=>{if(e.target.classList.contains("sbfull"))return;minify()};
  box.querySelector(".sbfull").onclick=(e)=>{e.preventDefault();e.stopPropagation();openSession(cid,null)};
  const r=await fetch("/api/session/"+encodeURIComponent(cid)).then(x=>x.json());
  sbc.innerHTML="";
  if(r.error){sbc.innerHTML='<div class="empty">'+esc(r.error)+'</div>';return;}
  const b=buildNodes(r.pieces);
  sbc.appendChild(b.frag);
  if(r.view!=="full")sbc.appendChild(el('<div class="empty" style="padding:8px">big sub-session — showing a window; open full ↗ for all of it</div>'));
}
function bucketHtml(name,lines){
  let h='<div class="bucket"><h3>'+name+': '+lines.length+'</h3>';
  lines.slice(0,40).forEach(x=>{h+='<div>'+esc(x)+'</div>'});
  if(lines.length>40)h+='<div>... '+(lines.length-40)+' more</div>';
  return h+'</div>';
}
async function openUndoPlan(id,seq){
  const root=document.getElementById("modalRoot");root.style.display="flex";
  root.innerHTML='<div class="modal"><div class="gsub">planning undo…</div></div>';
  const r=await fetch("/api/session/"+encodeURIComponent(id)+"/undo/plan?seq="+encodeURIComponent(seq)).then(x=>x.json());
  if(r.error){root.innerHTML='<div class="modal"><div class="err">'+esc(r.error)+'</div><div class="hrow" style="margin-top:12px"><button class="chip" id="modalClose">Close</button></div></div>';root.querySelector("#modalClose").onclick=closeModal;return;}
  const p=r.plan,dl=p.detailLines||{restore:[],unchanged:[],moveToStash:[]};
  let h='<div class="modal"><div class="hrow"><b style="font-weight:500">Undo to seq '+seq+'</b><span style="flex:1"></span><button class="chip" id="modalClose">Close</button></div>';
  h+='<div class="kv" style="margin-top:12px"><div class="k">checkpoint</div><div>seq '+p.checkpointSeq+'</div><div class="k">source</div><div>'+esc(p.source)+'</div></div>';
  (p.warnings||[]).forEach(w=>{h+='<div class="warn" style="margin-top:10px">'+esc(w)+'</div>'});
  (p.errors||[]).forEach(e=>{h+='<div class="err" style="margin-top:10px">'+esc(e)+'</div>'});
  h+=bucketHtml("restore",dl.restore)+bucketHtml("unchanged",dl.unchanged)+bucketHtml("move-to-stash",dl.moveToStash);
  h+='<div class="note">nothing is deleted — every current version is preserved in the pre-undo stash</div>';
  h+='<div class="hrow" style="margin-top:12px">'+(!(p.errors&&p.errors.length)?'<button class="act" id="undoApply">Apply undo</button>':'')+'<button class="chip" id="undoCancel">Cancel</button></div></div>';
  root.innerHTML=h;
  root.querySelector("#modalClose").onclick=closeModal;
  root.querySelector("#undoCancel").onclick=closeModal;
  const btn=root.querySelector("#undoApply");
  if(btn)btn.onclick=async()=>{
    btn.textContent="applying…";
    const a=await fetch("/api/session/"+encodeURIComponent(id)+"/undo",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({seq})}).then(x=>x.json());
    if(a.error){root.innerHTML='<div class="modal"><div class="err">'+esc(a.error)+'</div><div class="hrow" style="margin-top:12px"><button class="chip" id="modalClose">Close</button></div></div>';root.querySelector("#modalClose").onclick=closeModal;return;}
    root.innerHTML='<div class="modal"><div class="ok" style="font-weight:500">undo applied</div>'
      +'<div class="kv" style="margin-top:12px"><div class="k">restored</div><div>'+a.restored+' files</div><div class="k">moved</div><div>'+a.moved+' files</div>'
      +'<div class="k">stash</div><div><code class="path" id="stashPath">'+esc(a.stashDir)+'</code></div>'
      +'<div class="k">brief</div><div><code class="path" id="briefPath">'+esc(a.briefPath)+'</code></div></div>'
      +'<div class="note">start fresh: Read <code class="path">'+esc(a.briefPath)+'</code> and continue from where it ends.</div>'
      +'<div class="hrow" style="margin-top:12px"><button class="chip" id="modalClose">Close</button></div></div>';
    root.querySelector("#stashPath").onclick=()=>copyText(a.stashDir,"stash path copied");
    root.querySelector("#briefPath").onclick=()=>copyText(a.briefPath,"brief path copied");
    root.querySelector("#modalClose").onclick=closeModal;
  };
}
function closeModal(){const root=document.getElementById("modalRoot");root.style.display="none";root.innerHTML=""}
function receiveShell(){
  return '<div class="hrow"><b style="font-weight:500">Receive</b><span style="flex:1"></span><button class="chip" id="receiveClose">Close</button></div>'
    +'<div class="note" id="receiveDrop" style="margin-top:12px"><input type="file" id="receiveFile" accept=".carafe"/><div class="gsub" style="margin-top:8px">drop a .carafe file here</div></div>'
    +'<div id="receiveOut"></div>';
}
function openReceive(){
  const p=document.getElementById("receivePanel");
  p.style.display=p.style.display==="block"?"none":"block";
  if(p.style.display!=="block")return;
  p.innerHTML=receiveShell();
  p.querySelector("#receiveClose").onclick=()=>{p.style.display="none"};
  const file=p.querySelector("#receiveFile"),drop=p.querySelector("#receiveDrop");
  file.onchange=()=>{if(file.files&&file.files[0])previewReceive(file.files[0])};
  drop.ondragover=(e)=>{e.preventDefault();p.classList.add("drag")};
  drop.ondragleave=()=>p.classList.remove("drag");
  drop.ondrop=(e)=>{e.preventDefault();p.classList.remove("drag");const f=e.dataTransfer.files&&e.dataTransfer.files[0];if(f)previewReceive(f)};
}
async function previewReceive(file){
  const out=document.getElementById("receiveOut");out.innerHTML='<div class="gsub" style="margin-top:12px">reading package…</div>';
  const r=await fetch("/api/receive/preview",{method:"POST",body:await file.arrayBuffer()}).then(x=>x.json());
  if(r.error){out.innerHTML='<div class="err" style="margin-top:12px">'+esc(r.error)+'</div>';return;}
  const s=r.summary,pin=s.pin;
  const checkout=pin?(pin.branch?'git fetch && git checkout '+pin.branch:'git fetch && git checkout '+pin.head):'';
  let h='<div class="panel"><div class="kv"><div class="k">sender</div><div>'+esc(s.sender)+'</div><div class="k">created</div><div>'+esc(s.createdAt)+'</div><div class="k">title</div><div>'+esc(s.title)+'</div><div class="k">contents</div><div>'+s.sessions+' sessions · '+fmt(s.events)+' events</div></div>';
  if(s.warning)h+='<div class="warn" style="margin-top:10px">⚠ '+esc(s.warning)+'</div>';
  if(pin)h+='<div class="alabel" style="margin-top:12px">pin</div>'+renderPin(pin,null)+'<div class="note">checkout hint: <code class="path" id="checkoutHint">'+esc(checkout)+'</code></div>';
  else h+='<div class="note">pin: none</div>';
  h+='<div class="gsub" style="margin-top:10px">'+s.egressTotals.redactions+' redactions were applied before this left the sender\\'s machine</div>';
  h+='<div class="hrow" style="margin-top:12px"><button class="act" id="receiveImport">Import</button></div></div>';
  out.innerHTML=h;
  const hint=out.querySelector("#checkoutHint");if(hint)hint.onclick=()=>copyText(checkout,"checkout hint copied");
  out.querySelector("#receiveImport").onclick=()=>importReceive(r.token,false);
}
async function importReceive(token,force){
  const out=document.getElementById("receiveOut");out.innerHTML='<div class="gsub" style="margin-top:12px">importing…</div>';
  const r=await fetch("/api/receive/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,force})}).then(x=>x.json());
  if(r.error){out.innerHTML='<div class="err" style="margin-top:12px">'+esc(r.error)+'</div>';return;}
  await load();
  let h='<div class="panel"><div class="ok" style="font-weight:500">receive complete</div><div class="kv" style="margin-top:10px"><div class="k">imported</div><div>'+r.imported+'</div><div class="k">skipped</div><div>'+r.skipped+'</div><div class="k">overwritten</div><div>'+(r.forced||0)+'</div></div>';
  if(r.imported===0&&(r.forced||0)===0&&r.skipped>0)h+='<div class="note">everything was skipped because local copies already exist.</div><div class="hrow"><button class="act" id="receiveForce">Import again with overwrite</button><span class="gsub">overwrite existing copies</span></div>';
  else h+='<div class="hrow" style="margin-top:12px"><button class="act" id="openImported">Open imported session</button></div>';
  h+='</div>';out.innerHTML=h;
  const forceBtn=out.querySelector("#receiveForce");if(forceBtn)forceBtn.onclick=()=>importReceive(token,true);
  const openBtn=out.querySelector("#openImported");if(openBtn)openBtn.onclick=()=>{document.getElementById("receivePanel").style.display="none";openSession(r.mainSessionId,null)};
}
function deb(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
document.getElementById("q").oninput=deb(load,180);
// refresh the list when you return to the tab — the server keeps ~/.carafe current,
// this makes the VIEW current too without a manual reload
window.addEventListener("focus",()=>{if(activeView==="sessions"&&!document.getElementById("q").value.trim())load()});
document.querySelectorAll("#tabs .chip").forEach(c=>c.onclick=()=>switchView(c.getAttribute("data-view")));
if(OFF.has("share"))document.getElementById("receiveTop").remove();else document.getElementById("receiveTop").onclick=openReceive;
document.querySelectorAll("header .chip[data-tool]").forEach(c=>c.onclick=()=>{document.querySelectorAll("header .chip[data-tool]").forEach(x=>x.classList.remove("on"));c.classList.add("on");tool=c.dataset.tool;load()});
load();
</script></body></html>`;

const PRO_FEATURES = ["share", "distill"] as const;

/** The page as served. With every Carafe Pro feature present it is exactly
 *  HTML; otherwise the body names the missing ones and the script leaves their
 *  buttons out instead of showing controls that could only fail. */
export function pageHtml(features: readonly string[]): string {
  const off = PRO_FEATURES.filter((f) => !features.includes(f));
  if (!off.length) return HTML;
  return HTML.replace("<body>", `<body data-off="${off.join(" ")}">`);
}
