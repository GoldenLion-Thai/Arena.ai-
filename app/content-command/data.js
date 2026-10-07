/* CONTENT COMMAND — mock data layer (no backend, no credentials, UI/demo prototype)
   Source record IDs (REC-xxx) are referenced by the Intelligence Agent for citation. */
const DATA = {
  meta: {
    account: "SFG-OPERATIONS",
    window: "2026-09-15 → 2026-09-29",
    ingestionHealth: "SYNCED",
    lastSync: "2026-09-29T14:02:00Z"
  },

  // ---- DASHBOARD SIGNAL CARDS ----
  signals: [
    { cap: "DEMAND SIGNAL",      value: "8.4",   unit: "/10",  tone: "active"  },
    { cap: "OUTLIERS DETECTED",  value: "214",   unit: "this window", tone: "pos" },
    { cap: "CONTENT FATIGUE",    value: "31",    unit: "%",    tone: "warn"  },
    { cap: "INGESTION HEALTH",   value: "SYNCED",unit: "",     tone: "neutral"}
  ],

  // ---- CONTENT LIBRARY ----
  library: [
    { id:"REC-201", title:"OPEN: MORNING RITUAL UNDER 30S", platform:"SHORTS", views:"1.42M", outlier:0.94, fatigue:"LOW", tags:["ritual","gen-z","short"] },
    { id:"REC-202", title:"OPEN: BENCH SETUP REVEAL",        platform:"INSTAGRAM", views:"620,000", outlier:0.81, fatigue:"MED", tags:["setup","aesthetic"] },
    { id:"REC-203", title:"LONG: B2B OUTREACH GUIDE",     platform:"POSTS", views:"88,000",  outlier:0.72, fatigue:"LOW", tags:["b2b","outreach","icp"] },
    { id:"REC-204", title:"OPEN: 3 SEC BEAUTY FIX",          platform:"SHORTS", views:"2.10M", outlier:0.97, fatigue:"HIGH",tags:["beauty","fast"] },
    { id:"REC-205", title:"CAROUSEL: TAX SAVINGS 2026",      platform:"INSTAGRAM", views:"410,000", outlier:0.66, fatigue:"LOW", tags:["finance","list"] },
    { id:"REC-206", title:"OPEN: QUIET QUITTING RESPONSE",   platform:"POSTS", views:"305,000", outlier:0.78, fatigue:"MED", tags:["culture","reply"] },
    { id:"REC-207", title:"OPEN: CAMPING ON A BUDGET",       platform:"YOUTUBE", views:"540,000", outlier:0.69, fatigue:"LOW", tags:["outdoor","budget"] },
    { id:"REC-208", title:"LONG: FOUNDER STORY DOC",         platform:"YOUTUBE", views:"190,000", outlier:0.74, fatigue:"LOW", tags:["story","brand"] }
  ],

  // ---- COMPETITOR RADAR ----
  competitors: [
    { id:"CMP-01", name:"NORTHBEAM MEDIA", sov:28.4, delta:+3.1, content:142, tier:"LEAD" },
    { id:"CMP-02", name:"AXIS CONTENT LAB", sov:19.7, delta:-1.2, content:98,  tier:"CHASE" },
    { id:"CMP-03", name:"ORBIT STUDIO",     sov:15.2, delta:+0.6, content:76,  tier:"CHASE" },
    { id:"CMP-04", name:"VERTEX POSTS",     sov:11.0, delta:-0.4, content:54,  tier:"TRAIL" },
    { id:"CMP-05", name:"MERIDIAN MEDIA",   sov:8.9,  delta:+1.8, content:41,  tier:"TRAIL" }
  ],

  // ---- IDEA SCORER ----
  ideas: [
    { id:"IDEA-01", title:"30S MICRO-RITUAL SERIES", icpFit:0.91, novelty:0.74, demand:0.88, status:"QUEUED" },
    { id:"IDEA-02", title:"B2B COLD REPLY TEMPLATES", icpFit:0.86, novelty:0.55, demand:0.82, status:"QUEUED" },
    { id:"IDEA-03", title:"BUDGET CAMP SETUP REEL",  icpFit:0.70, novelty:0.81, demand:0.79, status:"DRAFT" },
    { id:"IDEA-04", title:"FOUNDER FAILS MONTAGE",   icpFit:0.62, novelty:0.90, demand:0.71, status:"DRAFT" },
    { id:"IDEA-05", title:"TAX LIST CAROUSEL V2",    icpFit:0.83, novelty:0.48, demand:0.84, status:"QUEUED" },
    { id:"IDEA-06", title:"QUIET QUIT REPLY PART2",  icpFit:0.77, novelty:0.66, demand:0.80, status:"DRAFT" }
  ],

  // ---- BRIEF / SLATE ----
  brief: {
    week:"W39 — 2026-09-29",
    summary:"DEMAND SURGING IN RITUAL + BUDGET VERTICALS. FATIGUE RISING ON BEAUTY FAST-CLIPS. RECOMMEND 3 PUBLISHES, HOLD BEAUTY.",
    slate:[
      { id:"IDEA-01", publish:"MON", score:0.87, action:"PUBLISH" },
      { id:"IDEA-05", publish:"WED", score:0.82, action:"PUBLISH" },
      { id:"IDEA-03", publish:"FRI", score:0.79, action:"PUBLISH" },
      { id:"REC-204", publish:"—",   score:0.97, action:"HOLD-FATIGUE" }
    ]
  },

  // ---- INTELLIGENCE AGENT SOURCE ONTOLOGY ----
  sources: [
    { id:"REC-201", type:"CONTENT",   field:"outlier_score", value:"0.94", note:"TOP SHORTS OUTLIER" },
    { id:"REC-204", type:"CONTENT",   field:"fatigue",       value:"HIGH", note:"BEAUTY FAST-CLIP FATIGUE" },
    { id:"CMP-01",  type:"COMPETITOR",field:"share_of_voice",value:"28.4", note:"LEAD POSITION" },
    { id:"IDEA-01", type:"IDEA",      field:"icp_fit",       value:"0.91", note:"HIGHEST ICP FIT" },
    { id:"IDEA-05", type:"IDEA",      field:"demand",        value:"0.84", note:"TAX LIST DEMAND" }
  ],

  // ---- SOURCES / API CONNECTION CARDS ----
  connections: [
    { id:"API-01", name:"SHORTS ADS API",     health:"ONLINE",  last:"2026-09-29T14:00Z", scope:"READ-ONLY" },
    { id:"API-02", name:"INSTAGRAM GRAPH",    health:"ONLINE",  last:"2026-09-29T13:58Z", scope:"READ-ONLY" },
    { id:"API-03", name:"POSTS API",       health:"DEGRADED",last:"2026-09-29T12:10Z", scope:"READ-ONLY" },
    { id:"API-04", name:"YOUTUBE DATA API",   health:"ONLINE",  last:"2026-09-29T14:01Z", scope:"READ-ONLY" },
    { id:"API-05", name:"LLM ENRICHMENT",     health:"ONLINE",  last:"2026-09-29T14:02Z", scope:"INFERENCE" }
  ]
};

