/* ============================================================================
   wiki.js — the browser half of the KiNETiC-Ai wiki.

   It talks to the platform over the SAME ORIGIN: server.js proxies /platform/*
   to PLATFORM_URL, so the browser never makes a cross-origin request and no
   third party sees what you know. There is no local fallback content and no
   sample pages: when the platform is not running, the page says so and shows
   the command that starts it. A wiki that invents pages while the backend is
   down is the same mistake as a retrieval score nobody measured.

   Views: list · page · editor · history · results. State lives in `S` and every
   render is a pure function of it, so the smoke tests can drive the UI by
   calling refresh() against a stubbed fetch.
   ========================================================================== */

(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const MD = window.GRID_MD;
  const esc = (s) => (MD && MD.escape ? MD.escape(String(s ?? "")) : String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]));

  const API = "/platform"; // same-origin proxy in server.js
  const KEY_LS = "grid:platform.key"; // a bearer key is a secret: sessionStorage, not localStorage
  const PREF_LS = "grid:wiki"; // non-secret prefs only

  const S = {
    status: "checking", // checking | offline | nokey | ready | denied
    health: null,
    meta: null,
    key: null,
    appId: null,
    scopes: [],
    verticals: [],
    pages: [],
    filter: null,
    q: "",
    current: null, // the page being viewed
    revisions: [],
    stats: null,
    results: null,
    ask: null,
    reviews: [],
    quota: null,
    capacity: null,
    view: "list",
    editing: null, // { slug } | { create: true }
    message: null,
  };

  /* --------------------------------------------------------------- helpers
     Pure, exported, and tested: these decide what the UI claims. */

  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function groupByVertical(pages) {
    const out = {};
    for (const p of pages || []) (out[p.vertical] = out[p.vertical] || []).push(p);
    for (const k of Object.keys(out)) out[k].sort((a, b) => (a.title > b.title ? 1 : -1));
    return out;
  }

  function formatGB(gb) {
    const n = Number(gb || 0);
    if (n === 0) return "0 GB";
    if (n < 0.001) return `${(n * 1024).toFixed(2)} MB`;
    if (n < 1) return `${(n * 1024).toFixed(1)} MB`;
    return `${n.toFixed(3)} GB`;
  }

  /** The window actually in force, not the policy default — they differ under pressure. */
  function windowLabel(row) {
    if (!row) return "—";
    const def = row.defaultWindowDays ?? 60;
    const cur = row.windowDays ?? def;
    if (cur === def) return `${cur}d`;
    return `${cur}d (of ${def}d)`;
  }

  function timeAgo(iso) {
    if (!iso) return "never";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return "never";
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  /** One citation line, stating only what is known: page only if the source gave one. */
  function citationLine(c, i) {
    const bits = [`[${i + 1}]`, c.title];
    if (c.heading) bits.push(`— ${c.heading}`);
    if (c.page && c.page.start != null) bits.push(`(p.${c.page.start}${c.page.end && c.page.end !== c.page.start ? `–${c.page.end}` : ""})`);
    bits.push(`[${c.vertical}${c.sensitivity === "critical" ? ", restricted" : ""}]`);
    if (c.tier === "cold") bits.push("[archived in SharePoint — reopenable]");
    return bits.join(" ");
  }

  /** What the platform panel says, in the honest order: down → no key → denied → ready. */
  function describeState(s) {
    if (s.status === "offline")
      return { label: "Platform not running", detail: "Start it, then reload. Nothing is cached and nothing is faked.", tone: "danger" };
    if (s.status === "nokey")
      return { label: "Connected · no key", detail: "Health is public; content needs a key scoped to your verticals.", tone: "warning" };
    if (s.status === "denied")
      return { label: "Key refused", detail: s.message || "That key is unknown, revoked, or lacks the scope for this call.", tone: "danger" };
    if (s.status === "ready")
      return { label: `Connected as ${s.appId || "app"}`, detail: `scopes ${(s.scopes || []).join(", ") || "none"} · ${s.verticals.length} vertical${s.verticals.length === 1 ? "" : "s"} in scope`, tone: "verified" };
    return { label: "Checking…", detail: "", tone: "action" };
  }

  /* ------------------------------------------------------------------ fetch */
  async function api(path, { method = "GET", body: payload, auth = true } = {}) {
    if (typeof fetch !== "function") return { status: 0, body: null, error: "fetch unavailable" };
    const headers = {};
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (auth && S.key) headers.authorization = `Bearer ${S.key}`;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    } catch (e) {
      return { status: 0, body: null, error: e.message };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON response is still a status we can report */
    }
    return { status: res.status, body: json };
  }

  function toast(msg, tone) {
    S.message = msg;
    const t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.dataset.tone = tone || "info";
    t.dataset.open = "true";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.dataset.open = "false"), 4200);
  }

  /* ------------------------------------------------------------------ load */
  async function refresh() {
    const health = await api("/healthz", { auth: false });
    if (health.status === 0 || health.status === 503 || health.status === 404) {
      S.status = "offline";
      S.health = null;
      renderAll();
      return S;
    }
    S.health = health.body;
    if (!S.key) {
      S.status = "nokey";
      renderAll();
      return S;
    }
    const meta = await api("/v1/meta");
    if (meta.status === 401 || meta.status === 403) {
      S.status = "denied";
      S.message = meta.body?.error || "key refused";
      renderAll();
      return S;
    }
    S.meta = meta.body;
    S.appId = meta.body?.key?.appId || null;
    S.scopes = meta.body?.key?.scopes || [];
    S.verticals = (meta.body?.key?.verticals || []).includes("*") ? (meta.body?.verticals || []).map((v) => v.id) : meta.body?.key?.verticals || [];
    S.status = "ready";

    const can = (s) => S.scopes.includes(s);
    const [pages, reviews, stats] = await Promise.all([
      can("read") ? api("/v1/wiki/pages") : Promise.resolve(null),
      can("read") ? api("/v1/wiki/reviews?days=60") : Promise.resolve(null),
      can("read") ? api("/v1/wiki/stats") : Promise.resolve(null),
    ]);
    if (pages?.status === 200) S.pages = pages.body.pages || [];
    if (reviews?.status === 200) S.reviews = reviews.body.reviews || [];
    if (stats?.status === 200) S.stats = stats.body;
    if (can("admin")) {
      const q = await api("/v1/admin/quota");
      if (q.status === 200) S.quota = q.body;
      const c = await api("/v1/admin/capacity");
      if (c.status === 200) S.capacity = c.body;
    } else {
      // meta carries the totals any key may see; per-vertical quota needs admin
      S.quota = null;
    }
    if (S.current) await loadPage(S.current.slug, { quiet: true });
    renderAll();
    return S;
  }

  async function loadPage(slug, { quiet = false } = {}) {
    const r = await api(`/v1/wiki/pages/${slug}`);
    if (r.status !== 200) {
      if (!quiet) toast(r.body?.error || `could not load ${slug}`, "danger");
      return null;
    }
    S.current = r.body.page;
    S.revisions = r.body.revisions || [];
    S.stats = r.body.stats || null;
    return S.current;
  }

  async function loadDiff(from, to) {
    const r = await api(`/v1/wiki/pages/${S.current.slug}/diff?from=${from}&to=${to}`);
    return r.status === 200 ? r.body : null;
  }

  async function runSearch(q) {
    const r = await api(`/v1/wiki/search?q=${encodeURIComponent(q)}&limit=25`);
    S.results = r.status === 200 ? { kind: "pages", q, items: r.body.results || [] } : { kind: "pages", q, items: [], error: r.body?.error };
    return S.results;
  }

  /** A hybrid RAG search: the same retrieval the workspace uses, with citations. */
  async function askIndex(q) {
    const r = await api("/v1/search", { method: "POST", body: { query: q, k: 6 } });
    if (r.status !== 200) {
      S.ask = { error: r.body?.error || `search refused (${r.status})` };
      return S.ask;
    }
    S.ask = { citations: r.body.citations || [], cold: r.body.cold || [], metrics: r.body.metrics || {} };
    return S.ask;
  }

  /* ---------------------------------------------------------------- render */
  function renderAll() {
    renderState();
    renderVerticals();
    renderReviews();
    renderRail();
    const online = S.status === "ready";
    $("#offlinePanel").hidden = online;
    $("#listPanel").hidden = !online || S.view !== "list";
    $("#pagePanel").hidden = !online || S.view !== "page";
    $("#editorPanel").hidden = !online || S.view !== "editor";
    $("#historyPanel").hidden = !online || S.view !== "history";
    $("#resultsPanel").hidden = !online || S.view !== "results";
    if (!online) renderOffline();
    if (S.view === "list") renderList();
    if (S.view === "page") renderPage();
    if (S.view === "editor") renderEditor();
    if (S.view === "history") renderHistory();
    if (S.view === "results") renderResults();
  }

  function renderState() {
    const st = describeState(S);
    const line = $("#stateLine");
    line.textContent = st.label;
    line.dataset.state = st.tone;
    const facts = $("#stateFacts");
    facts.innerHTML = "";
    const rows = [];
    if (S.health) {
      rows.push(["platform", `${S.health.platform} ${S.health.version}`]);
      rows.push(["embedder", `${S.health.embedder} · ${S.health.dims}d`]);
      rows.push(["store", `${S.health.backend} · ${S.health.documents} docs · ${S.health.chunks} chunks`]);
      rows.push(["live", `${formatGB(S.health.liveGB)} of ${S.health.ceilingGB} GB ceiling`]);
      rows.push(["mirror", `SharePoint (${S.health.sharePoint})`]);
      /* The platform derives this from what is actually stored, so the wiki can
         never present sample content as a customer corpus by accident. */
      if (S.health.fixtureContent) rows.push(["content", "fixture — sample documents seeded with --fixtures, not a live corpus"]);
      if (S.health.embedder === "hash-embed-local") rows.push(["embeddings", "offline fallback — deterministic, not semantic"]);
    } else {
      rows.push(["platform", "not reachable"]);
    }
    if (S.stats) rows.push(["wiki", `${S.stats.pages} pages · ${S.stats.revisions} revisions · ${S.stats.indexed} indexed`]);
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      facts.append(dt, dd);
    }
    $("#keyBox").hidden = S.status === "ready";
    $("#keyHint").textContent =
      S.status === "denied"
        ? S.message || "That key was refused."
        : "Keys are issued by whoever operates the platform (node platform/server.mjs --create-key …). The secret is shown once and only its hash is stored.";
  }

  function renderOffline() {
    const cmd = [
      "# start the platform (local embeddings, JSONL persistence)",
      "node platform/server.mjs --port 8090 --data-dir .data/platform",
      "",
      "# point the app origin at it, then reload this page",
      "PLATFORM_URL=http://127.0.0.1:8090 node server.js",
      "",
      "# issue a key for the wiki (secret printed once)",
      "node platform/server.mjs --create-key kinetic-wiki",
    ].join("\n");
    $("#offlineCmd").textContent = cmd;
    $("#offlineLede").textContent =
      S.status === "offline"
        ? "The platform API is not reachable from this origin, so there is nothing to show."
        : "The platform is reachable but this browser has no key.";
  }

  /** Pages this key is scoped to. The API already filters, and so does this:
   *  a UI that renders what it was handed would show another vertical's titles
   *  the moment any layer above it slipped. */
  function visiblePages() {
    if (!S.verticals.length) return S.pages;
    return S.pages.filter((p) => S.verticals.includes(p.vertical));
  }

  function renderVerticals() {
    const list = $("#verticalList");
    list.innerHTML = "";
    const grouped = groupByVertical(visiblePages());
    const known = S.verticals.length ? S.verticals : Object.keys(grouped);
    if (!known.length) {
      const li = document.createElement("li");
      li.className = "wiki__vrow";
      li.textContent = S.status === "ready" ? "No pages yet." : "—";
      list.append(li);
      $("#verticalHint").textContent = "";
      return;
    }
    for (const v of known) {
      const li = document.createElement("li");
      li.className = "wiki__vrow";
      li.dataset.vertical = v;
      if (S.filter === v) li.dataset.active = "true";
      const meta = (S.meta?.verticals || []).find((x) => x.id === v);
      const n = (grouped[v] || []).length;
      li.innerHTML = `<button class="wiki__vbtn" type="button" data-vertical="${esc(v)}">
          <span>${esc(meta?.label || v)}</span>
          <b class="mono">${n}</b>
        </button>`;
      if (meta) {
        const bar = document.createElement("span");
        bar.className = "wiki__bar";
        bar.title = `${meta.quotaGB} GB quota · sensitivity ${meta.sensitivity}`;
        const row = S.quota?.rows?.find((r) => r.vertical === v);
        const pct = row ? Math.min(100, row.pct || 0) : 0;
        bar.innerHTML = `<span style="width:${pct}%"></span>`;
        li.append(bar);
      }
      list.append(li);
    }
    $("#verticalHint").textContent = S.quota
      ? "Bars show live use against each vertical's quota."
      : "Quota bars need a key with the admin scope; counts are from the pages you can read.";
  }

  function renderReviews() {
    const ul = $("#reviewList");
    ul.innerHTML = "";
    if (!S.reviews.length) {
      const li = document.createElement("li");
      li.className = "wiki__hint";
      li.textContent = S.status === "ready" ? "Nothing due in the next 60 days." : "—";
      ul.append(li);
      return;
    }
    for (const r of S.reviews.slice(0, 8)) {
      const li = document.createElement("li");
      li.className = "wiki__review";
      li.dataset.overdue = r.overdue ? "true" : "false";
      li.innerHTML = `<button class="wiki__link" type="button" data-slug="${esc(r.slug)}">${esc(r.title)}</button>
        <span class="mono">${r.overdue ? `${Math.abs(r.daysUntilDue)}d overdue` : `due in ${r.daysUntilDue}d`}</span>`;
      ul.append(li);
    }
  }

  function renderList() {
    const scoped = visiblePages();
    const shown = S.filter ? scoped.filter((p) => p.vertical === S.filter) : scoped;
    $("#listTitle").textContent = S.filter ? `${S.filter} — pages` : "All pages";
    $("#listCount").textContent = `${shown.length} page${shown.length === 1 ? "" : "s"}`;
    const ul = $("#pageList");
    ul.innerHTML = "";
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "wiki__hint";
      li.textContent = "No pages in this vertical yet. Create one, or pull from SharePoint with the mirror sync.";
      ul.append(li);
      return;
    }
    for (const p of shown) {
      const li = document.createElement("li");
      li.className = "wiki__page";
      li.innerHTML = `<button class="wiki__link" type="button" data-slug="${esc(p.slug)}">
          <b>${esc(p.title)}</b>
          <span class="mono wiki__slug">${esc(p.slug)}</span>
        </button>
        <span class="wiki__pageMeta mono">r${p.revision} · ${esc(p.updatedBy || p.owner || "?")} · ${timeAgo(p.updatedAt)}${p.mirrorState === "mirrored" ? " · mirrored" : ""}</span>
        ${p.snippet ? `<p class="wiki__snippet">${esc(p.snippet)}…</p>` : ""}`;
      ul.append(li);
    }
  }

  function renderPage() {
    const p = S.current;
    if (!p) return;
    $("#pageTitle").textContent = p.title;
    $("#pageMeta").innerHTML = [
      `<span class="tag tag--accent">${esc(p.vertical)}</span>`,
      `<span class="mono">${esc(p.slug)}</span>`,
      `<span>revision ${p.revision}</span>`,
      `<span>by ${esc(p.updatedBy || p.owner || "unknown")}</span>`,
      `<span>${timeAgo(p.updatedAt)}</span>`,
      p.reviewBy ? `<span class="${Date.parse(p.reviewBy) < Date.now() ? "wiki__overdue" : ""}">review by ${esc(p.reviewBy)}</span>` : "",
      (p.tags || []).map((t) => `<span class="wiki__tag">${esc(t)}</span>`).join(""),
    ]
      .filter(Boolean)
      .join(" · ");
    // document mode: real headings, real links. [[slug]], [text](wiki:slug) and a
    // bare /wiki/slug all become anchors the delegated handler turns into navigations.
    $("#pageBody").innerHTML =
      MD && MD.render ? MD.render(p.body || "", { documentHeadings: true, links: true }) : `<pre class="wiki__code">${esc(p.body || "")}</pre>`;

    const bl = $("#backlinks");
    bl.hidden = !(p.backlinks || []).length;
    const ul = $("#backlinkList");
    ul.innerHTML = "";
    for (const b of p.backlinks || []) {
      const li = document.createElement("li");
      li.innerHTML = `<button class="wiki__link" type="button" data-slug="${esc(b)}">${esc(b)}</button>`;
      ul.append(li);
    }

    const canWrite = S.scopes.includes("wiki");
    $("#editBtn").disabled = !canWrite;
    $("#mirrorBtn").disabled = !S.scopes.includes("admin");
    $("#pageMirror").innerHTML = p.sharePoint
      ? `<h2 class="wiki__h">Mirror</h2><p class="wiki__hint">state <b class="mono">${esc(p.mirrorState)}</b>${p.sharePoint.itemId ? ` · item <b class="mono">${esc(p.sharePoint.itemId)}</b>` : ""}${p.sharePoint.webUrl ? ` · <a class="wiki__link" href="${esc(p.sharePoint.webUrl)}" rel="noopener">open in SharePoint</a>` : ""}</p>`
      : `<h2 class="wiki__h">Mirror</h2><p class="wiki__hint">Not mirrored yet — state <b class="mono">${esc(p.mirrorState || "pending")}</b>. Mirroring needs the admin scope.</p>`;
  }

  function renderEditor() {
    const creating = !!(S.editing && S.editing.create);
    $("#editorTitle").textContent = creating ? "New page" : `Edit — ${S.current?.title || ""}`;
    $("#newFields").hidden = !creating;
    const sel = $("#newVertical");
    if (creating && sel.options.length !== S.verticals.length) {
      sel.innerHTML = "";
      for (const v of S.verticals) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        sel.append(o);
      }
    }
    if (creating) {
      if (!$("#newTitle").value) $("#newTitle").value = "";
      if (!$("#bodyInput").value) $("#bodyInput").value = "";
    } else if (S.current && $("#bodyInput").value !== S.current.body) {
      $("#bodyInput").value = S.current.body || "";
    }
    $("#noteInput").placeholder = creating ? "why this page exists" : "what changed, and why";
    $("#editorHint").textContent = creating
      ? "The slug is derived from the vertical and title. Saving indexes the page into RAG, so it becomes citable immediately."
      : "Saving creates a new revision. The previous text stays readable and the diff is kept — history here cannot be rewritten.";
  }

  function renderHistory() {
    const p = S.current;
    if (!p) return;
    $("#historyTitle").textContent = `History — ${p.title}`;
    const ul = $("#revisionList");
    ul.innerHTML = "";
    for (const r of S.revisions.slice().reverse()) {
      const li = document.createElement("li");
      li.className = "wiki__rev";
      li.innerHTML = `<span class="mono">r${r.revision}</span>
        <span>${esc(r.note || "")}</span>
        <span class="wiki__revBy">${esc(r.author || "?")} · ${timeAgo(r.at)} · <span class="mono">${esc(r.hash || "")}</span></span>
        ${r.revision > 1 ? `<button class="btn btn--ghost btn--sm" type="button" data-diff="${r.revision}">diff</button>` : ""}`;
      ul.append(li);
    }
    $("#diffBox").hidden = true;
  }

  function renderResults() {
    const r = S.results;
    if (!r) return;
    $("#resultsTitle").textContent = r.q ? `Results for “${r.q}”` : "Results";
    const ul = $("#resultList");
    ul.innerHTML = "";
    if (r.error) {
      const li = document.createElement("li");
      li.className = "wiki__hint";
      li.textContent = r.error;
      ul.append(li);
    }
    for (const it of r.items || []) {
      const li = document.createElement("li");
      li.className = "wiki__page";
      li.innerHTML = `<button class="wiki__link" type="button" data-slug="${esc(it.slug)}"><b>${esc(it.title)}</b>
          <span class="mono wiki__slug">${esc(it.slug)} · score ${it.score}</span></button>
        ${it.snippet ? `<p class="wiki__snippet">${esc(it.snippet)}</p>` : ""}`;
      ul.append(li);
    }
    if (!r.items?.length && !r.error) {
      const li = document.createElement("li");
      li.className = "wiki__hint";
      li.textContent = "No page matched.";
      ul.append(li);
    }

    const ask = $("#askPanel");
    ask.hidden = !S.ask;
    if (S.ask) {
      const ol = $("#citeList");
      ol.innerHTML = "";
      if (S.ask.error) {
        const li = document.createElement("li");
        li.className = "wiki__hint";
        li.textContent = S.ask.error;
        ol.append(li);
      }
      (S.ask.citations || []).forEach((c, i) => {
        const li = document.createElement("li");
        li.className = "wiki__cite";
        li.dataset.tier = c.tier || "hot";
        li.innerHTML = `<p class="mono wiki__citeHead">${esc(citationLine(c, i))}</p>
          <blockquote>${esc((c.quote || "").slice(0, 420))}</blockquote>
          <p class="wiki__hint">${c.sharePoint?.webUrl ? `<a class="wiki__link" href="${esc(c.sharePoint.webUrl)}" rel="noopener">source</a> · ` : ""}checksum <span class="mono">${esc(c.checksum || "—")}</span></p>`;
        ol.append(li);
      });
      const cold = $("#coldBox");
      const coldItems = S.ask.cold || [];
      cold.hidden = !coldItems.length;
      if (coldItems.length) {
        cold.innerHTML = `<h3 class="wiki__h">Archived, still discoverable</h3>` +
          coldItems
            .map(
              (c) =>
                `<p class="wiki__hint"><b>${esc(c.title)}</b> — ${esc(c.reason || "archived")}${c.sharePoint?.webUrl ? ` · <a class="wiki__link" href="${esc(c.sharePoint.webUrl)}" rel="noopener">open in SharePoint</a>` : ""}</p>`
            )
            .join("");
      }
      const m = S.ask.metrics || {};
      $("#askMetrics").textContent = m.query
        ? `pool ${m.poolSize} chunks · dense ${m.denseHits} · lexical ${m.lexicalHits} · fused ${m.fusedHits} · returned ${m.returned} · ${m.retrievalMs} ms (${m.withinBudget ? "within" : "over"} the ${m.budgetMs} ms budget) · ${m.embedder} ${m.dims}d`
        : "";
    }
  }

  function renderRail() {
    const fill = $("#gaugeFill");
    const label = $("#gaugeLabel");
    const tbody = $("#quotaTable tbody");
    tbody.innerHTML = "";
    const total = S.quota?.total || (S.meta?.quota ?? null);
    if (total && total.ceilingGB) {
      const pct = Math.min(100, ((total.liveGB || 0) / total.ceilingGB) * 100);
      fill.style.width = `${pct}%`;
      fill.dataset.tone = pct >= 97 ? "danger" : pct >= 90 ? "warning" : "verified";
      label.textContent = `${formatGB(total.liveGB)} live of ${total.ceilingGB} GB ceiling (${pct.toFixed(3)}%) · ${total.chunks ?? "?"} chunks · ${total.coldStubs ?? "?"} archived stubs`;
    } else if (S.health) {
      const pct = Math.min(100, ((S.health.liveGB || 0) / (S.health.ceilingGB || 1)) * 100);
      fill.style.width = `${pct}%`;
      fill.dataset.tone = "verified";
      label.textContent = `${formatGB(S.health.liveGB)} live of ${S.health.ceilingGB} GB ceiling · ${S.health.chunks} chunks · ${S.health.documents} documents`;
    } else {
      fill.style.width = "0%";
      label.textContent = "—";
    }

    for (const row of S.quota?.rows || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(row.label || row.vertical)}${row.pressure && row.pressure !== "ok" ? ` <span class="wiki__press" data-p="${esc(row.pressure)}">${esc(row.pressure)}</span>` : ""}</td>
        <td class="num mono">${formatGB(row.usedGB)}</td>
        <td class="num mono">${row.quotaGB} GB</td>
        <td class="num mono">${windowLabel(row)}</td>`;
      tbody.append(tr);
    }
    $("#capacityHint").textContent = S.quota
      ? `Headroom ${formatGB(S.quota.headroomGB)} under the ceiling · ${S.quota.ceilingHeld ? "ceiling held" : "CEILING BREACHED"}. Window tightens 60→30 days at 90% of a quota and to 14 days at 97%.`
      : "Per-vertical quotas need the admin scope. The totals above come from the health endpoint, which is public.";

    const tiers = S.meta?.tiers;
    $("#retentionLine").textContent = tiers
      ? `A document nobody opens for ${tiers.coldAfterDaysUnopened} days goes back to SharePoint, keeping a discoverable stub and a way to reopen it.`
      : "60 days unopened → back to SharePoint, with a reopenable path.";
    const rf = $("#retentionFacts");
    rf.innerHTML = "";
    const facts = [];
    if (S.quota?.total) facts.push(["live chunks", String(S.quota.total.chunks ?? "—")]);
    if (S.quota?.total) facts.push(["archived stubs", String(S.quota.total.coldStubs ?? "—")]);
    if (S.capacity?.actual) facts.push(["by tier", Object.entries(S.capacity.actual.byTier || {}).map(([k, v]) => `${k} ${v}`).join(" · ")]);
    if (S.capacity?.plan) facts.push(["chunk budget", Number(S.capacity.plan.chunkBudget || 0).toLocaleString()]);
    if (S.capacity?.plan) facts.push(["headroom policy", `≥ ${S.capacity.plan.headroom?.storage ?? 2}× provisioned`]);
    if (!facts.length) facts.push(["state", "no admin key — retention figures unavailable"]);
    for (const [k, v] of facts) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      rf.append(dt, dd);
    }

    const mf = $("#mirrorFacts");
    mf.innerHTML = "";
    const rows = [];
    if (S.stats) rows.push(["wiki mirrored", `${S.stats.mirrored} of ${S.stats.pages}`]);
    if (S.stats) rows.push(["indexed into RAG", `${S.stats.indexed} of ${S.stats.pages}`]);
    if (S.health) rows.push(["mirror backend", S.health.sharePoint]);
    if (S.meta?.storage?.backup) rows.push(["rpo", S.meta.storage.backup.rpo]);
    if (!rows.length) rows.push(["state", "—"]);
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      mf.append(dt, dd);
    }
    const admin = S.scopes.includes("admin");
    $("#syncBtn").disabled = !admin;
    $("#sweepBtn").disabled = !admin;
    $("#mirrorHint").textContent = admin
      ? "Pull runs the SharePoint delta sync; sweep plans demotions without applying them."
      : "Admin scope required for sync and sweep.";
  }

  /* --------------------------------------------------------------- actions */
  function show(view) {
    S.view = view;
    renderAll();
  }

  async function openSlug(slug) {
    const p = await loadPage(slug);
    if (p) show("page");
  }

  async function save() {
    const creating = !!(S.editing && S.editing.create);
    const bodyText = $("#bodyInput").value;
    const author = $("#authorInput").value.trim() || S.appId || "unknown";
    const note = $("#noteInput").value.trim() || (creating ? "created" : "edit");
    const tags = $("#tagsInput")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const reviewBy = $("#reviewInput").value || undefined;
    const payload = { body: bodyText, author, note, tags: tags.length ? tags : undefined, reviewBy };
    let r;
    if (creating) {
      const title = $("#newTitle").value.trim();
      if (!title) return toast("a title is required", "danger");
      payload.title = title;
      payload.vertical = $("#newVertical").value || S.verticals[0] || "shared";
      r = await api("/v1/wiki/pages", { method: "POST", body: payload });
    } else {
      r = await api(`/v1/wiki/pages/${S.current.slug}`, { method: "PUT", body: payload });
    }
    if (r.status === 200 || r.status === 201) {
      rememberAuthor(author);
      toast(creating ? `created ${r.body.page.slug}` : `revision ${r.body.page.revision} saved`, "verified");
      S.editing = null;
      await refresh();
      await openSlug(r.body.page.slug);
      return;
    }
    const msg = r.body?.error || r.body?.reasons?.join("; ") || `save failed (${r.status})`;
    toast(msg, "danger");
  }

  /** Non-secret preference: who you are when you edit. The key is never stored here. */
  function rememberAuthor(author) {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREF_LS) || "{}");
      localStorage.setItem(PREF_LS, JSON.stringify({ ...prefs, author }));
    } catch {
      /* storage unavailable: the field simply will not prefill next time */
    }
  }

  async function mirror() {
    const r = await api("/v1/admin/wiki/mirror", { method: "POST", body: {} });
    if (r.status === 200) {
      toast(`mirrored ${r.body.uploaded} page${r.body.uploaded === 1 ? "" : "s"} to SharePoint${r.body.failed?.length ? ` · ${r.body.failed.length} failed` : ""}`, r.body.failed?.length ? "warning" : "verified");
      await refresh();
    } else toast(r.body?.error || `mirror failed (${r.status})`, "danger");
  }

  async function sync() {
    const r = await api("/v1/admin/mirror/sync", { method: "POST", body: {} });
    if (r.status === 200) {
      const b = r.body;
      toast(`sync — created ${b.created ?? 0} · updated ${b.updated ?? 0} · rejected ${(b.rejected || []).length}`, "verified");
      await refresh();
    } else toast(r.body?.error || `sync failed (${r.status})`, "danger");
  }

  async function sweepDry() {
    const r = await api("/v1/admin/lifecycle/sweep", { method: "POST", body: { dryRun: true } });
    if (r.status === 200) {
      const n = (r.body.planned || []).length;
      toast(n ? `sweep would archive ${n} document${n === 1 ? "" : "s"} (nothing changed)` : "sweep would archive nothing", "info");
    } else toast(r.body?.error || `sweep failed (${r.status})`, "danger");
  }

  /* ------------------------------------------------------------------ boot */
  function bind() {
    $("#connectBtn").addEventListener("click", async () => {
      const v = $("#apiKey").value.trim();
      if (!v) return toast("paste a key first", "danger");
      S.key = v;
      try {
        sessionStorage.setItem(KEY_LS, v);
      } catch {
        /* private mode: the key stays in memory for this page only */
      }
      await refresh();
      if (S.status === "ready") {
        $("#apiKey").value = "";
        toast(`connected as ${S.appId}`, "verified");
      } else toast(S.status === "denied" ? S.message || "that key was refused" : "still no platform on this origin", "danger");
    });
    $("#forgetBtn").addEventListener("click", () => {
      S.key = null;
      S.meta = null;
      S.pages = [];
      S.current = null;
      try {
        sessionStorage.removeItem(KEY_LS);
      } catch {
        /* nothing stored */
      }
      $("#apiKey").value = "";
      refresh();
    });
    $("#searchBtn").addEventListener("click", async () => {
      const q = $("#wikiSearch").value.trim();
      if (!q) return show("list");
      S.q = q;
      await runSearch(q);
      show("results");
    });
    $("#wikiSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#searchBtn").click();
    });
    $("#askBtn").addEventListener("click", async () => {
      const q = $("#wikiSearch").value.trim();
      if (!q) return toast("type a question first", "danger");
      if (!S.scopes.includes("search")) return toast("this key has no search scope", "danger");
      S.q = q;
      await runSearch(q);
      await askIndex(q);
      show("results");
    });
    $("#newBtn").addEventListener("click", () => {
      if (!S.scopes.includes("wiki")) return toast("this key cannot write to the wiki", "danger");
      S.editing = { create: true };
      S.current = null;
      $("#noteInput").value = "";
      $("#tagsInput").value = "";
      $("#reviewInput").value = "";
      show("editor");
    });
    $("#editBtn").addEventListener("click", () => {
      S.editing = { slug: S.current.slug };
      $("#noteInput").value = "";
      $("#bodyInput").value = S.current.body || "";
      $("#reviewInput").value = S.current.reviewBy || "";
      $("#tagsInput").value = (S.current.tags || []).join(", ");
      show("editor");
    });
    $("#saveBtn").addEventListener("click", save);
    $("#cancelBtn").addEventListener("click", () => {
      S.editing = null;
      show(S.current ? "page" : "list");
    });
    $("#backBtn").addEventListener("click", () => show("list"));
    $("#backFromResults").addEventListener("click", () => show("list"));
    $("#backFromHistory").addEventListener("click", () => show(S.current ? "page" : "list"));
    $("#historyBtn").addEventListener("click", () => show("history"));
    $("#mirrorBtn").addEventListener("click", mirror);
    $("#syncBtn").addEventListener("click", sync);
    $("#sweepBtn").addEventListener("click", sweepDry);

    // delegated clicks: page links, vertical filters, review items, diff buttons
    document.addEventListener("click", async (e) => {
      const link = e.target.closest("[data-slug]");
      if (link) {
        if (link.tagName === "A") e.preventDefault(); // a wikilink must not touch the URL hash
        return openSlug(link.dataset.slug);
      }
      const vbtn = e.target.closest("[data-vertical]");
      if (vbtn) {
        S.filter = S.filter === vbtn.dataset.vertical ? null : vbtn.dataset.vertical;
        return show("list");
      }
      const dbtn = e.target.closest("[data-diff]");
      if (dbtn && S.current) {
        const to = Number(dbtn.dataset.diff);
        const d = await loadDiff(to - 1, to);
        if (!d) return toast("that revision pair is not available", "danger");
        $("#diffBox").hidden = false;
        $("#diffTitle").textContent = `Diff — revision ${d.from} → ${d.to}`;
        $("#diffRemoved").textContent = (d.diff.removed || []).join("\n") || "(nothing removed)";
        $("#diffAdded").textContent = (d.diff.added || []).join("\n") || "(nothing added)";
        $("#diffMeta").textContent = `${d.diff.linesBefore} lines before · ${d.diff.linesAfter} after · ${d.diff.unchanged} unchanged`;
      }
    });

    try {
      const saved = sessionStorage.getItem(KEY_LS);
      if (saved) S.key = saved;
      const prefs = JSON.parse(localStorage.getItem(PREF_LS) || "{}");
      if (prefs.author) $("#authorInput").value = prefs.author;
    } catch {
      /* no stored key or prefs: start clean */
    }
    $("#authorInput").addEventListener("change", () => {
      try {
        localStorage.setItem(PREF_LS, JSON.stringify({ author: $("#authorInput").value.trim() }));
      } catch {
        /* storage unavailable */
      }
    });
  }

  let booted = false;
  document.addEventListener("DOMContentLoaded", () => {
    if (booted) return;
    booted = true;
    bind();
    refresh();
  });

  window.GRID_WIKI = {
    state: S,
    api,
    refresh,
    loadPage,
    loadDiff,
    runSearch,
    askIndex,
    show,
    openSlug,
    save,
    // pure helpers, exposed so the tests can hold the UI to its own claims
    slugify,
    groupByVertical,
    formatGB,
    windowLabel,
    timeAgo,
    citationLine,
    describeState,
    renderAll,
  };
})();
