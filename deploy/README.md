# Deploying on OCI (or any VPC) with Ollama

Reference deployment for a single-tenant private LLM: the UI and the model sit
behind one origin, the model port is never published, and the browser never
talks to the inference host directly.

```
                        ┌────────────────────────── your VCN ──────────────────────────┐
   user browser ──TLS──▶│  public subnet          private subnet                       │
                        │  ┌──────────────────┐   ┌──────────────────────────────────┐ │
                        │  │ nginx / node      │──▶│ Ollama  127.0.0.1:11434          │ │
                        │  │ server.js         │   │  · qwen2.5:14b-instruct-q4_K_M   │ │
                        │  │  · static UI      │   │  · GPU shape (A10 / L40S)        │ │
                        │  │  · /gateway/* ────┼───┤  · no public IP, no NSG ingress  │ │
                        │  └──────────────────┘   └──────────────────────────────────┘ │
                        └──────────────────────────────────────────────────────────────┘
```

UK/EU residency: `uk-london-1`, `uk-cardiff-1`, `eu-frankfurt-1` or
`eu-amsterdam-1`. Put the compute, the object storage and the database in the
same region — inference *and* embeddings must both stay inside the boundary you
advertise.

---

## 1. The Ollama host

GPU shapes that fit the shortlist:

| Shape | VRAM | Comfortable models |
| --- | --- | --- |
| `VM.GPU.A10.1` | 24 GB | 7B–14B Q4 with long context, 22B Q4 tight |
| `VM.GPU2.2` / `BM.GPU.L40S.4` | 48–192 GB | 32B Q4, two models resident, or 70B Q4 sharded |
| `VM.Standard.A1.Flex` (CPU, 32 GB+) | — | 7B–8B Q4, slow but usable for a pilot |

```bash
# Ubuntu 22.04/24.04 on the private subnet, no public IP
curl -fsSL https://ollama.com/install.sh | sh

# Bind to loopback ONLY. The proxy publishes it, nothing else does.
sudo systemctl edit ollama
```

`/etc/systemd/system/ollama.service.d/override.conf`:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_NUM_PARALLEL=4"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
# Only needed if a browser will hit Ollama directly (not recommended):
# Environment="OLLAMA_ORIGINS=https://llm.yourdomain.co.uk"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5:coder7b-q4_K_M
curl -s http://127.0.0.1:11434/api/tags | head -c 300   # sanity check
```

`OLLAMA_FLASH_ATTENTION=1` plus `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves KV-cache
memory, which is what lets a 14B model hold a long context on a 24 GB card.

**Network rules.** No ingress to 11434 from anywhere. The NSG/security list for
the private subnet allows only the app subnet to reach the proxy port; the proxy
host reaches 127.0.0.1:11434 locally. Egress can be locked down to the Ollama
registry for pulls and nothing else.

---

## 2. The app host

### Option A — node (fastest, includes the proxy)

```bash
git clone <your-fork> grid-os-sovereign && cd grid-os-sovereign
cp deploy/.env.example .env      # edit OLLAMA_URL
OLLAMA_URL=http://127.0.0.1:11434 PORT=8080 node server.js
```

`server.js` serves the static UI **and** forwards `/gateway/*` to `OLLAMA_URL`
with streaming intact (no buffering, `X-Accel-Buffering: no`). It is a
single-target proxy, not an open one.

Then in the workspace: **Settings → Model gateway → "Same-origin proxy → Ollama"
→ Save & probe.** Discovered models appear in the picker under *Your endpoint*.

### Option B — docker compose (UI + Ollama together, GPU passthrough)

```bash
cd deploy && docker compose up -d
# UI on :8080, Ollama bound to the compose network only
```

### Option C — nginx in front of node or Ollama directly

`deploy/nginx.conf` has the two `location` blocks that matter: `proxy_buffering
off`, HTTP/1.1 with an empty `Connection` header, and long read timeouts. Without
`proxy_buffering off` nginx holds the token stream and your TTFT collapses into
one big flush at the end.

---

## 3. Verify before you tell anyone it works

```bash
# from the app host
curl -s localhost:8080/healthz
curl -s localhost:8080/gateway/api/tags | jq '.models[].name'

# streaming actually streams (tokens should arrive incrementally, not at once)
curl -N -s localhost:8080/gateway/api/chat -d '{
  "model":"qwen2.5:14b-instruct-q4_K_M","stream":true,
  "messages":[{"role":"user","content":"Count slowly from one to ten."}]}'

# nothing is listening publicly
ss -ltnp | grep 11434        # must show 127.0.0.1, not 0.0.0.0
```

Then in the UI: send a prompt and check the message footer shows
`gateway · <host>`, the real model id, `prefill N ms`, and a token count that
came from Ollama's own `eval_count` rather than a character estimate.

---

## 4. Production hardening checklist

- [ ] Ollama bound to `127.0.0.1`; no NSG/security-list ingress on 11434.
- [ ] TLS terminated at nginx/OCI load balancer; HSTS on.
- [ ] Basic auth, OIDC or an identity-aware proxy in front of the UI — the
      reference build has no authentication of its own.
- [ ] Audit log written by the proxy or an app tier: actor, workspace, model,
      timestamp, token counts, retention decision.
- [ ] Object storage for documents with server-side encryption and a customer-
      managed key; bucket policies deny public access.
- [ ] Postgres + pgvector (or Qdrant) in the private subnet, one schema/namespace
      per tenant, deletion that removes chunks and embeddings, not just rows.
- [ ] Backups: model weights are reproducible, the vector index and transcripts
      are not. Snapshot both, and test a restore.
- [ ] Retention job that actually deletes on schedule (the UI control governs the
      browser store; server-side retention is yours to implement).
- [ ] Load test with `OLLAMA_NUM_PARALLEL` at your expected concurrency — TTFT
      degrades long before the GPU is saturated.
- [ ] Pin model versions by digest and record them per workspace, so an audit can
      reconstruct which weights answered a question.

---

## 5. Scaling up from Ollama

Ollama is the right pilot: one command, GGUF quantisations, native streaming.
Move to **vLLM** when you need continuous batching across many concurrent users,
tensor parallelism for a 32B+ model, or paged attention under load. Keep the same
OpenAI-compatible surface — in the workspace choose *"vLLM / TGI / LiteLLM
gateway"* and point the base URL at `:8000/v1`; nothing else changes.

Put **LiteLLM** (or your own router) in front when you need per-workspace API
keys, spend caps, model aliases, or a single audit point across several runtimes.
