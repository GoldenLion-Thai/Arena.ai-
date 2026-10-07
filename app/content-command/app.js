/* CONTENT COMMAND — app controller (vanilla SPA, no deps) */
(function(){
  "use strict";

  // angular nav glyphs — rect / line / polyline only, no curves
  const GLYPH = {
    dashboard:'<svg class="glyph" viewBox="0 0 18 18"><rect x="2" y="11" width="3" height="5"/><rect x="7" y="7" width="3" height="9"/><rect x="12" y="3" width="3" height="13"/></svg>',
    library:'<svg class="glyph" viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="4"/><rect x="2" y="8" width="14" height="4"/><rect x="2" y="14" width="14" height="2"/></svg>',
    radar:'<svg class="glyph" viewBox="0 0 18 18"><polyline points="9,2 16,9 9,16 2,9 9,2"/><line x1="9" y1="2" x2="9" y2="16"/><line x1="2" y1="9" x2="16" y2="9"/></svg>',
    scorer:'<svg class="glyph" viewBox="0 0 18 18"><rect x="2" y="9" width="3" height="7"/><rect x="7" y="5" width="3" height="11"/><rect x="12" y="11" width="3" height="5"/></svg>',
    brief:'<svg class="glyph" viewBox="0 0 18 18"><rect x="3" y="2" width="12" height="14"/><line x1="6" y1="6" x2="12" y2="6"/><line x1="6" y1="9" x2="12" y2="9"/><line x1="6" y1="12" x2="10" y2="12"/></svg>',
    agent:'<svg class="glyph" viewBox="0 0 18 18"><rect x="2" y="2" width="6" height="6"/><rect x="10" y="10" width="6" height="6"/><line x1="8" y1="5" x2="10" y2="10"/><line x1="5" y1="8" x2="10" y2="10"/></svg>',
    sources:'<svg class="glyph" viewBox="0 0 18 18"><rect x="6" y="2" width="6" height="6"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="4" y1="13" x2="14" y2="13"/><line x1="4" y1="16" x2="14" y2="16"/></svg>'
  };

  const MODULES = [
    { id:"dashboard", label:"COMMAND DASHBOARD", glyph:GLYPH.dashboard },
    { id:"library",   label:"CONTENT LIBRARY",   glyph:GLYPH.library },
    { id:"radar",     label:"COMPETITOR RADAR",  glyph:GLYPH.radar },
    { id:"scorer",    label:"IDEA SCORER",       glyph:GLYPH.scorer },
    { id:"brief",     label:"BRIEF GENERATOR",   glyph:GLYPH.brief },
    { id:"agent",     label:"INTELLIGENCE AGENT",glyph:GLYPH.agent },
    { id:"sources",   label:"SOURCES",           glyph:GLYPH.sources }
  ];

  const state = { module:"dashboard", collapsed:false, density:"comfortable", sort:{} };
  const nav = document.getElementById("nav");
  const view = document.getElementById("view");
  const crumb = document.getElementById("crumb");
  const sidebar = document.getElementById("sidebar");
  const detail = document.getElementById("detail");

  // ---- NAV ----
  MODULES.forEach(m=>{
    const b = document.createElement("button");
    b.className = "nav-item" + (m.id===state.module?" active":"");
    b.dataset.id = m.id;
    b.innerHTML = m.glyph + '<span class="label">'+m.label+'</span>';
    b.onclick = ()=>go(m.id);
    nav.appendChild(b);
  });

  function go(id){
    state.module = id;
    [...nav.children].forEach(c=>c.classList.toggle("active", c.dataset.id===id));
    const m = MODULES.find(x=>x.id===id);
    crumb.textContent = m.label;
    render();
  }

  // ---- SIDEBAR TOGGLES ----
  document.getElementById("collapseBtn").innerHTML =
    '<svg viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="2"/><rect x="2" y="8" width="14" height="2"/><rect x="2" y="13" width="14" height="2"/></svg>';
  document.getElementById("collapseBtn").onclick = ()=>{
    state.collapsed = !state.collapsed;
    sidebar.classList.toggle("collapsed", state.collapsed);
  };
  const densityBtn = document.getElementById("densityBtn");
  const densityLabel = document.getElementById("densityLabel");
  densityBtn.innerHTML = '<svg viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="3"/><rect x="2" y="9" width="14" height="3"/><rect x="2" y="15" width="14" height="1"/></svg>';
  densityBtn.onclick = ()=>{
    state.density = state.density==="comfortable" ? "compact" : "comfortable";
    document.body.dataset.density = state.density;
    densityLabel.textContent = "DENSITY: " + (state.density==="comfortable"?"COMFORT":"COMPACT");
  };

  // ---- TOP STATUS ----
  document.getElementById("topStatus").innerHTML =
    '<span><span class="dot"></span>SYNC '+DATA.meta.ingestionHealth+'</span>'+
    '<span>ACCT '+DATA.meta.account+'</span>'+
    '<span>WIN '+DATA.meta.window+'</span>';

  // ---- HELPERS ----
  function el(html){ const t=document.createElement("template"); t.innerHTML=html.trim(); return t.content.firstChild; }
  function badge(tone,txt){ return '<span class="badge '+tone+'">'+txt+'</span>'; }
  function bar(v){ return '<div class="bar"><i style="width:'+Math.round(v*100)+'%"></i></div>'; }
  function toneForFatigue(f){ return f==="HIGH"?"warn":f==="MED"?"neutral":"pos"; }

  // generic table builder with click-sort + row detail
  function buildTable(cols, rows, onRow, detailFor){
    state._col = state._col || cols[0].key;
    const dir = state.sort[state.module]||"desc";
    const arr = rows.slice().sort((a,b)=>{
      let x=a[state._col], y=b[state._col];
      if(typeof x==="string") return dir==="asc"?x.localeCompare(y):y.localeCompare(x);
      return dir==="asc"?x-y:y-x;
    });
    let html = '<table class="table"><thead><tr>';
    cols.forEach(c=>{
      const arrow = c.key===state._col ? (dir==="asc"?" ▲":" ▼") : "";
      html += '<th data-col="'+c.key+'">'+c.label+arrow+'</th>';
    });
    html += '</tr></thead><tbody>';
    arr.forEach(r=>{
      html += '<tr data-id="'+r.id+'">';
      cols.forEach(c=>{
        const v = c.render ? c.render(r[c.key], r) : r[c.key];
        const cls = c.num ? ' class="num"' : '';
        html += '<td'+cls+'>'+v+'</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    const wrap = el('<div>'+html+'</div>');
    wrap.querySelectorAll("th").forEach(th=>{
      th.onclick = ()=>{ state._col = th.dataset.col; state.sort[state.module] = state.sort[state.module]==="asc"?"desc":"asc"; render(); };
    });
    wrap.querySelectorAll("tr[data-id]").forEach(tr=>{
      tr.onclick = ()=>{
        wrap.querySelectorAll("tr").forEach(x=>x.classList.remove("sel"));
        tr.classList.add("sel");
        openDetail(detailFor(tr.dataset.id));
      };
    });
    return wrap;
  }

  function openDetail(node){
    detail.innerHTML = "";
    const panel = el('<div class="detail-panel"></div>');
    const close = el('<button class="icon-btn close-x" title="CLOSE"><svg viewBox="0 0 18 18"><line x1="3" y1="3" x2="15" y2="15"/><line x1="15" y1="3" x2="3" y2="15"/></svg></button>');
    close.onclick = ()=>{ detail.hidden = true; detail.innerHTML=""; };
    panel.appendChild(close);
    panel.appendChild(node);
    detail.appendChild(panel);
    detail.hidden = false;
  }

  // ---- VIEWS ----
  function viewDashboard(){
    let html = '<div class="h1">COMMAND DASHBOARD</div><div class="sub">SIGNAL OVERVIEW · '+DATA.meta.window+'</div>';
    html += '<div class="grid grid-4">';
    DATA.signals.forEach(s=>{
      html += '<div class="card"><div class="cap">'+s.cap+'</div><div class="metric '+s.tone+'">'+s.value+' <span style="font-size:11px;color:var(--text-dim)">'+s.unit+'</span></div></div>';
    });
    html += '</div>';
    html += '<div class="section-title">DEMAND BY VERTICAL</div>';
    const verts = [["RITUAL",0.84],["BUDGET",0.79],["BEAUTY",0.71],["B2B",0.66],["FINANCE",0.62]];
    html += '<div class="grid grid-4">';
    verts.forEach(v=>{ html += '<div class="card"><div class="cap">'+v[0]+'</div>'+bar(v[1])+'<div class="cap" style="color:var(--active)">'+Math.round(v[1]*100)+'%</div></div>'; });
    html += '</div>';
    html += '<div class="section-title">TOP OUTLIERS</div>';
    const top = DATA.library.slice().sort((a,b)=>b.outlier-a.outlier).slice(0,4);
    const cols = [
      {key:"id",label:"REC"},
      {key:"title",label:"TITLE"},
      {key:"platform",label:"PLATFORM"},
      {key:"views",label:"VIEWS",num:true},
      {key:"outlier",label:"OUTLIER",num:true,render:v=>bar(v)},
      {key:"fatigue",label:"FATIGUE",render:v=>badge(toneForFatigue(v),v)}
    ];
    const node = buildTable(cols, top, null, id=>detailContent(id));
    const wrap = el('<div>'+html+'</div>');
    wrap.appendChild(node);
    return wrap;
  }

  function detailContent(id){
    const r = DATA.library.find(x=>x.id===id);
    const h = el('<div><h3>'+r.id+'</h3></div>');
    const dl = el('<dl class="kv"></dl>');
    [["TITLE",r.title],["PLATFORM",r.platform],["VIEWS",r.views],["OUTLIER",r.outlier.toFixed(2)],["FATIGUE",r.fatigue],["TAGS",r.tags.join(", ")]].forEach(p=>{
      dl.appendChild(el('<dt>'+p[0]+'</dt>')); dl.appendChild(el('<dd>'+p[1]+'</dd>'));
    });
    h.appendChild(dl);
    return h;
  }

  function viewLibrary(){
    let html = '<div class="h1">CONTENT LIBRARY</div><div class="sub">'+DATA.library.length+' LOGGED ITEMS · TAGS + PERFORMANCE</div>';
    const wrap = el('<div>'+html+'</div>');
    const cols = [
      {key:"id",label:"REC"},
      {key:"title",label:"TITLE"},
      {key:"platform",label:"PLATFORM"},
      {key:"views",label:"VIEWS",num:true},
      {key:"outlier",label:"OUTLIER",num:true,render:v=>bar(v)},
      {key:"fatigue",label:"FATIGUE",render:v=>badge(toneForFatigue(v),v)},
      {key:"tags",label:"TAGS",render:(v,r)=>r.tags.join(", ")}
    ];
    wrap.appendChild(buildTable(cols, DATA.library, null, id=>detailContent(id)));
    return wrap;
  }

  function detailComp(id){
    const r = DATA.competitors.find(x=>x.id===id);
    const h = el('<div><h3>'+r.id+'</h3></div>');
    const dl = el('<dl class="kv"></dl>');
    [["NAME",r.name],["SHARE OF VOICE",r.sov+"%"],["DELTA",(r.delta>0?"+":"")+r.delta+" pts"],["CONTENT COUNT",r.content],["TIER",r.tier]].forEach(p=>{
      dl.appendChild(el('<dt>'+p[0]+'</dt>')); dl.appendChild(el('<dd>'+p[1]+'</dd>'));
    });
    h.appendChild(dl);
    return h;
  }

  function viewRadar(){
    let html = '<div class="h1">COMPETITOR RADAR</div><div class="sub">PEER TRIANGULATION · SHARE OF VOICE</div>';
    const wrap = el('<div>'+html+'</div>');
    const cols = [
      {key:"id",label:"CMP"},
      {key:"name",label:"NAME"},
      {key:"sov",label:"SOV %",num:true,render:v=>bar(v/30)},
      {key:"delta",label:"DELTA",num:true,render:v=>(v>0?'+':'')+v},
      {key:"content",label:"CONTENT",num:true},
      {key:"tier",label:"TIER",render:v=>badge(v==="LEAD"?"active":v==="CHASE"?"neutral":"neutral",v)}
    ];
    wrap.appendChild(buildTable(cols, DATA.competitors, null, id=>detailComp(id)));
    return wrap;
  }

  function detailIdea(id){
    const r = DATA.ideas.find(x=>x.id===id);
    const h = el('<div><h3>'+r.id+'</h3></div>');
    const dl = el('<dl class="kv"></dl>');
    [["TITLE",r.title],["ICP FIT",r.icpFit.toFixed(2)],["NOVELTY",r.novelty.toFixed(2)],["DEMAND",r.demand.toFixed(2)],["COMPOSITE",( (r.icpFit+r.novelty+r.demand)/3 ).toFixed(2)],["STATUS",r.status]].forEach(p=>{
      dl.appendChild(el('<dt>'+p[0]+'</dt>')); dl.appendChild(el('<dd>'+p[1]+'</dd>'));
    });
    h.appendChild(dl);
    return h;
  }

  function viewScorer(){
    let html = '<div class="h1">IDEA SCORER</div><div class="sub">ICP-FIT RUBRIC · COMPOSITE = (ICP + NOVELTY + DEMAND) / 3</div>';
    const wrap = el('<div>'+html+'</div>');
    const cols = [
      {key:"id",label:"IDEA"},
      {key:"title",label:"TITLE"},
      {key:"icpFit",label:"ICP",num:true,render:v=>bar(v)},
      {key:"novelty",label:"NOVEL",num:true,render:v=>bar(v)},
      {key:"demand",label:"DEMAND",num:true,render:v=>bar(v)},
      {key:"status",label:"STATUS",render:v=>badge(v==="QUEUED"?"pos":"neutral",v)}
    ];
    wrap.appendChild(buildTable(cols, DATA.ideas, null, id=>detailIdea(id)));
    return wrap;
  }

  function viewBrief(){
    let html = '<div class="h1">BRIEF GENERATOR</div><div class="sub">'+DATA.brief.week+'</div>';
    html += '<div class="card"><div class="cap">SUMMARY</div><div style="color:var(--text)">'+DATA.brief.summary+'</div></div>';
    html += '<div class="section-title">RECOMMENDED SLATE</div>';
    const wrap = el('<div>'+html+'</div>');
    const cols = [
      {key:"id",label:"ID"},
      {key:"publish",label:"PUBLISH",num:true},
      {key:"score",label:"SCORE",num:true,render:v=>bar(v)},
      {key:"action",label:"ACTION",render:v=>badge(v.startsWith("HOLD")?"warn":"pos",v)}
    ];
    wrap.appendChild(buildTable(cols, DATA.brief.slate, null, id=>{
      const r = DATA.brief.slate.find(x=>x.id===id);
      const h = el('<div><h3>'+r.id+'</h3></div>');
      const dl = el('<dl class="kv"></dl>');
      [["PUBLISH",r.publish],["SCORE",r.score],["ACTION",r.action]].forEach(p=>{ dl.appendChild(el('<dt>'+p[0]+'</dt>')); dl.appendChild(el('<dd>'+p[1]+'</dd>')); });
      h.appendChild(dl); return h;
    }));
    return wrap;
  }

  function viewAgent(){
    let html = '<div class="h1">INTELLIGENCE AGENT</div><div class="sub">ONTOLOGY Q&A · CITED SOURCE RECORDS · CONFIDENCE SHOWN</div>';
    html += '<div class="agent-log" id="agentLog"></div>';
    html += '<div class="agent-input"><input id="agentIn" placeholder="QUERY: outliers / fatigue / competitors / icp / brief" /><button id="agentSend">SEND</button></div>';
    const wrap = el('<div>'+html+'</div>');
    const log = wrap.querySelector("#agentLog");
    const input = wrap.querySelector("#agentIn");
    function push(line, who){
      const d = el('<div class="agent-line '+(who==="USER"?"user":"")+'"></div>');
      d.innerHTML = '<span class="who">'+who+'</span><span>'+line.text+'</span>'+
        (line.cited&&line.cited.length?'<div class="cite">REF '+line.cited.join(", ")+' · CONF '+Math.round(line.conf*100)+'%</div>':'');
      log.appendChild(d); log.scrollTop = log.scrollHeight;
    }
    push({text:"AGENT ONLINE. I CITE ONLY STORED RECORD IDS. QUERY ABOUT OUTLIERS, FATIGUE, COMPETITORS, ICP, OR BRIEF.",conf:1});
    function send(){
      const q = input.value.trim(); if(!q) return;
      push({text:q}, "USER");
      push(agentRespond(q), "AGENT");
      input.value="";
    }
    wrap.querySelector("#agentSend").onclick = send;
    input.addEventListener("keydown", e=>{ if(e.key==="Enter") send(); });
    return wrap;
  }

  function viewSources(){
    let html = '<div class="h1">SOURCES</div><div class="sub">API CONNECTION CARDS · READ-ONLY SCOPE · HEALTH INDICATORS</div>';
    html += '<div class="grid grid-4">';
    DATA.connections.forEach(c=>{
      const tone = c.health==="ONLINE"?"pos":c.health==="DEGRADED"?"warn":"neutral";
      html += '<div class="card"><div class="cap">'+c.id+'</div><div style="color:var(--text)">'+c.name+'</div><div>'+badge(tone,c.health)+' <span class="cap" style="margin-left:6px">'+c.scope+'</span></div><div class="cap">LAST '+c.last+'</div></div>';
    });
    html += '</div>';
    return el('<div>'+html+'</div>');
  }

  const VIEWS = { dashboard:viewDashboard, library:viewLibrary, radar:viewRadar, scorer:viewScorer, brief:viewBrief, agent:viewAgent, sources:viewSources };

  function render(){
    view.innerHTML = "";
    view.appendChild(VIEWS[state.module]());
  }

  go(state.module);
})();
