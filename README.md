# GRiD-OS-SOVEREIGN — private-LLM product reference implementation

A dark, chat-first, local-first interface for running open-weight language models inside
infrastructure you control. Built to the Venice-adjacent "sovereign AI" register: quiet surfaces, one
deliberate accent, technical proof in monospace, and a data boundary the user can inspect rather than
take on faith.

**Zero dependencies. No build step. No trackers, analytics or cookies.**

```bash
node server.js           # → http://localhost:8080
# or
python3 -m http.server 8080 --bind 0.0.0.0
```

## What's here

| Page | What it demonstrates |
| --- | --- |
| [`index.html`](index.html) | Landing narrative: hero terminal, trust strip, features, four-step flow, architecture diagram, open-weight shortlist, **live theme switcher** across three palettes, copy system, pre-launch honesty note |
| [`app.html`](app.html) | The working workspace: streaming chat, encrypted local history, model picker with data-handling metadata, privacy-state panel, slash commands, `@`-knowledge, file indexing, gateway settings |
| [`lab.html`](lab.html) | Behaviour Lab: standard vs refusal-reduced ("abliterated") profile side by side, per prompt-set tabs, blind tone rubric, length distribution, metric definitions |
| [`wiki.html`](wiki.html) | The **KiNETiC-Ai wiki**: page list by vertical, Markdown view with `[[wikilinks]]` and backlinks, immutable revision history with diffs, review queue, hybrid search with citations, and live capacity/retention/mirror panels — all read from the platform over the same origin, and rendering *nothing* invented when the platform is down |
| [`platform/`](platform/) | The unified data platform: policy and capacity maths, embeddings, store, ingestion and admission, hybrid retrieval with citations, SharePoint mirror, retention lifecycle, wiki, HTTP API, and the production `schema.sql` |
| [`docs/DATA-PLATFORM.md`](docs/DATA-PLATFORM.md) | The data platform design: capacity arithmetic, admission policy, retrieval and citation contract, the 60-day rule, permissions, API surface, production schema, and what is not wired yet |
| [`DESIGN.md`](DESIGN.md) | The design guide: principles, layout blueprint, tokens, storage model, picker UX, streaming rules, benchmark method, claim audit |
| [`deploy/`](deploy/) | Deployment automation: `install.sh` (VPS installer), `local.sh` (one-command local run), `package.sh` (reproducible artifact), `verify.sh` (post-deploy proof), `Makefile`, nginx template, Ollama systemd drop-in, docker-compose, cloud-init, hardening checklist |
| [`oci/terraform/`](oci/terraform/) | Fully automated infrastructure on Oracle Cloud: VCN, NSG (22/80/443 only), GPU or A1 Flex instance, separate model-weight volume, cloud-init that installs and verifies the product |
| [`.github/workflows/`](.github/workflows/) | CI (tests + deployment harness + Terraform validate) and the release pipeline (artifact → GitHub release → optional SSH deploy → optional `terraform apply`) |

## Architecture of the code

```
(all pages)──▶ assets/js/brand.js       NAME / MARK constants → titles, wordmarks, favicon, marks
index.html ──▶ assets/js/landing.js     hero terminal · THEMES (live CSS-variable swap) · reveal
app.html   ──▶ assets/js/app.js         workspace controller
              ├─ models.js               model registry: location, speed, context, memory, licence,
              │                          policy profile, trains-on-your-data
              ├─ gateway.js              real inference: Ollama ndjson + OpenAI SSE, probe, discovery
              ├─ vault.js                PBKDF2-SHA256 (210k) → AES-GCM 256, key in memory only
              ├─ db.js                   IndexedDB store: conversations · messages · files
              ├─ engine.js               on-device demo responder (offline default)
              └─ md.js                   escape-first markdown renderer for streamed output
lab.html   ──▶ assets/js/lab.js         DATASETS per prompt set × variant, metrics, rubric, samples
wiki.html  ──▶ assets/js/wiki.js        the KiNETiC-Ai wiki UI: pages, revisions, reviews, citations,
              └─ md.js (document mode)   capacity — same-origin /platform/* only, nothing faked offline
server.js                               static server + same-origin /gateway/* and /platform/* proxies

platform/server.mjs                     HTTP API: keys, scopes, verticals, rate limits, audit
  ├─ config.mjs                         STORAGE · VERTICALS · TIERS · ADMISSION · APPS · capacityPlan()
  ├─ embeddings.mjs                     Ollama embedder (768d) + deterministic local fallback
  ├─ store.mjs                          documents · chunks · vectors · wiki · audit · keys · JSONL persistence
  ├─ ingest.mjs                         parse → chunk → admission → embed → index (dedupe by content hash)
  ├─ retrieve.mjs                       dense + BM25 → RRF → diversity → citations → context block
  ├─ sharepoint.mjs                     delta sync in, mirror out, permission mapping, mirror verification
  ├─ lifecycle.mjs                      60-day demotion · rehydration · sweeps · ceiling · quota reports
  ├─ wiki.mjs                           pages · immutable revisions · links · reviews · diff · mirror
  └─ schema.sql                         production Postgres 16 + pgvector: HNSW, RLS, retention views
```

