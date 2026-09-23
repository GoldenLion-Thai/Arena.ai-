# Deploying GRiD-OS-SOVEREIGN

Four ways to get from this repository to a running private-model host, fastest
first. Every one of them ends with `deploy/verify.sh` proving the deployment
rather than assuming it.

| Method | Command | Time | Use it when |
| --- | --- | --- | --- |
| **Fastest — local** | `bash deploy/local.sh` | ~30s + model pull | your own machine, one user |
| **Fastest — VPS** | `curl … install.sh \| sudo bash -s -- …` | ~10 min | you already have a box |
| **Artifact** | `bash deploy/package.sh` → `scp` → install | ~10 min | no GitHub access from the host, or you want a checksummed build |
| **Fully automated** | `cd oci/terraform && terraform apply` | ~15 min | no box yet — provision, install, verify, destroy |

Nothing in the app tier has runtime dependencies: `node server.js` and a model
host. There is no build step, no database, no container registry to trust.

---

## 1 · Fastest — run it locally

```sh
bash deploy/local.sh                                  # real Ollama, small model
bash deploy/local.sh --model qwen2.5:14b-instruct-q4_K_M
bash deploy/local.sh --mock                           # no Ollama installed? demo host
```

It checks node ≥ 18, installs Ollama if it is missing (macOS: Homebrew;
Linux/WSL: the official installer), starts the model host on loopback, pulls the
model, launches the app on `http://127.0.0.1:8080` and opens your browser.
`Ctrl-C` stops only what it started.

Default bind is **loopback** — deliberate for a privacy product. Inside a
container or a preview environment use `--host 0.0.0.0`.

Then, in the workspace: **⚙ Settings → Model gateway → “Ollama (localhost)” →
Save & probe**. The top-bar chip should read `GATEWAY LIVE`.

### Memory reality check (CPU machines)

| RAM | What runs | Expect |
| --- | --- | --- |
| 8 GB | `qwen2.5:1.5b`, `llama3.2:3b` | 8–15 tok/s |
| 16 GB | `qwen2.5:7b-instruct-q4_K_M` | 5–12 tok/s |
| 32 GB | `qwen2.5:14b-instruct-q4_K_M` | 3–6 tok/s |
| 24 GB VRAM (A10/4090) | `qwen2.5:14b-instruct-q4_K_M` | 40–70 tok/s |
| 48 GB VRAM (A100/L40S) | `qwen2.5:32b`, `llama3.1:70b-q4` | 20–45 tok/s |

Keep-alive matters more than most settings: `OLLAMA_KEEP_ALIVE=30m` means the
first prompt after idle pays a 1–4 s reload. If you chase the 200–400 ms TTFT
target, keep one model permanently warm (`--keep-alive -1` for a single-model
host).

---

## 2 · Fastest — install on a VPS you already have

Ubuntu/Debian/Oracle Linux/RHEL/Fedora, systemd, root or sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/main/deploy/install.sh \
  | sudo bash -s -- \
      --domain llm.example.com \
      --email ops@example.com \
      --model qwen2.5:14b-instruct-q4_K_M \
      --auth admin:CHANGE_ME \
      --allow 203.0.113.0/24
```

From a checkout instead (recommended — you read what you run):

```sh
sudo bash deploy/install.sh --domain llm.example.com --email ops@example.com \
     --model qwen2.5:14b-instruct-q4_K_M --auth admin:CHANGE_ME --yes
