# ACCEPTANCE — how to prove the install before you accept it

Run these in order. Each check states the command, what a pass looks like, and what a failure means.
Checks marked **[auto]** are automated; **[manual]** need a human or an agent to look at the output.

The rule this repository was built under: **a claim is only a claim until a command proves it.** Do
not sign off on adjectives.

---

## Stage 0 — Repository sanity (any machine, 2 minutes)

```bash
node -v                                   # [auto] v22.x or newer
cat package.json | grep -A4 devDependencies   # [auto] js-yaml, jsdom, fake-indexeddb only
npm install                               # [auto] dev dependencies, for the tests
npm test                                  # [auto] all four suites
```

**Pass:** `npm test` ends with four summary lines and no failures. At handover the counts were
**smoke 213 · gateway 50 · platform 308 · deploy 522 = 1093 passed, 0 failed** — record the numbers
you actually see; if they differ, something changed and you should know what.

**Also confirm no runtime dependency was smuggled in:**

```bash
node -e "const p=require('./package.json');console.log('runtime deps:',Object.keys(p.dependencies||{}).length)"
# [auto] → runtime deps: 0
```

```bash
git status --porcelain | grep -E "\.data/|node_modules|\.env$" ; echo "exit=$?"
# [auto] → no output (exit=1 from grep). Local state and secrets must never be staged.
```

---

## Stage 1 — The demo stack on your machine (5 minutes, no GPU, no downloads)

```bash
bash deploy/local.sh --mock --platform --fixtures --host 127.0.0.1 --port 8080 --no-open
```

**Pass [manual]:** the banner lists three processes (mock model host, data platform, app tier), the
URLs, and a **demo API key** (`ka_…`). Keep that key for Stage 2.

```bash
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/platform/healthz
```

**Pass [auto]:** the app reports `ok:true` and shows the gateway and platform as reachable; the
platform reports `ok:true`, `backend`, `dims`, `documents`, `chunks`, and — with `--fixtures` —
`fixtureContent:true`.

In the browser: **`http://localhost:8080`** → chat sends and streams a reply (proves UI → gateway →
model host); **Lab** → a retrieval returns hits **with citations**; **Wiki** → pages render, and
backlinks appear on a page that other pages link to.

---

## Stage 2 — Data platform behaviour (the requirements, one command each)

Set the key from the Stage 1 banner. `appId` is derived from the key — it is never sent in a body.

```bash
KEY=ka_...
B=http://127.0.0.1:8080/platform
AUTH="Authorization: Bearer $KEY"
```