Everything is plain ES5-compatible browser JS loaded with `<script>` tags, so it runs from `file://`,
a static host, or an nginx/OCI bucket with no toolchain.

## The workspace, concretely

- **Local-first storage.** Conversations, messages and file metadata live in IndexedDB. Message bodies
  are AES-GCM encrypted once you set a passphrase; titles stay plaintext so the list renders while
  locked, and the sidebar says so.
- **Real client-side encryption.** `vault.js` derives the key with PBKDF2-SHA256 over a per-device salt
  at 210k iterations, stores a verification token instead of the passphrase, and clears the key on
  lock. The UI states the threat model, including what it does *not* protect against.
- **Retention that is enforced, not decorative.** `0 days` keeps transcripts in this tab's memory
  only — nothing touches disk, and the sidebar marks them `RAM`. Any other window purges expired
  conversations on load and whenever you change it. Reads are never gated, so switching to 0 does not
  hide or orphan the history that already exists.
- **Streaming that behaves.** User message renders instantly; the assistant container is reserved with
  a real stage label; deltas are buffered and flushed every ~48 ms inside `requestAnimationFrame`;
  scroll follows only while you are near the bottom (otherwise *Jump to latest*); Stop aborts via
  `AbortController` and the partial output is persisted as `stopped`.
- **Per-message telemetry you can see:** TTFT, throughput, token counts, total time, transport, and
  cited sources. The sidebar keeps a rolling 40-run TTFT p50/p95.
- **Model picker** exposes location (local / private VPC / external), speed, context, memory, runtime,
  licence, policy profile and training posture *before* you send — with an explicit confirmation when
  a choice moves data outside your boundary.
- **Real gateway support.** Settings → Model gateway accepts any OpenAI-compatible endpoint
  (Ollama, vLLM, TGI, LiteLLM) and streams real SSE. Keys stay in `sessionStorage` for the tab and are
  never placed in prompt context. Without a gateway the workspace runs an on-device demo responder and
  tells you that plainly.

> For Ollama: set `OLLAMA_ORIGINS` to include the origin serving this page, and remember the browser
> must reach the host — a sandboxed browser cannot talk to `localhost` inside the sandbox.

## The data platform (KiNETiC-Ai)

One knowledge substrate shared by every app and every business vertical — the thing that makes
retrieval real instead of illustrative.

- **Capacity is arithmetic.** 50 GB per node volume, a **20 GB live ceiling**, 10,226 planning bytes
  per chunk ⇒ **1,785,019 chunks ≈ 714 M tokens**. HNSW index 7.05 GB + heap 9.95 GB ⇒ **22 GB RAM**
  under a **2× headroom policy** (storage comes out at 2.5×). `capacityPlan()` computes it,
  `tests/platform.mjs` asserts it, and `platform/schema.sql` carries the same constants — a test
  parses the SQL to prove the two agree.
- **Only live, production, useful data.** Drafts, templates, personal files, training corpora,
  duplicates, 7-year-old content, sub-40-token documents and over-quota ingests are refused with
  reasons, and every refusal is audited.
- **Hybrid retrieval with honest citations.** Dense (HNSW, 768d) + BM25 fused with RRF, diversified
  per document. Citations state a page **only if the source gave one**, carry a checksum and the
  SharePoint link, and mark restricted content. 3/3 exact identifiers (`clause 14.2`,
  `FCA-2024-118`) rank the right document first in the fixtures.
