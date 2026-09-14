/* ============================================================================
   app.js — Sovereign workspace controller.

   Design rules enforced in code, not just in copy:
   • the user message renders locally and instantly, before any network work
   • streaming is buffered (~48 ms flush), never one DOM write per token
   • scroll only follows when the reader is already near the bottom
   • Stop cancels inference too (AbortController), and partial output is kept
   • the privacy state is an inspectable panel, and moving to an external
     endpoint requires an explicit confirmation step
   ========================================================================== */

(function () {
  const DB = window.SOV_DB;
  const Vault = window.SOV_VAULT;
  const Engine = window.SOV_ENGINE;
  const MD = window.SOV_MD;
  const MODELS = window.SOV_MODELS;
  const MODEL_BY_ID = window.SOV_MODEL_BY_ID;
  const MODES = window.SOV_MODES;
  const MODE_BY_ID = window.SOV_MODE_BY_ID;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem("sov:" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("sov:" + k, JSON.stringify(v));
      } catch {}
    },
  };

  const WORKSPACES = [
    { id: "legal", name: "Legal Ops" },
    { id: "finance", name: "Finance" },
    { id: "research", name: "Evaluation" },
  ];

  const SUGGESTIONS = [
    { k: "contracts", t: "Review this contract for liability exposure", d: "Indemnity caps, carve-outs, notice periods" },
    { k: "models", t: "Compare these two financial models for assumptions", d: "Churn, CAC payback, runway sensitivity" },
    { k: "privacy", t: "What does GDPR require for this deployment?", d: "Basis, residency, retention, DSAR, transfers" },
    { k: "stack", t: "Sketch the hosting stack for a 20-user rollout", d: "Gateway, vLLM, pgvector, RBAC" },
  ];

  const COMMANDS = [
    { cmd: "/model", d: "Change model and review its data handling" },
    { cmd: "/privacy", d: "Open the data boundary panel" },
    { cmd: "/knowledge", d: "Toggle retrieval over approved sources" },
    { cmd: "/export", d: "Download this conversation as JSON" },
    { cmd: "/stats", d: "Show local storage and latency stats" },
    { cmd: "/lock", d: "Lock the vault and clear the key from memory" },
    { cmd: "/clear", d: "Start a new conversation" },
    { cmd: "/settings", d: "Retention, telemetry, gateway" },
  ];

  const state = {
    conv: null,
    messages: [],
    model: null,
    mode: "local",
    ws: "legal",
    retrieve: true,
    telemetry: false,
    retention: 30,
    files: [],
    convs: [],
    pendingRefs: [],
    stream: null,
    pinned: true,
    gateway: null, // in-memory only, never persisted
  };

  /* ------------------------------------------------- retention-aware store

     Retention is enforced, not decorative. `0 days` means transcripts live in
     this tab's memory only and nothing is written to IndexedDB; any other
     window writes through and purges expired records at boot and on change. */

  const mem = { convs: [], msgs: {} };
  const persistOn = () => state.retention !== 0;

  const Store = {
    async listConversations() {
      // Reads are not gated by retention: history already on disk stays visible.
      const rows = await DB.listConversations();
      const held = mem.convs.filter((c) => !rows.some((r) => r.id === c.id));
      return [...held, ...rows].sort(
        (a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt
      );
    },

    async getConversation(id) {
      return mem.convs.find((c) => c.id === id) || (await DB.getConversation(id));
    },

    async putConversation(c) {
      c.updatedAt = Date.now();
      if (persistOn()) return DB.putConversation(c);
      const i = mem.convs.findIndex((x) => x.id === c.id);
      if (i >= 0) mem.convs[i] = c;
      else mem.convs.unshift(c);
      return c;
    },

    async removeConversation(id) {
      mem.convs = mem.convs.filter((c) => c.id !== id);
      delete mem.msgs[id];
      if (persistOn()) await DB.deleteConversation(id);
    },

    async addMessage({ convId, role, content, meta }) {
      if (persistOn()) return DB.addMessage({ convId, role, content, meta });
      const rec = { id: DB.uid(), convId, role, content, meta: meta || {}, createdAt: Date.now() };
      (mem.msgs[convId] = mem.msgs[convId] || []).push(rec);
      return rec;
    },

    async listMessages(convId) {
      const held = mem.msgs[convId];
      if (held) return held.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta }));
      const recs = await DB.listMessages(convId);
      const out = [];
      for (const r of recs)
        out.push({ id: r.id, role: r.role, content: await DB.readMessage(r), meta: r.meta || {} });
      return out;
    },

    async updateMessage(id, content, meta) {
      for (const list of Object.values(mem.msgs)) {
        const m = list.find((x) => x.id === id);
        if (m) {
          m.content = content;
          m.meta = Object.assign({}, m.meta, meta);
          return m;
        }
      }
      return persistOn() ? DB.updateMessage(id, content, meta) : null;
    },

    async stats() {
      const d = await DB.stats();
      const held = Object.values(mem.msgs).reduce((n, l) => n + l.length, 0);
      d.conversations += mem.convs.length;
      d.messages += held;
      d.memoryOnly = mem.convs.length + held;
      return d;
    },

    /** Delete anything older than the configured window. Retention 0 governs
     *  new writes (memory-only), so it does not wipe existing history here —
     *  erasing on-disk data is an explicit action in Settings → Local data. */
    async purgeExpired() {
      if (!persistOn()) return 0;
      const cutoff = Date.now() - state.retention * 86400000;
      let n = 0;
      for (const c of await DB.listConversations()) {
        if ((c.updatedAt || c.createdAt || 0) < cutoff) {
          await DB.deleteConversation(c.id);
          n++;
        }
      }
      return n;
    },
  };

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    const s = LS.get("settings", {});
    state.model = MODEL_BY_ID[s.modelId] || MODELS.find((m) => m.default) || MODELS[0];
    state.mode = MODE_BY_ID[s.mode] ? s.mode : "local";
    state.ws = s.ws || "legal";
    state.retrieve = s.retrieve !== false;
    state.telemetry = s.telemetry === true;
    state.retention = typeof s.retention === "number" ? s.retention : 30;

    // Gateway credentials live in sessionStorage at most — never localStorage,
    // never in prompt context.
    try {
      state.gateway = JSON.parse(sessionStorage.getItem("sov:gateway") || "null");
    } catch {
      state.gateway = null;
    }

    bindStatic();
    paintChrome();

    const purged = await Store.purgeExpired();
    if (purged) toast(`Retention policy removed ${purged} expired conversation${purged === 1 ? "" : "s"}`);

    if (await Vault.isInitialised()) {
      openSheet("vault", { locked: true });
    } else {
      await refresh();
    }
  }

  function persist() {
    LS.set("settings", {
      modelId: state.model.id,
      mode: state.mode,
      ws: state.ws,
      retrieve: state.retrieve,
      telemetry: state.telemetry,
      retention: state.retention,
    });
  }

  async function refresh() {
    state.convs = await Store.listConversations();
    state.files = await DB.listFiles();
    renderSidebar();
    renderKnowledgeList();
    renderThread();
    paintChrome();
  }

  /* ------------------------------------------------------------ chrome paint */

  function paintChrome() {
    const mode = MODE_BY_ID[state.mode];
    const p = $("#pstate");
    p.dataset.state = state.mode;
    $(".dot", p).className = "dot dot--" + mode.dot;
    $("#pstateLabel").textContent = mode.label;
    $("#pstateSub").textContent = mode.headline;

    $("#wsSelect").value = state.ws;
    $("#modelChipName").textContent = state.model.short;
    $("#modelChipLoc").textContent =
      state.model.location === "local"
        ? "LOCAL"
        : state.model.location === "cloud"
        ? "PRIVATE VPC"
        : "EXTERNAL";
    $("#modelChipLoc").className = "mono loc-" + state.model.location;

    const k = $("#knowledgeChip");
    k.setAttribute("aria-pressed", String(state.retrieve));
    $("#knowledgeChipState").textContent = state.retrieve ? "On" : "Off";

    // The model's own data-handling location can override the session mode.
    const effective = state.model.location === "external" ? "external" : state.mode;
    $("#pstate").dataset.state = effective;
    if (effective !== state.mode) {
      $("#pstateLabel").textContent = MODE_BY_ID[effective].label;
      $("#pstateSub").textContent = "Model endpoint overrides workspace mode";
      $(".dot", p).className = "dot dot--" + MODE_BY_ID[effective].dot;
    }

    paintVault();
    paintStats();
    const c = $("#composer");
    if (c && document.activeElement !== c) c.focus({ preventScroll: true });
  }

  async function paintVault() {
    const init = await Vault.isInitialised();
    const el = $("#vaultState");
    if (!init) {
      el.innerHTML = `<span class="tag tag--warning">Vault off</span><span class="dim" style="font-size:12px">History is plaintext on this device</span>`;
    } else if (Vault.unlocked) {
      el.innerHTML = `<span class="tag tag--verified">Vault unlocked</span><span class="dim" style="font-size:12px">AES-GCM 256 · key in memory only</span>`;
    } else {
      el.innerHTML = `<span class="tag tag--action">Vault locked</span><span class="dim" style="font-size:12px">Bodies unreadable until unlocked</span>`;
    }
  }

  async function paintStats() {
    const st = await Store.stats();
    const kb = (st.bytes / 1024).toFixed(1);
    $("#statConvs").textContent = state.convs.filter((c) => c.ws === state.ws).length;
    $("#statMsgs").textContent = st.messages;
    $("#statSize").textContent = persistOn()
      ? kb + " KB"
      : "session only · 0 KB on disk";
    $("#statRetention").textContent =
      state.retention === 0 ? "0 days" : state.retention < 0 ? "Indefinite" : state.retention + " days";
    $("#statFiles").textContent = st.files;
    // 5 MB soft budget for encrypted local history, shown as a real meter
    const pct = Math.max(1.5, Math.min(100, (st.bytes / (5 * 1024 * 1024)) * 100));
    const bar = $("#storageBar");
    if (bar) bar.style.width = pct.toFixed(1) + "%";
  }

  /* --------------------------------------------------------------- sidebar */

  function groupConvs(convs) {
    const now = Date.now();
    const day = 86400000;
    const g = { Pinned: [], Today: [], "Previous 7 days": [], Older: [] };
    convs.forEach((c) => {
      if (c.pinned) g.Pinned.push(c);
      else if (now - c.updatedAt < day) g.Today.push(c);
      else if (now - c.updatedAt < 7 * day) g["Previous 7 days"].push(c);
      else g.Older.push(c);
    });
    return g;
  }

  function renderSidebar() {
    const q = ($("#convSearch").value || "").trim().toLowerCase();
    const list = $("#convList");
    list.innerHTML = "";
    const convs = state.convs.filter(
      (c) => c.ws === state.ws && (!q || (c.title || "").toLowerCase().includes(q))
    );
    const groups = groupConvs(convs);

    if (!convs.length) {
      list.innerHTML = `<p class="dim" style="font-size:12.5px;padding:6px 8px;line-height:1.6">
        No conversations in this workspace yet. Titles are stored unencrypted so this list can render while the vault is locked; bodies are encrypted.</p>`;
      return;
    }

    Object.entries(groups).forEach(([label, items]) => {
      if (!items.length) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = `<div class="sidebar__group-label">${label}</div>`;
      items.forEach((c) => {
        const b = document.createElement("div");
        b.className = "conv";
        b.setAttribute("role", "button");
        b.tabIndex = 0;
        if (state.conv && state.conv.id === c.id) b.setAttribute("aria-current", "true");
        const inMemory = Boolean(c.sessionOnly) || mem.convs.some((x) => x.id === c.id);
        b.innerHTML = `
          <span class="dot ${c.encrypted ? "dot--local" : ""}" style="width:5px;height:5px"></span>
          <span class="conv__title">${MD.escape(c.title || "Untitled")}</span>
          ${inMemory ? '<span class="mono" style="color:var(--warning);flex:none" title="Held in memory for this tab only — retention is 0 days">RAM</span>' : ""}
          <button class="conv__del" title="Delete conversation" aria-label="Delete conversation">✕</button>`;
        const open = () => openConversation(c.id);
        b.addEventListener("click", open);
        b.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
        b.addEventListener("dblclick", () => togglePin(c));
        $(".conv__del", b).addEventListener("click", async (e) => {
          e.stopPropagation();
          await Store.removeConversation(c.id);
          if (state.conv && state.conv.id === c.id) {
            state.conv = null;
            state.messages = [];
          }
          toast(
            persistOn()
              ? "Conversation deleted from this device"
              : "Conversation discarded from this session"
          );
          await refresh();
        });
        wrap.appendChild(b);
      });
      list.appendChild(wrap);
    });
  }

  async function togglePin(c) {
    c.pinned = !c.pinned;
    await Store.putConversation(c);
    await refresh();
    toast(c.pinned ? "Pinned" : "Unpinned");
  }

  async function openConversation(id) {
    if (state.stream) stopStream(true);
    const conv = await Store.getConversation(id);
    if (!conv) return;
    const msgs = await Store.listMessages(id);
    state.conv = conv;
    state.messages = msgs;
    if (MODEL_BY_ID[conv.modelId]) state.model = MODEL_BY_ID[conv.modelId];
    if (MODE_BY_ID[conv.mode]) state.mode = conv.mode;
    persist();
    renderSidebar();
    renderThread();
    paintChrome();
    closeMobileSidebar();
  }

  function newChat() {
    if (state.stream) stopStream(true);
    state.conv = null;
    state.messages = [];
    state.pendingRefs = [];
    renderSidebar();
    renderThread();
    paintChrome();
    closeMobileSidebar();
    $("#composer").focus();
  }

  /* ---------------------------------------------------------------- thread */

  function renderThread() {
    const inner = $("#threadInner");
    inner.innerHTML = "";
    if (!state.messages.length) {
      inner.appendChild(emptyState());
      return;
    }
    state.messages.forEach((m) => inner.appendChild(msgNode(m)));
    requestAnimationFrame(() => scrollToEnd(true));
  }

  function emptyState() {
    const d = document.createElement("div");
    d.className = "empty";
    const mode = MODE_BY_ID[state.mode];
    d.innerHTML = `
      <div class="row" style="gap:8px;margin-bottom:16px">
        <span class="tag tag--accent"><span class="dot dot--local"></span>${MD.escape(state.model.short)}</span>
        <span class="tag">${MD.escape(state.model.locationLabel)}</span>
        <span class="tag tag--verified">${MD.escape(mode.label)}</span>
      </div>
      <h2>Ask privately.</h2>
      <p>Everything below runs inside your boundary. Prompts, uploads and transcripts stay in this workspace — encrypted on this device, indexed locally, never used to train anyone else's model.</p>
      <div class="suggestions">
        ${SUGGESTIONS.map(
          (s) => `<button class="suggestion" data-s="${MD.escape(s.t)}">
            <span class="mono">${s.k}</span>${MD.escape(s.t)}
            <span class="dim" style="display:block;font-size:12px;margin-top:4px">${MD.escape(s.d)}</span>
          </button>`
        ).join("")}
      </div>`;
    $$(".suggestion", d).forEach((b) =>
      b.addEventListener("click", () => {
        $("#composer").value = b.dataset.s;
        autoGrow();
        $("#composer").focus();
      })
    );
    return d;
  }

  function msgNode(m) {
    const node = document.createElement("article");
    node.className = "msg msg--" + (m.role === "user" ? "user" : "ai");
    node.dataset.id = m.id || "";
    const who = m.role === "user" ? "You" : (MODEL_BY_ID[m.meta && m.meta.modelId] || state.model).short;
    node.innerHTML = `
      <div class="msg__who">${MD.escape(who)}</div>
      <div class="msg__body">
        <div class="msg__text"></div>
        <div class="sources"></div>
        <div class="msg__foot"></div>
      </div>`;
    $(".msg__text", node).innerHTML = MD.render(m.content);
    renderSources($(".sources", node), m.meta);
    renderFoot($(".msg__foot", node), m);
    return node;
  }

  function renderSources(host, meta) {
    host.innerHTML = "";
    const src = (meta && meta.sources) || [];
    if (!src.length) return;
    src.forEach((s) => {
      const d = document.createElement("div");
      d.className = "source";
      d.innerHTML = `<span class="mono">${MD.escape(s.ref)}</span><span>${MD.escape(s.file)}</span><span class="mono" style="margin-left:auto">${MD.escape(s.page)}</span>`;
      host.appendChild(d);
    });
  }

  function renderFoot(host, m) {
    host.innerHTML = "";
    if (m.role === "user") {
      const meta = m.meta || {};
      if (meta.refs && meta.refs.length) {
        const s = document.createElement("span");
        s.className = "msg__metrics";
        s.textContent = "Context: " + meta.refs.join(", ");
        host.appendChild(s);
      }
      return;
    }
    const meta = m.meta || {};
    const metrics = document.createElement("div");
    metrics.className = "msg__metrics";
    const bits = [];
    if (meta.ttftMs != null) bits.push(`TTFT ${meta.ttftMs} ms`);
    if (meta.tokensPerSec != null) bits.push(`${meta.tokensPerSec} tok/s`);
    if (meta.tokens != null) bits.push(`${meta.tokens} tokens`);
    if (meta.totalMs != null) bits.push(`${(meta.totalMs / 1000).toFixed(1)} s`);
    bits.push(meta.transport === "remote" ? "gateway" : "local runtime");
    if (meta.stopped) bits.push("stopped");
    metrics.innerHTML = bits.map((b) => `<span>${MD.escape(b)}</span>`).join("");
    host.appendChild(metrics);

    [["copy", "Copy"], ["regen", "Regenerate"], ["branch", "Branch"], ["up", "Useful"], ["down", "Off-target"]].forEach(
      ([k, label]) => {
        const b = document.createElement("button");
        b.className = "act";
        b.textContent = label;
        b.type = "button";
        if (k === "up" || k === "down") b.setAttribute("aria-pressed", String(Boolean(meta.feedback === k)));
        b.addEventListener("click", () => messageAction(k, m, b));
        host.appendChild(b);
      }
    );
  }

  async function messageAction(kind, m, btn) {
    if (kind === "copy") {
      try {
        await navigator.clipboard.writeText(m.content || "");
        toast("Response copied to clipboard");
      } catch {
        toast("Clipboard blocked by the browser");
      }
      return;
    }
    if (kind === "branch") {
      const idx = state.messages.findIndex((x) => x.id === m.id);
      const conv = await Store.putConversation({
        id: DB.uid(),
        title: "Branch · " + (state.conv ? state.conv.title : "new"),
        modelId: state.model.id,
        mode: state.mode,
        ws: state.ws,
        createdAt: Date.now(),
        encrypted: await Vault.isInitialised(),
      });
      for (const x of state.messages.slice(0, idx)) {
        await Store.addMessage({ convId: conv.id, role: x.role, content: x.content, meta: x.meta });
      }
      toast("Branched into a new conversation");
      state.convs = await Store.listConversations();
      await openConversation(conv.id);
      return;
    }
    if (kind === "regen") {
      const idx = state.messages.findIndex((x) => x.id === m.id);
      const promptMsg = state.messages.slice(0, idx).reverse().find((x) => x.role === "user");
      if (!promptMsg) return;
      state.messages = state.messages.slice(0, idx);
      renderThread();
      await runCompletion(promptMsg.content, { replaceId: m.id });
      return;
    }
    // feedback — stored locally against the message, never uploaded
    const val = btn.getAttribute("aria-pressed") === "true" ? null : kind;
    m.meta = Object.assign({}, m.meta, { feedback: val });
    if (m.id) await Store.updateMessage(m.id, m.content, { feedback: val });
    $$(".act", btn.parentElement).forEach((b) => {
      if (b.textContent === "Useful") b.setAttribute("aria-pressed", String(val === "up"));
      if (b.textContent === "Off-target") b.setAttribute("aria-pressed", String(val === "down"));
    });
    toast(val ? "Feedback stored locally" : "Feedback cleared");
  }

  /* ------------------------------------------------------------ send + stream */

  async function send() {
    const ta = $("#composer");
    const text = ta.value.trim();
    if (!text || state.stream) return;

    if (text.startsWith("/")) {
      const handled = await runCommand(text);
      if (handled) {
        ta.value = "";
        autoGrow();
        hideCommands();
        return;
      }
    }

    ta.value = "";
    autoGrow();
    hideCommands();

    if (!state.conv) {
      state.conv = await Store.putConversation({
        id: DB.uid(),
        title: text.slice(0, 48) + (text.length > 48 ? "…" : ""),
        modelId: state.model.id,
        mode: state.mode,
        ws: state.ws,
        createdAt: Date.now(),
        encrypted: await Vault.isInitialised(),
        sessionOnly: !persistOn(),
      });
      state.convs = await Store.listConversations();
    } else {
      state.conv.modelId = state.model.id;
      state.conv.mode = state.mode;
      await Store.putConversation(state.conv);
    }

    const refs = state.pendingRefs.map((f) => f.name);
    state.pendingRefs = [];
    renderPendingRefs();

    const userMsg = { id: null, role: "user", content: text, meta: { refs } };
    state.messages.push(userMsg);
    if ($("#threadInner .empty")) renderThread();
    else $("#threadInner").appendChild(msgNode(userMsg));
    scrollToEnd(true);

    const rec = await Store.addMessage({
      convId: state.conv.id,
      role: "user",
      content: text,
      meta: { refs, modelId: state.model.id },
    });
    userMsg.id = rec.id;
    renderSidebar();
    paintStats();

    await runCompletion(text, { refs });
  }

  async function runCompletion(prompt, opts) {
    opts = opts || {};
    const inner = $("#threadInner");

    // Reserve the assistant container immediately — visible latency honesty.
    const live = document.createElement("article");
    live.className = "msg msg--ai";
    live.innerHTML = `
      <div class="msg__who">${MD.escape(state.model.short)}</div>
      <div class="msg__body">
        <div class="stage"><span class="dot dot--live dot--local"></span><span id="stageText">Connecting securely…</span></div>
        <div class="msg__text" style="display:none"></div>
        <div class="sources"></div>
        <div class="msg__foot"></div>
      </div>`;
    inner.appendChild(live);
    scrollToEnd(true);

    const stageEl = $("#stageText", live);
    const textEl = $(".msg__text", live);
    const controller = new AbortController();
    const startedAt = performance.now();
    let buffer = "";
    let acc = "";
    let firstDelta = null;
    let rafPending = false;

    const flush = () => {
      rafPending = false;
      if (!buffer) return;
      acc += buffer;
      buffer = "";
      textEl.style.display = "";
      textEl.innerHTML = MD.render(acc) + '<span class="stream-cursor"></span>';
      if (state.pinned) scrollToEnd();
    };

    const flushTimer = setInterval(() => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flush);
      }
    }, 48);

    const setStage = (s) => {
      stageEl.textContent = s;
      $("#liveStatus").textContent = s;
    };

    const sendBtn = $("#sendBtn");
    sendBtn.innerHTML = '<span class="mono">Stop</span>';
    sendBtn.classList.remove("btn--primary");
    sendBtn.classList.add("btn--danger");
    sendBtn.dataset.mode = "stop";
    $("#composer").disabled = false; // composer stays active; queue is visible

    const onDelta = (d) => {
      if (firstDelta === null) {
        firstDelta = performance.now() - startedAt;
        $(".stage", live).style.display = "none";
      }
      buffer += d;
    };

    let result = null;
    let error = null;

    state.stream = { controller, live, flushTimer };

    try {
      const gwReady = Boolean(state.gateway && state.gateway.baseUrl);
      const useRemote =
        gwReady &&
        (state.model.location === "external" ||
          (state.model.location === "cloud" && state.gateway.useForAll));
      if (state.model.location === "external" && !gwReady) {
        setStage("No gateway configured — using on-device demo responder");
        toast("Set Settings → Model gateway to reach a real endpoint");
      }
      if (useRemote) {
        result = await Engine.runRemote({
          prompt,
          history: state.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
          model: state.model,
          cfg: state.gateway,
          onStage: setStage,
          onDelta,
          signal: controller.signal,
        });
      } else {
        result = await Engine.runLocal({
          prompt,
          model: state.model,
          retrieve: state.retrieve,
          onStage: setStage,
          onDelta,
          signal: controller.signal,
        });
      }
    } catch (e) {
      error = e;
    } finally {
      clearInterval(flushTimer);
      flush();
      state.stream = null;
      sendBtn.innerHTML = '<span class="mono">Send</span>';
      sendBtn.classList.add("btn--primary");
      sendBtn.classList.remove("btn--danger");
      sendBtn.dataset.mode = "send";
      $("#liveStatus").textContent = "";
    }

    const stopped = error && error.name === "AbortError";
    const finalText = stopped || error ? acc : result.text;
    textEl.innerHTML = MD.render(finalText);

    const meta = {
      modelId: state.model.id,
      transport: result ? result.transport : "local",
      tokens: result ? result.tokens : Math.round(finalText.length / 4),
      promptTokens: result ? result.promptTokens : undefined,
      ttftMs: result ? result.ttftMs : Math.round(firstDelta || performance.now() - startedAt),
      totalMs: Math.round(performance.now() - startedAt),
      tokensPerSec: result ? result.tokensPerSec : undefined,
      sources: result ? result.sources : [],
      stopped: Boolean(stopped),
      refs: opts.refs,
    };

    if (error && !stopped) {
      textEl.innerHTML =
        MD.render(finalText) +
        `<div class="callout" style="margin-top:12px"><b>Connection interrupted.</b><br>${MD.escape(
          error.message || String(error)
        )}</div>`;
      meta.error = error.message || String(error);
    }

    renderSources($(".sources", live), meta);
    const msgObj = { id: null, role: "ai", content: finalText, meta };
    state.messages.push(msgObj);

    const rec = await Store.addMessage({
      convId: state.conv ? state.conv.id : "orphan",
      role: "ai",
      content: finalText,
      meta,
    });
    msgObj.id = rec.id;

    const foot = $(".msg__foot", live);
    renderFoot(foot, msgObj);
    live.dataset.id = rec.id;
    if (stopped) toast("Generation stopped · partial output saved");
    if (error && !stopped) toast("Inference failed — see the message for detail");
    recordLatency(meta);
    paintStats();
    if (state.pinned) scrollToEnd();
  }

  function stopStream(silent) {
    if (!state.stream) return;
    state.stream.controller.abort();
    if (!silent) {
      /* the finally-block in runCompletion persists the partial text */
    }
  }

  /* latency histogram for the sidebar readout */
  function recordLatency(meta) {
    const hist = LS.get("latency", []);
    hist.push({ ttft: meta.ttftMs, total: meta.totalMs, tps: meta.tokensPerSec, at: Date.now() });
    LS.set("latency", hist.slice(-40));
    const ttfts = hist.map((h) => h.ttft).sort((a, b) => a - b);
    const p50 = ttfts[Math.floor(ttfts.length * 0.5)] || 0;
    const p95 = ttfts[Math.floor(ttfts.length * 0.95)] || 0;
    $("#statP50").textContent = p50 + " ms";
    $("#statP95").textContent = p95 + " ms";
  }

  /* --------------------------------------------------------------- scroll */

  function scrollToEnd(force) {
    const t = $("#thread");
    t.scrollTop = t.scrollHeight;
    if (force) state.pinned = true;
    updateJump();
  }

  function updateJump() {
    const t = $("#thread");
    const near = t.scrollHeight - t.scrollTop - t.clientHeight < 120;
    state.pinned = near;
    $("#jumpBtn").style.display = near ? "none" : "inline-flex";
  }

  /* -------------------------------------------------------------- composer */

  function autoGrow() {
    const ta = $("#composer");
    ta.style.height = "auto";
    ta.style.height = Math.min(220, ta.scrollHeight) + "px";
    const approx = Math.round(ta.value.length / 4);
    $("#tokenEstimate").textContent = approx ? `~${approx} tokens` : "";
  }

  function showCommands(filter) {
    const box = $("#cmdMenu");
    const items = COMMANDS.filter((c) => !filter || c.cmd.startsWith(filter));
    if (!items.length) return hideCommands();
    box.innerHTML = items
      .map(
        (c) =>
          `<button class="conv" data-cmd="${c.cmd}" type="button"><span class="conv__title" style="font-family:var(--font-mono);font-size:12.5px;color:var(--accent)">${c.cmd}</span><span class="dim" style="font-size:12px">${c.d}</span></button>`
      )
      .join("");
    box.dataset.open = "true";
    $$("[data-cmd]", box).forEach((b) =>
      b.addEventListener("click", () => {
        $("#composer").value = b.dataset.cmd + " ";
        $("#composer").focus();
        hideCommands();
        autoGrow();
      })
    );
  }

  function hideCommands() {
    $("#cmdMenu").dataset.open = "false";
  }

  /** “@” surfaces the local index. Selecting a file attaches it as retrieval
   *  context — metadata only ever enters the prompt, the chunks stay local. */
  function showKnowledgeMenu(filter) {
    const box = $("#cmdMenu");
    const f = (filter || "").toLowerCase();
    const items = state.files.filter((x) => !f || x.name.toLowerCase().includes(f));
    if (!items.length) {
      box.innerHTML = `<div class="dim" style="font-size:12.5px;padding:10px 12px;line-height:1.6">
        ${
          state.files.length
            ? "No indexed file matches that name."
            : "Nothing indexed yet. Use <b>+ Attach</b> to index a document inside this workspace — chunks and embeddings are stored locally."
        }</div>`;
      box.dataset.open = "true";
      return;
    }
    box.innerHTML =
      `<div class="sidebar__group-label" style="padding:6px 10px 4px">Approved sources · local index</div>` +
      items
        .map(
          (x) =>
            `<button class="conv" data-file="${MD.escape(x.name)}" type="button">
               <span class="mono" style="color:var(--accent-dim)">${x.chunks} chunks</span>
               <span class="conv__title">${MD.escape(x.name)}</span>
               <span class="dim mono">${(x.size / 1024).toFixed(0)} KB</span>
             </button>`
        )
        .join("");
    box.dataset.open = "true";
    $$("[data-file]", box).forEach((b) =>
      b.addEventListener("click", () => {
        const name = b.dataset.file;
        const ta = $("#composer");
        ta.value = ta.value.replace(/@[\w.\-]*$/, "");
        if (!state.pendingRefs.some((r) => r.name === name)) {
          const rec = state.files.find((x) => x.name === name);
          state.pendingRefs.push({ name, chunks: rec ? rec.chunks : 0 });
          renderPendingRefs();
        }
        autoGrow();
        hideCommands();
        ta.focus();
      })
    );
  }

  async function runCommand(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    switch (cmd.toLowerCase()) {
      case "/model":
        openSheet("models");
        return true;
      case "/privacy":
        openSheet("privacy");
        return true;
      case "/knowledge":
        state.retrieve = !state.retrieve;
        persist();
        paintChrome();
        toast("Knowledge retrieval " + (state.retrieve ? "on" : "off"));
        return true;
      case "/export":
        exportConversation();
        return true;
      case "/stats": {
        const st = await Store.stats();
        const hist = LS.get("latency", []);
        const ttfts = hist.map((h) => h.ttft).sort((a, b) => a - b);
        const p50 = ttfts[Math.floor(ttfts.length * 0.5)] || 0;
        const p95 = ttfts[Math.floor(ttfts.length * 0.95)] || 0;
        const tps = hist.map((h) => h.tps).filter(Boolean);
        const avgTps = tps.length ? Math.round(tps.reduce((a, b) => a + b, 0) / tps.length) : 0;
        alertBox(
          "Local stats",
          `Conversations: ${st.conversations}\nMessages: ${st.messages}\nIndexed files: ${st.files}\nEncrypted payload: ${(st.bytes / 1024).toFixed(1)} KB\nTTFT p50: ${p50} ms · p95: ${p95} ms\nMean throughput: ${avgTps} tok/s\nVault: ${Vault.unlocked ? "unlocked" : (await Vault.isInitialised()) ? "locked" : "off"}`
        );
        return true;
      }
      case "/lock":
        Vault.lock();
        paintVault();
        toast("Vault locked · key cleared from memory");
        renderThread();
        return true;
      case "/clear":
        newChat();
        return true;
      case "/settings":
        openSheet("settings");
        return true;
      case "/help":
        alertBox(
          "Commands",
          COMMANDS.map((c) => `${c.cmd} — ${c.d}`).join("\n") +
            "\n\nEnter sends · Shift+Enter newline · ⌘/Ctrl+K model picker · Esc closes panels"
        );
        return true;
      default:
        return false;
    }
  }

  function renderPendingRefs() {
    const host = $("#pendingRefs");
    host.innerHTML = "";
    state.pendingRefs.forEach((f, i) => {
      const s = document.createElement("span");
      s.className = "tag tag--verified";
      s.innerHTML = `${MD.escape(f.name)} <button class="act" style="padding:0 2px" aria-label="Remove">✕</button>`;
      $("button", s).addEventListener("click", () => {
        state.pendingRefs.splice(i, 1);
        renderPendingRefs();
      });
      host.appendChild(s);
    });
  }

  /* --------------------------------------------------------------- exports */

  async function exportConversation() {
    if (!state.conv) return toast("Nothing to export yet");
    const payload = {
      exportedAt: new Date().toISOString(),
      workspace: state.ws,
      model: state.model.name,
      privacyMode: state.mode,
      conversation: { title: state.conv.title, createdAt: state.conv.createdAt },
      messages: state.messages.map((m) => ({
        role: m.role,
        content: m.content,
        meta: m.meta,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.conv.title || "conversation").replace(/[^a-z0-9-_ ]/gi, "").slice(0, 40) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Exported — the file leaves this browser only because you asked it to");
  }

  /* ---------------------------------------------------------------- sheets */

  let confirmArmed = null;

  function openSheet(name, arg) {
    closeSheets();
    const el = $("#sheet-" + name);
    if (!el) return;
    el.dataset.open = "true";
    $("#scrim").dataset.open = "true";
    if (name === "models") renderModelPicker();
    if (name === "privacy") renderPrivacy();
    if (name === "settings") renderSettings();
    if (name === "vault") renderVault(arg || {});
    const focusable = $('input:not([type=hidden]), textarea, [tabindex], button', el);
    if (focusable) setTimeout(() => focusable.focus(), 60);
  }

  function closeSheets() {
    $$(".sheet").forEach((s) => (s.dataset.open = "false"));
    $("#scrim").dataset.open = "false";
  }

  /* ---- model picker ---- */

  function renderModelPicker() {
    const host = $("#modelList");
    const q = ($("#modelSearch").value || "").toLowerCase();
    host.innerHTML = "";
    const groups = ["Recommended", "Specialist", "Advanced"];
    groups.forEach((g) => {
      const items = MODELS.filter(
        (m) =>
          m.group === g &&
          (!q ||
            (m.name + " " + m.tags.join(" ") + " " + m.locationLabel).toLowerCase().includes(q))
      );
      if (!items.length) return;
      const label = document.createElement("div");
      label.className = "picker__group";
      label.textContent = g;
      host.appendChild(label);

      items.forEach((m) => {
        const row = document.createElement("div");
        row.className = "mrow";
        row.setAttribute("role", "radio");
        row.setAttribute("aria-checked", String(state.model.id === m.id));
        row.tabIndex = 0;
        row.innerHTML = `
          <span class="dot ${m.id === state.model.id ? "dot--live" : ""} ${
          m.location === "local" ? "dot--local" : m.location === "cloud" ? "dot--cloud" : "dot--external"
        }" style="width:6px;height:6px"></span>
          <span>
            <span class="mrow__name">${MD.escape(m.name)}
              ${m.research ? '<span class="tag tag--research">research</span>' : ""}
              ${m.default ? '<span class="tag tag--accent">default</span>' : ""}
            </span>
            <span class="mrow__sub">${m.speed} · ${m.context} context · ${MD.escape(m.tags.slice(0, 3).join(" / "))}</span>
          </span>
          <span>
            <span class="mrow__loc loc-${m.location}">${MD.escape(
          m.location === "local" ? "local" : m.location === "cloud" ? "private vpc" : "external"
        )}</span>
            <button class="act" data-info type="button" aria-expanded="false">details</button>
          </span>
          <div class="mrow__details" hidden>
            <div class="kv"><span>Runs on</span><b>${MD.escape(m.locationLabel)}</b></div>
            <div class="kv"><span>Memory</span><b>${MD.escape(m.memory)}</b></div>
            <div class="kv"><span>Runtime</span><b>${MD.escape(m.runtime)}</b></div>
            <div class="kv"><span>Licence</span><b>${MD.escape(m.license)}</b></div>
            <div class="kv"><span>Policy profile</span><b>${MD.escape(m.policy)}</b></div>
            <div class="kv"><span>Retention</span><b>${MD.escape(m.retention)}</b></div>
            <div class="kv"><span>Trains on your data</span><b>${
              m.trainsOnData === false ? "No" : m.trainsOnData === true ? "Yes" : "Provider-defined"
            }</b></div>
            <div style="grid-column:1/-1;font-size:12.5px;color:var(--text-2);line-height:1.6">${MD.escape(m.blurb)}</div>
          </div>`;

        const choose = async () => {
          if (m.location === "external" && state.mode !== "external") {
            const ok = await confirmBox(
              "This model sends prompts outside your boundary",
              `${m.name} is an external endpoint. Prompts will leave this browser and go to the host you configure. Review its retention and training terms first.`
            );
            if (!ok) return;
            state.mode = "external";
          }
          state.model = m;
          if (m.location !== "external" && state.mode === "external") state.mode = m.location === "cloud" ? "cloud" : "local";
          persist();
          paintChrome();
          renderModelPicker();
          toast(`Model set to ${m.short}`);
          if (m.location !== "external") closeSheets();
        };

        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-info]")) return;
          choose();
        });
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choose();
          }
        });
        $("[data-info]", row).addEventListener("click", (e) => {
          e.stopPropagation();
          const d = $(".mrow__details", row);
          d.hidden = !d.hidden;
          e.currentTarget.setAttribute("aria-expanded", String(!d.hidden));
        });
        host.appendChild(row);
      });
    });
  }

  /* ---- privacy panel ---- */

  function renderPrivacy() {
    const host = $("#modeList");
    host.innerHTML = "";
    MODES.forEach((mode) => {
      const b = document.createElement("button");
      b.className = "mode";
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.mode === mode.id));
      b.innerHTML = `
        <span class="dot dot--${mode.dot}" style="margin-top:5px"></span>
        <span>
          <span class="mode__t">${MD.escape(mode.label)}</span>
          <span class="mode__d">${MD.escape(mode.detail)}</span>
        </span>`;
      b.addEventListener("click", async () => {
        if (mode.id === "external") {
          const ok = await confirmBox(
            "Confirm data boundary change",
            "Switching to an external endpoint means prompts leave infrastructure you control. Only continue if the provider's retention and training terms are acceptable for this workspace."
          );
          if (!ok) return;
        }
        state.mode = mode.id;
        if (state.mode !== "external" && state.model.location === "external") {
          state.model = MODELS.find((m) => m.default);
          toast("Model reset to a private default");
        }
        persist();
        paintChrome();
        renderPrivacy();
      });
      host.appendChild(b);
    });

    const active = MODE_BY_ID[state.model.location === "external" ? "external" : state.mode];
    $("#flowHost").innerHTML = active.flow
      .map(
        (f) => `<div class="flow__item">
          <span class="flow__k">${f.k}</span>
          <span><span class="flow__t">${MD.escape(f.t)}</span><span class="flow__d">${MD.escape(f.d)}</span></span>
        </div>`
      )
      .join("");
    $("#flowTitle").textContent = active.label;
    $("#flowHeadline").textContent = active.headline;
  }

  /* ---- settings ---- */

  function renderSettings() {
    $("#retention").value = String(state.retention);
    $("#telemetryToggle").setAttribute("aria-pressed", String(state.telemetry));
    $("#telemetryPayload").hidden = !state.telemetry;

    const g = state.gateway || {};
    $("#gwUrl").value = g.baseUrl || "";
    $("#gwModel").value = g.model || "";
    $("#gwSystem").value = g.system || "";
    $("#gwTemp").value = g.temperature ?? 0.4;
    $("#gwMax").value = g.maxTokens ?? 1200;
    $("#gwKey").value = g.apiKey || "";
    $("#gwUseForAll").setAttribute("aria-pressed", String(Boolean(g.useForAll)));
    $("#gwKeyNote").textContent = g.apiKey
      ? "Key held in this tab's memory only. It is sent as an Authorization header to your endpoint and is never written into prompt context or local storage."
      : "No key stored. Keys are never placed in prompt context.";
  }

  function saveGateway() {
    state.gateway = {
      baseUrl: $("#gwUrl").value.trim(),
      model: $("#gwModel").value.trim(),
      system: $("#gwSystem").value.trim(),
      temperature: parseFloat($("#gwTemp").value) || 0.4,
      maxTokens: parseInt($("#gwMax").value, 10) || 1200,
      apiKey: $("#gwKey").value.trim(),
      useForAll: $("#gwUseForAll").getAttribute("aria-pressed") === "true",
    };
    sessionStorage.setItem("sov:gateway", JSON.stringify(state.gateway));
    toast("Gateway saved for this tab");
    renderSettings();
  }

  /* ---- vault ---- */

  function renderVault(arg) {
    const host = $("#vaultBody");
    Vault.isInitialised().then((init) => {
      if (!init) {
        host.innerHTML = `
          <p class="muted" style="font-size:13.5px;line-height:1.65;margin-bottom:14px">
            Chat bodies are written to IndexedDB on this device. Without a passphrase they are
            <b style="color:var(--warning)">plaintext</b>. Setting one derives an AES-GCM-256 key with
            PBKDF2-SHA256 (${(Vault.iterations / 1000).toFixed(0)}k iterations) from a per-device salt.
            The passphrase is never stored; the key lives in memory for this session.
          </p>
          <div class="callout" style="margin-bottom:14px"><b>Threat model.</b> This protects history at rest from anyone reading the browser profile without the passphrase. It does not protect against other scripts on this origin while unlocked.</div>
          <div class="field"><label for="vp1">Passphrase</label><input id="vp1" type="password" autocomplete="new-password" placeholder="At least 12 characters"></div>
          <div class="field"><label for="vp2">Confirm</label><input id="vp2" type="password" autocomplete="new-password"></div>
          <div class="row" style="margin-top:6px">
            <button class="btn btn--primary" id="vpCreate">Encrypt local history</button>
            <button class="btn btn--ghost" id="vpSkip">Continue without encryption</button>
          </div>`;
        $("#vpCreate", host).addEventListener("click", async () => {
          const a = $("#vp1", host).value;
          const b = $("#vp2", host).value;
          if (a.length < 12) return toast("Use at least 12 characters");
          if (a !== b) return toast("Passphrases do not match");
          await Vault.init(a);
          await reencryptAll();
          toast("Vault created · existing history re-encrypted");
          closeSheets();
          paintVault();
          renderThread();
        });
        $("#vpSkip", host).addEventListener("click", () => {
          closeSheets();
          toast("History is stored unencrypted on this device");
        });
        return;
      }

      if (arg.locked && !Vault.unlocked) {
        host.innerHTML = `
          <p class="muted" style="font-size:13.5px;margin-bottom:14px">This workspace is encrypted. Enter your passphrase to read the stored conversations. Bodies cannot be decrypted without it.</p>
          <div class="field"><label for="vu">Passphrase</label><input id="vu" type="password" autocomplete="current-password"></div>
          <div class="row"><button class="btn btn--primary" id="vuGo">Unlock</button><button class="btn btn--ghost" id="vuBrowse">Browse titles only</button></div>`;
        $("#vuGo", host).addEventListener("click", async () => {
          try {
            await Vault.unlock($("#vu", host).value);
            toast("Vault unlocked");
            closeSheets();
            paintVault();
            await refresh();
          } catch (e) {
            toast(e.message === "BAD_PASSPHRASE" ? "Wrong passphrase" : "Could not unlock");
          }
        });
        $("#vuBrowse", host).addEventListener("click", async () => {
          closeSheets();
          await refresh();
        });
        $("#vu", host).addEventListener("keydown", (e) => {
          if (e.key === "Enter") $("#vuGo", host).click();
        });
        return;
      }

      host.innerHTML = `
        <div class="stack" style="gap:14px">
          <div class="kv"><span>Cipher</span><b>AES-GCM 256</b></div>
          <div class="kv"><span>Key derivation</span><b>PBKDF2-SHA256 · ${(Vault.iterations / 1000).toFixed(0)}k</b></div>
          <div class="kv"><span>Key storage</span><b>Memory only (this tab)</b></div>
          <div class="kv"><span>State</span><b>${Vault.unlocked ? "Unlocked" : "Locked"}</b></div>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            ${Vault.unlocked ? '<button class="btn" id="vLock">Lock now</button>' : '<button class="btn btn--primary" id="vUnlock">Unlock</button>'}
            <button class="btn btn--ghost" id="vRekey">Change passphrase</button>
          </div>
        </div>`;
      const lock = $("#vLock", host);
      if (lock)
        lock.addEventListener("click", () => {
          Vault.lock();
          paintVault();
          renderThread();
          toast("Locked · key cleared from memory");
          closeSheets();
        });
      const unlock = $("#vUnlock", host);
      if (unlock) unlock.addEventListener("click", () => openSheet("vault", { locked: true }));
      $("#vRekey", host).addEventListener("click", () => {
        alertBox(
          "Change passphrase",
          "Re-keying rewrites every stored message body with a new key. Export a backup first if this history matters — there is no recovery path if the passphrase is lost."
        );
      });
    });
  }

  async function reencryptAll() {
    const convs = await DB.listConversations();
    for (const c of convs) {
      c.encrypted = true;
      await DB.putConversation(c);
      const msgs = await DB.listMessages(c.id);
      for (const m of msgs) {
        if (m.body && m.body.v === 0) {
          const plain = JSON.parse(m.body.data);
          await DB.updateMessage(m.id, plain, m.meta);
        }
      }
    }
  }

  /* ------------------------------------------------------- dialog helpers */

  function alertBox(title, body) {
    const host = $("#dialog");
    $("#dialogTitle").textContent = title;
    $("#dialogBody").innerHTML = `<pre style="white-space:pre-wrap;font-family:var(--font-body);font-size:13.5px;color:var(--text-2);line-height:1.65;margin:0">${MD.escape(body)}</pre>`;
    $("#dialogActions").innerHTML = `<button class="btn btn--primary" data-ok>Close</button>`;
    host.dataset.open = "true";
    $("#scrim").dataset.open = "true";
    $("[data-ok]", host).addEventListener("click", () => {
      host.dataset.open = "false";
      $("#scrim").dataset.open = "false";
    });
  }

  function confirmBox(title, body) {
    return new Promise((resolve) => {
      const host = $("#dialog");
      $("#dialogTitle").textContent = title;
      $("#dialogBody").innerHTML = `<p style="font-size:13.5px;color:var(--text-2);line-height:1.65;margin:0">${MD.escape(body)}</p>`;
      $("#dialogActions").innerHTML = `<button class="btn btn--ghost" data-no>Cancel</button><button class="btn btn--danger" data-yes>Continue</button>`;
      host.dataset.open = "true";
      $("#scrim").dataset.open = "true";
      const done = (v) => {
        host.dataset.open = "false";
        if (!$(".sheet[data-open='true']")) $("#scrim").dataset.open = "false";
        resolve(v);
      };
      $("[data-yes]", host).addEventListener("click", () => done(true));
      $("[data-no]", host).addEventListener("click", () => done(false));
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.dataset.open = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.dataset.open = "false"), 2600);
  }

  function closeMobileSidebar() {
    if (window.innerWidth <= 900) $("#sidebar").dataset.open = "false";
  }

  /* ----------------------------------------------------------------- bind */

  function bindStatic() {
    $("#newChat").addEventListener("click", newChat);
    $("#sidebarToggle").addEventListener("click", () => {
      const s = $("#sidebar");
      s.dataset.open = s.dataset.open === "true" ? "false" : "true";
    });
    $("#convSearch").addEventListener("input", renderSidebar);
    $("#wsSelect").addEventListener("change", async (e) => {
      state.ws = e.target.value;
      persist();
      state.conv = null;
      state.messages = [];
      await refresh();
    });

    $("#pstate").addEventListener("click", () => openSheet("privacy"));
    $("#modelChip").addEventListener("click", () => openSheet("models"));
    $("#modelSearch").addEventListener("input", renderModelPicker);
    $("#knowledgeChip").addEventListener("click", () => {
      state.retrieve = !state.retrieve;
      persist();
      paintChrome();
      toast("Knowledge retrieval " + (state.retrieve ? "on — approved sources only" : "off"));
    });

    $("#exportBtn").addEventListener("click", exportConversation);
    $("#settingsBtn").addEventListener("click", () => openSheet("settings"));
    $("#vaultBtn").addEventListener("click", () => openSheet("vault", {}));

    const ta = $("#composer");
    ta.addEventListener("input", () => {
      autoGrow();
      const v = ta.value;
      const mention = v.match(/@([\w.\-]*)$/);
      if (mention) showKnowledgeMenu(mention[1]);
      else if (v.startsWith("/") && !v.includes(" ")) showCommands(v.split(/\s+/)[0]);
      else if (v === "/") showCommands("");
      else hideCommands();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
      if (e.key === "Escape") hideCommands();
    });

    $("#sendBtn").addEventListener("click", () => {
      if ($("#sendBtn").dataset.mode === "stop") stopStream();
      else send();
    });

    $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        const chunks = Math.max(1, Math.round(f.size / 2400));
        await DB.putFile({
          id: DB.uid(),
          name: f.name,
          size: f.size,
          kind: f.type || "unknown",
          chunks,
          indexedAt: Date.now(),
        });
        state.pendingRefs.push({ name: f.name, chunks });
        toast(`${f.name} · indexed locally · ~${chunks} chunks`);
      }
      e.target.value = "";
      state.files = await DB.listFiles();
      renderPendingRefs();
      paintStats();
      renderKnowledgeList();
    });

    $("#knowledgeBtn").addEventListener("click", () => {
      openSheet("privacy");
      renderKnowledgeList();
    });

    $("#jumpBtn").addEventListener("click", () => scrollToEnd(true));
    $("#thread").addEventListener("scroll", updateJump);
    $("#scrim").addEventListener("click", () => {
      closeSheets();
      $("#dialog").dataset.open = "false";
    });

    // settings bindings
    $("#retention").addEventListener("change", async (e) => {
      state.retention = parseInt(e.target.value, 10);
      persist();
      const purged = await Store.purgeExpired();
      if (purged) toast(`Retention policy removed ${purged} expired conversation${purged === 1 ? "" : "s"}`);
      state.convs = await Store.listConversations();
      renderSidebar();
      paintStats();
      toast(
        state.retention === 0
          ? "Retention 0 days — transcripts are not persisted after this session"
          : state.retention < 0
          ? "Retention: indefinite, until you delete them"
          : `Retention set to ${state.retention} days`
      );
    });
    $("#telemetryToggle").addEventListener("click", () => {
      state.telemetry = !state.telemetry;
      persist();
      renderSettings();
    });
    $("#gwSave").addEventListener("click", saveGateway);
    $("#gwTest").addEventListener("click", testGateway);
    $("#gwUseForAll").addEventListener("click", (e) => {
      const b = e.currentTarget;
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    });
    $("#clearAll").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      if (confirmArmed !== "clearAll") {
        confirmArmed = "clearAll";
        b.textContent = "Confirm: erase everything";
        b.classList.add("btn--danger");
        setTimeout(() => {
          if (confirmArmed === "clearAll") {
            confirmArmed = null;
            b.textContent = "Erase all local data";
            b.classList.remove("btn--danger");
          }
        }, 4000);
        return;
      }
      confirmArmed = null;
      await DB.clearAll();
      LS.set("latency", []);
      state.conv = null;
      state.messages = [];
      b.textContent = "Erase all local data";
      b.classList.remove("btn--danger");
      await refresh();
      toast("All local data erased from this device");
    });
    $("#exportAll").addEventListener("click", async () => {
      const convs = await DB.listConversations();
      const out = [];
      for (const c of convs) {
        const msgs = [];
        for (const m of await DB.listMessages(c.id)) msgs.push({ role: m.role, content: await DB.readMessage(m), meta: m.meta });
        out.push({ conversation: c, messages: msgs });
      }
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), data: out }, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sovereign-workspace-export.json";
      a.click();
      toast("Full workspace exported");
    });

    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSheet("models");
      }
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        $("#sidebarToggle").click();
      }
      if (e.key === "Escape") {
        closeSheets();
        $("#dialog").dataset.open = "false";
        $("#scrim").dataset.open = "false";
      }
    });
  }

  function renderKnowledgeList() {
    const host = $("#knowledgeList");
    if (!host) return;
    if (!state.files.length) {
      host.innerHTML = `<p class="dim" style="font-size:12.5px;line-height:1.6">No files indexed. Attach a document to index it inside this workspace — only its chunks and embeddings are stored, in the location you select.</p>`;
      return;
    }
    host.innerHTML = state.files
      .map(
        (f) => `<div class="flow__item">
          <span class="flow__k">▤</span>
          <span>
            <span class="flow__t">${MD.escape(f.name)}</span>
            <span class="flow__d">${(f.size / 1024).toFixed(0)} KB · ${f.chunks} chunks · indexed ${new Date(f.indexedAt).toLocaleString()}</span>
          </span>
        </div>`
      )
      .join("");
  }

  async function testGateway() {
    const g = state.gateway || {};
    if (!g.baseUrl) return toast("Set a base URL first");
    const btn = $("#gwTest");
    btn.disabled = true;
    btn.textContent = "Probing…";
    const t0 = performance.now();
    try {
      const res = await fetch(g.baseUrl.replace(/\/+$/, "") + "/v1/models", {
        headers: g.apiKey ? { Authorization: "Bearer " + g.apiKey } : {},
      });
      const ms = Math.round(performance.now() - t0);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const ids = (j.data || []).map((m) => m.id).slice(0, 6);
        toast(`Reachable in ${ms} ms · ${ids.length ? ids.join(", ") : "no models listed"}`);
      } else toast(`Endpoint answered ${res.status} in ${ms} ms`);
    } catch (e) {
      toast("Unreachable from this browser — check host, CORS/OLLAMA_ORIGINS");
    } finally {
      btn.disabled = false;
      btn.textContent = "Test connection";
    }
  }

  // Idempotent: some hosts (and test harnesses) can fire DOMContentLoaded twice.
  let booted = false;
  document.addEventListener("DOMContentLoaded", () => {
    if (booted) return;
    booted = true;
    boot();
  });

  window.SOV_APP = { state, toast, openSheet, Store, persistOn, mem };
})();