| # | Requirement | Command | Pass looks like |
|---|---|---|---|
| 2.1 | **Real RAG**, hybrid | `curl -s $B/v1/search -H "$AUTH" -H 'content-type: application/json' -d '{"query":"what happens to documents nobody opens","k":3}'` | `hits` with scores, `citations` carrying a document id and a content checksum, `cold`, `context` (an **object**, not a string) and `metrics` with a retrieval time and `withinBudget:true` |
| 2.2 | **Admission** — live/useful data only | `curl -s $B/v1/documents -H "$AUTH" -H 'content-type: application/json' -d '{"content":"too short","vertical":"operations"}'` | HTTP **422** with `{"accepted":false,"reasons":[…]}` — a refusal with reasons, not a silent drop |
| 2.3 | **Unified DB, all apps, scoped keys** | `curl -s $B/v1/meta -H "$AUTH"` | 5 `apps` each with scopes and verticals, the platform's `scopes`/`verticals`/`tiers`/`storage`, **your key's** scopes, verticals and `ratePerMin`, plus capacity headroom and quota |
| 2.4 | **Wiki + backlinks + review dates** | `curl -s $B/v1/wiki/pages -H "$AUTH"` then `curl -s "$B/v1/wiki/reviews?days=30" -H "$AUTH"` | pages with revisions and non-zero backlink counts; the review queue lists the overdue page |
| 2.5 | **60-day rule + re-openable path** | `curl -s "$B/v1/documents?tier=cold" -H "$AUTH"` and `curl -s $B/v1/admin/quota -H "$AUTH"` | the fixture document that has not been opened for 61 days is in the cold tier, with a reason mentioning SharePoint and a stub (~4.3 KB) |
| 2.6 | Rehydrate works | `curl -s -X POST $B/v1/documents/<cold-id>/rehydrate -H "$AUTH"` | `{"ok":true,…,"note":"path reopened: content pulled from SharePoint and re-indexed"}`; a failed mirror answers **409** |
| 2.7 | Reading resets the clock, searching does not | `curl -s -X POST $B/v1/documents/<id>/open -H "$AUTH"` | `lastOpenedAt` updates and `retentionClockResetDays` is reported. Note `GET /v1/documents/:id` also counts as opening — that is intended; a search hit does not |
| 2.8 | **Double headroom** | `curl -s $B/v1/admin/capacity -H "$AUTH"` | RAM ≥ 2× the working set (22 GB for 10.53 GB), disk ≥ 2× the live ceiling (100 GB provisioned for 20 GB), connections ≥ 2× wanted (100 for 48) |
| 2.9 | **50 GB/node, 20 GB live ceiling** | same capacity response, plus `/v1/admin/quota` | vertical quotas summing to 20 GB (legal 5, finance 4, consulting 4, compliance 3, operations 2, people 1.5, shared 0.5) |
| 2.10 | **Vertical-scoped, default-deny** | ingest a document with no `acl` in one vertical, then `GET /v1/documents/<id>` with a key scoped to a different vertical | **404** (deliberately not 403 — no existence leak). Empty ACL never means world-readable |
| 2.11 | **Audit log** | `curl -s "$B/v1/admin/audit?action=open" -H "$AUTH"` | rows for what you just did, with actor and vertical |
| 2.12 | **Sweep + ceiling enforcement** | `curl -s -X POST $B/v1/admin/lifecycle/sweep -H "$AUTH"` and `…/lifecycle/enforce` | the sweep reports what it demoted (and refuses to demote anything whose mirror copy is not verified); enforce reports the ceiling action |
| 2.13 | **SharePoint mirror gating** | `npm run test:platform` | demotion is blocked unless `verifyMirror()` passes; a `GraphSharePoint` against a real tenant is **not** wired (`STATUS.md` §2) |

Routes are listed in full in `handover/AGENT-BRIEF.md` §5, and printed by the platform itself:
`node platform/server.mjs --help`.

**[auto] alternative for all of Stage 2:** `npm run test:platform` (308 assertions) exercises every
row above against the real modules. Run it, and use the curls when you want to see it live.

---

## Stage 3 — Security posture (before anything faces the internet)

```bash
ss -ltnp | grep -E ':(80|443|8000|8080|8090|11434|5432)\b'      # [auto] on the host
```

**Pass:** on a Coolify/compose host, only **80, 443** (proxy) and **8000** (Coolify UI) are
listening on public interfaces. **8090, 11434 and 5432 must not appear** — they live on the compose
network only. On a local laptop demo, 8080/8090/11500 on `127.0.0.1` is correct and expected.

```bash
git log -p --all | grep -inE "password|secret|token|api[_-]?key" | grep -viE "hashed|placeholder|change-me|example|POSTGRES_PASSWORD:-change-me" | head
# [manual] review anything that looks like a real credential. There should be none.
```

- [ ] **Basic auth on** for any public URL (`BASIC_AUTH_USER`/`BASIC_AUTH_PASS` in Coolify env, or
      `deploy/install.sh --auth basic`).
- [ ] API keys are **hashed at rest** — check a `.data/platform/keys.jsonl` row: you should see a
      hash, never a `ka_…` plaintext key.
- [ ] No secret was passed as a command-line argument (argv is world-readable via `/proc`).
- [ ] `.data/`, `node_modules/` and any `.env` are not committed.
- [ ] TLS: `curl -sI https://<your-domain>/` shows a valid certificate chain, and
      `curl -s -o /dev/null -w '%{ssl_verify_result}\n' https://<your-domain>/` prints `0`.

---

## Stage 4 — Path A: Coolify on the VPS

```bash
sudo bash deploy/coolify/install-coolify.sh --check-only          # [auto] host + network
sudo bash deploy/coolify/install-coolify.sh --dry-run --yes       # [auto] prints every command
sudo bash deploy/coolify/install-coolify.sh --email you@example.com --username kami --yes
```

- [ ] Installer exits `0` and prints `http://<vps-ip>:8000`.
- [ ] `docker ps` shows Coolify's own containers plus `coolify-proxy` and its Postgres/Redis.
- [ ] The UI opens **from your laptop** at `http://<vps-ip>:8000`, and the server shows connected.
- [ ] Resource created as **Docker Compose**, location `deploy/coolify/docker-compose.yml`, base
      directory = repository root, branch `arena/01a0a1c1-arena-ai`.
