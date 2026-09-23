/* ============================================================================
   gateway.js — real inference wiring for Ollama / vLLM / TGI / LiteLLM.

   Three things this module is responsible for:

   1. TRANSPORTS
      • `ollama` — Ollama's native /api/chat, which streams newline-delimited
        JSON and reports its own eval_count / eval_duration, so throughput is
        measured by the runtime rather than guessed by the browser.
      • `openai` — any OpenAI-compatible /v1/chat/completions SSE stream
        (Ollama's compat layer, vLLM, TGI, LiteLLM, llama.cpp server).
      • `demo`   — the on-device responder in engine.js. No network at all.

   2. REACHABILITY
      A browser cannot reach a private subnet, and Ollama rejects cross-origin
      requests unless OLLAMA_ORIGINS allows them. So the supported production
      path is a SAME-ORIGIN PROXY: the static server forwards /gateway/* to the
      Ollama host. The browser only ever talks to its own origin, which keeps
      the preview host, CSP, cookies and CORS out of the way. `server.js`
      implements that proxy; nginx and docker-compose equivalents are in /deploy.

   3. SECRET HYGIENE
      Non-secret config persists in localStorage. An API key is held in
      sessionStorage for the tab only, is sent solely as an Authorization
      header, and is never interpolated into prompt context.
   ========================================================================== */