```

**See the whole plan first, change nothing:**

```sh
bash deploy/install.sh --dry-run --domain llm.example.com
bash deploy/install.sh --render-only --domain llm.example.com --auth admin:pw   # the nginx site
```

Nine steps, all idempotent (re-run to upgrade in place):

1. **preflight** — OS, arch, systemd, RAM/disk, GPU detection
2. **runtime** — node ≥ 18 (NodeSource or dnf module)
3. **ollama** — official installer, GitHub-release fallback, systemd drop-in
4. **models** — `ollama pull` for each `--model`, resumable
5. **app tier** — files to `/opt/grid-os-sovereign`, system user `grid`,
   `grid-os-sovereign.service`, env in `/etc/grid-os-sovereign.env` (mode 640)
6. **edge** — nginx site rendered from `nginx.conf.tmpl`: basic auth, IP
   allowlist, `proxy_buffering off`, 600 s read timeout, security headers
7. **TLS** — Let's Encrypt via certbot (`--tls self` for staging, `--tls off`
   for an internal network or another terminator)
8. **firewall** — ufw/firewalld: 22/80/443 open; **8080 and 11434 denied**
9. **verify** — `deploy/verify.sh` against the live host

### Flags worth knowing

```
--domain HOST          public hostname; enables TLS + redirect
--email ADDR           Let's Encrypt contact
--model NAME           repeatable
--tls auto|certbot|self|off
--auth USER:PASS       basic auth at the edge (the app ships none of its own)
--allow CIDR           repeatable IP allowlist; omitting it means "any"
--ollama-host H:P      default 127.0.0.1:11434 — keep it private
--keep-alive DUR       OLLAMA_KEEP_ALIVE (default 30m)
--gpu auto|cuda|rocm|cpu
--source DIR|TARBALL|URL   where the app files come from
--app-dir PATH --port N --repo OWNER/NAME --ref REF
--skip-ollama|--skip-app|--skip-nginx|--skip-firewall|--skip-verify
--dry-run --render-only --out FILE -y/--yes
```

`--skip-ollama` is the interesting one for split topologies: install only the
app tier and point `OLLAMA_URL` at a model host on a private subnet.

---

## 3 · Upload-ready artifact (air-gapped or checksummed deploys)

```sh
bash deploy/package.sh          # → dist/grid-os-sovereign-<ver>-<sha>.tar.gz
```

Produces four files in `dist/`:

```
grid-os-sovereign-1.0.0-<sha>.tar.gz          runtime only, ~120 KB
grid-os-sovereign-1.0.0-<sha>.tar.gz.sha256   checksum
manifest.json                                 version, sha, files, git state, runtime
INSTALL.txt                                   the exact scp + install commands
```

The build is **byte-reproducible** — fixed mtime, sorted entries, uid/gid 0 —
so two machines hashing the same tree get the same artifact and you can compare
checksums instead of trusting a re-run.

```sh
scp dist/grid-os-sovereign-*.tar.gz* ubuntu@YOUR_HOST:/tmp/
ssh ubuntu@YOUR_HOST '
  cd /tmp && sha256sum -c grid-os-sovereign-*.sha256
  tar -xzf grid-os-sovereign-*.tar.gz && cd grid-os-sovereign-*/
  sudo bash deploy/install.sh --source . --domain llm.example.com \
       --auth admin:CHANGE_ME --yes'
```

Or with make, which does the packaging, upload, checksum, install and remote
restart in one step:

```sh
cd deploy
make deploy TARGET=ubuntu@1.2.3.4 DOMAIN=llm.example.com EMAIL=ops@example.com \
     MODELS="qwen2.5:14b-instruct-q4_K_M" AUTH=admin:CHANGE_ME
make ssh-verify TARGET=ubuntu@1.2.3.4 URL=https://llm.example.com PUBLIC_HOST=1.2.3.4
```

---

## 4 · Fully automated — Terraform on Oracle Cloud

`oci/terraform` provisions the whole host and installs the product on first
boot via cloud-init. No box, no SSH, no manual steps:

```sh
cd oci/terraform
export TF_VAR_tenancy_ocid=ocid1.tenancy.oc1..aaaa…
export TF_VAR_compartment_ocid=ocid1.compartment.oc1..aaaa…
export TF_VAR_region=eu-frankfurt-1
export TF_VAR_domain=llm.example.com
export TF_VAR_acme_email=ops@example.com
export TF_VAR_auth_pass='CHANGE_ME'                 # never in a tfvars file
export TF_VAR_admin_cidrs='["203.0.113.0/24"]'      # your egress, not 0.0.0.0/0

terraform init
terraform plan
terraform apply
```

Creates: VCN, internet gateway, route table, **NSG**, public subnet, instance
(GPU or A1 Flex), a separate block volume mounted at `/var/lib/ollama/models`
so weights survive instance replacement, and user-data that runs
`deploy/install.sh --yes`.

The NSG has exactly three ingress rules — 22 from `admin_cidrs`, 443 from
`allow_cidrs`, 80 for the redirect and the ACME challenge. **There is no rule
for 11434 or 8080**, and both services bind loopback anyway. That is defence in
depth, not one control doing two jobs.

`terraform output` prints the URL plus the exact `verify.sh` and
`terraform destroy` commands. Shape guidance is in `variables.tf`:

| Shape | Hardware | Good for | Free tier? |
| --- | --- | --- | --- |
| `VM.GPU.A10.1` | 1× A10 24 GB | 14B q4, 40–70 tok/s | no — hourly billing |
| `VM.GPU2.2` | 2× A10 48 GB | 32B q4 or two 14B | no |
| `BM.GPU.A10.4` | 4× A10 96 GB | 70B q4, small teams | no |
| `VM.Standard.A1.Flex` | ARM, up to 4 OCPU/32 GB | 3B–7B q4 at 5–10 tok/s | **yes** (A1 always-free) |

GPU capacity is regional and often out of stock: if `apply` fails with
`Out of host capacity`, change region or AD, or fall back to A1 Flex.

Watch first boot (8–15 minutes, mostly the model download):

```sh
ssh ubuntu@$(terraform output -raw public_ip) \
  'sudo tail -f /var/log/grid-os-sovereign-install.log /var/log/grid-bootstrap.log'
