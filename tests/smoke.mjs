/* ============================================================================
   tests/smoke.mjs — runtime smoke tests for the GRiD-OS-SOVEREIGN reference UI.

   Dev-only (jsdom + fake-indexeddb). The shipped product has zero runtime
   dependencies and no build step; these tests exist to prove the interactive
   behaviour actually works, not to add a toolchain.

     npm install
     npm test
   ========================================================================== */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import "fake-indexeddb/auto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const failures = [];

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPage(file, opts) {
  const html = readFileSync(join(ROOT, file), "utf8");
  const vc = new VirtualConsole();
  const errors = [];
  vc.on("jsdomError", (e) => errors.push(e.message || String(e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost:8080/" + file,
    virtualConsole: vc,
  });
  const w = dom.window;

  // Polyfills jsdom does not provide but the app legitimately uses in browsers.
  Object.defineProperty(w, "indexedDB", { value: globalThis.indexedDB, configurable: true });
  Object.defineProperty(w, "crypto", { value: globalThis.crypto, configurable: true });
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  w.matchMedia = w.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  if (!w.alert) w.alert = () => {};
  w.alert = (m) => (w.__lastAlert = m);

  // Execute the page's own <script src> files in document order, then inlines.
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of srcs) {
    const p = join(ROOT, src);
    if (!existsSync(p)) throw new Error(`missing script ${src}`);
    let code = readFileSync(p, "utf8");
    const patch = opts && opts.patch && opts.patch[src];
    if (patch) code = patch(code);
    w.eval(code);
  }
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const code of inline) w.eval(code);

  w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }));
  return { dom, w, doc: w.document, errors };
}

/** Read a numeric metric out of a rendered variant card in the lab. */
function metricValue(variantIdx, label) {
  const doc = globalThis.__labDoc;
  const card = [...doc.querySelectorAll("#versus .variant")][variantIdx];
  const row = [...card.querySelectorAll(".metric")].find((m) =>
    m.querySelector(".metric__label").textContent.trim().startsWith(label)
  );
  return row ? parseFloat(row.querySelector(".metric__val").textContent) : NaN;
}

/** Wait for a generation to start (button flips to Stop) and then finish.
 *  Polling only for "finished" is wrong: send() is async, so the button is
 *  still in Send state for a few ms after Enter. */
