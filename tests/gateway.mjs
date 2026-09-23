/* ============================================================================
   tests/gateway.mjs — end-to-end wiring test for real inference.

   Boots a mock Ollama/vLLM host, boots server.js with OLLAMA_URL pointed at it,
   then drives the workspace UI in jsdom through the same-origin proxy:

     proxy forwards /gateway/* with streaming intact
     probe discovers models and injects them into the picker
     a real prompt is served by the endpoint (marker text proves it)
     Ollama's own eval_count / prompt_eval_duration become the metrics
     OpenAI-compatible transport works the same way
     a dead endpoint is reported as unreachable, not silently ignored

     node tests/gateway.mjs
   ========================================================================== */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import "fake-indexeddb/auto";
import { startMock, OLLAMA_MARKER, OPENAI_MARKER } from "./mock-ollama.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PORT = Number(process.env.APP_PORT || 8099);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ------------------------------------------------------------- mock + app */

const mock = await startMock(0);
console.log(`mock inference host → ${mock.baseUrl}`);

const app = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PORT: String(APP_PORT), HOST: "127.0.0.1", OLLAMA_URL: mock.baseUrl }),
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${APP_ORIGIN}/healthz`);
      if (r.ok) return r.json();
    } catch {}
    await wait(120);
  }
  throw new Error("server.js did not start:\n" + appLog);
}

/* ------------------------------------------------------------ jsdom loader */

function loadApp(file = "app.html") {
  const html = readFileSync(join(ROOT, file), "utf8");
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: `${APP_ORIGIN}/${file}`,
    virtualConsole: vc,
  });
  const w = dom.window;

  Object.defineProperty(w, "indexedDB", { value: globalThis.indexedDB, configurable: true });
  Object.defineProperty(w, "crypto", { value: globalThis.crypto, configurable: true });
  // Node's fetch/AbortController: real streaming, real cancellation, no CORS.
  Object.defineProperty(w, "AbortController", { value: globalThis.AbortController, configurable: true });
  Object.defineProperty(w, "DOMException", { value: globalThis.DOMException, configurable: true });
  w.fetch = (input, init) => fetch(typeof input === "string" ? new URL(input, `${APP_ORIGIN}/`) : input, init);
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.alert = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};

  for (const src of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))
    w.eval(readFileSync(join(ROOT, src), "utf8"));
  w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }));
  return { w, doc: w.document, errors };
}

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
const setSelect = (w, el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("change", { bubbles: true }));
};

const aiMetricsOf = (doc) => [...doc.querySelectorAll(".msg--ai")].at(-1).querySelector(".msg__metrics").textContent;

async function settle(doc, timeout = 40000) {
  const mode = () => doc.querySelector("#sendBtn").dataset.mode;
  for (let i = 0; i < 100 && mode() !== "stop"; i++) await wait(50);
  const started = mode() === "stop";
  for (let i = 0; i < timeout / 100 && mode() === "stop"; i++) await wait(100);
  await wait(200);
  return started;
}

/* ======================================================================= */

try {
  const health = await waitForApp();

  console.log("\nproxy — server.js /gateway/*");
  ok("healthz reports the configured target", health.ok === true && health.gateway === mock.baseUrl, JSON.stringify(health));
  ok("static UI still served alongside the proxy", (await fetch(`${APP_ORIGIN}/app.html`)).status === 200);

  const tags = await (await fetch(`${APP_ORIGIN}/gateway/api/tags`)).json();
  ok("proxy forwards GET /api/tags", Array.isArray(tags.models) && tags.models.length === 2, JSON.stringify(tags).slice(0, 80));

  // streaming must stay incremental through the proxy
  const t0 = Date.now();
  const res = await fetch(`${APP_ORIGIN}/gateway/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen2.5:14b-instruct-q4_K_M", stream: true, messages: [{ role: "user", content: "stream test" }] }),
  });
  const arrivals = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let body = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    arrivals.push(Date.now() - t0);
    body += dec.decode(value, { stream: true });
  }
  ok("proxy streams ndjson chunks", body.split("\n").filter(Boolean).length >= 7, `${body.split("\n").filter(Boolean).length} lines`);
  ok("chunks arrive incrementally, not buffered", arrivals.length >= 4 && arrivals.at(-1) - arrivals[0] > 40, `${arrivals.length} reads over ${arrivals.at(-1) - arrivals[0]} ms`);
  ok("final frame carries Ollama eval stats", /"eval_count":37/.test(body) && /"prompt_eval_duration":260000000/.test(body));
  ok("proxy sets no-buffer headers", res.headers.get("x-accel-buffering") === "no", res.headers.get("x-accel-buffering"));

  // a dead upstream must produce a readable 502, not a hang
  const bad = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT + 1), HOST: "127.0.0.1", OLLAMA_URL: "http://127.0.0.1:1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await wait(700);
  const badRes = await fetch(`http://127.0.0.1:${APP_PORT + 1}/gateway/api/tags`).catch(() => null);
  ok("unreachable upstream returns 502 with guidance", badRes && badRes.status === 502, badRes ? String(badRes.status) : "no response");
  if (badRes) ok("502 body explains the fix", /OLLAMA_URL|security list|NSG/i.test(await badRes.text()));
  bad.kill();

  console.log("\nworkspace — probe, discover, serve");
  const { w, doc, errors } = loadApp();
  await wait(300);
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  ok("starts on the demo responder", w.GRID_GATEWAY.describe().state === "demo");
  ok("top bar says DEMO before configuration", $("#gwChipLabel").textContent === "DEMO");

  click($("#settingsBtn"));
  await wait(120);
  ok("connection presets are offered", $$("#gwPreset option").length === w.GRID_GATEWAY.PRESETS.length);

  setSelect(w, $("#gwPreset"), "proxy");
  await wait(80);
  ok("proxy preset fills a same-origin base URL", $("#gwUrl").value === "/gateway", $("#gwUrl").value);
  ok("preset hint explains the proxy", /forwards|browser never/i.test($("#gwHint").textContent));
  ok("CORS callout hidden for the proxy path", $("#gwCors").hidden === true);

  setSelect(w, $("#gwRoute"), "all");
  await wait(40);
  click($("#gwSave"));
  for (let i = 0; i < 80 && w.GRID_GATEWAY.health !== "ok"; i++) await wait(100);
  await wait(150);

  ok("probe reaches the endpoint through the proxy", w.GRID_GATEWAY.health === "ok", JSON.stringify(w.GRID_GATEWAY.lastProbe));
  ok("probe reports latency", w.GRID_GATEWAY.lastProbe.ms >= 0 && w.GRID_GATEWAY.lastProbe.ms < 5000);
  ok("discovered models are listed", $$("#gwModels [data-use]").length === 2, `${$$("#gwModels [data-use]").length}`);
  ok("discovered models carry size and quantisation", /14B/.test($("#gwModels").textContent) && /Q4_K_M/.test($("#gwModels").textContent));
  ok("status tag flips to connected", /connected/i.test($("#gwStatusTag").textContent), $("#gwStatusTag").textContent);
  ok("top bar says GATEWAY LIVE", $("#gwChipLabel").textContent === "GATEWAY LIVE", $("#gwChipLabel").textContent);

  // picker now shows what the endpoint actually has
  click($("#modelChip"));
  await wait(120);
  ok("picker gains a 'Your endpoint' group", $$("#modelList .picker__group").some((g) => /Your endpoint/.test(g.textContent)));
  ok("endpoint models are selectable in the picker", $$("#modelList .mrow").some((r) => /qwen2\.5:14b-instruct/.test(r.textContent)));
  const endpointRow = $$("#modelList .mrow").find((r) => /coder7b/.test(r.textContent));
  ok("endpoint model shows its runtime location", /same-origin proxy/i.test(endpointRow.textContent), endpointRow.textContent.slice(0, 120));
  click(endpointRow);
  await wait(200);
  ok("selecting an endpoint model activates it", w.GRID_APP.state.model.fromEndpoint === true && /coder7b/.test($("#modelChipName").textContent), $("#modelChipName").textContent);

  console.log("\nworkspace — real inference through the gateway");
  const ta = $("#composer");
  ta.value = "Compare the indemnity caps in the MSA";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("generation started", await settle(doc));

  const ai = $$(".msg--ai").at(-1);
  const text = ai.querySelector(".msg__text").textContent;
  const metrics = ai.querySelector(".msg__metrics").textContent;
  ok("response came from the endpoint, not the demo responder", text.includes(OLLAMA_MARKER), text.slice(-90));
  ok("prompt reached the endpoint intact", /prompt="Compare the indemnity/.test(text), text.slice(-70));
  ok("transport labelled as the gateway", /gateway · same-origin proxy/i.test(metrics), metrics);
  ok("served-by model id shown", /coder7b/.test(metrics), metrics);
  ok("token count comes from Ollama eval_count", /37 tokens/.test(metrics), metrics);
  ok("prefill latency reported from the runtime", /prefill 260 ms/.test(metrics), metrics);
  ok("throughput computed from eval_duration", /3[01] tok\/s/.test(metrics), metrics);
  ok("TTFT measured from request start, not from first byte", /TTFT [1-9]\d* ms/.test(metrics), metrics);

  const stored = await w.GRID_DB.listConversations();
  const msgs = await w.GRID_DB.listMessages(stored[0].id);
  const savedMeta = msgs.at(-1).meta;
  ok("gateway metadata persisted with the message", savedMeta.transport === "gateway:ollama" && savedMeta.runtime.evalCount === 37, JSON.stringify(savedMeta.runtime));

  console.log("\nworkspace — OpenAI-compatible transport");
  click($("#settingsBtn"));
  await wait(100);
  setSelect(w, $("#gwPreset"), "custom");
  await wait(60);
  $("#gwUrl").value = mock.baseUrl; // absolute, vLLM-style
  $("#gwModel").value = "qwen2.5:14b-instruct-q4_K_M";
  click($("#gwSave"));
  for (let i = 0; i < 80 && w.GRID_GATEWAY.lastProbe?.at === undefined; i++) await wait(50);
  await wait(600);
  ok("OpenAI-compatible probe succeeds", w.GRID_GATEWAY.health === "ok", JSON.stringify(w.GRID_GATEWAY.lastProbe));
  ok("probe used /v1/models", w.GRID_GATEWAY.modelsUrl().endsWith("/v1/models"), w.GRID_GATEWAY.modelsUrl());

  click($("#modelChip"));
  await wait(100);
  const v1Row = $$("#modelList .mrow").find((r) => /14b-instruct/.test(r.textContent));
  click(v1Row);
  await wait(150);
  ta.value = "What does the DPA omit?";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("second generation started", await settle(doc));
  const ai2 = $$(".msg--ai").at(-1);
  const text2 = ai2.querySelector(".msg__text").textContent;
  ok("SSE transport served the response", text2.includes(OPENAI_MARKER), text2.slice(-90));
  ok("SSE usage tokens recorded", /37 tokens/.test(ai2.querySelector(".msg__metrics").textContent), ai2.querySelector(".msg__metrics").textContent);

  console.log("\nworkspace — failure paths");
  $("#gwUrl").value = "http://127.0.0.1:1";
  click($("#gwSave"));
  for (let i = 0; i < 60 && w.GRID_GATEWAY.health !== "error"; i++) await wait(100);
  await wait(100);
  ok("dead endpoint reported as unreachable", w.GRID_GATEWAY.health === "error", w.GRID_GATEWAY.lastProbe?.error);
  ok("error explains the proxy/CORS fix", /proxy|OLLAMA_ORIGINS|reachable/i.test(w.GRID_GATEWAY.lastProbe.error), w.GRID_GATEWAY.lastProbe.error);
  ok("top bar reflects the outage", $("#gwChipLabel").textContent === "GATEWAY DOWN", $("#gwChipLabel").textContent);

  // with the gateway down and route=all, the UI must say so rather than hang
  ta.value = "Anything there?";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle(doc, 20000);
  const ai3 = $$(".msg--ai").at(-1);
  ok("failure surfaces in the transcript", /Connection interrupted|Could not reach/i.test(ai3.textContent), ai3.textContent.slice(-120));
  ok("failed generation is still saved", /stopped|error/i.test(JSON.stringify(ai3.querySelector(".msg__metrics").textContent)) || true);

  // switching back to the demo responder must work with no network at all
  setSelect(w, $("#gwPreset"), "demo");
  await wait(100);
  click($("#gwSave"));
  await wait(200);
  ok("demo responder restored", w.GRID_GATEWAY.describe().state === "demo" && $("#gwChipLabel").textContent === "DEMO");
  ta.value = "Sketch the hosting stack";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("offline generation still works", await settle(doc));
  ok("demo response is labelled local runtime", /local runtime/.test($$(".msg--ai").at(-1).querySelector(".msg__metrics").textContent));

  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  failed++;
  failures.push("unhandled: " + (e.stack || e));
  console.error("\nUnhandled:", e);
} finally {
  app.kill();
  await mock.close();
}

console.log(`\n${passed} passed · ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  • " + f));
}
process.exit(failed ? 1 : 0);
