/* ============================================================================
   tests/shots.mjs — optional visual capture of the three pages.

   Not part of `npm test` (which is pure jsdom and needs no browser). This needs
   a Chromium binary, so it is opt-in:

     npm i -D puppeteer                 # downloads Chromium
     node tests/shots.mjs

   Or point it at a browser you already have:

     PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node tests/shots.mjs

   Writes PNGs into ./shots (gitignored) and prints any console/page errors,
   which is the fastest way to catch a layout or runtime regression that jsdom
   cannot see.
   ========================================================================== */

const BASE = process.env.BASE || "http://127.0.0.1:8080";
const OUT = process.env.OUT || "shots";

let puppeteer;
try {
  puppeteer = (await import("puppeteer")).default;
} catch {
  console.log(`puppeteer is not installed.

  npm i -D puppeteer && node tests/shots.mjs
  # or: PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node tests/shots.mjs

  Start the site first:  node server.js`);
  process.exit(0);
}

const { mkdirSync } = await import("node:fs");
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(name, width = 1440, height = 900) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: 1 });
  p.on("console", (m) => m.type() === "error" && errors.push(`${name} console: ${m.text()}`));
  p.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  p.on("requestfailed", (r) => {
    // Web fonts are the only external request; offline capture is still valid.
    if (!/fonts\.(googleapis|gstatic)/.test(r.url()))
      errors.push(`${name} requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return p;
}

/** Wait until the composer's Send/Stop button returns to "send". */
async function idle(p) {
  for (let i = 0; i < 120; i++) {
    const mode = await p.$eval("#sendBtn", (b) => b.dataset.mode).catch(() => "send");
    if (mode === "send") return;
    await wait(250);
  }
}

/* ------------------------------------------------------------------ landing */
let p = await newPage("index");
await p.goto(`${BASE}/index.html`, { waitUntil: "networkidle2" });
await wait(2800);
await p.screenshot({ path: `${OUT}/01-landing-hero.png` });
await p.screenshot({ path: `${OUT}/02-landing-full.png`, fullPage: true });

/* ---------------------------------------------------------------- workspace */
p = await newPage("app");
await p.goto(`${BASE}/app.html`, { waitUntil: "networkidle2" });
await wait(700);
await p.screenshot({ path: `${OUT}/03-app-empty.png` });

await p.click("#composer");
await p.type("#composer", "Compare the indemnity obligations in the MSA and the DPA", { delay: 8 });
await p.keyboard.press("Enter");
await wait(1500);
await p.screenshot({ path: `${OUT}/04-app-streaming.png` });
await idle(p);
await wait(300);
await p.screenshot({ path: `${OUT}/05-app-complete.png` });

await p.click("#modelChip");
await wait(450);
await p.screenshot({ path: `${OUT}/06-model-picker.png` });
await p.keyboard.press("Escape");
await wait(250);

await p.click("#pstate");
await wait(450);
await p.screenshot({ path: `${OUT}/07-privacy-panel.png` });
await p.keyboard.press("Escape");
await wait(250);

await p.click("#settingsBtn");
await wait(450);
await p.screenshot({ path: `${OUT}/08-settings.png` });
await p.keyboard.press("Escape");
await wait(250);

await p.click("#vaultBtn");
await wait(450);
await p.screenshot({ path: `${OUT}/09-vault.png` });

/* ------------------------------------------------------------------- mobile */
const m = await newPage("mobile", 390, 844);
await m.goto(`${BASE}/app.html`, { waitUntil: "networkidle2" });
await wait(700);
await m.screenshot({ path: `${OUT}/10-mobile-app.png` });
await m.click("#sidebarToggle");
await wait(450);
await m.screenshot({ path: `${OUT}/11-mobile-sidebar.png` });

/* --------------------------------------------------------------------- lab */
p = await newPage("lab");
await p.goto(`${BASE}/lab.html`, { waitUntil: "networkidle2" });
await wait(700);
await p.screenshot({ path: `${OUT}/12-lab.png` });
await p.screenshot({ path: `${OUT}/13-lab-full.png`, fullPage: true });
await p.evaluate(() =>
  [...document.querySelectorAll("#tabs .tab")].find((t) => /Disallowed/.test(t.textContent)).click()
);
await wait(450);
await p.screenshot({ path: `${OUT}/14-lab-disallowed.png` });

await browser.close();
console.log(`wrote screenshots to ./${OUT}/`);
console.log(errors.length ? `\nERRORS (${errors.length}):\n` + errors.join("\n") : "no console or page errors");
process.exit(errors.length ? 1 : 0);
