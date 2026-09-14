/* ============================================================================
   tests/smoke.mjs — runtime smoke tests for the Sovereign reference UI.

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

function loadPage(file) {
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
    w.eval(readFileSync(p, "utf8"));
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
  ok("model picker lists the full registry", rows.length === w.SOV_MODELS.length, `${rows.length}`);
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
  ok("conversation persisted locally", (await w.SOV_DB.listConversations()).length === 1);
  const stored = await w.SOV_DB.listMessages((await w.SOV_DB.listConversations())[0].id);
  ok("both messages persisted", stored.length === 2, `${stored.length}`);
  ok("conversation titled from the prompt", /indemnity/i.test((await w.SOV_DB.listConversations())[0].title));
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
  await w.SOV_VAULT.init("correct-horse-battery-staple");
  ok("vault reports unlocked after init", w.SOV_VAULT.unlocked);
  const secret = await w.SOV_DB.addMessage({ convId: "vault-test", role: "user", content: "PAYROLL: 412000 GBP", meta: {} });
  ok("ciphertext does not contain the plaintext", !JSON.stringify(secret.body).includes("PAYROLL"));
  ok("cipher version marked as encrypted", secret.body.v === 1 && Boolean(secret.body.iv));
  ok("decrypt round-trips", (await w.SOV_DB.readMessage(secret)) === "PAYROLL: 412000 GBP");
  w.SOV_VAULT.lock();
  ok("locked vault cannot read bodies", /encrypted/i.test(await w.SOV_DB.readMessage(secret)));
  await w.SOV_VAULT.unlock("correct-horse-battery-staple");
  ok("correct passphrase re-unlocks", (await w.SOV_DB.readMessage(secret)) === "PAYROLL: 412000 GBP");
  let rejected = false;
  try {
    await w.SOV_VAULT.unlock("wrong-passphrase-entirely");
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
  const convsOnDisk = (await w.SOV_DB.listConversations()).length;
  ok("one conversation is on disk before the switch", convsOnDisk === 1, `${convsOnDisk}`);

  click($("#newChat"));
  await wait(80);
  $("#retention").value = "0";
  $("#retention").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(250);
  ok("retention 0 switches writes to memory-only", w.SOV_APP.persistOn() === false);
  ok("sidebar labels storage as session-only", /session only/i.test($("#statSize").textContent), $("#statSize").textContent);
  ok("existing history is still readable at retention 0", $$("#convList .conv").length === 1, `${$$("#convList .conv").length}`);

  ta.value = "What does GDPR require for this deployment?";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  ok("memory-only generation completes", await settle(doc));

  ok("transcript renders in the thread", $$("#threadInner .msg").length === 2, `${$$("#threadInner .msg").length}`);
  ok("nothing new written to disk", (await w.SOV_DB.listConversations()).length === convsOnDisk, `${convsOnDisk} → ${(await w.SOV_DB.listConversations()).length}`);
  ok("session-only conversation held in memory and flagged", w.SOV_APP.mem.convs.length === 1 && w.SOV_APP.mem.convs[0].sessionOnly === true);
  ok("session-only conversation appears in the sidebar", $$("#convList .conv").length === 2, `${$$("#convList .conv").length}`);
  ok("sidebar marks it as RAM-only", /RAM/.test($("#convList").textContent));
  const memMsgs = Object.values(w.SOV_APP.mem.msgs).flat();
  ok("both messages live in RAM, not on disk", memMsgs.length === 2 && /GDPR/.test(memMsgs[0].content));
  ok("memory messages never reached IndexedDB", (await w.SOV_DB.listMessages(w.SOV_APP.mem.convs[0].id)).length === 0);

  // switching back to a window restores persistence
  $("#retention").value = "30";
  $("#retention").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(250);
  ok("retention restored", w.SOV_APP.persistOn() === true && /KB/.test($("#statSize").textContent));

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

/* ========================================================================== */

(async function main() {
  console.log("Sovereign smoke tests — jsdom + fake-indexeddb");
  const started = Date.now();
  try {
    await testLanding();
    await testWorkspace();
    await testLab();
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
