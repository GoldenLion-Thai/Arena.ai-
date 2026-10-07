/* ============================================================================
   tests/deploy.mjs — the deployment layer is code, so it gets tested.

   Covers the four ways this product reaches a host:

     install.sh    automated installer for an existing VPS  (dry-run + renderer)
     local.sh      fastest path on a laptop                 (really started here)
     package.sh    the upload-ready artifact                (reproducible build)
     verify.sh     proof that a deployment behaves          (run against a live host)
     oci/          Terraform + cloud-init                   (static + policy checks)
     .github/      CI and release pipelines                 (YAML parsed, gates present)

     node tests/deploy.mjs
   ========================================================================== */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = join(ROOT, "deploy");
const LOCAL_PORT = Number(process.env.DEPLOY_TEST_PORT || 8123);
const LOCAL_OLLAMA_PORT = Number(process.env.DEPLOY_TEST_OLLAMA_PORT || 11599);
const LOCAL_PLATFORM_PORT = Number(process.env.DEPLOY_TEST_PLATFORM_PORT || 8299); // not 8199: a manual demo once took it
const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}`;
// Platform state lives in a temp dir, so a test run never writes into the repo.
const PLATFORM_DATA = mkdtempSync(join(tmpdir(), "grid-platform-data-"));

let passed = 0;
let failed = 0;
const failures = [];
const notes = [];
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
function note(msg) {
  notes.push(msg);
  console.log(`  · ${msg}`);
}
function section(title) {
  console.log(`\n${title}`);
}

/** run a command, never throw, return {code,out} */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: opts.timeout ?? 180000, ...opts });
  return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "", stderr: r.stderr || "" };
}
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const exists = (p) => existsSync(join(ROOT, p));

async function fetchText(url, ms = 8000, headers = null) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: headers || undefined });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ============================================================ 1 · the scripts
section("deploy scripts — present, executable, syntactically valid");

const SCRIPTS = ["install.sh", "local.sh", "package.sh", "verify.sh"];
for (const s of SCRIPTS) {
  const p = join(DEPLOY, s);
  ok(`${s} exists`, existsSync(p));
  ok(`${s} is executable`, existsSync(p) && (statSync(p).mode & 0o111) !== 0, `mode ${(existsSync(p) ? statSync(p).mode.toString(8) : "-")}`);
  const n = sh("bash", ["-n", p]);
  ok(`${s} passes bash -n`, n.code === 0, n.out.slice(0, 120));
  const src = readFileSync(p, "utf8");
  // verify.sh deliberately omits -e: a failed check must not abort the run.
  ok(`${s} runs under strict mode`, s === "verify.sh" ? /set -uo pipefail/.test(src) : /set -euo pipefail/.test(src),
    s === "verify.sh" ? "verify.sh continues past failures by design" : "");
}

for (const f of ["nginx.conf.tmpl", "ollama.service", "docker-compose.yml", ".env.example", "Makefile", "cloud-init.yaml", "README.md"]) {
  ok(`deploy/${f} present`, exists(`deploy/${f}`));
}

// ============================================================ 2 · installer
section("install.sh — plan, flags, and the nginx renderer");

const help = sh("bash", [join(DEPLOY, "install.sh"), "--help"]);
ok("--help exits 0", help.code === 0, `code ${help.code}`);
for (const flag of ["--domain", "--model", "--auth", "--tls", "--allow", "--dry-run", "--render-only", "--source", "--skip-ollama"]) {
  ok(`--help documents ${flag}`, help.out.includes(flag));
}

const unknown = sh("bash", [join(DEPLOY, "install.sh"), "--nonsense", "--dry-run"]);
ok("unknown flag is rejected", unknown.code !== 0, `code ${unknown.code}`);

const badAuth = sh("bash", [join(DEPLOY, "install.sh"), "--render-only", "--auth", "adminonly"]);
ok("--auth without a password is rejected", badAuth.code !== 0 && /USER:PASS/.test(badAuth.out), badAuth.out.trim().slice(0, 90));

const installerSource = read("deploy/install.sh");
const plan = sh("bash", [
  join(DEPLOY, "install.sh"), "--dry-run", "--yes",
  "--domain", "ci.example.com", "--email", "ci@example.com",
  "--model", "qwen2.5:14b-instruct-q4_K_M", "--model", "qwen2.5:coder7b-q4_K_M",
  "--auth", "admin:s3cret", "--allow", "203.0.113.0/24",
]);
ok("dry-run plan exits 0", plan.code === 0, plan.out.slice(-200));
for (const step of ["preflight", "app runtime", "ollama", "model weights", "app tier", "nginx edge", "TLS", "host firewall", "verification"]) {
  ok(`plan covers: ${step}`, plan.out.includes(step));
}
for (const must of [
  ["detects the node runtime", /node/i],
  ["installs ollama", /ollama.com\/install.sh|ollama/i],
  ["pulls every requested model", /ollama pull qwen2\.5:14b-instruct-q4_K_M[\s\S]*ollama pull qwen2\.5:coder7b-q4_K_M/],
  ["hardens ollama via a systemd drop-in", /ollama\.service\.d\/override\.conf/],
  ["creates the app systemd unit", /grid-os-sovereign\.service/],
  ["writes the app env file", /\/etc\/grid-os-sovereign\.env/],
  ["binds the app tier to loopback", /HOST=127\.0\.0\.1/],
  ["renders the nginx site", /sites-available\/grid-os-sovereign\.conf|conf\.d\/grid-os-sovereign\.conf/],
  ["requests a certificate", /certbot/],
  ["configures the firewall", /ufw|firewall/],
  ["runs the verifier at the end", /verify\.sh/],
  ["prints the public URL", /https:\/\/ci\.example\.com/],
]) {
  ok(must[0], must[1].test(plan.out));
}
ok("installer knows how to install node on apt and dnf families",
  /deb\.nodesource\.com\/setup_20\.x/.test(installerSource) && /dnf module enable -y nodejs:20/.test(installerSource));
ok("dry-run warns that auth is required at the edge", /no authentication configured|basic auth for user/i.test(plan.out));
ok("installer version is a real version, not clobbered by /etc/os-release", /v\d+\.\d+\.\d+/.test(plan.out), (plan.out.match(/installed v[^\s]*/) || [""])[0]);
ok("dry-run created nothing on this machine", !existsSync("/opt/grid-os-sovereign") && !existsSync("/etc/grid-os-sovereign.env"));

// the renderer is a pure function of the flags — test both TLS modes
const tlsSite = sh("bash", [join(DEPLOY, "install.sh"), "--render-only", "--domain", "llm.example.com", "--auth", "admin:pw", "--allow", "203.0.113.0/24"]);
ok("--render-only emits a config", tlsSite.code === 0 && /server \{/.test(tlsSite.out), `code ${tlsSite.code}`);
ok("TLS mode listens on 443 with http2", /listen 443 ssl/.test(tlsSite.out) && /http2 on/.test(tlsSite.out));
ok("server_name is substituted", /server_name llm\.example\.com;/.test(tlsSite.out));
ok("document root points at the install dir", /root \/opt\/grid-os-sovereign;/.test(tlsSite.out));
ok("gateway upstream is loopback only", /server 127\.0\.0\.1:11434;/.test(tlsSite.out));
ok("streaming is never buffered", /proxy_buffering off;/.test(tlsSite.out));
ok("long generations get a long read timeout", /proxy_read_timeout\s+600s/.test(tlsSite.out));
ok("X-Accel-Buffering is disabled", /X-Accel-Buffering no/.test(tlsSite.out));
ok("basic auth is injected", /auth_basic "GRiD-OS-SOVEREIGN"/.test(tlsSite.out) && /auth_basic_user_file/.test(tlsSite.out));
ok("IP allowlist is injected", /allow 203\.0\.113\.0\/24;/.test(tlsSite.out) && /deny all;/.test(tlsSite.out));
ok("ACME challenge path is left open", /acme-challenge/.test(tlsSite.out));
ok("no template tokens survive into real config", !tlsSite.out.split("\n").filter((l) => !/^\s*#/.test(l)).some((l) => l.includes("{{")));
ok("plain-HTTP redirect server is present", /return 301 https:\/\//.test(tlsSite.out));

const plainSite = sh("bash", [join(DEPLOY, "install.sh"), "--render-only", "--tls", "off"]);
ok("--tls off renders an HTTP-only site", /listen 80 default_server/.test(plainSite.out) && !/listen 443/.test(plainSite.out));
ok("HTTP-only site still proxies the gateway", /location \/gateway\//.test(plainSite.out) && /proxy_buffering off/.test(plainSite.out));
ok("HTTP-only site still serves the app", /root \/opt\/grid-os-sovereign/.test(plainSite.out));

const tmplTokens = (read("deploy/nginx.conf.tmpl").match(/\{\{[#^/]?[A-Z_]+\}?[A-Z_/]*\}\}/g) || [])
  .map((t) => t.replace(/[{}]/g, "")).filter((t, i, a) => a.indexOf(t) === i);
const installer = read("deploy/install.sh");
ok("every template token is handled by the installer",
  tmplTokens.every((t) => installer.includes(t.replace(/[#^]/g, "").replace(/\/$/, "")) || ["#TLS", "/TLS", "^TLS", "^/TLS", "SECURITY"].includes(t)),
  tmplTokens.join(","));

// ============================================================ 3 · packager
section("package.sh — upload-ready, checksummed, reproducible");

const distA = mkdtempSync(join(tmpdir(), "grid-dist-a-"));
const distB = mkdtempSync(join(tmpdir(), "grid-dist-b-"));
const pkgA = sh("bash", [join(DEPLOY, "package.sh"), "--out", distA]);
const pkgB = sh("bash", [join(DEPLOY, "package.sh"), "--out", distB]);
ok("package.sh exits 0", pkgA.code === 0, pkgA.out.slice(-300));

const listA = execFileSync("ls", [distA], { encoding: "utf8" }).trim().split("\n");
const tarball = listA.find((f) => f.endsWith(".tar.gz"));
const sumFile = listA.find((f) => f.endsWith(".sha256"));
ok("artifact tarball produced", !!tarball, listA.join(","));
ok("checksum file produced", !!sumFile);
ok("manifest.json produced", listA.includes("manifest.json"));
ok("INSTALL.txt produced", listA.includes("INSTALL.txt"));

const tarPath = join(distA, tarball);
const actual = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
const claimed = readFileSync(join(distA, sumFile), "utf8").split(/\s+/)[0];
ok("checksum matches the artifact", actual === claimed, `${actual.slice(0, 12)} vs ${claimed.slice(0, 12)}`);

const manifest = JSON.parse(readFileSync(join(distA, "manifest.json"), "utf8"));
ok("manifest records the same sha256", manifest.sha256 === actual);
ok("manifest records version and size", manifest.version && manifest.bytes === statSync(tarPath).size);
ok("manifest records the git state", manifest.git && manifest.git.sha);
ok("manifest declares zero runtime dependencies", manifest.runtime.dependencies === "none", manifest.runtime.dependencies);

const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" }).trim().split("\n");
for (const need of [
  "index.html", "app.html", "lab.html", "wiki.html", "server.js",
  "assets/js/brand.js", "assets/js/gateway.js", "assets/js/wiki.js", "assets/js/md.js", "assets/css/grid-os.css",
  "platform/server.mjs", "platform/config.mjs", "platform/retrieve.mjs", "platform/lifecycle.mjs", "platform/wiki.mjs", "platform/schema.sql",
  "docs/DATA-PLATFORM.md",
  "deploy/install.sh", "deploy/verify.sh", "deploy/nginx.conf.tmpl", "deploy/docker-compose.platform.yml",
]) {
  ok(`artifact ships ${need}`, entries.some((e) => e.endsWith("/" + need) || e === need));
}
ok("the manifest lists the data platform and the docs", manifest.contents.includes("platform/") && manifest.contents.includes("docs/") && manifest.contents.includes("wiki.html"), JSON.stringify(manifest.contents));
ok("artifact excludes node_modules", !entries.some((e) => e.includes("node_modules")));
ok("artifact excludes dist and .git", !entries.some((e) => /\/(dist|\.git)\//.test(e)));
ok("artifact is small enough to email", statSync(tarPath).size < 3 * 1024 * 1024, `${(statSync(tarPath).size / 1024).toFixed(0)}KB`);

const shaB = createHash("sha256").update(readFileSync(join(distB, execFileSync("ls", [distB], { encoding: "utf8" }).trim().split("\n").find((f) => f.endsWith(".tar.gz"))))).digest("hex");
ok("build is byte-reproducible", actual === shaB, `${actual.slice(0, 12)} vs ${shaB.slice(0, 12)}`);

/* Reproducibility must not depend on WHEN it ran: a build stamped from the wall
   clock drifts across a second boundary and two hosts can never agree. */
const distC = mkdtempSync(join(tmpdir(), "grid-dist-c-"));
const distD = mkdtempSync(join(tmpdir(), "grid-dist-d-"));
const fixedEnv = { ...process.env, SOURCE_DATE_EPOCH: "1700000000" };
sh("bash", [join(DEPLOY, "package.sh"), "--out", distC], { env: fixedEnv });
sh("bash", [join(DEPLOY, "package.sh"), "--out", distD], { env: fixedEnv });
const tarOf = (d) => join(d, execFileSync("ls", [d], { encoding: "utf8" }).trim().split("\n").find((f) => f.endsWith(".tar.gz")));
const shaC = createHash("sha256").update(readFileSync(tarOf(distC))).digest("hex");
const shaD = createHash("sha256").update(readFileSync(tarOf(distD))).digest("hex");
ok("SOURCE_DATE_EPOCH pins the build byte for byte", shaC === shaD, `${shaC.slice(0, 12)} vs ${shaD.slice(0, 12)}`);
const manC = JSON.parse(readFileSync(join(distC, "manifest.json"), "utf8"));
ok("the stamped date is the source date, not the wall clock", manC.built_at === "2023-11-14T22:13:20Z" && manC.source_date_epoch === 1700000000, `${manC.built_at} / ${manC.source_date_epoch}`);
ok("a build without git stamps from HEAD, so it is still stable", /^\d{4}-\d{2}-\d{2}T/.test(manifest.built_at) && Number.isInteger(manifest.source_date_epoch), manifest.built_at);
rmSync(distC, { recursive: true, force: true });
rmSync(distD, { recursive: true, force: true });

const installTxt = readFileSync(join(distA, "INSTALL.txt"), "utf8");
ok("INSTALL.txt gives the scp command", /scp .*ubuntu@YOUR_HOST:\/tmp\//.test(installTxt));
ok("INSTALL.txt verifies the checksum before installing", /sha256sum -c/.test(installTxt));
ok("INSTALL.txt installs from the extracted tree", /install\.sh --source \./.test(installTxt));
ok("INSTALL.txt documents the local path too", /local\.sh/.test(installTxt));

// ============================================================ 4 · fastest path
section("local.sh — the fastest method, really executed");

const local = spawn("bash", [
  join(DEPLOY, "local.sh"), "--mock", "--no-open",
  "--host", "127.0.0.1", "--port", String(LOCAL_PORT), "--ollama-port", String(LOCAL_OLLAMA_PORT),
  "--platform", "--platform-port", String(LOCAL_PLATFORM_PORT), "--platform-data", PLATFORM_DATA, "--fixtures",
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });

let localLog = "";
local.stdout.on("data", (d) => (localLog += d.toString()));
local.stderr.on("data", (d) => (localLog += d.toString()));

let up = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  const h = await fetchText(`${LOCAL_URL}/healthz`, 1500);
  if (h.status === 200) { up = true; break; }
}
ok("local.sh brings the stack up by itself", up, localLog.slice(-300));
await wait(1200); // local.sh prints its Ready banner after healthz passes
ok("local.sh reports the model host it used", new RegExp(`${LOCAL_OLLAMA_PORT}`).test(localLog), localLog.slice(0, 120));
ok("local.sh prints the URLs to open", /\/app\.html/.test(localLog) && /\/lab\.html/.test(localLog));
ok("local.sh binds loopback by default (privacy first)", /127\.0\.0\.1/.test(localLog) && !/0\.0\.0\.0/.test(localLog));

/* --platform: the data tier comes up on loopback, the app tier is pointed at it,
   and the script says out loud that fixture content is sample content. */
ok("local.sh starts the data platform on the port it was given", /KiNETiC-Ai data platform/.test(localLog) && new RegExp(String(LOCAL_PLATFORM_PORT)).test(localLog), localLog.slice(-260));
ok("local.sh reports the platform's own health numbers", /"liveGB"/.test(localLog) && /"ceilingGB":20/.test(localLog), (localLog.match(/platform: .*/) || [""])[0].slice(0, 160));
ok("local.sh says fixture content is not a live corpus", /fixture content — sample documents, not a live corpus/i.test(localLog));
ok("local.sh prints the command that issues a wiki key", /--create-key --app kinetic-wiki/.test(localLog));

/* A wiki you cannot open is a poor demo, so --fixtures issues a key too. It is
   created before the server starts, so one process owns the store. */
const demoKey = (localLog.match(/ka_[A-Za-z0-9_-]{20,}/) || [null])[0];
ok("--fixtures issues a demo wiki key and pastes it into the banner", !!demoKey && /paste this key/.test(localLog), (localLog.match(/.*paste this key.*/) || ["none"])[0].slice(0, 120));
ok("the demo key is labelled as a local demo key with admin scope", /local demo key with admin scope/i.test(localLog) && /Do not reuse it anywhere real/i.test(localLog));
const keyedPages = demoKey ? await fetchText(`${LOCAL_URL}/platform/v1/wiki/pages`, 6000, { authorization: `Bearer ${demoKey}` }) : { status: 0, body: "no key in the banner" };
ok("the demo key really works against the running platform", keyedPages.status === 200 && /"pages":\[/.test(keyedPages.body || ""), `HTTP ${keyedPages.status} ${(keyedPages.body || "").slice(0, 160)}`);
ok("local.sh points the app tier at the platform", /PLATFORM_URL/.test(read("deploy/local.sh")) && localLog.includes("/wiki.html"));

const platHz = await fetchText(`http://127.0.0.1:${LOCAL_PLATFORM_PORT}/healthz`, 3000);
ok("the platform answers on its own loopback port", platHz.status === 200 && /"ok":true/.test(platHz.body || ""), JSON.stringify(platHz).slice(0, 140));
ok("the platform reports the fixtures it seeded", /"fixtureContent":true/.test(platHz.body || "") && /"documents":11/.test(platHz.body || ""), (platHz.body || "").slice(0, 220));
ok("the platform embedded through the model host, not the offline fallback", /"embedder":"nomic-embed-text"/.test(platHz.body || ""), (platHz.body || "").slice(0, 200));