- **Authorisation is in the candidate query, never a post-filter** — in `scanChunks()` and in
  Postgres RLS. Default deny; permissions inherit from SharePoint and never widen; an out-of-scope
  vertical returns an empty scope rather than a 403, so nothing leaks about what exists.
- **The 60-day rule.** Content nobody *opens* for 60 days goes back to SharePoint, keeping a
  4.3 KB discoverable stub — and demotion only happens after the mirror is verified, so the platform
  never deletes the only copy. Retrieval does not reset the clock; opening does. The path reopens on
  demand, pulling from SharePoint and reporting drift if the source changed. Under quota pressure the
  window adapts 60 → 30 → 14 days.
- **A real wiki.** Vertical-scoped slugs, immutable revisions with diffs, `[[wikilinks]]` and
  backlinks in both directions, review dates with an overdue queue, and every page indexed into RAG so
  it is citable beside a contract — then mirrored back out to SharePoint.
- **One API, five apps, scoped keys.** `search · read · ingest · wiki · admin`, per-app verticals,
  sliding-window rate limits, secrets hashed at rest and shown once, every write audited.

```bash
npm run platform                                   # the data tier on :8090
PLATFORM_URL=http://127.0.0.1:8090 npm start       # the app origin proxies /platform/*
node platform/server.mjs --create-key kinetic-wiki # issue a key (printed once)
open http://127.0.0.1:8080/wiki.html               # the wiki

# or the whole stack in one command, with sample content that says it is sample
npm run local:demo
```

**Status, plainly:** the reference server persists to JSONL on a volume and is fully tested
(retrieval, retention, wiki, mirror, ACLs, audit). `platform/schema.sql` is the production
Postgres + pgvector shape and `deploy/docker-compose.platform.yml --profile pgvector` applies it, but
the adapter that makes the server read and write those tables is the next piece of work — until then
`DATABASE_URL` is set and unused. `GraphSharePoint` is written against the documented Graph endpoints
and has not met a real tenant. See [docs/DATA-PLATFORM.md](docs/DATA-PLATFORM.md).

## Deploy it

Four routes, fastest first. Full detail in [`deploy/README.md`](deploy/README.md).

```bash
# 1 · FASTEST, local — installs Ollama if needed, pulls a model, opens the browser
bash deploy/local.sh                          # real inference
bash deploy/local.sh --mock                   # no Ollama? demo host, zero downloads

# 2 · FASTEST, a VPS you already have — one command, idempotent, TLS + auth + firewall
curl -fsSL https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/main/deploy/install.sh \
  | sudo bash -s -- --domain llm.example.com --email ops@example.com \
                    --model qwen2.5:14b-instruct-q4_K_M --auth admin:CHANGE_ME
bash deploy/install.sh --dry-run --domain llm.example.com      # review the plan first
bash deploy/install.sh --render-only --domain llm.example.com  # review the nginx site

# 3 · UPLOAD-READY ARTIFACT — reproducible, checksummed, for hosts without GitHub access
bash deploy/package.sh                        # → dist/*.tar.gz + .sha256 + manifest.json + INSTALL.txt
cd deploy && make deploy TARGET=ubuntu@1.2.3.4 DOMAIN=llm.example.com AUTH=admin:CHANGE_ME

# 4 · FULLY AUTOMATED — provision the host itself on Oracle Cloud
cd oci/terraform && terraform init && terraform apply
```

Every route ends with proof rather than assumption:

```bash
bash deploy/verify.sh --url https://llm.example.com --auth admin:pw \
     --public-host 1.2.3.4 --expect-models --ssh ubuntu@1.2.3.4
```

`verify.sh` exits non-zero if streaming is buffered, if the gateway is reachable
without credentials, if port 11434 is public, if the certificate expires within a
week, or if Ollama is bound to anything but loopback. `--json` for CI.

### Or wire a model host by hand

```bash
# model host — Ollama bound to loopback, never published
curl -fsSL https://ollama.com/install.sh | sh
sudo cp deploy/ollama.service /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
ollama pull qwen2.5:14b-instruct-q4_K_M

# app host — one origin for UI and model
OLLAMA_URL=http://127.0.0.1:11434 node server.js
```