(function () {
  const LS_KEY = "grid:gateway";
  const SS_KEY = "grid:gateway-key";

  const PRESETS = [
    {
      id: "demo",
      label: "On-device demo responder",
      transport: "demo",
      baseUrl: "",
      hint: "No network. Deterministic local responder so the workspace is usable before you deploy anything.",
    },
    {
      id: "proxy",
      label: "Same-origin proxy → Ollama (recommended)",
      transport: "ollama",
      baseUrl: "/gateway",
      hint: "server.js forwards /gateway/* to OLLAMA_URL. The browser never contacts the model host directly.",
    },
    {
      id: "ollama-local",
      label: "Ollama on this machine",
      transport: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      hint: "Requires OLLAMA_ORIGINS to allow this page's origin. Works only when the browser runs on that machine.",
    },
    {
      id: "ollama-openai",
      label: "Ollama — OpenAI-compatible",
      transport: "openai",
      baseUrl: "http://127.0.0.1:11434",
      hint: "Uses /v1/chat/completions. Same CORS requirement as native Ollama.",
    },
    {
      id: "vllm",
      label: "vLLM / TGI / LiteLLM gateway",
      transport: "openai",
      baseUrl: "http://127.0.0.1:8000",
      hint: "Any OpenAI-compatible server. Point at your private load balancer, not a public one.",
    },
    {
      id: "custom",
      label: "Custom endpoint",
      transport: "openai",
      baseUrl: "",
      hint: "Anything speaking /v1/chat/completions with stream:true.",
    },
  ];

  const DEFAULTS = {
    preset: "demo",
    transport: "demo",
    baseUrl: "",
    model: "",
    system:
      "You are an internal assistant for a private workspace. Cite the source reference for any claim drawn from retrieved documents. If a request is outside organisation policy, say so plainly and offer the closest permitted alternative.",
    temperature: 0.4,
    maxTokens: 1200,
    keepAlive: "10m",
    route: "external", // external | cloud | all  — which models go through the gateway
    apiKey: "", // sessionStorage only
  };

  let cfg = Object.assign({}, DEFAULTS);
  let lastProbe = null; // { ok, ms, models[], error, at }
  let health = "unknown"; // unknown | ok | error | demo

  /* ------------------------------------------------------------- config io */

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      cfg = Object.assign({}, DEFAULTS, saved);
    } catch {
      cfg = Object.assign({}, DEFAULTS);
    }
    try {
      cfg.apiKey = sessionStorage.getItem(SS_KEY) || "";
    } catch {
      cfg.apiKey = "";
    }
    return cfg;
  }

  function save(next) {
    cfg = Object.assign({}, cfg, next || {});
    const key = cfg.apiKey || "";
    const persistable = Object.assign({}, cfg);
    delete persistable.apiKey; // never written to disk
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(persistable));
      if (key) sessionStorage.setItem(SS_KEY, key);
      else sessionStorage.removeItem(SS_KEY);
    } catch {}
    return cfg;
  }

  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return cfg;
    return save({ preset: p.id, transport: p.transport, baseUrl: p.baseUrl });
  }

  /* ------------------------------------------------- host classification */

  const PRIVATE_HOST =
    /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local$|.*\.internal$)/i;

  /** Where does this gateway actually live? Drives the picker's colour coding. */
  function classify(baseUrl) {
    if (!baseUrl) return "local";
    if (baseUrl.startsWith("/")) return "local"; // same-origin proxy → your infra
    const host = baseUrl.replace(/^https?:\/\//, "").split(/[/:]/)[0];
    return PRIVATE_HOST.test(host) ? "local" : "cloud";
  }

  function locationLabel() {
    if (!isConfigured()) return "this device (demo responder)";
    if (cfg.baseUrl.startsWith("/")) return "same-origin proxy → your Ollama host";
    return cfg.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  function isConfigured() {
    return cfg.transport !== "demo" && Boolean(cfg.baseUrl);
  }

  /** Should a given model be served by the gateway?
   *  Models discovered on the endpoint always are — they only exist there. */
  function routes(model) {
    if (!isConfigured()) return false;
    if (model.fromEndpoint) return true;
    if (model.location === "external") return true;
    if (cfg.route === "all") return true;
    if (cfg.route === "cloud" && model.location === "cloud") return true;
    return false;
  }

  /* --------------------------------------------------------------- probing */

  function modelsUrl() {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    return cfg.transport === "ollama" ? base + "/api/tags" : base + "/v1/models";
  }

  async function probe(opts) {
    opts = opts || {};
    if (!isConfigured()) {
      health = "demo";
      lastProbe = { ok: false, error: "No gateway configured", models: [], at: Date.now() };
      return lastProbe;
    }
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 6000);
    try {
      const res = await fetch(modelsUrl(), {
        signal: controller.signal,
        headers: headers(),
      });
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const json = await res.json();
      const models = normaliseModels(json);
      health = "ok";
      lastProbe = { ok: true, ms, models, at: Date.now() };
      publishModels(models);
    } catch (e) {
      health = "error";
      const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : "";
      const msg =
        e.name === "AbortError"
          ? "Timed out — is the host reachable from this browser?"
          : /fetch failed|Failed to fetch|NetworkError|Load failed/i.test(e.message || "")
          ? `Unreachable or blocked by CORS${cause}. Use the same-origin proxy (/gateway), or set OLLAMA_ORIGINS to include this origin.`
          : (e.message || "Unknown error") + cause;
      lastProbe = { ok: false, ms: Math.round(performance.now() - t0), error: msg, models: [], at: Date.now() };
    } finally {
      clearTimeout(timer);
    }
    return lastProbe;
  }

  function normaliseModels(json) {
    if (Array.isArray(json?.models))
      // Ollama /api/tags
      return json.models.map((m) => ({
        id: m.name || m.model,
        size: m.size,
        family: (m.details && m.details.family) || "",
        params: (m.details && m.details.parameter_size) || "",
        quant: (m.details && m.details.quantization_level) || "",
      }));
    if (Array.isArray(json?.data))
      // OpenAI-compatible /v1/models
      return json.data.map((m) => ({ id: m.id, size: 0, family: "", params: "", quant: "", owned: m.owned_by }));
    return [];
  }

  /** Discovered models are injected into the registry so the picker shows what
   *  is ACTUALLY available on your endpoint, not a marketing list. */
  function publishModels(list) {
    const registry = window.GRID_MODELS;
    if (!registry) return [];
    // drop previously published endpoint models
    for (let i = registry.length - 1; i >= 0; i--) if (registry[i].fromEndpoint) registry.splice(i, 1);

    const loc = classify(cfg.baseUrl);
    const added = list.map((m) => ({
      id: "endpoint:" + m.id,
      endpointModel: m.id,
      fromEndpoint: true,
      group: "Your endpoint",
      name: m.id + (m.params ? ` · ${m.params}` : "") + (m.quant ? ` · ${m.quant}` : ""),
      // Keep enough of the id to tell variants apart in the header chip:
      // "qwen2.5:14b-instruct-q4_K_M" → "qwen2.5:14b-instruct"
      short: m.id.replace(/[-_.](q|Q)\d+[_-].*$/, "").replace(/[-_.](fp|int)\d+.*$/, "") || m.id,
      location: loc,
      locationLabel: locationLabel(),
      speed: guessSpeed(m),
      tags: ["From your gateway", m.family || "open-weight"].filter(Boolean),
      context: "runtime-defined",
      memory: m.size ? (m.size / 1073741824).toFixed(1) + " GB on disk" : "see host",
      runtime: cfg.transport === "ollama" ? "Ollama" : "OpenAI-compatible",
      license: "as published with the model",
      policy: "Organisation baseline",
      retention: "0 days",
      trainsOnData: false,
      blurb: `Discovered on ${locationLabel()} by probing ${modelsUrl()}. Inference happens on that host; nothing is sent anywhere else.`,
    }));
    added.forEach((m) => registry.push(m));
    window.GRID_MODEL_BY_ID = Object.fromEntries(registry.map((m) => [m.id, m]));
    return added;
  }

  function guessSpeed(m) {
    const gb = m.size ? m.size / 1073741824 : 0;
    if (gb && gb <= 6) return "Fast";
    if (gb && gb <= 14) return "Balanced";
    if (gb) return "Deliberate";
    return "Balanced";
  }

  function headers() {
    return Object.assign(
      { "Content-Type": "application/json" },
      cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}
    );
  }

  /* ------------------------------------------------------------ streaming */

  /**
   * Unified streaming call.
   * onStage(label), onDelta(text), signal → returns a result object shaped like
   * engine.runLocal so the UI does not care which transport produced it.
   */
  async function stream({ prompt, history, model, onStage, onDelta, signal }) {
    if (cfg.transport === "ollama") return streamOllama({ prompt, history, model, onStage, onDelta, signal });
    return streamOpenAI({ prompt, history, model, onStage, onDelta, signal });
  }

  function messagesFor(prompt, history) {
    const msgs = (history || []).map((m) => ({
      role: m.role === "ai" ? "assistant" : m.role,
      content: m.content,
    }));
    msgs.push({ role: "user", content: prompt });
    return msgs;
  }

  async function streamOllama({ prompt, history, model, onStage, onDelta, signal }) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/api/chat";
    const modelName = model.endpointModel || cfg.model || model.short;
    onStage(`Connecting to ${locationLabel()}`);
    const startedAt = performance.now(); // TTFT is measured from here, not from the first byte

    const res = await post(url, {
      model: modelName,
      stream: true,
      keep_alive: cfg.keepAlive || "5m",
      options: {
        temperature: Number(cfg.temperature),
        num_predict: Number(cfg.maxTokens),
      },
      messages: (cfg.system ? [{ role: "system", content: cfg.system }] : []).concat(messagesFor(prompt, history)),
    }, signal);

    onStage("Generating response");
    let text = "";
    let firstTokenAt = null;
    let final = null;

    for await (const line of ndjson(res.body, signal)) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error.message || j.error);
      const piece = j.message && j.message.content;
      if (piece) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += piece;
        onDelta(piece);
      }
      if (j.done) final = j;
      if (j.done_reason && j.done_reason !== "stop") final = Object.assign({}, final, { note: j.done_reason });
    }

    return finish({ text, startedAt, firstTokenAt, final, modelName, transport: "ollama" });
  }

  async function streamOpenAI({ prompt, history, model, onStage, onDelta, signal }) {
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
    const modelName = model.endpointModel || cfg.model || model.short;
    onStage(`Connecting to ${locationLabel()}`);
    const startedAt = performance.now();

    const res = await post(url, {
      model: modelName,
      stream: true,
      stream_options: { include_usage: true },
      temperature: Number(cfg.temperature),
      max_tokens: Number(cfg.maxTokens),
      messages: (cfg.system ? [{ role: "system", content: cfg.system }] : []).concat(messagesFor(prompt, history)),
    }, signal);

    onStage("Generating response");
    let text = "";
    let firstTokenAt = null;
    let usage = null;

    for await (const line of sse(res.body, signal)) {
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue; // keep-alive comment or a frame split across reads
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? "";
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += delta;
        onDelta(delta);
      }
      if (j.usage) usage = j.usage;
    }

    return finish({ text, startedAt, firstTokenAt, usage, modelName, transport: "openai" });
  }

  async function post(url, body, signal) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : "";
      throw new Error(
        `Could not reach ${url}${cause}. From a browser this usually means an unreachable host or a blocked cross-origin request — use the same-origin proxy (/gateway), or set OLLAMA_ORIGINS to include this origin.`
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gateway responded ${res.status} ${res.statusText}${detail ? " — " + detail.slice(0, 200) : ""}`);
    }
    if (!res.body) throw new Error("Endpoint returned no streaming body.");
    return res;
  }

  /** Timings are measured from request start. Where the runtime reports its own
   *  numbers (Ollama's eval_count / eval_duration, OpenAI-style usage) those win
   *  over browser-side estimates — they exclude network and queueing noise. */
  function finish({ text, startedAt, firstTokenAt, final, usage, modelName, transport }) {
    const end = performance.now();
    const ttftMs = Math.round((firstTokenAt === null ? end : firstTokenAt) - startedAt);
    const wallMs = Math.max(1, end - startedAt);
    const genMs = Math.max(1, end - (firstTokenAt === null ? end : firstTokenAt));

    let tokens = Math.max(1, Math.round(text.length / 4));
    let tps = Math.round(tokens / (genMs / 1000));

    const runtime = {};
    if (final) {
      if (final.eval_count) {
        tokens = final.eval_count;
        runtime.evalCount = final.eval_count;
      }
      if (final.eval_duration) {
        tps = Math.max(1, Math.round((final.eval_count || tokens) / (final.eval_duration / 1e9)));
        runtime.evalMs = Math.round(final.eval_duration / 1e6);
      }
      if (final.prompt_eval_count) runtime.promptTokens = final.prompt_eval_count;
      if (final.prompt_eval_duration) runtime.prefillMs = Math.round(final.prompt_eval_duration / 1e6);
      if (final.load_duration) runtime.loadMs = Math.round(final.load_duration / 1e6);
      if (final.total_duration) runtime.totalMs = Math.round(final.total_duration / 1e6);
      if (final.note) runtime.doneReason = final.note;
    }
    if (usage) {
      if (usage.completion_tokens) tokens = usage.completion_tokens;
      if (usage.prompt_tokens) runtime.promptTokens = usage.prompt_tokens;
      if (usage.total_tokens) runtime.totalTokens = usage.total_tokens;
    }

    return {
      text,
      tokens,
      promptTokens: runtime.promptTokens,
      ttftMs,
      totalMs: Math.round(runtime.totalMs || wallMs),
      tokensPerSec: tps,
      sources: [],
      transport: "gateway:" + transport,
      endpoint: locationLabel(),
      model: modelName,
      runtime,
    };
  }

  /* --------------------------------------------------- stream line readers */

  async function* reader(body, signal) {
    const r = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    if (signal)
      signal.addEventListener(
        "abort",
        () => r.cancel().catch(() => {}),
        { once: true }
      );
    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { value, done } = await r.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          yield buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
        }
      }
      if (buf) yield buf;
    } finally {
      r.releaseLock();
    }
  }

  const ndjson = reader;

  async function* sse(body, signal) {
    for await (const line of reader(body, signal)) {
      if (line.startsWith("data:")) yield line;
      // SSE comments (": keep-alive") and event:/id: lines are ignored
    }
  }

  /* ------------------------------------------------------------- describe */

  function describe() {
    if (!isConfigured())
      return { state: "demo", label: "Demo responder", detail: "No gateway configured · nothing leaves this device" };
    if (health === "ok")
      return {
        state: "ok",
        label: "Gateway connected",
        detail: `${locationLabel()} · ${lastProbe.models.length} model${lastProbe.models.length === 1 ? "" : "s"} · ${lastProbe.ms} ms`,
      };
    if (health === "error")
      return { state: "error", label: "Gateway unreachable", detail: lastProbe.error };
    return { state: "unknown", label: "Gateway configured", detail: locationLabel() + " · not probed yet" };
  }

  window.GRID_GATEWAY = {
    PRESETS,
    get cfg() {
      return cfg;
    },
    get health() {
      return health;
    },
    get lastProbe() {
      return lastProbe;
    },
    load,
    save,
    applyPreset,
    probe,
    stream,
    routes,
    isConfigured,
    classify,
    locationLabel,
    modelsUrl,
    describe,
    publishModels,
  };
})();