const proxiedHz = await fetchText(`${LOCAL_URL}/platform/healthz`, 3000);
ok("the app origin proxies /platform/* to the data tier", proxiedHz.status === 200 && /"platform":"KiNETiC-Ai"/.test(proxiedHz.body || ""), JSON.stringify(proxiedHz).slice(0, 160));
const proxiedMeta = await fetchText(`${LOCAL_URL}/platform/v1/meta`, 3000);
ok("a scoped platform route through the proxy demands a key", proxiedMeta.status === 401, `HTTP ${proxiedMeta.status}`);

/* A proxy has one job: make the upstream see the same request the client sent.
   Every filter this API has is a query parameter — ?vertical=, ?tier=, ?days=,
   ?q=, ?limit= — so a proxy that mangles the query does not fail loudly. It
   returns HTTP 200 and an empty list, the demo looks broken, and every unit
   test still passes because none of them sent a "?" through the proxy. So each
   of these sends the same request twice: once straight to the platform, once
   through the app origin, and compares what came back. */
const DIRECT_PLATFORM = `http://127.0.0.1:${LOCAL_PLATFORM_PORT}`;
const demoAuth = demoKey ? { authorization: `Bearer ${demoKey}` } : null;
const directAndProxied = async (path) => ({
  direct: await fetchText(`${DIRECT_PLATFORM}${path}`, 5000, demoAuth),
  via: await fetchText(`${LOCAL_URL}/platform${path}`, 5000, demoAuth),
});
const count = (body) => Number(((body || "").match(/"count":(\d+)/) || [0, -1])[1]);