// Agent responder — rule-based over ontology, always cites source record IDs, surfaces confidence.
function agentRespond(query){
  const q = (query||"").toLowerCase();
  const cited = [];
  let text, conf;
  if(/outlier|best|top|perform/.test(q)){
    text = "TOP OUTLIER IS REC-201 (OPEN: MORNING RITUAL) AT OUTLIER SCORE 0.94 ON SHORTS. REC-204 SHOWS HIGHEST RAW OUTLIER 0.97 BUT IS FATIGUED.";
    cited.push("REC-201","REC-204"); conf=0.93;
  } else if(/fatigue|burn|over/.test(q)){
    text = "FATIGUE IS HIGH ON BEAUTY FAST-CLIPS (REC-204). RECOMMEND HOLDING THAT FORMAT THIS WEEK PER BRIEF SLATE.";
    cited.push("REC-204","IDEA-03"); conf=0.88;
  } else if(/competitor|rival|share|voice/.test(q)){
    text = "LEAD COMPETITOR IS NORTHBEAM MEDIA AT 28.4% SHARE OF VOICE, UP 3.1 PTS. AXIS CONTENT LAB DECLINED 1.2 PTS.";
    cited.push("CMP-01","CMP-02"); conf=0.90;
  } else if(/icp|fit|audience/.test(q)){
    text = "HIGHEST ICP FIT IDEA IS IDEA-01 (30S MICRO-RITUAL SERIES) AT 0.91, WITH DEMAND 0.88.";
    cited.push("IDEA-01"); conf=0.85;
  } else if(/brief|slate|publish|week/.test(q)){
    text = "WEEKLY SLATE (W39) RECOMMENDS 3 PUBLISHES: IDEA-01 MON, IDEA-05 WED, IDEA-03 FRI. HOLD REC-204 FOR FATIGUE.";
    cited.push("IDEA-01","IDEA-05","REC-204"); conf=0.91;
  } else {
    text = "QUERY OUT OF ONTOLOGY. ROUTE TO: CONTENT / COMPETITOR / IDEA / BRIEF. I CITE ONLY STORED RECORD IDS.";
    conf=0.40;
  }
  return { text, cited, conf };
}
