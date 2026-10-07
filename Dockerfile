# ============================================================================
# GRiD-OS-SOVEREIGN + KiNETiC-Ai — one image, two roles.
#
#   app tier       node server.js                  (default CMD, port 8080)
#   data platform  node platform/server.mjs        (override the command, 8090)
#
# Zero npm dependencies at runtime, so there is no build step and nothing to
# resolve: the image is a copy plus a user. That is deliberate — a private-LLM
# product should not need a registry full of transitive packages to serve its
# own UI, and every dependency is one more thing to audit for residency.
#
# Build and run by hand:
#   docker build -t grid-os-sovereign .
#   docker run --rm -p 8080:8080 grid-os-sovereign
#   docker run --rm -e PLATFORM_PORT=8090 -e PLATFORM_HOST=0.0.0.0 \
#     -v kinetic-data:/data grid-os-sovereign node platform/server.mjs
#
# Coolify, Fly, Render, ECS and plain docker compose all use this same file.
# deploy/coolify/docker-compose.yml wires the full stack from it.
# ============================================================================

FROM node:22-alpine

# Runtime configuration; every one of these is also settable per container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    GATEWAY_PREFIX=/gateway/ \
    PLATFORM_PREFIX=/platform/

WORKDIR /app

# Copy only the runtime surface. tests/, deploy/, oci/, docs/ and .data/ stay
# outside the image: they are how the product is proved and shipped, not what it
# serves. .dockerignore enforces the rest.
COPY package.json server.js ./
COPY index.html app.html lab.html wiki.html ./
COPY assets ./assets
COPY platform ./platform

# Non-root, and /data exists for the platform's JSONL store before anything
# tries to write to it. The platform binds 0.0.0.0 *inside* the container so
# other containers on the same network can reach it; nothing publishes that port
# unless you publish it, so the host still never exposes it.
RUN addgroup -S grid && adduser -S grid -G grid \
    && mkdir -p /data \
    && chown -R grid:grid /app /data
USER grid
VOLUME ["/data"]

EXPOSE 8080

# A real health check, not `true`: it asks whichever tier this container is
# running for /healthz and fails on a non-2xx, so an orchestrator restarts a
# process that is alive but not serving. PLATFORM_PORT wins when set (platform
# role), otherwise PORT (app role).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PLATFORM_PORT||process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