const qPages = await directAndProxied("/v1/wiki/pages?vertical=compliance");
ok("the proxy forwards a query string exactly once",
  qPages.direct.status === 200 && qPages.via.status === 200 && qPages.direct.body === qPages.via.body,
  `direct ${qPages.direct.status} ${(qPages.direct.body || "").slice(0, 80)} | proxy ${qPages.via.status} ${(qPages.via.body || "").slice(0, 80)}`);
const viaPages = JSON.parse(qPages.via.body || "{}").pages || [];
ok("a vertical filter still filters when it arrives through the app origin",
  viaPages.length === 1 && viaPages.every((p) => p.vertical === "compliance") && viaPages[0].slug === "compliance/retention-and-the-60-day-rule",
  JSON.stringify(viaPages.map((p) => p.slug)));

const qReviews = await directAndProxied("/v1/wiki/reviews?days=120");
ok("the seeded overdue review is visible through the app origin",
  qReviews.via.status === 200 && count(qReviews.via.body) === count(qReviews.direct.body) && /"overdue":true/.test(qReviews.via.body || ""),
  (qReviews.via.body || "").slice(0, 150));
ok("?days= arrives as a number, not as '120?days=120'",
  /"daysUntilDue":-?\d+[,\}]/.test(qReviews.via.body || "") && !/\?/.test((qReviews.via.body || "").replace(/https?:\/\/[^"]*/g, "")),
  (qReviews.via.body || "").slice(0, 150));

const qWikiSearch = await directAndProxied("/v1/wiki/search?q=retention&limit=2");
ok("wiki search through the proxy finds what a direct search finds",
  qWikiSearch.via.status === 200 && count(qWikiSearch.via.body) === count(qWikiSearch.direct.body) && count(qWikiSearch.via.body) >= 1,
  `direct ${count(qWikiSearch.direct.body)} | proxy ${count(qWikiSearch.via.body)} ${(qWikiSearch.via.body || "").slice(0, 100)}`);

const qDocs = await directAndProxied("/v1/documents?tier=cold");
ok("the cold-tier filter works through the app origin",
  qDocs.via.status === 200 && count(qDocs.via.body) === count(qDocs.direct.body) && count(qDocs.via.body) >= 1,
  `direct ${count(qDocs.direct.body)} | proxy ${count(qDocs.via.body)}`);

const qAudit = await directAndProxied("/v1/admin/audit?limit=3&action=key.created");
ok("an admin route with two parameters works through the app origin",
  qAudit.via.status === 200 && Array.isArray(JSON.parse(qAudit.via.body || "{}").entries) && JSON.parse(qAudit.via.body || "{}").entries.length <= 3,
  (qAudit.via.body || "").slice(0, 130));
const wikiPage = await fetchText(`${LOCAL_URL}/wiki.html`, 3000);
ok("the wiki page is served by the app tier", wikiPage.status === 200 && /wiki/i.test(wikiPage.body || ""), `HTTP ${wikiPage.status}`);
const platformStateWritten = existsSync(join(PLATFORM_DATA, "documents.jsonl")) || existsSync(join(PLATFORM_DATA, "state.jsonl"));
ok("the platform persisted its state outside the repo", platformStateWritten, PLATFORM_DATA);
/* A developer's own `local.sh --platform` writes .data/platform inside the
   checkout by design, so the assertion is not "the directory does not exist" but
   "it can never reach a commit, and this test did not use it". */
ok("platform state is gitignored, so a local run cannot pollute a commit", read(".gitignore").split("\n").some((l) => l.trim() === ".data/"), read(".gitignore"));
ok("this test run wrote its platform state to the temp dir only", existsSync(join(PLATFORM_DATA, "keys.jsonl")) || existsSync(join(PLATFORM_DATA, "documents.jsonl")), PLATFORM_DATA);

// ============================================================ 5 · verifier
section("verify.sh — run against the host local.sh just started");

const v = sh("bash", [join(DEPLOY, "verify.sh"), "--url", LOCAL_URL, "--expect-models", "--platform"]);
ok("verify passes on a healthy host", v.code === 0, v.out.split("\n").filter((l) => l.includes("✗")).join(" | ").slice(0, 200));
ok("verify counted its checks", /\d+ passed/.test(v.out), (v.out.match(/\d+ passed[^\n]*/) || [""])[0]);
ok("verify proved discovery through the proxy", /discovery through the same-origin proxy/.test(v.out));
ok("verify proved streaming is incremental", /streaming is incremental/.test(v.out));
ok("verify measured time to first token", /time to first token/.test(v.out));
ok("verify checks runtime token accounting", /runtime token accounting/.test(v.out));
ok("verify warns about missing TLS on http", /TLS not checked/.test(v.out));
ok("verify warns about missing auth", /no authentication/.test(v.out));
ok("verify refuses to guess about public exposure on loopback", /public port exposure not tested/.test(v.out));

ok("verify proves the data platform answers through the app origin", /the data platform answers through the app origin/.test(v.out), v.out.split("\n").filter((l) => /platform/i.test(l)).join(" | ").slice(0, 220));
ok("verify reads the platform's real capacity numbers", /live [0-9.]+ GB of 20 GB/.test(v.out), (v.out.match(/live [^\n]*/) || [""])[0].slice(0, 120));
ok("verify proves the platform API demands a key", /the API refuses a request with no key/.test(v.out));
ok("verify flags fixture content instead of letting it pass as real", /the store holds fixture content/.test(v.out) && /not a live corpus/.test(v.out));
ok("verify flags the offline embedding fallback", /embeddings are the offline fallback/.test(v.out) || /embedder (?!hash-embed-local)/.test(v.out), (v.out.match(/embedder[^\n]*/) || [""])[0].slice(0, 120));
ok("verify checks the wiki page is served", /the wiki page is served/.test(v.out));
ok("verify treats the data port as one that must stay closed", /for P in 11434 8080 8090/.test(read("deploy/verify.sh")));
ok("verify only requires the platform when asked", /meh "the data platform is not enabled"/.test(read("deploy/verify.sh")) && /--platform\)     PLATFORM_EXPECT=1/.test(read("deploy/verify.sh")));

const vjson = sh("bash", [join(DEPLOY, "verify.sh"), "--url", LOCAL_URL, "--json"]);
let parsed = null;
try { parsed = JSON.parse(vjson.stdout); } catch { /* asserted below */ }
ok("verify --json emits valid JSON", parsed && typeof parsed === "object", vjson.stdout.slice(0, 80));
ok("verify --json reports counters and checks", parsed && parsed.pass > 10 && Array.isArray(parsed.checks) && parsed.checks.length > 10);
ok("verify --json has no ANSI escapes", !/\u001b\[/.test(vjson.stdout));

const vfail = sh("bash", [join(DEPLOY, "verify.sh"), "--url", "http://127.0.0.1:9", "--timeout", "3"]);
ok("verify fails loudly on a dead host", vfail.code === 1, `code ${vfail.code}`);
ok("verify names the failures", /✗/.test(vfail.out) && /\d+ failed/.test(vfail.out));

const vmodel = sh("bash", [join(DEPLOY, "verify.sh"), "--url", LOCAL_URL, "--model", "does-not-exist:latest"]);
ok("verify detects a missing requested model", vmodel.code === 1 && /not on the host/.test(vmodel.out), `code ${vmodel.code}`);

// ============================================================ 6 · make
section("Makefile — the same automation without remembering flags");

if (sh("make", ["--version"]).code === 0) {
  const mk = read("deploy/Makefile");
  for (const t of ["help", "local", "mock", "package", "plan", "vps", "verify", "deploy", "ssh-verify", "terraform-plan", "terraform-apply", "lint", "test", "clean"]) {
    ok(`make ${t} target exists`, new RegExp(`^${t}:`, "m").test(mk));
  }
  const dryPlan = sh("make", ["-C", "deploy", "-n", "plan", "DOMAIN=llm.example.com", "EMAIL=o@e.com", "MODELS=a b", "AUTH=u:p", "ALLOW=1.2.3.0/24 5.6.7.0/24"]);
  ok("make plan renders install.sh with every flag", dryPlan.code === 0 && /--dry-run/.test(dryPlan.out) && /--model a --model b/.test(dryPlan.out) && /--allow 1\.2\.3\.0\/24 --allow 5\.6\.7\.0\/24/.test(dryPlan.out) && /--auth u:p/.test(dryPlan.out), dryPlan.out.slice(0, 160));
  const dryVerify = sh("make", ["-C", "deploy", "-n", "verify", "URL=https://llm.example.com", "PUBLIC_HOST=1.2.3.4", "AUTH=u:p"]);
  ok("make verify forwards URL, auth and public host", /verify\.sh --url https:\/\/llm\.example\.com --auth u:p --public-host 1\.2\.3\.4 --expect-models/.test(dryVerify.out), dryVerify.out.slice(0, 160));
  const dryLocal = sh("make", ["-C", "deploy", "-n", "local", "MODEL=qwen2.5:14b", "PORT=9000"]);
  ok("make local forwards model and port", /local\.sh --model qwen2\.5:14b --port 9000/.test(dryLocal.out), dryLocal.out.slice(0, 160));
  const lint = sh("make", ["-C", "deploy", "lint"]);
  ok("make lint passes on every script", lint.code === 0 && /OK/.test(lint.out), lint.out.slice(-120));
} else {
  note("make is not installed here — Makefile checked statically only");
  const mk = read("deploy/Makefile");
  ok("Makefile declares the documented targets", ["local:", "vps:", "package:", "verify:", "deploy:", "terraform-apply:"].every((t) => mk.includes(t)));
}

// ============================================================ 7 · cloud-init
section("cloud-init — first-boot automation for any cloud");

const ci = read("deploy/cloud-init.yaml");
ok("cloud-init.yaml starts with #cloud-config", ci.startsWith("#cloud-config"));
let ciDoc = null;
try { ciDoc = yaml.load(ci); } catch (e) { ok("cloud-init.yaml is valid YAML", false, e.message); }
ok("cloud-init.yaml is valid YAML", !!ciDoc);
if (ciDoc) {
  ok("installs curl and ca-certificates", (ciDoc.packages || []).some((p) => String(p).includes("curl")));
  const files = (ciDoc.write_files || []).map((f) => f.path);
  ok("writes the bootstrap env file", files.includes("/etc/grid-os-sovereign.bootstrap.env"));
  ok("writes an executable bootstrap script", files.some((f) => f.endsWith("grid-bootstrap.sh")));
  const bootFile = (ciDoc.write_files || []).find((f) => f.path.endsWith("grid-bootstrap.sh"));
  ok("bootstrap env is 0600 (it holds the auth password)", (ciDoc.write_files || []).find((f) => f.path.endsWith(".env")).permissions === "0600");
  ok("bootstrap runs install.sh non-interactively", /install\.sh/.test(bootFile.content) && /--yes/.test(bootFile.content));
  ok("bootstrap waits for the network before fetching", /for _ in \$\(seq 1 \d+\)/.test(bootFile.content));
  ok("bootstrap logs to /var/log/grid-bootstrap.log", /grid-bootstrap\.log/.test(bootFile.content));
  ok("bootstrap mounts a model volume when present", /var\/lib\/ollama\/models/.test(bootFile.content) && /mkfs\.ext4/.test(bootFile.content));
  ok("bootstrap passes models and auth through", /--model/.test(bootFile.content) && /--auth/.test(bootFile.content));
  ok("runcmd invokes the bootstrap", JSON.stringify(ciDoc.runcmd || []).includes("grid-bootstrap.sh"));
}

// ============================================================ 8 · terraform
section("oci/terraform — automated infrastructure");

for (const f of ["versions.tf", "variables.tf", "main.tf", "outputs.tf", "cloud-init.tftpl"]) {
  ok(`oci/terraform/${f} present`, exists(`oci/terraform/${f}`));
}
const main = read("oci/terraform/main.tf");
const vars = read("oci/terraform/variables.tf");
const outs = read("oci/terraform/outputs.tf");
const tpl = read("oci/terraform/cloud-init.tftpl");

ok("creates a VCN, subnet and internet gateway", /oci_core_vcn/.test(main) && /oci_core_subnet/.test(main) && /oci_core_internet_gateway/.test(main));
ok("creates a network security group", /oci_core_network_security_group"/.test(main));
ok("allows SSH only from admin CIDRs", /security_rule" "ssh"/.test(main) && /local\.ssh_cidrs/.test(main));
ok("allows HTTPS from the allowlist", /security_rule" "https"/.test(main) && /local\.web_cidrs/.test(main));
// comments may mention the ports; no rule may open them
const portRules = (main.match(/destination_port_range \{[^}]*\}/g) || []).join(" ");
ok("creates NO ingress rule for the model port", !/11434/.test(portRules), portRules);
ok("creates NO ingress rule for the app tier port", !/8080/.test(portRules), portRules);
ok("the only opened ports are 22, 80 and 443", (portRules.match(/min = (\d+)/g) || []).every((m) => /22|80|443/.test(m)), portRules);
ok("port 80 exists only for the redirect and ACME", /min = 80/.test(main) && /acme|redirect/i.test(main));
ok("model weights get their own block volume", /oci_core_volume" "models"/.test(main) && /model_volume_gb/.test(main));
ok("cloud-init is passed as base64 user_data", /base64encode\(templatefile/.test(main) && /user_data/.test(main));
ok("instance is not rebooted by a password change", /ignore_changes = \[metadata\["user_data"\]\]/.test(main));
ok("supports both GPU and A1 Flex shapes", /is_flex/.test(main) && /shape_config/.test(main));
ok("prefers a GPU platform image when available", /oci_core_images" "gpu"/.test(main) && /local\.image_id/.test(main));
ok("auth password is a sensitive variable", /variable "auth_pass"[\s\S]{0,300}sensitive\s*=\s*true/.test(vars));
ok("SSH source defaults to restricted, with a loud fallback", /admin_cidrs/.test(vars) && /would lock you out/.test(main));
ok("outputs tell you how to verify and how to destroy", /verify/.test(outs) && /terraform destroy/.test(outs));
ok("outputs surface the security notes", /security_notes/.test(outs));
ok("template escapes bash variables for Terraform", /\$\$\{/.test(tpl) && !/^\s*\$\{DOMAIN\}/m.test(tpl));
ok("template renders the same bootstrap as the standalone file", /grid-bootstrap\.sh/.test(tpl) && /install\.sh/.test(tpl));

if (sh("terraform", ["version"]).code === 0) {
  const fmt = sh("terraform", ["-chdir=oci/terraform", "fmt", "-check", "-recursive"]);
  ok("terraform fmt -check is clean", fmt.code === 0, fmt.out.slice(0, 200));
  const init = sh("terraform", ["-chdir=oci/terraform", "init", "-backend=false", "-input=false"], { timeout: 300000 });
  ok("terraform init succeeds", init.code === 0, init.out.slice(-200));
  if (init.code === 0) {
    const val = sh("terraform", ["-chdir=oci/terraform", "validate"]);
    ok("terraform validate succeeds", val.code === 0, val.out.slice(-300));
  }
} else {
  note("terraform is not installed here — CI runs fmt/validate (see .github/workflows/ci.yml)");
}

// ============================================================ 9 · pipelines
section(".github/workflows — the automated method");

for (const wf of ["ci.yml", "release.yml"]) {
  const p = `.github/workflows/${wf}`;
  ok(`${p} present`, exists(p));
  let doc = null;
  try { doc = yaml.load(read(p)); } catch (e) { ok(`${p} is valid YAML`, false, e.message); }
  ok(`${p} is valid YAML`, !!doc);
  if (!doc) continue;
  const text = read(p);
  ok(`${p} does not use secrets in an if: (not allowed)`, !/^\s*if:.*secrets\./m.test(text));
  ok(`${p} declares jobs`, Object.keys(doc.jobs || {}).length > 0);
  const triggers = doc.on ?? doc[true];   // YAML 1.1 parses `on:` as boolean true
  ok(`${p} declares its triggers`, !!triggers);
  if (wf === "ci.yml") {
    ok("CI runs on pushes and pull requests", !!triggers.push && "pull_request" in triggers);
    ok("CI runs the full test suite", /npm test/.test(text));
    ok("CI exercises the deployment harness end to end", /verify\.sh --url/.test(text) && /mock-ollama/.test(text));
    ok("CI checks the installer plan", /install\.sh --dry-run/.test(text));
    ok("CI checks the nginx renderer in both modes", /--render-only/.test(text) && /--tls off/.test(text));
    ok("CI asserts the artifact is reproducible", /reproducible/i.test(text) && /sha256sum/.test(text));
    ok("CI validates the Terraform", /terraform validate/.test(text));
    ok("CI lints the shell", /bash -n/.test(text) || /shellcheck/i.test(text));
  }
  if (wf === "release.yml") {
    ok("release runs on tags and manual dispatch", !!triggers.push?.tags && "workflow_dispatch" in triggers);
    ok("release packages and tests first", /npm test/.test(text) && /package\.sh/.test(text));
    ok("release uploads the artifact", /upload-artifact/.test(text));
    ok("release creates a GitHub release", /gh release create/.test(text));
    ok("release can deploy over SSH", /DEPLOY_HOST/.test(text) && /DEPLOY_SSH_KEY/.test(text));
    ok("release verifies the deployed host", /verify\.sh --url/.test(text));
    ok("release can provision with Terraform", /terraform apply/.test(text) && /TF_VAR_/.test(text));
    ok("deploy job no-ops cleanly without a target", /configured=false/.test(text));
    ok("checksums are verified on the remote host", /sha256sum -c/.test(text));
  }
}

// ============================================================ 10 · docs
section("documentation");

const dReadme = read("deploy/README.md");
ok("deploy/README documents the fastest method", /local\.sh|fastest/i.test(dReadme));
ok("deploy/README documents the automated installer", /install\.sh/.test(dReadme));
ok("deploy/README documents the artifact path", /package\.sh|scp/.test(dReadme));
ok("deploy/README documents verification", /verify\.sh/.test(dReadme));
ok("deploy/README documents Terraform", /terraform/i.test(dReadme));
ok("deploy/README keeps the model port private", /11434/.test(dReadme) && /loopback|private|not public/i.test(dReadme));
ok("root README points at the deployment layer", /deploy\/(install|local|package|verify)\.sh/.test(read("README.md")));
ok("DESIGN.md covers automated deployment", /terraform|install\.sh/i.test(read("DESIGN.md")));

// ================================================ 11 · KiNETiC-Ai data tier
section("deploying the KiNETiC-Ai data platform");

for (const flag of ["--platform", "--platform-port", "--embed-model"]) {
  ok(`--help documents ${flag}`, help.out.includes(flag));
}

const platPlan = sh("bash", [join(DEPLOY, "install.sh"), "--dry-run", "--yes", "--platform", "--skip-nginx", "--skip-firewall", "--skip-verify"]);
ok("the platform plan exits 0", platPlan.code === 0, platPlan.out.slice(-160));
ok("the plan writes a platform env file", /write \/etc\/kinetic-ai\.env/.test(platPlan.out));
ok("the platform binds loopback only", /PLATFORM_HOST=127\.0\.0\.1/.test(platPlan.out));
ok("the platform env uses the names parseArgs() actually reads", /PLATFORM_PORT=8090/.test(platPlan.out) && /PLATFORM_DATA=\/var\/lib\/kinetic-ai/.test(platPlan.out) && /PLATFORM_EMBED=auto/.test(platPlan.out) && /OLLAMA_URL=http:\/\//.test(platPlan.out));
ok("the platform unit runs platform/server.mjs as the service user", /ExecStart=\/usr\/bin\/env node platform\/server\.mjs/.test(platPlan.out) && /User=grid/.test(platPlan.out));
ok("the platform unit is hardened and can only write its own data dir", /ProtectSystem=strict/.test(platPlan.out) && /ReadWritePaths=\/var\/lib\/kinetic-ai/.test(platPlan.out) && /NoNewPrivileges=true/.test(platPlan.out));
ok("the platform starts after the model host", /After=network-online\.target ollama\.service/.test(platPlan.out));
ok("the embedding model is pulled with the platform", /ollama pull nomic-embed-text/.test(platPlan.out));
ok("the app tier is told where the platform lives", /PLATFORM_URL=http:\/\/127\.0\.0\.1:8090/.test(platPlan.out));
ok("the summary reports the platform endpoint", /Platform\s+http:\/\/127\.0\.0\.1:8090/.test(platPlan.out));
ok("the step count grows to include the platform", /\[10\/10\]/.test(platPlan.out) && !/\/9\]/.test(platPlan.out));
ok("the plan tells the operator how to issue a key", /--create-key kinetic-wiki/.test(platPlan.out));

const noPlat = sh("bash", [join(DEPLOY, "install.sh"), "--dry-run", "--yes", "--skip-nginx", "--skip-firewall", "--skip-verify"]);
ok("without --platform nothing platform-shaped is written", !/kinetic-ai/.test(noPlat.out) && /PLATFORM_URL not set/.test(noPlat.out));
ok("without --platform the step count stays at 9", /\[9\/9\]/.test(noPlat.out) && !/\/10\]/.test(noPlat.out));
ok("without --platform the summary says so honestly", /Platform\s+not enabled/.test(noPlat.out));
ok("--platform-port is honoured", sh("bash", [join(DEPLOY, "install.sh"), "--dry-run", "--yes", "--platform", "--platform-port", "9911", "--skip-nginx", "--skip-firewall", "--skip-verify"]).out.includes("PLATFORM_PORT=9911"));
const embedPlan = sh("bash", [join(DEPLOY, "install.sh"), "--dry-run", "--yes", "--platform", "--embed-model", "bge-m3", "--skip-nginx", "--skip-firewall", "--skip-verify"]);
ok("--embed-model changes the model that gets pulled", /ollama pull bge-m3/.test(embedPlan.out) && !/ollama pull nomic-embed-text/.test(embedPlan.out), (embedPlan.out.match(/ollama pull \S+/g) || []).join(","));

const COMPOSE = "deploy/docker-compose.platform.yml";
ok("the platform compose file is present", exists(COMPOSE));
let cdoc = null;
try { cdoc = yaml.load(read(COMPOSE)); } catch (e) { ok("the platform compose is valid YAML", false, e.message); }
ok("the platform compose is valid YAML", !!cdoc);
if (cdoc) {
  const svc = cdoc.services || {};
  const text = read(COMPOSE);
  ok("it defines the app, platform, model host and pull job", ["grid-os", "platform", "ollama", "model-pull"].every((k) => svc[k]), Object.keys(svc).join(","));
  ok("only the app tier publishes a port", Object.entries(svc).filter(([, v]) => (v.ports || []).length).map(([k]) => k).join(",") === "grid-os", Object.entries(svc).filter(([, v]) => (v.ports || []).length).map(([k]) => k).join(","));
  ok("the app tier proxies /platform/* to the platform by DNS name", svc["grid-os"].environment.PLATFORM_URL === "http://platform:8090");
  ok("the app tier waits for a healthy platform", svc["grid-os"].depends_on?.platform?.condition === "service_healthy");
  ok("the store lives on a volume, not the read-only code mount", svc.platform.volumes.some((v) => String(v).endsWith("platform-data:/data")) && svc.platform.volumes.some((v) => String(v).endsWith(":ro")) && svc.platform.environment.PLATFORM_DATA === "/data", JSON.stringify(svc.platform.volumes));
  ok("the platform healthcheck hits /healthz", JSON.stringify(svc.platform.healthcheck?.test || "").includes("/healthz"));
  ok("the pull job fetches an embedding model, not just a chat model", /EMBED_MODEL/.test(svc["model-pull"].command.join(" ")) && /nomic-embed-text/.test(text));
  ok("Postgres is behind a profile, so the default stack stays as it is", (svc.postgres.profiles || []).includes("pgvector"));
  ok("the production schema is applied on first boot", (svc.postgres.volumes || []).some((v) => String(v).includes("platform/schema.sql") && String(v).includes("docker-entrypoint-initdb.d")));
  ok("Postgres is tuned to the capacity plan", ["maintenance_work_mem=3GB", "max_connections=100", "hnsw.ef_search=100"].every((c) => svc.postgres.command.includes(c)), svc.postgres.command.filter((c) => /=/.test(c)).join(" "));
  ok("Postgres is not published either", !svc.postgres.ports);
  ok("the compose file is honest about what is not wired yet", /does not use it|next piece of work/i.test(text));
  ok("the compose file states the same numbers as the capacity plan", /50 GB per node/.test(text) && /20 GB/.test(text) && /22 GB/.test(text));
}

ok("docs/DATA-PLATFORM.md documents the platform", exists("docs/DATA-PLATFORM.md"));
if (exists("docs/DATA-PLATFORM.md")) {
  const doc = read("docs/DATA-PLATFORM.md");
  ok("the design doc states the capacity ceiling and per-node volume", /20\s*GB/.test(doc) && /50\s*GB/.test(doc));
  ok("the design doc states the double-headroom rule as arithmetic", /2×|2x|double/i.test(doc) && /10,?226/.test(doc));
  ok("the design doc states the 60-day rule and the way back in", /60[- ]day/i.test(doc) && /rehydrat/i.test(doc));
  ok("the design doc states that the mirror is verified before anything is demoted", /verif/i.test(doc) && /never deletes the only copy|only copy/i.test(doc));
  ok("the design doc names the verticals and their quotas", /legal/i.test(doc) && /compliance/i.test(doc) && /quota/i.test(doc));
  ok("the design doc says what is NOT built yet", /not (yet )?(built|wired|implemented)|next piece of work|does not use it/i.test(doc));
  ok("the design doc points at the tests that prove it", /tests\/platform\.mjs/.test(doc) && /npm test/.test(doc));
}
ok("deploy/README documents the platform tier", /--platform/.test(read("deploy/README.md")) && /docker-compose\.platform\.yml/.test(read("deploy/README.md")));
ok("deploy/README no longer calls retrieval illustrative", !/RAG[^.]{0,60}illustrative/i.test(read("deploy/README.md")));
ok("root README points at the data platform", /KiNETiC-Ai/.test(read("README.md")) && /platform\/server\.mjs|docs\/DATA-PLATFORM\.md/.test(read("README.md")));
ok("DESIGN.md covers the data platform", /KiNETiC-Ai/.test(read("DESIGN.md")));

// ====================================================== 13 · the container image
section("Dockerfile — one image, two roles, no build step, no root");

ok("Dockerfile exists at the repository root", exists("Dockerfile"));
ok(".dockerignore exists alongside it", exists(".dockerignore"));
const dockerfile = exists("Dockerfile") ? read("Dockerfile") : "";
const dockerignore = exists(".dockerignore") ? read(".dockerignore") : "";

ok("the base image is a pinned Node 22 alpine", /^FROM node:22-alpine$/m.test(dockerfile));
ok("there is no npm install in the image — the runtime has zero dependencies", !/\bnpm (install|ci|i)\b/.test(dockerfile));
ok("the image runs as a non-root user", /^USER grid$/m.test(dockerfile) && /adduser -S grid/.test(dockerfile));
ok("the image declares a HEALTHCHECK", /^HEALTHCHECK /m.test(dockerfile));
ok("the healthcheck probes /healthz instead of returning true", /\/healthz/.test(dockerfile) && !/CMD\s+(true|none)\b/.test(dockerfile));
ok("the healthcheck works for either role (PLATFORM_PORT wins, else PORT)", /PLATFORM_PORT\|\|process\.env\.PORT/.test(dockerfile));
ok("the image exposes the app tier port", /^EXPOSE 8080$/m.test(dockerfile));
ok("the default command is the app tier", /^CMD \["node", "server\.js"\]$/m.test(dockerfile));
ok("the platform role is a command override, not a second image", /node platform\/server\.mjs/.test(dockerfile));
ok("the image sets the same-origin proxy prefixes by default", /GATEWAY_PREFIX=\/gateway\//.test(dockerfile) && /PLATFORM_PREFIX=\/platform\//.test(dockerfile));
ok("a writable /data volume exists for the platform's store", /^VOLUME \["\/data"\]$/m.test(dockerfile));

// Every COPY source must exist, or `docker build` fails on a clean clone.
const copySources = [...dockerfile.matchAll(/^COPY\s+(.+?)\s+(?:\.\/|\S+)\s*$/gm)]
  .flatMap((m) => m[1].split(/\s+/))
  .filter((s) => !s.startsWith("--") && !s.startsWith("./") && s !== ".");
ok("the Dockerfile COPYs the runtime surface", copySources.length >= 8, `found ${copySources.length}`);
for (const src of copySources) ok(`COPY source exists in the repository: ${src}`, exists(src));
ok("the image copies the platform code", copySources.includes("platform"));
ok("the image copies all four surfaces in one line", /COPY index\.html app\.html lab\.html wiki\.html/.test(dockerfile));

ok(".dockerignore keeps .git out of the build context", /^\.git$/m.test(dockerignore));
ok(".dockerignore keeps node_modules out", /^node_modules$/m.test(dockerignore));
ok(".dockerignore keeps local runtime state out", /^\.data$/m.test(dockerignore));
ok(".dockerignore says why .data is excluded — it can hold real content hashes", /residency|content hashes|audit/i.test(dockerignore));
ok(".dockerignore keeps proof and packaging out of the runtime image",
  ["tests", "deploy", "handover", "docs", "oci"].every((d) => new RegExp(`^${d}$`, "m").test(dockerignore)));
ok(".dockerignore keeps env files out", /^\.env$/m.test(dockerignore));

// ============================================================ 14 · Coolify
section("Coolify — the free-forever path from a VPS to a URL on your laptop");

const COOLIFY_COMPOSE = "deploy/coolify/docker-compose.yml";
const COOLIFY_INSTALL = "deploy/coolify/install-coolify.sh";
ok(`${COOLIFY_COMPOSE} exists`, exists(COOLIFY_COMPOSE));
ok(`${COOLIFY_INSTALL} exists`, exists(COOLIFY_INSTALL));

const coolText = exists(COOLIFY_COMPOSE) ? read(COOLIFY_COMPOSE) : "";
let coolDoc = null;
try { coolDoc = yaml.load(coolText); } catch (e) { ok("the Coolify compose is valid YAML", false, e.message); }
ok("the Coolify compose is valid YAML", !!coolDoc);

if (coolDoc) {
  const svcs = coolDoc.services || {};
  for (const s of ["grid-os", "platform", "ollama", "model-pull", "postgres"]) ok(`the compose defines ${s}`, !!svcs[s]);

  const gridEnv = (svcs["grid-os"]?.environment || []).map(String);
  const magic = gridEnv.find((e) => /^SERVICE_(URL|FQDN)_/.test(e));
  ok("grid-os declares a Coolify magic variable", !!magic, magic || "none found");
  ok("the magic variable carries the app tier port", /_8080$/.test(magic || ""), String(magic));
  ok("the magic variable is left valueless for Coolify to generate", magic ? !/=.+/.test(magic) : false);
  ok("no other service declares a magic URL — only the app tier faces the internet",
    Object.entries(svcs).filter(([n, s]) => n !== "grid-os" && (s.environment || []).map(String).some((e) => /^SERVICE_(URL|FQDN)_/.test(e))).length === 0);
  ok("no service publishes a port; Coolify's proxy is the only way in",
    Object.values(svcs).every((s) => !s.ports || s.ports.length === 0));
  ok("no internal port is published anywhere in the file", !/"(8090|11434|5432):/.test(coolText));

  const ctx = svcs["grid-os"]?.build?.context;
  ok("grid-os builds from an explicit context", !!ctx, String(ctx));
  const ctxResolved = join(dirname(join(ROOT, COOLIFY_COMPOSE)), String(ctx || ""));
  ok(`the context "${ctx}" resolves to the repository root`, ctxResolved === ROOT, ctxResolved);
  ok("the Dockerfile that context points at exists",
    existsSync(join(ctxResolved, String(svcs["grid-os"]?.build?.dockerfile || "Dockerfile"))));
  ok("the platform reuses the same image with a command override",
    (svcs.platform?.command || []).join(" ") === "node platform/server.mjs");
  ok("the platform persists to a named volume, not the container filesystem",
    (svcs.platform?.volumes || []).some((v) => String(v).startsWith("platform-data:")));
  ok("the platform binds inside the container network only",
    (svcs.platform?.environment || []).map(String).includes("PLATFORM_HOST=0.0.0.0"));
  ok("grid-os reaches the platform by compose DNS, never by host address",
    gridEnv.includes("PLATFORM_URL=http://platform:8090"));
  ok("grid-os reaches the model host by compose DNS", gridEnv.includes("OLLAMA_URL=http://ollama:11434"));
  ok("grid-os waits for a healthy platform before starting",
    svcs["grid-os"]?.depends_on?.platform?.condition === "service_healthy");
  ok("grid-os and platform both carry a healthcheck", !!svcs["grid-os"]?.healthcheck && !!svcs.platform?.healthcheck);
  ok("ollama keeps weights on a named volume so a redeploy does not re-download them",
    (svcs.ollama?.volumes || []).some((v) => String(v).startsWith("ollama-models:")));
  ok("ollama has a healthcheck", !!svcs.ollama?.healthcheck);
  ok("the GPU block ships disabled so a CPU VPS can deploy at all", !svcs.ollama?.deploy,
    "uncomment it only on a node with the NVIDIA container toolkit");
  ok("model-pull is one-shot and cannot restart forever", svcs["model-pull"]?.restart === "no");
  ok("model-pull fetches the embedding model that makes retrieval real",
    /EMBED_MODEL/.test(JSON.stringify(svcs["model-pull"])) && /nomic-embed-text/.test(coolText));
  ok("postgres is behind the pgvector profile", (svcs.postgres?.profiles || []).includes("pgvector"));
  const schemaMount = (svcs.postgres?.volumes || []).map(String).find((v) => v.includes("schema.sql"));
  ok("postgres applies platform/schema.sql on first boot", !!schemaMount, String(schemaMount));
  if (schemaMount) {
    ok("that schema mount path resolves to a real file",
      existsSync(join(dirname(join(ROOT, COOLIFY_COMPOSE)), schemaMount.split(":")[0])), schemaMount.split(":")[0]);
  }
  ok("the database is tuned from the capacity plan rather than guessed",
    /maintenance_work_mem=3GB/.test(coolText) && /shared_buffers=4GB/.test(coolText) && /max_connections=100/.test(coolText));
  ok("the compose states the 50 GB per node / 20 GB live figures", /50 GB per node/.test(coolText) && /20 GB/.test(coolText));
  ok("the compose is honest that DATABASE_URL is not read yet", /next piece of work|still persists/i.test(coolText));
  ok("the compose explains how the public URL happens", /SERVICE_URL_GRID_8080/.test(coolText) && /Let's Encrypt/i.test(coolText));
  ok("the compose tells the operator where secrets belong (Coolify env vars)", /Environment\s*\n?\s*Variables|Coolify \(Resource → Environment/i.test(coolText));
}

ok("install-coolify.sh is executable", exists(COOLIFY_INSTALL) && (statSync(join(ROOT, COOLIFY_INSTALL)).mode & 0o111) !== 0);
const coolSyntax = sh("bash", ["-n", join(ROOT, COOLIFY_INSTALL)]);
ok("install-coolify.sh passes bash -n", coolSyntax.code === 0, coolSyntax.out.slice(0, 160));
const cool = exists(COOLIFY_INSTALL) ? read(COOLIFY_INSTALL) : "";
ok("it runs under strict mode", /set -euo pipefail/.test(cool));
// The CDN base is defined once and composed, so check the pieces, not one long literal.
ok("it points at the OFFICIAL Coolify CDN rather than a fork", /^CDN="https:\/\/cdn\.coollabs\.io\/coolify"$/m.test(cool));
ok("it installs from the CDN's install.sh", /INSTALLER="\$CDN\/install\.sh"/.test(cool));
ok("it reads the CDN's versions.json to report the latest release", /VERSIONS_JSON="\$CDN\/versions\.json"/.test(cool) && /coolify-versions\.json/.test(cool));
ok("it upgrades using Coolify's own upgrade.sh, preferring the installed copy",
  /UPGRADE_SH="\$CDN\/upgrade\.sh"/.test(cool) && /COOLIFY_SOURCE="\/data\/coolify\/source"/.test(cool)
  && /\$COOLIFY_SOURCE\/upgrade\.sh/.test(cool));
ok("it passes the documented upgrade arguments (image, helper, registry, skip-backup)",
  /latest latest '\$\{REGISTRY:-docker\.io\}' false/.test(cool));
ok("it uses the installer's documented unattended variables",
  ["ROOT_USERNAME", "ROOT_USER_EMAIL", "ROOT_USER_PASSWORD", "AUTOUPDATE", "REGISTRY_URL"].every((v) => cool.includes(v)));
ok("it refuses to install as a non-root user", /id -u/.test(cool) && /must run as root/i.test(cool));
ok("a rehearsal is allowed without root so it can be dry-run anywhere", /allowed without it/i.test(cool));
ok("it checks the host before touching it (RAM, disk, ports, Docker, curl)",
  ["MemTotal", "df -BG", "80 443", "docker", "curl"].every((t) => cool.includes(t)));
ok("it knows Coolify's UI port and says so", /COOLIFY_UI_PORT=8000/.test(cool) && /:8000/.test(cool));
ok("it shows what it downloaded before running it as root", /sha256sum/.test(cool) && /head -n1/.test(cool));
ok("it refuses to execute a download that is not a script", /does not start with a shebang/i.test(cool));
ok("it never accepts a password as a command-line value", !/--password\)/.test(cool) && /--password-file\)/.test(cool));
ok("it explains why: argv is readable by other users on the host", /\/proc\/|shell history/i.test(cool));
ok("it documents its exit codes", /Exit codes: 0 ok/.test(cool));
ok("it fails loudly when the Coolify CDN is unreachable instead of hanging", /exit 3/.test(cool) && /cannot be installed offline/i.test(cool));
ok("it ends by telling the operator how to reach the app from a laptop",
  /Where to point your laptop/i.test(cool) && /deploy\/coolify\/docker-compose\.yml/.test(cool));
ok("it offers --dry-run, --yes, --upgrade, --check-only and --no-autoupdate",
  ["--dry-run", "--yes", "--upgrade", "--check-only", "--no-autoupdate"].every((f) => cool.includes(f)));

const coolHelp = sh("bash", [join(ROOT, COOLIFY_INSTALL), "--help"]);
ok("--help prints usage without touching the host", coolHelp.code === 0 && /install-coolify\.sh/.test(coolHelp.out));

const coolDry = sh("bash", [join(ROOT, COOLIFY_INSTALL), "--dry-run", "--yes", "--email", "handover@example.test", "--username", "kami"], { timeout: 120000 });
ok("a dry run exits 0 (nothing installed) or 3 (no egress to the Coolify CDN)",
  coolDry.code === 0 || coolDry.code === 3, `exit ${coolDry.code}`);
ok("the dry run reports its host checks", /1\/5\s+Host checks/.test(coolDry.out));
ok("the dry run never executes the installer", !/\[run\]\s+env ROOT_/.test(coolDry.out));
ok("the dry run either prints the command it would run or explains why it stopped",
  /\[dry\]/.test(coolDry.out) || /cannot reach https:\/\/cdn\.coollabs\.io/.test(coolDry.out));
ok("the dry run names the compose location the operator enters in Coolify (when it gets that far)",
  /deploy\/coolify\/docker-compose\.yml/.test(coolDry.out) || coolDry.code === 3);
note(coolDry.code === 3
  ? "the Coolify CDN is not reachable from this environment; install-coolify.sh said so and stopped with exit 3, which is the designed behaviour"
  : "the Coolify CDN was reachable from this environment; the dry run walked all five stages");

const coolCheck = sh("bash", [join(ROOT, COOLIFY_INSTALL), "--check-only"], { timeout: 90000 });
ok("--check-only stops after the checks and changes nothing",
  (coolCheck.code === 0 || coolCheck.code === 3) && /Host checks/.test(coolCheck.out), `exit ${coolCheck.code}`);

// ==================================================== 15 · the handover pack
section("handover pack — what the next operator or agent reads first");

for (const f of ["README.md", "STATUS.md", "AGENT-BRIEF.md", "VPS-COOLIFY.md", "WINDOWS-11.md", "ACCEPTANCE.md"]) {
  const p = `handover/${f}`;
  ok(`${p} exists`, exists(p));
  if (exists(p)) ok(`${p} is substantive rather than a stub`, statSync(join(ROOT, p)).size > 2500,
    `${statSync(join(ROOT, p)).size} bytes`);
}

const hReadme = exists("handover/README.md") ? read("handover/README.md") : "";
ok("the handover README names the agent it was written for", /Qoder\.ai IDE/i.test(hReadme));
ok("the handover README offers all three install paths", /Coolify/.test(hReadme) && /install\.sh/.test(hReadme) && /Windows 11/.test(hReadme));
ok("the handover README sends the reader to the honest status first", /STATUS\.md/.test(hReadme) && /ACCEPTANCE\.md/.test(hReadme));
ok("the handover README states that the runtime has no dependencies", /Runtime dependencies: none/i.test(hReadme));
ok("the handover README forbids pasting credentials into chat", /never paste passwords/i.test(hReadme));
ok("the handover README lists what the operator must supply", /domain/i.test(hReadme) && /RAM/.test(hReadme));

const status = exists("handover/STATUS.md") ? read("handover/STATUS.md") : "";
ok("STATUS.md answers the question that was actually asked", /is this complete/i.test(status) && /Verdict/i.test(status));
ok("STATUS.md separates 'built and tested' from 'not executed here'", /wired/i.test(status) && /Not executed/i.test(status));
ok("STATUS.md says the JSONL store is what runs", /JSONL/.test(status));
ok("STATUS.md says DATABASE_URL is set and unused", /DATABASE_URL/.test(status) && /unused/.test(status));
ok("STATUS.md says GraphSharePoint has never met a real tenant", /GraphSharePoint/.test(status) && /never met a real tenant/.test(status));
ok("STATUS.md says TLS has not been issued", /TLS has not been issued/i.test(status));
ok("STATUS.md answers the local Windows 11 question explicitly", /Windows 11/.test(status) && /WSL2/.test(status));
ok("STATUS.md states the capacity figures the rest of the pack quotes", /22 GB/.test(status) && /20 GB/.test(status) && /50 GB/.test(status));
ok("STATUS.md records build provenance (repo, branch, runtime)", /GoldenLion-Thai\/Arena\.ai-/.test(status) && /arena\/01a0a1c1-arena-ai/.test(status) && /Node 22/.test(status));
ok("STATUS.md is honest that the Coolify path was not executed live", /not.{0,20}been run against a live Coolify/i.test(status));

const brief = exists("handover/AGENT-BRIEF.md") ? read("handover/AGENT-BRIEF.md") : "";
ok("AGENT-BRIEF.md states the job before the detail", /You are being handed a working, tested repository/i.test(brief));
ok("AGENT-BRIEF.md forbids renaming the app", /Do not rename the app/i.test(brief) && /GRiD-OS-SOVEREIGN/.test(brief));
ok("AGENT-BRIEF.md requires a test for every new artifact", /every design claim must be backed by working code and a test/i.test(brief));
ok("AGENT-BRIEF.md keeps internal ports unpublished", /8090/.test(brief) && /11434/.test(brief) && /never be reachable/i.test(brief));
ok("AGENT-BRIEF.md lists the invariants that the tests pin", /setEmbedder/.test(brief) && /linkSlug/.test(brief) && /reviewBy/.test(brief) && /HashEmbedder/.test(brief));
ok("AGENT-BRIEF.md warns about the vertical: principal form", /vertical:<id>/.test(brief));
ok("AGENT-BRIEF.md warns about leftover processes holding ports", /pkill/.test(brief) && /old.{0,10}platform|401/i.test(brief));
ok("AGENT-BRIEF.md warns that a proxied 200 with count: 0 can mean a mangled query string",
  /query string/i.test(brief) && /count: 0/.test(brief) && /splitting path and query once/i.test(brief));
ok("AGENT-BRIEF.md has a definition of done", /Definition of done/i.test(brief) && /ACCEPTANCE\.md/.test(brief));
ok("AGENT-BRIEF.md tells the agent how to report back", /Reporting back/i.test(brief) && /BLOCKED ON OPERATOR/i.test(brief));
ok("AGENT-BRIEF.md corrects the search parameter name rather than leaving a guess",
  /`k`, not `topK`/.test(brief) && /appId comes from the KEY/i.test(brief));

// The brief's route list must match the platform's own help text: a handover
// document that invents endpoints costs the next agent an hour.
const serverSrc = read("platform/server.mjs");
const helpAt = serverSrc.indexOf("Routes: GET /healthz");
ok("the platform prints its own route list (used to cross-check the brief)", helpAt > 0);
const helpBlock = helpAt > 0 ? serverSrc.slice(helpAt, helpAt + 700) : "";
const ROUTES = [
  ["/healthz", "/healthz"], ["/v1/meta", "/v1/meta"], ["/v1/search", "/v1/search"],
  ["/v1/documents", "/v1/documents"], ["/v1/documents/:id", "/v1/documents/:id"],
  ["/v1/documents/:id/open", "/v1/documents/:id/open"], ["/v1/documents/:id/rehydrate", "/v1/documents/:id/rehydrate"],
  ["/v1/wiki/pages", "/v1/wiki/pages"], ["/v1/wiki/pages/:slug", "/v1/wiki/pages/:slug"],
  ["/v1/wiki/search", "/v1/wiki/search"], ["/v1/wiki/reviews", "/v1/wiki/reviews"],
  ["/v1/admin/capacity", "/v1/admin/capacity"], ["/v1/admin/quota", "/quota"],
  ["/v1/admin/audit", "/audit"], ["/v1/admin/lifecycle/sweep", "/v1/admin/lifecycle/sweep"],
  ["/v1/admin/lifecycle/enforce", "/enforce"], ["/v1/admin/mirror/sync", "/v1/admin/mirror/sync"],
  ["/v1/admin/wiki/mirror", "/wiki/mirror"],
];
for (const [route, asHelp] of ROUTES) {
  ok(`the brief documents ${route}`, brief.includes(route));
  ok(`${route} is a real route the platform lists itself`, helpBlock.includes(asHelp), `looked for "${asHelp}"`);
}
const acceptance = exists("handover/ACCEPTANCE.md") ? read("handover/ACCEPTANCE.md") : "";
for (const [name, doc] of [["AGENT-BRIEF.md", brief], ["ACCEPTANCE.md", acceptance]]) {
  for (const invented of ["/v1/ingest", "review-queue", "/v1/admin/apps"]) {
    ok(`${name} does not cite an endpoint or parameter that does not exist: ${invented}`, !doc.includes(invented));
  }
}

ok("ACCEPTANCE.md runs the test suite as its first stage", /npm test/.test(acceptance) && /npm install/.test(acceptance));
ok("ACCEPTANCE.md quotes the assertion counts and tells the reader to record the real ones", /\d{3} passed/.test(acceptance) && /record the numbers/i.test(acceptance));
ok("ACCEPTANCE.md checks that no runtime dependency was smuggled in", /runtime deps/i.test(acceptance));
ok("ACCEPTANCE.md proves the security posture with ss, not with a claim", /ss -ltnp/.test(acceptance));
ok("ACCEPTANCE.md reuses deploy/verify.sh for the live host", /deploy\/verify\.sh/.test(acceptance) && /--expect-tls/.test(acceptance));
ok("ACCEPTANCE.md checks the cold tier and the way back in", /tier=cold/.test(acceptance) && /rehydrate/i.test(acceptance));
ok("ACCEPTANCE.md expects 422 for refused admission and 404 for out-of-vertical reads", /422/.test(acceptance) && /404/.test(acceptance));
ok("ACCEPTANCE.md ends with a sign-off table that allows 'not run'", /Sign-off/i.test(acceptance) && /Not run, with reason/i.test(acceptance));
ok("ACCEPTANCE.md carries the known-not-wired list forward", /Known-not-wired/i.test(acceptance) && /STATUS\.md/.test(acceptance));

const vps = exists("handover/VPS-COOLIFY.md") ? read("handover/VPS-COOLIFY.md") : "";
ok("VPS-COOLIFY.md sizes the node from the capacity plan", /16 GB/.test(vps) && /32 GB/.test(vps) && /22 GB/.test(vps));
ok("VPS-COOLIFY.md gives the install commands in order (check, dry-run, real)", /--check-only/.test(vps) && /--dry-run/.test(vps) && /--yes/.test(vps));
ok("VPS-COOLIFY.md states the compose location and base directory", /deploy\/coolify\/docker-compose\.yml/.test(vps) && /repository root/.test(vps));
ok("VPS-COOLIFY.md explains the magic variable", /SERVICE_URL_GRID_8080/.test(vps) && /do not set a\s*\n?\s*value|Coolify generates/i.test(vps));
ok("VPS-COOLIFY.md gets the operator to a URL on their laptop", /from your laptop/i.test(vps) && /https:\/\/<domain>|https:\/\/grid\.example\.com/.test(vps));
ok("VPS-COOLIFY.md covers DNS and TLS", /A record|A\s+grid\.example\.com/.test(vps) && /Let's Encrypt/i.test(vps) && /dig \+short/.test(vps));
ok("VPS-COOLIFY.md says which ports must stay closed", /do \*\*not\*\* open 8080, 8090, 11434 or 5432|not.{0,10}open 8080/i.test(vps));
ok("VPS-COOLIFY.md covers staying upgraded", /AUTOUPDATE/.test(vps) && /--upgrade/.test(vps) && /auto-updates by default/i.test(vps));
ok("VPS-COOLIFY.md explains that volumes survive a redeploy", /keeps named volumes across redeploys/i.test(vps));
ok("VPS-COOLIFY.md has a troubleshooting table", /Troubleshooting/.test(vps) && /502/.test(vps) && /OOM/.test(vps));
ok("VPS-COOLIFY.md carries the not-wired Postgres note", /DATABASE_URL/.test(vps) && /unused|does not expect the platform to read/i.test(vps));
ok("VPS-COOLIFY.md is honest that the install was not executed here", /has \*\*not\*\* been done is run it|not.{0,30}run it/i.test(vps));
ok("VPS-COOLIFY.md names the Coolify version it was verified against", /v4\.4\.2/.test(vps));

const win = exists("handover/WINDOWS-11.md") ? read("handover/WINDOWS-11.md") : "";
ok("WINDOWS-11.md answers the question directly", /yes\.\*\* The product is plain Node 22|— yes\./i.test(win));
ok("WINDOWS-11.md gives the WSL2 route with real commands", /wsl --install/.test(win) && /wsl -l -v/.test(win) && /Ubuntu/.test(win));
ok("WINDOWS-11.md gives the native route for people without WSL", /winget install/.test(win) && /Git Bash/.test(win));
ok("WINDOWS-11.md keeps the repository off /mnt/c and says why", /\/mnt\/c/.test(win) && /slower/i.test(win));
ok("WINDOWS-11.md covers the CRLF trap and the fix", /core\.autocrlf/.test(win) && /\.gitattributes/.test(win));
ok("WINDOWS-11.md covers reaching Windows Ollama from WSL2", /OLLAMA_HOST/.test(win) && /ip route show default/.test(win) && /New-NetFirewallRule/.test(win));
ok("WINDOWS-11.md covers GPU passthrough honestly", /nvidia-smi/.test(win) && /Windows.{0,20}NVIDIA driver|Windows\*\* driver/i.test(win));
ok("WINDOWS-11.md states what does not apply locally", /install\.sh/.test(win) && /Linux-only/.test(win));
ok("WINDOWS-11.md notes that local.sh already opens a Windows browser", /powershell\.exe -c "start/.test(win));
ok("WINDOWS-11.md has a troubleshooting table", /Troubleshooting on Windows/.test(win) && /EADDRINUSE/.test(win));

ok(".gitattributes exists so Windows checkouts do not break the bash scripts", exists(".gitattributes"));
if (exists(".gitattributes")) {
  const ga = read(".gitattributes");
  ok(".gitattributes forces LF on shell scripts", /^\*\.sh text eol=lf$/m.test(ga));
  ok(".gitattributes forces LF on systemd units and the Makefile", /^\*\.service text eol=lf$/m.test(ga) && /^Makefile text eol=lf$/m.test(ga));
  ok(".gitattributes forces LF on container and compose files", /^Dockerfile text eol=lf$/m.test(ga) && /^\*\.yml text eol=lf$/m.test(ga));
  ok(".gitattributes marks binaries so they are never re-encoded", /\.png binary/.test(ga) && /\.woff2 binary/.test(ga) && /\.tgz binary/.test(ga));
  ok(".gitattributes explains the failure it prevents", /command not found/i.test(ga));
}

// ------------------------------------------------------- cross-document truth
const coolifyVersions = [...new Set([status, vps].flatMap((d) => [...d.matchAll(/v4\.\d+\.\d+/g)].map((m) => m[0])))];
ok("STATUS.md and VPS-COOLIFY.md agree on the Coolify version they were verified against",
  coolifyVersions.length === 1, coolifyVersions.join(", "));
ok("the handover pack quotes the same capacity figures as the platform",
  /20 GB/.test(status) && /22 GB/.test(vps) && /10\.5|10,?226|7\.05/.test(status + vps));
ok("every handover document points at another one", ["STATUS.md", "ACCEPTANCE.md", "AGENT-BRIEF.md", "VPS-COOLIFY.md", "WINDOWS-11.md"]
  .every((f) => [hReadme, status, brief, vps, win, acceptance].some((d) => d.includes(f))));
ok("the root README sends readers to the handover pack", /handover\//.test(read("README.md")) && /Coolify/i.test(read("README.md")));
ok("deploy/README documents the Coolify path", /coolify/i.test(read("deploy/README.md")) && /install-coolify\.sh/.test(read("deploy/README.md")));
ok("deploy/README documents the container image", /Dockerfile/.test(read("deploy/README.md")));

// ------------------------------------------------------------------ teardown
try { process.kill(-local.pid, "SIGTERM"); } catch { /* already gone */ }
await wait(400);
try { process.kill(-local.pid, "SIGKILL"); } catch { /* already gone */ }
rmSync(distA, { recursive: true, force: true });
rmSync(distB, { recursive: true, force: true });
let down = false;
for (let i = 0; i < 12 && !down; i++) {
  await wait(250);
  down = (await fetchText(`${LOCAL_URL}/healthz`, 1200)).status === 0 && (await fetchText(`http://127.0.0.1:${LOCAL_PLATFORM_PORT}/healthz`, 1200)).status === 0;
}
ok("local.sh stack shut down cleanly — app tier and data platform both gone", down);

console.log(`\n${passed} passed · ${failed} failed`);
if (notes.length) {
  console.log("\nNotes:");
  notes.forEach((n) => console.log("  · " + n));
}
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  • " + f));
}
process.exit(failed ? 1 : 0);