async function settle(doc, { startTimeout = 4000, runTimeout = 30000 } = {}) {
  const mode = () => doc.querySelector("#sendBtn").dataset.mode;
  for (let i = 0; i < startTimeout / 50 && mode() !== "stop"; i++) await wait(50);
  const started = mode() === "stop";
  for (let i = 0; i < runTimeout / 100 && mode() === "stop"; i++) await wait(100);
  await wait(250);
  return started;
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/* ========================================================================== */

async function testLanding() {
  console.log("\nindex.html — landing");
  const { w, doc, errors } = loadPage("index.html");
  await wait(1400);

  ok("hero terminal streams content", doc.getElementById("term").textContent.length > 80, doc.getElementById("term").textContent.slice(0, 40));
  ok("nine palette swatches render", doc.querySelectorAll("#swatches .card").length === 9);
  ok("model shortlist table present", doc.querySelectorAll("#models tbody tr").length === 6);
  ok("architecture flow has 8 nodes", doc.querySelectorAll(".arch__flow .node").length === 8);
  ok("honesty notice present", /design target/i.test(doc.querySelector(".notice").textContent));

  // live theme switcher must rewrite CSS custom properties on :root
  const before = w.getComputedStyle(doc.documentElement).getPropertyValue("--canvas").trim();
  click(doc.querySelector('[data-theme="navy"]'));
  await wait(30);
  const after = w.getComputedStyle(doc.documentElement).getPropertyValue("--canvas").trim();
  ok("theme switcher re-tokens the page", before !== after && after === "#07111f", `${before} → ${after}`);
  ok("theme note updates", /Deep Navy/i.test(doc.getElementById("themeNote").textContent));
  click(doc.querySelector('[data-theme="obsidian"]'));
  await wait(20);
  ok("obsidian theme applies", w.getComputedStyle(doc.documentElement).getPropertyValue("--canvas").trim() === "#0a0a0a");
  ok("no page errors", errors.length === 0, errors.join(" | "));
}

async function testBrand() {
  console.log("\nbrand — single-constant rename");

  // default brand
  const base = loadPage("index.html");
  await wait(200);
  ok("wordmark is injected from brand.js", base.doc.querySelector(".brand [data-brand='name']").textContent === base.w.GRID_BRAND.NAME);
  ok("document title derives from the brand", base.doc.title === `${base.w.GRID_BRAND.NAME} — ${base.w.GRID_BRAND.TAGLINE}`, base.doc.title);
  ok("meta description is brand-managed", base.doc.querySelector('meta[name="description"]').content === base.w.GRID_BRAND.DESCRIPTION);
  ok("logo mark is an injected SVG", base.doc.querySelectorAll(".brand__mark svg").length >= 2);
  ok("favicon generated from the brand", /^data:image\/svg\+xml,/.test(base.doc.querySelector('link[rel="icon"]').href));
  ok("footer legal name and year injected", /Private AI/.test(base.doc.querySelector("[data-brand='legal']").textContent) && base.doc.querySelector("[data-brand='year']").textContent === String(new Date().getFullYear()));
  ok("brand aria labels resolved", /home/.test(base.doc.querySelector(".brand").getAttribute("aria-label")), base.doc.querySelector(".brand").getAttribute("aria-label"));
  ok("no page errors", base.errors.length === 0, base.errors.join(" | "));

  // the rename claim: change ONE constant and every identifying string follows
  const renamed = loadPage("index.html", {
    patch: {
      "assets/js/brand.js": (code) => {
        const out = code.replace('const NAME = "GRiD-OS-SOVEREIGN";', 'const NAME = "QuietCompute";');
        if (out === code) throw new Error("brand.js NAME constant not found — rename point moved");
        return out;
      },
    },
  });
  await wait(1600); // let the hero terminal type its first CLI line
  const d = renamed.doc;
  const B = renamed.w.GRID_BRAND;
  ok("one constant renames the wordmark", [...d.querySelectorAll("[data-brand='name']")].every((e) => e.textContent === "QuietCompute"));
  ok("one constant renames the title", d.title.startsWith("QuietCompute — "), d.title);
  ok("legal name derives from the constant", B.LEGAL_NAME === "QuietCompute Private AI", B.LEGAL_NAME);
  ok("compact wordmark derives from the constant", d.querySelector(".brand__compact").textContent === B.COMPACT && B.COMPACT.length > 0, B.COMPACT);
  ok("slug and CLI name derive from the constant", B.SLUG === "quietcompute" && B.CLI === "quietcompute", `${B.SLUG}/${B.CLI}`);
  ok("hero terminal types the derived CLI name", /quietcompute status/.test(d.getElementById("term").textContent), d.getElementById("term").textContent.slice(0, 40));
  const stale = d.body.textContent.match(/GRiD-OS[-\s]?SOVEREIGN|grid-os-sovereign/gi) || [];
  ok("no stale brand text left in the rendered page", stale.length === 0, stale.slice(0, 3).join(","));
  ok("app page renames too", (() => {
    const app = loadPage("app.html", {
      patch: { "assets/js/brand.js": (c) => c.replace('const NAME = "GRiD-OS-SOVEREIGN";', 'const NAME = "QuietCompute";') },
    });
    return app.doc.title === "QuietCompute — Private workspace";
  })(), "app title");
  ok("lab page renames too", (() => {
    const lab = loadPage("lab.html", {
      patch: { "assets/js/brand.js": (c) => c.replace('const NAME = "GRiD-OS-SOVEREIGN";', 'const NAME = "QuietCompute";') },
    });
    return lab.doc.title === "Behaviour Lab — QuietCompute";
  })(), "lab title");
  ok("no page errors after rename", renamed.errors.length === 0, renamed.errors.join(" | "));
}

async function testWorkspace() {
  console.log("\napp.html — workspace");
  const { w, doc, errors } = loadPage("app.html");
  await wait(300);

  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  ok("default model chip shows a private model", $("#modelChipName").textContent === "Qwen 14B", $("#modelChipName").textContent);
  ok("privacy state starts local-only", $("#pstateLabel").textContent === "Local only" && $("#pstate").dataset.state === "local");
  ok("knowledge retrieval defaults on", $("#knowledgeChipState").textContent === "On");
  ok("empty state offers real example prompts", $$(".suggestion").length === 4);
  ok("vault reports honest plaintext state", /plaintext/i.test($("#vaultState").textContent), $("#vaultState").textContent);

  /* ---- model picker ---- */
  click($("#modelChip"));
  await wait(80);
  const rows = $$("#modelList .mrow");
  ok("model picker lists the full registry", rows.length === w.GRID_MODELS.length, `${rows.length}`);
  ok("picker groups recommended / specialist / advanced", $$("#modelList .picker__group").length === 3);
  ok("every row states a data location", rows.every((r) => r.querySelector(".mrow__loc").textContent.trim().length > 0));
  ok("research profile is visibly tagged", /research/i.test($("#modelList").textContent) && $$("#modelList .tag--research").length >= 1);

  // details disclosure
  const infoBtn = rows[0].querySelector("[data-info]");
  click(infoBtn);
  await wait(20);
  ok("details expand to show licence + memory", !rows[0].querySelector(".mrow__details").hidden && /Apache-2.0/.test(rows[0].textContent));
  ok("details include training posture", /Trains on your data/.test(rows[0].textContent));

  // search narrows the list
  $("#modelSearch").value = "coder";
  $("#modelSearch").dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(40);
  ok("model search filters rows", $$("#modelList .mrow").length === 1, `${$$("#modelList .mrow").length}`);
  $("#modelSearch").value = "";
  $("#modelSearch").dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(40);

  // selecting a private model updates chrome and closes the sheet
  const target = $$("#modelList .mrow").find((r) => /Mistral Small/.test(r.textContent));
  click(target);
  await wait(120);
  ok("selecting a model updates the chip", $("#modelChipName").textContent === "Mistral Small", $("#modelChipName").textContent);
  ok("picker closes after a private selection", $("#sheet-models").dataset.open === "false");

  /* ---- privacy panel ---- */
  click($("#pstate"));
  await wait(80);
  ok("three privacy modes offered", $$("#modeList .mode").length === 3);
  ok("data flow is generated, not static", $$("#flowHost .flow__item").length === 4);
  const externalMode = $$("#modeList .mode")[2];
  click(externalMode);
  await wait(60);
  ok(
    "switching to external requires explicit confirmation",
    $("#dialog").dataset.open === "true" &&
      /confirm data boundary/i.test($("#dialogTitle").textContent) &&
      /leave infrastructure you control/i.test($("#dialogBody").textContent),
    $("#dialogTitle").textContent
  );
  click(doc.querySelector('[data-no]'));
  await wait(40);
  ok("cancelling keeps the session local", $("#pstate").dataset.state === "local" && $("#pstateLabel").textContent === "Local only");
  doc.querySelector("[data-close]") && click($("#sheet-privacy").querySelector("[data-close]"));
  await wait(30);

  /* ---- streaming conversation ---- */
  const ta = $("#composer");
  ta.value = "Compare the indemnity obligations in the MSA and the DPA";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("token estimate updates while typing", /~\d+ tokens/.test($("#tokenEstimate").textContent), $("#tokenEstimate").textContent);

  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(180);
  ok("user message renders before inference completes", $$(".msg--user").length === 1);
  ok("assistant container reserved with a real stage", /retriev|connect|generat/i.test($("#liveStatus").textContent + doc.querySelector(".stage")?.textContent));
  ok("send button becomes stop during generation", $("#sendBtn").dataset.mode === "stop");

  // let the stream finish
  ok("generation started", await settle(doc));

  const ai = doc.querySelector(".msg--ai");
  ok("assistant response streamed to completion", ai && ai.querySelector(".msg__text").textContent.length > 300, `${ai?.querySelector(".msg__text").textContent.length}`);
  ok("streaming caret removed on completion", !ai.querySelector(".stream-cursor"));
  ok("sources cited from the local index", ai.querySelectorAll(".source").length >= 1);
  const metrics = ai.querySelector(".msg__metrics").textContent;
  ok("TTFT reported per message", /TTFT \d+ ms/.test(metrics), metrics);
  ok("throughput reported per message", /tok\/s/.test(metrics), metrics);
  ok("transport labelled local runtime", /local runtime/.test(metrics), metrics);
  ok("conversation persisted locally", (await w.GRID_DB.listConversations()).length === 1);
  const stored = await w.GRID_DB.listMessages((await w.GRID_DB.listConversations())[0].id);
  ok("both messages persisted", stored.length === 2, `${stored.length}`);
  ok("conversation titled from the prompt", /indemnity/i.test((await w.GRID_DB.listConversations())[0].title));
  ok("sidebar lists the conversation", $$("#convList .conv").length === 1);
  ok("latency histogram populated", /ms/.test($("#statP50").textContent), $("#statP50").textContent);

  /* ---- stop generation keeps partial output ---- */
  ta.value = "Sketch the hosting stack for a 20-user rollout";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  for (let i = 0; i < 80 && $("#sendBtn").dataset.mode !== "stop"; i++) await wait(50); // wait for it to start
  ok("second generation started", $("#sendBtn").dataset.mode === "stop");
  await wait(650); // let tokens stream in
  const partialDuring = doc.querySelector(".msg--ai:last-of-type .msg__text").textContent.length;
  click($("#sendBtn")); // stop mid-stream
  for (let i = 0; i < 40 && $("#sendBtn").dataset.mode === "stop"; i++) await wait(100);
  await wait(400);
  ok("tokens had streamed before the stop", partialDuring > 0, `${partialDuring} chars`);
  const stopped = $$(".msg--ai").at(-1);
  ok("stop halts generation", $("#sendBtn").dataset.mode === "send");
  ok("partial output is kept, not discarded", stopped.querySelector(".msg__text").textContent.length > 0);
  ok("stopped state is labelled", /stopped/.test(stopped.querySelector(".msg__metrics").textContent), stopped.querySelector(".msg__metrics").textContent);

  /* ---- encryption round-trip ---- */
  await w.GRID_VAULT.init("correct-horse-battery-staple");
  ok("vault reports unlocked after init", w.GRID_VAULT.unlocked);
  const secret = await w.GRID_DB.addMessage({ convId: "vault-test", role: "user", content: "PAYROLL: 412000 GBP", meta: {} });
  ok("ciphertext does not contain the plaintext", !JSON.stringify(secret.body).includes("PAYROLL"));
  ok("cipher version marked as encrypted", secret.body.v === 1 && Boolean(secret.body.iv));
  ok("decrypt round-trips", (await w.GRID_DB.readMessage(secret)) === "PAYROLL: 412000 GBP");
  w.GRID_VAULT.lock();
  ok("locked vault cannot read bodies", /encrypted/i.test(await w.GRID_DB.readMessage(secret)));
  await w.GRID_VAULT.unlock("correct-horse-battery-staple");
  ok("correct passphrase re-unlocks", (await w.GRID_DB.readMessage(secret)) === "PAYROLL: 412000 GBP");
  let rejected = false;
  try {
    await w.GRID_VAULT.unlock("wrong-passphrase-entirely");
  } catch (e) {
    rejected = e.message === "BAD_PASSPHRASE";
  }
  ok("wrong passphrase is rejected", rejected);

  /* ---- commands ---- */
  ta.value = "/knowledge";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("slash menu opens for commands", $("#cmdMenu").dataset.open === "true");
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(80);
  ok("/knowledge toggles retrieval", $("#knowledgeChipState").textContent === "Off");

  ta.value = "/stats";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await wait(200);
  const statsText = $("#dialogBody").textContent;
  ok("/stats reports local storage facts", /Messages: \d+/.test(statsText) && /TTFT p50/.test(statsText), statsText.slice(0, 70));
  ok("/stats reports vault state", /Vault: (unlocked|locked|off)/.test(statsText), statsText.slice(-40));

  /* ---- retention is enforced, not decorative ---- */
  click(doc.querySelector("#dialog [data-ok]")); // close the stats dialog
  await wait(60);
  const convsOnDisk = (await w.GRID_DB.listConversations()).length;
  ok("one conversation is on disk before the switch", convsOnDisk === 1, `${convsOnDisk}`);

  click($("#newChat"));
  await wait(80);
  $("#retention").value = "0";
  $("#retention").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(250);
  ok("retention 0 switches writes to memory-only", w.GRID_APP.persistOn() === false);
  ok("sidebar labels storage as session-only", /session only/i.test($("#statSize").textContent), $("#statSize").textContent);
  ok("existing history is still readable at retention 0", $$("#convList .conv").length === 1, `${$$("#convList .conv").length}`);

  ta.value = "What does GDPR require for this deployment?";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("memory-only generation completes", await settle(doc));

  ok("transcript renders in the thread", $$("#threadInner .msg").length === 2, `${$$("#threadInner .msg").length}`);
  ok("nothing new written to disk", (await w.GRID_DB.listConversations()).length === convsOnDisk, `${convsOnDisk} → ${(await w.GRID_DB.listConversations()).length}`);
  ok("session-only conversation held in memory and flagged", w.GRID_APP.mem.convs.length === 1 && w.GRID_APP.mem.convs[0].sessionOnly === true);
  ok("session-only conversation appears in the sidebar", $$("#convList .conv").length === 2, `${$$("#convList .conv").length}`);
  ok("sidebar marks it as RAM-only", /RAM/.test($("#convList").textContent));
  const memMsgs = Object.values(w.GRID_APP.mem.msgs).flat();
  ok("both messages live in RAM, not on disk", memMsgs.length === 2 && /GDPR/.test(memMsgs[0].content));
  ok("memory messages never reached IndexedDB", (await w.GRID_DB.listMessages(w.GRID_APP.mem.convs[0].id)).length === 0);

  // switching back to a window restores persistence
  $("#retention").value = "30";
  $("#retention").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(250);
  ok("retention restored", w.GRID_APP.persistOn() === true && /KB/.test($("#statSize").textContent));

  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
}

async function testLab() {
  console.log("\nlab.html — behaviour lab");
  const { w, doc, errors } = loadPage("lab.html");
  globalThis.__labDoc = doc;
  await wait(120);
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  ok("four prompt-set tabs", $$("#tabs .tab").length === 4);
  ok("two variants rendered side by side", $$("#versus .variant").length === 2);
  ok("research variant is visually distinct", $$("#versus .variant--research").length === 1);
  ok("metrics rendered per variant", $$("#versus .metric").length >= 18, `${$$("#versus .metric").length}`);
  ok("safe-work refusal rate shown", /3\.1%/.test($("#versus").textContent));
  ok("paired samples shown for permitted prompts", $$("#samples .sample").length >= 5);
  ok("evaluator rationale included", /Evaluator rationale/.test($("#samples").textContent));
  ok("rubric has seven criteria", $$("#rubric tbody tr").length === 7);
  ok("length distribution shows p10/p50/p90", /p10/.test($("#lengths").textContent) && /p90/.test($("#lengths").textContent));
  ok("illustrative-data notice present", /Illustrative reference data/i.test(doc.querySelector(".callout").textContent));

  // disallowed tab must flip refusal polarity and withhold raw samples
  click($$("#tabs .tab").find((t) => /Disallowed/.test(t.textContent)));
  await wait(80);
  ok("disallowed tab loads", /100 prompts/.test($("#tabNote").textContent));
  const versus = $("#versus").textContent;
  ok("standard refusal rate high on disallowed set", /96%/.test(versus));
  ok("research refusal rate drops to 39%", /39%/.test(versus));
  ok("unsafe completion reported for research variant", /27%/.test(versus));
  ok("raw samples withheld by policy", /withheld/i.test($("#samples").textContent) && $$("#samples .sample__body").length === 0);
  ok("96% refusal is coloured as good, not bad", (() => {
    const row = $$("#versus .metric").find((m) => /Refusal rate/.test(m.textContent));
    return row && row.querySelector(".metric__val").classList.contains("good");
  })());

  // re-running the suite must re-measure and timestamp
  const before = $("#lastRun").textContent;
  await wait(1001);
  click($("#runBtn"));
  for (let i = 0; i < 30 && $("#runBtn").disabled; i++) await wait(100);
  await wait(60);
  ok("run completes and re-enables the button", !$("#runBtn").disabled);
  ok("last-run timestamp updates", $("#lastRun").textContent !== before, `${before} → ${$("#lastRun").textContent}`);
  ok("timestamp is second-precise", /\d{2} \w{3}, \d{2}:\d{2}:\d{2}/.test($("#lastRun").textContent), $("#lastRun").textContent);
  ok("run progress meter is hidden after completion", $("#runMeterWrap").hidden);

  click($$("#tabs .tab").find((t) => /Internal policies/.test(t.textContent)));
  await wait(60);
  const stdFmt = metricValue(0, "Format compliance");
  const resFmt = metricValue(1, "Format compliance");
  ok(
    "policy tab shows format-compliance regression",
    resFmt < stdFmt - 10,
    `standard ${stdFmt}% vs research ${resFmt}%`
  );
  ok("research profile is shorter on policy prompts", metricValue(1, "Median length") < metricValue(0, "Median length"));
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
}

/* -------------------------------------------------------------------------- */
async function testWiki() {
  console.log("\nwiki.html — the KiNETiC-Ai wiki UI");

  const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString();
  const dateOnly = (daysFromNow) => new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);

  /* A fake platform that answers exactly the shapes platform/server.mjs returns.
     Every call is logged so the test can assert what the UI actually sent. */
  function fakePlatform() {
    const calls = [];
    const pages = [
      {
        slug: "legal/indemnity-policy", title: "Indemnity policy", vertical: "legal", revision: 2,
        owner: "alice", updatedBy: "alice", updatedAt: iso(-2), reviewBy: dateOnly(-3), tags: ["indemnity", "contracts"],
        backlinks: ["legal/msa-checklist"], mirrorState: "mirrored", docId: "doc_1",
        sharePoint: { itemId: "sp-wiki-1", webUrl: "https://contoso.sharepoint.com/sites/legal/KiNETiC-Ai Mirror/indemnity-policy.md" },
        body: "# Indemnity policy\n\nCaps are set per contract, reviewed annually.\n",
        snippet: "Caps are set per contract, reviewed annually.",
      },
      {
        slug: "legal/msa-checklist", title: "MSA checklist", vertical: "legal", revision: 1,
        owner: "bob", updatedBy: "bob", updatedAt: iso(-9), reviewBy: dateOnly(12), tags: ["checklist"],
        backlinks: [], mirrorState: "pending", docId: "doc_2", sharePoint: null,
        body: "# MSA checklist\n\nSee [[legal/indemnity-policy]] before signing.\n",
        snippet: "See legal/indemnity-policy before signing.",
      },
      {
        slug: "finance/billing-cadence", title: "Billing cadence", vertical: "finance", revision: 3,
        owner: "carol", updatedBy: "carol", updatedAt: iso(-1), reviewBy: null, tags: ["billing"],
        backlinks: [], mirrorState: "mirrored", docId: "doc_3", sharePoint: { itemId: "sp-wiki-3" },
        body: "Invoices are raised monthly in arrears.\n", snippet: "Invoices are raised monthly in arrears.",
      },
    ];
    const verticals = [
      { id: "legal", label: "Legal", quotaGB: 5, sensitivity: "high" },
      { id: "finance", label: "Finance", quotaGB: 4, sensitivity: "high" },
      { id: "compliance", label: "Compliance", quotaGB: 3, sensitivity: "critical" },
    ];
    const quota = {
      rows: verticals.map((v, i) => ({
        vertical: v.id, label: v.label, quotaGB: v.quotaGB, usedGB: 0.0012 + i * 0.0001,
        pct: 0.02 + i, documents: 2, coldStubs: i === 2 ? 1 : 0, chunks: 6,
        windowDays: i === 2 ? 30 : 60, defaultWindowDays: 60, pressure: "ok", sensitivity: v.sensitivity,
      })),
      total: { liveGB: 0.0015, ceilingGB: 20, pct: 0.0075, chunks: 18, coldStubs: 1 },
      headroomGB: 19.9985, ceilingHeld: true,
    };
    const capacity = {
      plan: { chunkBudget: 1785019, headroom: { storage: 2.5, ram: 2 } },
      actual: { liveGB: 0.0015, byTier: { hot: 10, warm: 5, cold: 3 }, chunks: 18, coldStubs: 1 },
    };
    const stats = { pages: 3, revisions: 6, indexed: 3, mirrored: 2, overdueReviews: 1, backlinks: 1, byVertical: { legal: 2, finance: 1 } };
    const health = {
      ok: true, platform: "KiNETiC-Ai", version: "v1", backend: "memory", embedder: "hash-embed-local", dims: 768,
      liveGB: 0.0015, ceilingGB: 20, documents: 3, chunks: 18, verticals: verticals.map((v) => v.id), sharePoint: "mock",
      fixtureContent: true, // the platform derives this from what it holds; the UI must say so
    };
    const meta = {
      platform: { name: "KiNETiC-Ai", slug: "kinetic-ai", apiVersion: "v1", tagline: "One knowledge substrate." },
      verticals, scopes: ["search", "read", "ingest", "wiki", "admin"], apps: [], tiers: { coldAfterDaysUnopened: 60, adaptive: { tightenAtQuotaPct: 0.9, tightenedDays: 30, criticalAtQuotaPct: 0.97, criticalDays: 14 } },
      storage: { liveCeilingGB: 20, nodeVolumeGB: 50, backup: { rpo: "15m (SharePoint delta sync)", rto: "1h" } },
      key: { appId: "kinetic-wiki", scopes: ["search", "read", "wiki", "admin"], verticals: ["*"], ratePerMin: 240 },
      capacity: capacity.plan.headroom, quota: quota.total,
    };
    const reviews = [
      { slug: "legal/indemnity-policy", title: "Indemnity policy", vertical: "legal", owner: "alice", reviewBy: dateOnly(-3), daysUntilDue: -3, overdue: true, revision: 2, updatedBy: "alice" },
      { slug: "legal/msa-checklist", title: "MSA checklist", vertical: "legal", owner: "bob", reviewBy: dateOnly(12), daysUntilDue: 12, overdue: false, revision: 1, updatedBy: "bob" },
    ];

    let revision = 2;
    const json = (status, body) => ({ status, json: async () => body, ok: status < 400 });

    const fetchStub = async (url, opts = {}) => {
      const method = (opts.method || "GET").toUpperCase();
      const payload = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, url, body: payload, auth: (opts.headers || {}).authorization || null });
      const path = String(url).replace(/^\/platform/, "").split("?")[0];
      const query = new URL("http://x" + String(url).replace(/^\/platform/, "")).searchParams;

      if (path === "/healthz") return json(200, health);
      if (path === "/v1/meta") return json(200, meta);
      if (method === "GET" && path === "/v1/wiki/pages") return json(200, { count: pages.length, pages });
      if (method === "POST" && path === "/v1/wiki/pages") {
        const slug = `${payload.vertical}/${payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        const page = { slug, title: payload.title, vertical: payload.vertical, revision: 1, owner: payload.author, updatedBy: payload.author, updatedAt: iso(0), reviewBy: payload.reviewBy || null, tags: payload.tags || [], backlinks: [], mirrorState: "pending", docId: "doc_new", sharePoint: null, body: payload.body };
        pages.push(page);
        return json(201, { ok: true, page });
      }
      if (method === "PUT" && path.startsWith("/v1/wiki/pages/")) {
        const p = pages.find((x) => x.slug === decodeURIComponent(path.slice("/v1/wiki/pages/".length)));
        if (!p) return json(404, { error: "no such page" });
        revision += 1;
        Object.assign(p, { body: payload.body, revision, updatedBy: payload.author, updatedAt: iso(0), tags: payload.tags || p.tags, reviewBy: payload.reviewBy || p.reviewBy });
        return json(200, { ok: true, page: p });
      }
      if (method === "GET" && path.startsWith("/v1/wiki/pages/") && path.endsWith("/diff"))
        return json(200, {
          slug: pages[0].slug, from: Number(query.get("from")), to: Number(query.get("to")),
          diff: { added: ["Caps are set per contract, reviewed annually."], removed: ["Caps are advisory."], unchanged: 2, linesBefore: 3, linesAfter: 3 },
        });
      if (method === "GET" && path.startsWith("/v1/wiki/pages/")) {
        const slug = decodeURIComponent(path.slice("/v1/wiki/pages/".length));
        const p = pages.find((x) => x.slug === slug);
        if (!p) return json(404, { error: "no such page" });
        return json(200, {
          page: p,
          revisions: [
            { revision: 1, at: iso(-40), author: "alice", note: "first draft", hash: "a1b2c3d4e5f6" },
            { revision: p.revision, at: p.updatedAt, author: p.updatedBy, note: "tightened the cap wording", hash: "f6e5d4c3b2a1" },
          ],
          stats,
        });
      }
      if (path === "/v1/wiki/search") {
        const q = (query.get("q") || "").toLowerCase();
        const results = pages.filter((p) => (p.title + p.body + p.tags.join(" ")).toLowerCase().includes(q))
          .map((p) => ({ slug: p.slug, title: p.title, vertical: p.vertical, revision: p.revision, updatedAt: p.updatedAt, score: 3.4, snippet: p.snippet }));
        return json(200, { count: results.length, results });
      }
      if (path === "/v1/wiki/reviews") return json(200, { count: reviews.length, reviews });
      if (path === "/v1/wiki/stats") return json(200, { ...stats, verticals: verticals.map((v) => v.id) });
      if (method === "POST" && path === "/v1/search")
        return json(200, {
          hits: [],
          citations: [
            { docId: "doc_1", chunkId: "chk_1", title: "Master services agreement — Northwind", heading: "Clause 14.2 indemnity cap", vertical: "legal", sensitivity: "high", tier: "hot", quote: "The supplier's aggregate liability is capped at the fees paid in the twelve months preceding the claim.", page: { start: 12, end: 12 }, checksum: "sha256:9f3c1a2b4d5e6f70", sharePoint: { itemId: "sp-indemnity", webUrl: "https://contoso.sharepoint.com/sites/legal/Knowledge/msa.md" }, mirrorState: "verified" },
            { docId: "doc_w", chunkId: null, title: "Indemnity policy", vertical: "legal", sensitivity: "high", tier: "hot", quote: "Caps are set per contract, reviewed annually.", page: null, checksum: "sha256:11aa22bb33cc44dd", sharePoint: null },
          ],
          cold: [{ docId: "doc_old", title: "2019 supplier terms", vertical: "legal", reason: "not opened for 71 days — reverted to SharePoint", sharePoint: { itemId: "sp-old", webUrl: "https://contoso.sharepoint.com/sites/legal/Knowledge/2019-terms.md" } }],
          metrics: { query: payload.query, retrievalMs: 41, poolSize: 18, denseHits: 12, lexicalHits: 9, fusedHits: 15, returned: 2, coldMatches: 1, embedder: "hash-embed-local", dims: 768, tiers: "hot+warm", budgetMs: 350, withinBudget: true },
          context: "[1] Master services agreement — Northwind — Clause 14.2 indemnity cap (p.12) [legal]\n…",
        });
      if (path === "/v1/admin/quota") return json(200, quota);
      if (path === "/v1/admin/capacity") return json(200, capacity);
      if (method === "POST" && path === "/v1/admin/wiki/mirror") return json(200, { uploaded: 2, failed: [] });
      if (method === "POST" && path === "/v1/admin/mirror/sync") return json(200, { created: 1, updated: 0, unchanged: 2, rejected: [], deltaLink: "tok" });
      if (method === "POST" && path === "/v1/admin/lifecycle/sweep") return json(200, { planned: [{ docId: "doc_old", title: "2019 supplier terms", days: 71, bytesFreed: 40960 }], demoted: [], skipped: [] });
      return json(404, { error: `no route ${method} ${path}` });
    };
    return { fetchStub, calls, pages, quota };
  }

  /* ---- 1. no platform at all: the page must say so, not invent content ---- */
  {
    const { w, doc, errors } = loadPage("wiki.html");
    await wait(120);
    const $ = (s) => doc.querySelector(s);
    const $$ = (s) => [...doc.querySelectorAll(s)];
    ok("the wiki page loads with no errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    ok("the title carries the brand", doc.title === `Wiki — ${w.GRID_BRAND.NAME}`, doc.title);
    ok("without a platform the offline panel is what you see", $("#offlinePanel").hidden === false && $("#listPanel").hidden === true);
    ok("the state line says the platform is not running", $("#stateLine").textContent === "Platform not running", $("#stateLine").textContent);
    ok("the offline panel shows the command that fixes it", /node platform\/server\.mjs/.test($("#offlineCmd").textContent) && /PLATFORM_URL=/.test($("#offlineCmd").textContent));
    ok("no sample pages are invented while the platform is down", $$("#pageList li.wiki__page").length === 0);
    ok("the wiki explains what it is even offline", $$("#offlinePanel .wiki__bullets li").length === 5);
    ok("the key box is offered", $("#keyBox").hidden === false);

    // pure helpers the UI's claims depend on
    const W = w.GRID_WIKI;
    ok("slugify is stable and safe", W.slugify("Billing Cadence!") === "billing-cadence" && W.slugify("  MSA / v2  ") === "msa-v2", W.slugify("  MSA / v2  "));
    ok("groupByVertical buckets and sorts", Object.keys(W.groupByVertical([{ vertical: "legal", title: "b" }, { vertical: "legal", title: "a" }, { vertical: "finance", title: "c" }])).join(",") === "legal,finance" && W.groupByVertical([{ vertical: "legal", title: "b" }, { vertical: "legal", title: "a" }]).legal[0].title === "a");
    ok("formatGB switches units instead of printing 0.000", W.formatGB(0) === "0 GB" && W.formatGB(0.0005) === "0.51 MB" && W.formatGB(0.5) === "512.0 MB" && W.formatGB(1.2345) === "1.234 GB", [W.formatGB(0.0005), W.formatGB(0.5), W.formatGB(1.2345)].join(" / "));
    ok("windowLabel distinguishes the policy default from the window in force", W.windowLabel({ windowDays: 60, defaultWindowDays: 60 }) === "60d" && W.windowLabel({ windowDays: 30, defaultWindowDays: 60 }) === "30d (of 60d)");
    ok("a citation states a page only when the source gave one", /p\.12/.test(W.citationLine({ title: "T", vertical: "legal", page: { start: 12, end: 12 } }, 0)) && !/p\./.test(W.citationLine({ title: "T", vertical: "legal", page: null }, 0)));
    ok("a citation marks restricted and archived content", /restricted/.test(W.citationLine({ title: "T", vertical: "compliance", sensitivity: "critical" }, 0)) && /archived in SharePoint/.test(W.citationLine({ title: "T", vertical: "legal", tier: "cold" }, 0)));
    ok("describeState reports the honest reason in the right order", W.describeState({ status: "offline" }).label === "Platform not running" && W.describeState({ status: "nokey" }).label === "Connected · no key" && W.describeState({ status: "denied", message: "unknown or revoked key" }).detail === "unknown or revoked key" && /^Connected as kinetic-wiki$/.test(W.describeState({ status: "ready", appId: "kinetic-wiki", scopes: ["read"], verticals: ["legal"] }).label));
    ok("timeAgo is human, not an ISO string", W.timeAgo(iso(0)) === "just now" && /days ago/.test(W.timeAgo(iso(-9))) && W.timeAgo(null) === "never");

    // 503 from the proxy (platform configured but down) must read the same way
    w.fetch = async () => ({ status: 503, json: async () => ({ error: "platform not configured", detail: "start platform/server.mjs" }) });
    await W.refresh();
    ok("a 503 from the proxy is also reported as offline", $("#stateLine").textContent === "Platform not running", $("#stateLine").textContent);

    // healthy platform, no key yet
    const fp = fakePlatform();
    w.fetch = fp.fetchStub;
    await W.refresh();
    ok("a healthy platform with no key says exactly that", $("#stateLine").textContent === "Connected · no key", $("#stateLine").textContent);
    ok("health facts are shown without a key (healthz is public)", /hash-embed-local · 768d/.test($("#stateFacts").textContent), $("#stateFacts").textContent);
    ok("sample content is labelled as sample content", /fixture — sample documents seeded with --fixtures, not a live corpus/i.test($("#stateFacts").textContent), $("#stateFacts").textContent.slice(0, 200));
    ok("the offline embedding fallback is stated, not presented as semantic search", /offline fallback — deterministic, not semantic/i.test($("#stateFacts").textContent));
    ok("content is still not rendered without a key", $("#listPanel").hidden === true && $$("#pageList li.wiki__page").length === 0);
    ok("no request carried an authorization header before a key was set", fp.calls.every((c) => !c.auth), JSON.stringify(fp.calls.map((c) => [c.url, c.auth])));
    ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  }

  /* ---- 2. a refused key ---- */
  {
    const { w, doc, errors } = loadPage("wiki.html");
    await wait(80);
    const $ = (s) => doc.querySelector(s);
    const fp = fakePlatform();
    w.fetch = async (url, opts) => (/\/healthz$/.test(url) ? fp.fetchStub(url, opts) : { status: 401, json: async () => ({ error: "unknown or revoked key" }) });
    $("#apiKey").value = "ka_wrong";
    click($("#connectBtn"));
    await wait(120);
    ok("a refused key is reported, not silently ignored", $("#stateLine").textContent === "Key refused", $("#stateLine").textContent);
    ok("the reason from the platform is shown", /unknown or revoked key/.test($("#keyHint").textContent), $("#keyHint").textContent);
    ok("a refused key does not render content", $("#listPanel").hidden === true);
    ok("a refused key is not kept in localStorage", !Object.keys(w.localStorage).some((k) => /key/i.test(k) && w.localStorage.getItem(k) === "ka_wrong"));
    ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  }

  /* ---- 3. the full working wiki ---- */
  {
    const { w, doc, errors } = loadPage("wiki.html");
    await wait(80);
    const $ = (s) => doc.querySelector(s);
    const $$ = (s) => [...doc.querySelectorAll(s)];
    const W = w.GRID_WIKI;
    const fp = fakePlatform();
    w.fetch = fp.fetchStub;

    $("#apiKey").value = "ka_test_secret";
    click($("#connectBtn"));
    await wait(200);

    ok("a valid key connects and names the app", /^Connected as kinetic-wiki$/.test($("#stateLine").textContent), $("#stateLine").textContent);
    ok("the key's own scopes are shown back to it", /scopes search, read, wiki, admin · 3 verticals in scope/.test(W.describeState(W.state).detail), W.describeState(W.state).detail);
    ok("the key is held in sessionStorage, never localStorage", w.sessionStorage.getItem("grid:platform.key") === "ka_test_secret" && !Object.keys(w.localStorage).includes("grid:platform.key"));
    ok("every authenticated call carried the bearer key", fp.calls.filter((c) => !/healthz/.test(c.url)).every((c) => c.auth === "Bearer ka_test_secret"));
    ok("the platform tag names the platform", /KiNETiC-Ai/.test($("#platformTag").textContent));
    ok("the page list is rendered from the API", $$("#pageList li.wiki__page").length === 3, String($$("#pageList li.wiki__page").length));
    ok("each page shows slug, revision, author and mirror state", /legal\/indemnity-policy/.test($("#pageList").textContent) && /r2 · alice/.test($("#pageList").textContent) && /mirrored/.test($("#pageList").textContent));
    ok("verticals are counted from the pages you can read", $$("#verticalList .wiki__vbtn").length === 3 && $$("#verticalList .wiki__vbtn")[0].textContent.includes("2"));
    ok("quota bars are drawn for an admin key", $$("#verticalList .wiki__bar").length === 3);
    ok("overdue reviews are surfaced, not hidden", /3d overdue/.test($("#reviewList").textContent) && /due in 12d/.test($("#reviewList").textContent));
    ok("the capacity gauge reports live against the ceiling", /1\.5 MB live of 20 GB ceiling/.test($("#gaugeLabel").textContent) && /18 chunks · 1 archived stubs/.test($("#gaugeLabel").textContent), $("#gaugeLabel").textContent);
    ok("the quota table shows used, quota and the window in force", $$("#quotaTable tbody tr").length === 3 && /30d \(of 60d\)/.test($("#quotaTable").textContent) && /60d/.test($("#quotaTable").textContent));
    ok("the capacity hint states headroom and whether the ceiling holds", /Headroom/.test($("#capacityHint").textContent) && /ceiling held/.test($("#capacityHint").textContent), $("#capacityHint").textContent);
    ok("the retention panel states the 60-day rule", /60 days goes back to SharePoint/.test($("#retentionLine").textContent), $("#retentionLine").textContent);
    ok("the retention panel reports the chunk budget and tier split", /1,785,019/.test($("#retentionFacts").textContent) && /hot 10/.test($("#retentionFacts").textContent), $("#retentionFacts").textContent);
    ok("the mirror panel reports wiki mirror state and RPO", /2 of 3/.test($("#mirrorFacts").textContent) && /15m/.test($("#mirrorFacts").textContent));

    /* open a page */
    click($('#pageList [data-slug="legal/indemnity-policy"]'));
    await wait(120);
    ok("opening a page shows it", $("#pagePanel").hidden === false && $("#listPanel").hidden === true);
    ok("the page title and metadata are rendered", $("#pageTitle").textContent === "Indemnity policy" && /revision 2/.test($("#pageMeta").textContent) && /legal/.test($("#pageMeta").textContent));
    ok("an overdue review date is flagged on the page", /review by/.test($("#pageMeta").textContent) && $$(".wiki__overdue").length >= 1);
    ok("tags are rendered", $$("#pageMeta .wiki__tag").length === 2);
    ok("the body is rendered as Markdown, not dumped as text", $$("#pageBody h1").length === 1 && $("#pageBody").textContent.includes("Caps are set per contract"));
    ok("a document heading renders as an h1, not a chat-scale h4", $$("#pageBody h4").length === 0);
    ok("backlinks are listed and clickable", $$("#backlinkList [data-slug]").length === 1 && $("#backlinkList").textContent.includes("legal/msa-checklist"));
    ok("the mirror state and the SharePoint link are shown", /mirrored/.test($("#pageMirror").textContent) && /sharepoint\.com/.test($("#pageMirror").innerHTML));

    /* wiki links: [[slug]] in the body must be clickable navigation */
    click($("#backBtn"));
    await wait(40);
    click($('#pageList [data-slug="legal/msa-checklist"]'));
    await wait(120);
    ok("[[slug]] renders as an internal link, not literal brackets", $$("#pageBody a.wikilink").length === 1 && $("#pageBody").textContent.includes("legal/indemnity-policy") && !/\[\[/.test($("#pageBody").textContent), $("#pageBody").innerHTML.slice(0, 160));
    ok("the wiki link carries the target slug", $("#pageBody a.wikilink").dataset.slug === "legal/indemnity-policy");
    const hashBefore = w.location.hash;
    click($("#pageBody a.wikilink"));
    await wait(120);
    ok("clicking a wiki link opens the target page", $("#pageTitle").textContent === "Indemnity policy");
    ok("clicking a wiki link does not dirty the URL hash", w.location.hash === hashBefore, `${hashBefore} → ${w.location.hash}`);

    /* history + diff */
    click($("#historyBtn"));
    await wait(60);
    ok("history lists every revision, newest first", $$("#revisionList .wiki__rev").length === 2 && $$("#revisionList .wiki__rev")[0].textContent.includes("r2"));
    ok("history shows the note, author and content hash", /tightened the cap wording/.test($("#revisionList").textContent) && /f6e5d4c3b2a1/.test($("#revisionList").textContent));
    click($('#revisionList [data-diff="2"]'));
    await wait(90);
    ok("the diff endpoint is called with the revision pair", fp.calls.some((c) => /\/diff\?from=1&to=2$/.test(c.url)), JSON.stringify(fp.calls.slice(-1)));
    ok("the diff shows added and removed lines", $("#diffBox").hidden === false && /reviewed annually/.test($("#diffAdded").textContent) && /advisory/.test($("#diffRemoved").textContent));
    ok("the diff reports line counts", /3 lines before · 3 after · 2 unchanged/.test($("#diffMeta").textContent), $("#diffMeta").textContent);

    /* edit → save creates a revision */
    click($("#backFromHistory"));
    await wait(40);
    click($("#editBtn"));
    await wait(40);
    ok("the editor opens with the current body", $("#editorPanel").hidden === false && $("#bodyInput").value.includes("Caps are set per contract"));
    ok("the editor says saving creates a revision", /creates a new revision/.test($("#editorHint").textContent));
    ok("create-only fields are hidden while editing", $("#newFields").hidden === true);
    $("#bodyInput").value = "# Indemnity policy\n\nCaps are set per contract and reviewed twice a year.\n";
    $("#noteInput").value = "review cadence changed to twice yearly";
    $("#authorInput").value = "dave";
    click($("#saveBtn"));
    await wait(200);
    const put = fp.calls.filter((c) => c.method === "PUT").pop();
    ok("saving PUTs the body, note and author", !!put && put.body.body.includes("twice a year") && put.body.note === "review cadence changed to twice yearly" && put.body.author === "dave", JSON.stringify(put && put.body));
    ok("the author preference is persisted (non-secret)", JSON.parse(w.localStorage.getItem("grid:wiki")).author === "dave");
    ok("the saved revision is shown", /revision 3/.test($("#pageMeta").textContent), $("#pageMeta").textContent);
    ok("a save reports success", /revision 3 saved/.test($("#toast").textContent), $("#toast").textContent);

    /* create a page */
    click($("#newBtn"));
    await wait(60);
    ok("the create form shows title and vertical", $("#newFields").hidden === false && $("#newVertical").options.length === 3);
    ok("the create hint explains that saving indexes the page", /into RAG/.test($("#editorHint").textContent), $("#editorHint").textContent);
    $("#newTitle").value = "Dispute windows";
    $("#newVertical").value = "finance";
    $("#bodyInput").value = "Disputes must be raised within thirty days of invoice.\n";
    $("#noteInput").value = "new page";
    click($("#saveBtn"));
    await wait(200);
    const post = fp.calls.filter((c) => c.method === "POST" && /wiki\/pages$/.test(c.url)).pop();
    ok("creating POSTs title, vertical and body", !!post && post.body.title === "Dispute windows" && post.body.vertical === "finance", JSON.stringify(post && post.body));
    ok("the new page is opened after creation", $("#pageTitle").textContent === "Dispute windows" && /finance\/dispute-windows/.test($("#pageMeta").textContent), $("#pageMeta").textContent);

    /* search */
    click($("#backBtn"));
    await wait(40);
    $("#wikiSearch").value = "indemnity";
    click($("#searchBtn"));
    await wait(120);
    ok("search renders matching pages with their score", $("#resultsPanel").hidden === false && $$("#resultList .wiki__page").length === 2 && /score 3.4/.test($("#resultList").textContent), String($$("#resultList .wiki__page").length));
    ok("search results carry a snippet", /Caps are set per contract/.test($("#resultList").textContent));

    /* ask the index: the RAG half, with citations */
    $("#wikiSearch").value = "indemnity cap";
    click($("#askBtn"));
    await wait(160);
    ok("asking the index POSTs a hybrid search", fp.calls.some((c) => c.method === "POST" && c.url === "/platform/v1/search" && c.body.query === "indemnity cap"));
    ok("citations are rendered with heading, page and vertical", $$("#citeList .wiki__cite").length === 2 && /Clause 14\.2 indemnity cap/.test($("#citeList").textContent) && /\(p\.12\)/.test($("#citeList").textContent) && /\[legal\]/.test($("#citeList").textContent));
    ok("a citation with no page claims no page", !/p\./.test($$("#citeList .wiki__cite")[1].querySelector(".wiki__citeHead").textContent), $$("#citeList .wiki__cite")[1].querySelector(".wiki__citeHead").textContent);
    ok("citations carry their checksum and source link", /sha256:9f3c1a2b4d5e6f70/.test($("#citeList").textContent) && /sharepoint\.com/.test($("#citeList").innerHTML));
    ok("archived content is surfaced with the reason and the way back in", $("#coldBox").hidden === false && /not opened for 71 days — reverted to SharePoint/.test($("#coldBox").textContent) && /open in SharePoint/.test($("#coldBox").textContent));
    ok("retrieval metrics are shown honestly", /pool 18 chunks · dense 12 · lexical 9 · fused 15 · returned 2 · 41 ms \(within the 350 ms budget\) · hash-embed-local 768d/.test($("#askMetrics").textContent), $("#askMetrics").textContent);

    /* admin actions */
    click($("#syncBtn"));
    await wait(140);
    ok("pulling from SharePoint reports created/updated/rejected", /sync — created 1 · updated 0 · rejected 0/.test($("#toast").textContent), $("#toast").textContent);
    click($("#sweepBtn"));
    await wait(140);
    ok("a dry-run sweep says what it WOULD do and that nothing changed", /would archive 1 document/.test($("#toast").textContent) && /nothing changed/.test($("#toast").textContent), $("#toast").textContent);
    ok("the dry-run sweep really was a dry run", fp.calls.some((c) => /lifecycle\/sweep$/.test(c.url) && c.body.dryRun === true));
    click($("#backFromResults"));
    await wait(40);
    click($('#pageList [data-slug="legal/indemnity-policy"]'));
    await wait(100);
    click($("#mirrorBtn"));
    await wait(140);
    ok("mirroring the wiki out to SharePoint reports what it uploaded", /mirrored 2 pages to SharePoint/.test($("#toast").textContent), $("#toast").textContent);

    /* filtering */
    click($("#backBtn"));
    await wait(40);
    click($('#verticalList [data-vertical="finance"]'));
    await wait(60);
    ok("filtering by vertical narrows the list", /finance/.test($("#listTitle").textContent) && $$("#pageList li.wiki__page").length === 2, String($$("#pageList li.wiki__page").length));
    click($('#verticalList [data-vertical="finance"]'));
    await wait(60);
    ok("clicking the filter again clears it", $("#listTitle").textContent === "All pages" && $$("#pageList li.wiki__page").length === 4);

    /* forgetting the key returns to the honest no-key state */
    click($("#forgetBtn"));
    await wait(120);
    ok("forgetting the key clears it from storage and the UI", w.sessionStorage.getItem("grid:platform.key") === null && $("#stateLine").textContent === "Connected · no key" && $("#listPanel").hidden === true);
    ok("no page errors anywhere in the wiki flow", errors.length === 0, errors.slice(0, 3).join(" | "));
  }

  /* ---- 4. a read-only key must not be offered write actions ---- */
  {
    const { w, doc, errors } = loadPage("wiki.html");
    await wait(80);
    const $ = (s) => doc.querySelector(s);
    const fp = fakePlatform();
    w.fetch = async (url, opts) => {
      const r = await fp.fetchStub(url, opts);
      if (/\/v1\/meta$/.test(url)) {
        const body = await r.json();
        body.key = { appId: "behaviour-lab", scopes: ["search", "read"], verticals: ["shared"], ratePerMin: 60 };
        return { status: 200, json: async () => body };
      }
      // the real API scopes the list to the key's verticals (platform/server.mjs)
      if (/\/v1\/wiki\/pages$/.test(url)) return { status: 200, json: async () => ({ count: 0, pages: [], verticals: ["shared"] }) };
      if (/\/v1\/wiki\/stats$/.test(url)) return { status: 200, json: async () => ({ pages: 0, revisions: 0, indexed: 0, mirrored: 0, overdueReviews: 0, backlinks: 0, byVertical: {}, verticals: ["shared"] }) };
      if (/\/v1\/admin\//.test(url)) return { status: 403, json: async () => ({ error: "this key lacks the admin scope" }) };
      return r;
    };
    $("#apiKey").value = "ka_readonly";
    click($("#connectBtn"));
    await wait(200);
    ok("a read-only key connects", /^Connected as behaviour-lab$/.test($("#stateLine").textContent), $("#stateLine").textContent);
    ok("a read-only key sees only its own vertical", w.GRID_WIKI.state.verticals.join(",") === "shared" && doc.querySelectorAll("#verticalList .wiki__vbtn").length === 1 && $("#verticalList").textContent.includes("shared"), w.GRID_WIKI.state.verticals.join(","));
    ok("a read-only key is not shown pages from other verticals", doc.querySelectorAll("#pageList li.wiki__page").length === 0, String(doc.querySelectorAll("#pageList li.wiki__page").length));
    ok("a read-only key is not offered quota figures it cannot see", /need a key with the admin scope|need the admin scope/.test($("#capacityHint").textContent + $("#mirrorHint").textContent), $("#capacityHint").textContent);
    ok("a read-only key cannot sync or sweep", $("#syncBtn").disabled === true && $("#sweepBtn").disabled === true);
    click($("#newBtn"));
    await wait(60);
    ok("creating a page is refused client-side for a key without the wiki scope", /cannot write to the wiki/.test($("#toast").textContent), $("#toast").textContent);
    ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  }

  /* ---- 5. the rename reaches the wiki too ---- */
  {
    const { w, doc } = loadPage("wiki.html", {
      patch: { "assets/js/brand.js": (c) => c.replace('const NAME = "GRiD-OS-SOVEREIGN";', 'const NAME = "QuietCompute";') },
    });
    await wait(120);
    ok("the wiki page renames from the same constant", doc.title === "Wiki — QuietCompute", doc.title);
    ok("the wiki footer legal name derives from the constant", /QuietCompute Private AI/.test(doc.querySelector("[data-brand='legal']").textContent));
    ok("the workspace links to the wiki", (() => {
      const app = loadPage("app.html");
      return !!app.doc.querySelector('#wikiChip[href="wiki.html"]');
    })());
  }
}

/* ========================================================================== */

(async function main() {
  console.log("GRiD-OS-SOVEREIGN smoke tests — jsdom + fake-indexeddb");
  const started = Date.now();
  try {
    await testBrand();
    await testLanding();
    await testWorkspace();
    await testLab();
    await testWiki();
  } catch (e) {
    failed++;
    failures.push("unhandled: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" ") : e));
    console.error("\nUnhandled error:", e);
  }
  console.log(`\n${passed} passed · ${failed} failed · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  • " + f));
  }
  process.exit(failed ? 1 : 0);
})();
