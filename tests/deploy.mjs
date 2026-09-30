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
