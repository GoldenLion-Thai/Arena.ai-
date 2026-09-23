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
const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}`;

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

async function fetchText(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
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
for (const need of ["index.html", "app.html", "lab.html", "server.js", "assets/js/brand.js", "assets/js/gateway.js", "assets/css/grid-os.css", "deploy/install.sh", "deploy/verify.sh", "deploy/nginx.conf.tmpl"]) {
  ok(`artifact ships ${need}`, entries.some((e) => e.endsWith("/" + need) || e === need));
}
ok("artifact excludes node_modules", !entries.some((e) => e.includes("node_modules")));
ok("artifact excludes dist and .git", !entries.some((e) => /\/(dist|\.git)\//.test(e)));
ok("artifact is small enough to email", statSync(tarPath).size < 3 * 1024 * 1024, `${(statSync(tarPath).size / 1024).toFixed(0)}KB`);

const shaB = createHash("sha256").update(readFileSync(join(distB, execFileSync("ls", [distB], { encoding: "utf8" }).trim().split("\n").find((f) => f.endsWith(".tar.gz"))))).digest("hex");
ok("build is byte-reproducible", actual === shaB, `${actual.slice(0, 12)} vs ${shaB.slice(0, 12)}`);

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

// ============================================================ 5 · verifier
section("verify.sh — run against the host local.sh just started");

const v = sh("bash", [join(DEPLOY, "verify.sh"), "--url", LOCAL_URL, "--expect-models"]);
ok("verify passes on a healthy host", v.code === 0, v.out.split("\n").filter((l) => l.includes("✗")).join(" | ").slice(0, 200));
ok("verify counted its checks", /\d+ passed/.test(v.out), (v.out.match(/\d+ passed[^\n]*/) || [""])[0]);
ok("verify proved discovery through the proxy", /discovery through the same-origin proxy/.test(v.out));
ok("verify proved streaming is incremental", /streaming is incremental/.test(v.out));
ok("verify measured time to first token", /time to first token/.test(v.out));
ok("verify checks runtime token accounting", /runtime token accounting/.test(v.out));
ok("verify warns about missing TLS on http", /TLS not checked/.test(v.out));
ok("verify warns about missing auth", /no authentication/.test(v.out));
ok("verify refuses to guess about public exposure on loopback", /public port exposure not tested/.test(v.out));

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

// ------------------------------------------------------------------ teardown
try { process.kill(-local.pid, "SIGTERM"); } catch { /* already gone */ }
await wait(400);
try { process.kill(-local.pid, "SIGKILL"); } catch { /* already gone */ }
rmSync(distA, { recursive: true, force: true });
rmSync(distB, { recursive: true, force: true });
ok("local.sh stack shut down cleanly", (await fetchText(`${LOCAL_URL}/healthz`, 1500)).status === 0);

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