Then in the workspace: **Settings → Model gateway → “Same-origin proxy → Ollama” → Save & probe**.
Probing lists what the endpoint actually has, injects those models into the picker under **Your
endpoint**, and *Route: every model* replaces the demo responder entirely. Each message footer then
shows the real endpoint, the model id that served it, and timings taken from Ollama's own
`eval_count` / `prompt_eval_duration` rather than a browser-side guess.

Why the proxy: a browser cannot reach a private subnet, and Ollama rejects cross-origin requests
unless `OLLAMA_ORIGINS` allows them. Serving UI and model from one origin removes CORS, works behind a
preview host or load balancer, and keeps port 11434 unpublished. `server.js` forwards to exactly one
target — it is not an open proxy. vLLM, TGI and LiteLLM work the same way: point `OLLAMA_URL` at them
and choose the OpenAI-compatible preset.

> The live preview in this session runs `deploy/local.sh --mock` — `tests/mock-ollama.mjs` is a
> faithful stand-in that streams ndjson and reports eval stats, so the whole gateway path can be
> exercised in a browser without a GPU. Responses are marked `MOCK-OLLAMA-9F3C` to keep that obvious.

## Rename the product

One constant: `NAME` in [`assets/js/brand.js`](assets/js/brand.js). Legal name, slug, page titles,
meta description, wordmarks, aria labels, favicon and the injected SVG logo mark all derive from it.
`tests/smoke.mjs` proves it by patching that single constant to `QuietCompute` and asserting no stale
brand text survives in the rendered DOM. Swap `MARK` in the same file to change the logo.

## Development

The product itself has no build step and no runtime dependencies. Tests are dev-only:

```bash
npm install           # jsdom + fake-indexeddb + js-yaml (devDependencies only)
npm test               # 863 assertions: UI + gateway + data platform + deployment layer
npm run test:smoke     # UI behaviour only, including the wiki          (213)
npm run test:gateway   # mock Ollama + proxy + real streaming in the UI  (50)
npm run test:platform  # the KiNETiC-Ai data platform end to end        (299)
npm run test:deploy    # installer, packager, verifier, local.sh, make, cloud-init, terraform, CI (301)
npm run platform       # the data tier on :8090 (RAG + wiki + retention + mirror)
npm run local:demo     # the whole thing — app + data tier + labelled sample content
npm run mock          # mock inference host on :11500 for manual testing
npm run local         # the fastest way to run the whole thing
npm run package       # build the upload-ready artifact into dist/
npm run verify        # prove a deployment (-- --url https://… --expect-models)
npm start             # static server + gateway proxy on 0.0.0.0:8080
```

`tests/smoke.mjs` (213 assertions) loads each page in jsdom with a real IndexedDB and WebCrypto shim
and drives the actual UI: brand injection and the single-constant rename, theme re-tokening, a sent
prompt with streaming to completion, TTFT/citations/throughput attached to the message, a generation
stopped mid-stream with partial output preserved, the AES-GCM vault round-trip (including rejecting a
wrong passphrase), the model picker, the external-endpoint confirmation gate, slash commands, and
proof that retention 0 writes nothing to disk. Its `testWiki` block drives `wiki.html` against a fake
platform that answers the shapes `platform/server.mjs` returns, and asserts what the UI *claims*: that
it renders nothing invented when the platform is down, that a refused key is reported in the platform's
own words, that a read-only key is not offered write actions or other verticals' pages, that citations
state a page only when the source gave one, that archived matches are surfaced with the reason and the
way back in, and that the API key lives in `sessionStorage` and never in `localStorage`.

`tests/gateway.mjs` (50 assertions) boots `tests/mock-ollama.mjs` plus `server.js` with `OLLAMA_URL`
pointed at it, then verifies: the proxy forwards and streams incrementally rather than buffering,
`X-Accel-Buffering: no` is set, an unreachable upstream returns a 502 that explains the fix, probing
discovers models and injects them into the picker, a prompt is genuinely served by the endpoint
(marker text), Ollama's eval stats become the displayed metrics, TTFT is measured from request start,
the OpenAI-compatible SSE transport works with `usage` accounting, a dead endpoint surfaces in the
transcript instead of hanging, and switching back to the demo responder works with no network at all.

