# Sovereign — private-LLM product reference implementation

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
| [`DESIGN.md`](DESIGN.md) | The design guide: principles, layout blueprint, tokens, storage model, picker UX, streaming rules, benchmark method, claim audit |
| [`deploy/`](deploy/) | OCI/VPC deployment: Ollama systemd drop-in, docker-compose, nginx with streaming-safe proxying, `.env.example`, hardening checklist |

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
server.js                               static server + same-origin /gateway/* streaming proxy
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

## Connect a real model (Ollama on your OCI box)

The workspace ships on the **demo responder** so it is usable and honestly "local only" before you
deploy anything. To serve real inference:

```bash
# 1. on the model host — Ollama bound to loopback, never published
curl -fsSL https://ollama.com/install.sh | sh
sudo cp deploy/ollama.service /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
ollama pull qwen2.5:14b-instruct-q4_K_M

# 2. on the app host — one origin for UI and model
OLLAMA_URL=http://127.0.0.1:11434 node server.js

# 3. in the workspace — Settings → Model gateway
#    Connection: "Same-origin proxy → Ollama"  →  Save & probe
```

Probing lists what the endpoint actually has, injects those models into the picker under **Your
endpoint**, and *Route: every model* replaces the demo responder entirely. Each message footer then
shows the real endpoint, the model id that served it, and timings taken from Ollama's own
`eval_count` / `prompt_eval_duration` rather than a browser-side guess.

Why the proxy: a browser cannot reach a private subnet, and Ollama rejects cross-origin requests
unless `OLLAMA_ORIGINS` allows them. Serving UI and model from one origin removes CORS, works behind a
preview host or load balancer, and keeps port 11434 unpublished. `server.js` forwards to exactly one
target — it is not an open proxy. nginx, docker-compose and a hardening checklist are in
[`deploy/README.md`](deploy/README.md).

vLLM, TGI and LiteLLM work the same way: point `OLLAMA_URL` at them and choose the
OpenAI-compatible preset.

> The live preview in this session runs against `tests/mock-ollama.mjs` — a faithful stand-in that
> streams ndjson and reports eval stats — so you can exercise the whole gateway path in the browser
> without a GPU. Responses are marked `MOCK-OLLAMA-9F3C` to keep that obvious.

## Rename the product

One constant: `NAME` in [`assets/js/brand.js`](assets/js/brand.js). Legal name, slug, page titles,
meta description, wordmarks, aria labels, favicon and the injected SVG logo mark all derive from it.
`tests/smoke.mjs` proves it by patching that single constant to `QuietCompute` and asserting no stale
brand text survives in the rendered DOM. Swap `MARK` in the same file to change the logo.

## Development

The product itself has no build step and no runtime dependencies. Tests are dev-only:

```bash
npm install          # jsdom + fake-indexeddb (devDependencies only)
npm test             # 159 assertions: smoke suite + gateway integration suite
npm run test:smoke   # UI behaviour only
npm run test:gateway # boots a mock Ollama + the proxy, drives real streaming
npm run mock         # mock inference host on :11500 for manual testing
npm start            # static server + gateway proxy on 0.0.0.0:8080
```

`tests/smoke.mjs` (110 assertions) loads each page in jsdom with a real IndexedDB and WebCrypto shim
and drives the actual UI: brand injection and the single-constant rename, theme re-tokening, a sent
prompt with streaming to completion, TTFT/citations/throughput attached to the message, a generation
stopped mid-stream with partial output preserved, the AES-GCM vault round-trip (including rejecting a
wrong passphrase), the model picker, the external-endpoint confirmation gate, slash commands, and
proof that retention 0 writes nothing to disk.

`tests/gateway.mjs` (49 assertions) boots `tests/mock-ollama.mjs` plus `server.js` with `OLLAMA_URL`
pointed at it, then verifies: the proxy forwards and streams incrementally rather than buffering,
`X-Accel-Buffering: no` is set, an unreachable upstream returns a 502 that explains the fix, probing
discovers models and injects them into the picker, a prompt is genuinely served by the endpoint
(marker text), Ollama's eval stats become the displayed metrics, TTFT is measured from request start,
the OpenAI-compatible SSE transport works with `usage` accounting, a dead endpoint surfaces in the
transcript instead of hanging, and switching back to the demo responder works with no network at all.

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

Sell *private, controlled, self-hosted, policy-configurable*. "Abliterated"/"uncensored" is a labelled
research configuration, never the commercial proposition.