```

Other clouds: `deploy/cloud-init.yaml` is the same bootstrap with hand-edited
values — pass it as user-data to AWS/GCP/Azure/any provider, then point
`TF_VAR_`-style values at it by editing the env block at the top.

---

## 5 · Verification (do this after every deploy)

```sh
bash deploy/verify.sh --url https://llm.example.com --auth admin:pw \
     --public-host 1.2.3.4 --expect-models --ssh ubuntu@1.2.3.4
```

It checks, and exits non-zero on any failure:

| Group | Checks |
| --- | --- |
| reachability | landing/app/lab pages, CSS + JS assets, `/healthz` |
| gateway | discovery through the same-origin proxy, ≥1 model, requested model present |
| streaming | completion accepted, TTFT < 3 s, ≥2 ndjson frames, `ttfb < total` (proves incremental, not buffered), `done:true`, runtime `eval_count` present |
| transport | HSTS, `X-Content-Type-Options`, CSP, certificate issuer and days-to-expiry, HTTP→HTTPS redirect |
| authentication | 401 without credentials, 200 with them, **and the gateway is behind auth too** |
| exposure | `:11434` and `:8080` unreachable from outside (via `/dev/tcp`, no `nc` needed) |
| host (`--ssh`) | services active, ollama bound to loopback, env file mode 640, disk for weights, RAM, node version, GPU visible |

`--json` emits the same result machine-readable for CI or a dashboard.

---

## 6 · Docker Compose (alternative to systemd)

```sh
cp deploy/.env.example .env      # edit OLLAMA_URL / model
docker compose -f deploy/docker-compose.yml up -d
```

GPU passthrough needs the NVIDIA Container Toolkit. The compose file
deliberately does **not** publish Ollama's port — only the app tier is
reachable, and it proxies `/gateway/*`.

---

## 7 · make targets

```sh
cd deploy
make help              # everything, with the variables it accepts
make local             # fastest path here
make mock              # fastest path, no Ollama
make package           # build dist/
make plan              # dry-run the installer
make vps               # run the installer for real (sudo)
make verify            # verify a URL
make deploy TARGET=…   # package + scp + remote install
make ssh-verify TARGET=…
make terraform-plan / terraform-apply / terraform-destroy
make lint              # bash -n (+ shellcheck when installed)
make test              # the whole suite, including this layer
```

Variables: `DOMAIN EMAIL MODEL MODELS AUTH ALLOW TLS PORT HOST APP_DIR
OLLAMA_HOST KEEP_ALIVE TARGET URL PUBLIC_HOST`.

---

## 8 · Hardening checklist

Before anyone puts a real contract through it:

- [ ] **Authentication exists.** `--auth` (basic) is the floor; put your IdP in
      front with `auth_request`/OIDC for anything real. The app ships no auth of
      its own and must never be exposed without one.
- [ ] **TLS** with a publicly trusted certificate, HSTS on, HTTP redirecting.
- [ ] `nc -vz <public-ip> 11434` **fails**. So does `:8080`.
- [ ] `OLLAMA_HOST=127.0.0.1:11434` in the drop-in (verify.sh checks via SSH).
- [ ] Vault passphrase is strong; history encrypted; retention set to what your
      policy actually says (0 days = memory only).
- [ ] IP allowlist or VPN/tailscale if the audience is small.
- [ ] Backups: `/var/lib/ollama/models` (or its volume) + `/opt/grid-os-sovereign`.
      Encrypted history lives in *your users'* browsers, so there is nothing to
      back up server-side — which is the point.
- [ ] Log retention decided for nginx and journald; access logs contain IPs and
      URLs, never prompt text (prompts are POST bodies, not logged).
- [ ] `certbot renew` timer present (the installer adds it).
- [ ] Update cadence: `ollama` and the OS monthly; the app tier is static files,
      so re-running the installer is the upgrade.

---

## 9 · Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Chip reads `GATEWAY DOWN` | Ollama not running / wrong `OLLAMA_URL` | `systemctl status ollama`; `curl -s localhost:8080/healthz` |
| `502` from `/gateway/*` | proxy target unreachable | the 502 body states the target; check the bind address and firewall |
| Tokens arrive all at once | something is buffering | `proxy_buffering off` + `X-Accel-Buffering: no`; no CDN in between; verify.sh catches this |
| TTFT is seconds | cold model load | raise `OLLAMA_KEEP_ALIVE`, or `-1` for a single-model host |
| `Out of host capacity` | GPU shape unavailable in that AD/region | change region/AD, or use `VM.Standard.A1.Flex` |
| certbot fails | DNS not pointing at the box yet, or :80 blocked | point DNS first; open 80; or `--tls self` to stage |
| Bootstrap hangs | egress blocked to raw.githubusercontent.com or registry.ollama.ai | open egress, or use the artifact method (§3) |
| `ollama pull` stalls | registry unreachable | resume is automatic; or copy `~/.ollama/models` from another host |