`tests/platform.mjs` (299 assertions) is the data platform end to end: the capacity arithmetic
(10,226 B per chunk, 1,785,019 chunks in 20 GB, 22 GB of RAM under the 2× rule, 2.5× storage
headroom, quotas summing to exactly the ceiling), embeddings (deterministic, normalised, semantically
ordered), chunking that keeps identifiers whole, the admission policy refusing drafts, personal files,
duplicates, stale and over-quota content with reasons, hybrid retrieval ranking 3/3 exact identifiers
into the right document, the citation contract, ACLs applied in the candidate query with no existence
leaks, the 60-day rule (demote only after the mirror verifies, keep a discoverable stub, report drift,
reopen on demand, retrieval does not reset the clock but opening does), the wiki (immutable revisions,
bidirectional backlinks, review queue, indexed and mirrored out), the HTTP API (hashed keys, scopes,
verticals, rate limits, audit), JSONL persistence across a restart, `/platform/*` reachable on the app
origin, and parity between `platform/schema.sql` and the constants in `platform/config.mjs`.

`tests/deploy.mjs` (301 assertions) treats the deployment layer as code, not prose: every script is
syntax-checked and executable; the installer's dry-run plan covers all nine steps (ten with
`--platform`, which is checked for a loopback bind, a hardened unit, the embedding-model pull and the
`PLATFORM_URL` it hands the app tier) and changes nothing
on the machine; `--render-only` is checked in both TLS and plain-HTTP modes (tokens substituted,
`proxy_buffering off`, 600 s read timeout, basic auth and allowlist injected, ACME path left open);
`package.sh` is proven checksummed, content-complete (the platform, the wiki and the docs ship too),
junk-free and **byte-reproducible** — including that reproducibility does not depend on when the build
ran, which is asserted by pinning `SOURCE_DATE_EPOCH`;
`local.sh --mock` is really started and really serves the app; `verify.sh` is run against that live
host (passing) and against a dead port (failing with exit 1, plus valid `--json`); the Makefile's
targets forward their variables correctly; `cloud-init.yaml` is parsed as YAML and checked for the
0600 env file, the network wait and the model-volume mount; the Terraform is checked for the absence
of any ingress rule on 11434/8080, sensitive variables and cloud-init wiring; and both workflows are
parsed, checked for the `secrets`-in-`if:` mistake GitHub Actions does not allow, and asserted to run
the gates they claim.

Optional visual capture (needs a Chromium binary, writes to gitignored `shots/`):

```bash
npm i -D puppeteer && node tests/shots.mjs
# or: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node tests/shots.mjs
```

## Behaviour Lab

Same prompts, temperature, max tokens and system policy for both variants; the only variable is the
weight edit. Tabs split the prompt set into **Safe work / Borderline / Disallowed / Internal policies**,
because a blended score hides the only two numbers that matter. Refusal rate flips polarity on the
disallowed tab (`METRICS[].tabDir`) — colouring 96% refusal red on prohibited prompts would be
actively misleading. Prohibited-category samples are withheld by policy and render as an aggregate
panel with an evaluator rationale.

The shipped numbers are an **illustrative worked example** of the format, labelled as such in the UI.
Replace `lab.js → DATASETS` with your own scored-run output before quoting anything externally.

## Claim discipline

The landing page footer carries a standing honesty note: every privacy claim is a design target for the
reference architecture, not a warranty. `DESIGN.md §13` is the pre-launch audit checklist — training
exclusion in writing, residency for inference *and* embeddings, deletion that removes vector chunks,
DSAR coverage, transfer risk assessment, audit-log fields, key handling, latency under concurrency, and
research profiles gated and never default.

The data platform holds itself to the same rule: `docs/DATA-PLATFORM.md §9` lists what is **not**
wired yet (the Postgres adapter, a live Graph tenant), and `wiki.html` renders nothing at all when the
platform is down rather than showing sample pages.

Sell *private, controlled, self-hosted, policy-configurable*. "Abliterated"/"uncensored" is a labelled
research configuration, never the commercial proposition.