- [ ] Deploy succeeds; `model-pull` exits `0` (both weights present).
- [ ] Coolify shows a generated URL for `grid-os` (from `SERVICE_URL_GRID_8080`).
- [ ] Your domain resolves (`dig +short <domain>` → the VPS IP) and is set under Resource → Domains.
- [ ] **From the laptop:** `https://<domain>/healthz` and `https://<domain>/platform/healthz` both
      return `ok:true` — same origin, no internal address visible.
- [ ] Browser: chat replies; Lab retrieval returns citations; Wiki renders with backlinks.
- [ ] `docker compose exec platform node -e "console.log(process.env.DATABASE_URL?'set':'unset')"`
      — and you have read `STATUS.md` §2 about the adapter that does not exist yet.

```bash
bash deploy/verify.sh --url https://<domain> --expect-tls --platform --json > acceptance.json
# [auto] exit 0 = every check passed; the JSON is your evidence artifact
```

---

## Stage 5 — Path B: bare metal (no Docker)

```bash
bash deploy/install.sh --dry-run --yes                    # [auto] the plan, nothing changed
bash deploy/install.sh --render-only --out /tmp/render    # [auto] inspect the rendered files
bash deploy/install.sh --domain grid.example.com --email you@example.com \
     --platform --gpu auto --tls letsencrypt --auth basic --yes
bash deploy/verify.sh --url https://grid.example.com --ssh root@<vps-ip> \
     --expect-tls --expect-models --platform --json
```

- [ ] systemd units active: the app, the platform (if `--platform`), `ollama`.
- [ ] nginx serves 443 with a Let's Encrypt certificate; `/gateway/` streams (verify.sh checks that
      the response arrives in chunks — buffering off).
- [ ] Firewall allows 80/443/22 only.
- [ ] Env file permissions are `640`/`600` (verify.sh reports this).
- [ ] Host RAM ≥ 8 GB and ≥ 20 GB free for weights, or verify.sh warns and you have accepted it.

---

## Stage 6 — Path C: Windows 11

- [ ] WSL2 route: `wsl -l -v` shows VERSION 2; `node -v` inside Ubuntu is v22.x; the repo lives in
      `~/`, not `/mnt/c/`.
- [ ] `npm test` green inside WSL2 (or in PowerShell for the native route).
- [ ] `bash deploy/local.sh --mock --platform --fixtures` starts, and **the Windows browser** opens
      `http://localhost:8080` (or the `wsl hostname -I` address).
- [ ] If using Windows-native Ollama from WSL2: `curl -s http://$(ip route show default | awk '{print $3}'):11434/api/tags`
      lists your models.
- [ ] No `$'\r': command not found` anywhere (`.gitattributes` + `core.autocrlf input`).
- [ ] Native route only: you have accepted the two documented differences (bash needed for
      `deploy/*.sh`; `install.sh` is Linux-only).

---

## Sign-off

Fill this in and keep it with the deployment. Anything you could not run goes in the last row with
the reason — an incomplete row with an explanation is an honest handover; a blank one is not.

| Area | Evidence (command + output) | Pass / Fail / Not run |
|---|---|---|
| Test suite (`npm test`) | counts per suite | |
| Local demo (Stage 1) | healthz JSON | |
| RAG + citations (2.1) | search response | |
| Admission (2.2) | refusal reasons | |
| Wiki + backlinks (2.4) | pages + reviews JSON | |
| Retention + rehydrate (2.5–2.7) | lifecycle JSON | |
| Capacity headroom (2.8–2.9) | capacity JSON | |
| ACL default-deny (2.10) | refused read | |
| Ports not published (Stage 3) | `ss -ltnp` output | |
| TLS + auth (Stage 3) | curl headers | |
| Public URL from laptop (Stage 4) | `verify.sh --json` | |
| Models + embedder in use | `/platform/healthz` `embedder` | |
| Windows path (Stage 6) | browser screenshot / healthz | |
| **Not run, with reason** | | |

**Known-not-wired at handover (from `STATUS.md` §2 — these are not defects, they are declared):**
the Postgres adapter (`DATABASE_URL` set but unused; the JSONL store is what runs), `GraphSharePoint`
against a real tenant, real model weights in the build environment, and an issued TLS certificate.
