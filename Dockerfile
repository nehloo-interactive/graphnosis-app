# Graphnosis personal server — headless sidecar + browser UI.
# Multi-stage: build everything (incl. native modules) in a full image, then
# copy into a slim runtime. No Tauri shell — this serves the web UI + JSON-RPC
# API on :3456. The cortex is a runtime volume, never baked into the image.
#
# Build (multi-arch):
#   docker buildx build --platform linux/amd64,linux/arm64 -t graphnosis-server .
# Run:
#   docker run -p 3456:3456 \
#     -e GRAPHNOSIS_PASSPHRASE=… -e GRAPHNOSIS_HTTP_UI_TOKEN="$(openssl rand -hex 32)" \
#     -v /srv/graphnosis-cortex:/data/cortex \
#     graphnosis-server

# ── Builder ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder
WORKDIR /app

# Toolchain for native addons (better-sqlite3, onnxruntime-node, msgpackr, etc.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

# Copy the full source (the workspace's many package.jsons are needed for the
# install graph; .dockerignore keeps host node_modules/dist/target out).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# NOTE: we copy the full node_modules into the runtime stage rather than
# pruning. pnpm's workspace symlink layout makes a reliable prod-prune fiddly,
# and correctness beats image size for v1. Slim later if size matters.
#
# OPTIONAL air-gapped pre-warm: the embedding model (fastembed → BGE-small-en,
# ~90 MB) is NOT bundled — it downloads from storage.googleapis.com on first
# embed. The runtime persists it on the /data volume (GRAPHNOSIS_EMBED_CACHE
# below), so it's a one-time fetch. For a fully air-gapped server, uncomment to
# bake the default model into the image instead, then COPY it + point the cache
# at it in the runtime stage:
#   RUN cd apps/desktop-sidecar && node -e "const{FlagEmbedding,EmbeddingModel}=require('fastembed');FlagEmbedding.init({model:EmbeddingModel.BGESmallENV15,cacheDir:'/opt/graphnosis-models',showDownloadProgress:false}).then(()=>console.log('warmed')).catch(e=>{console.error(e);process.exit(1)})"
# The multilingual e5-large model (~2.2 GB) is opt-in and intentionally never
# baked — it fetches on demand only if the user enables multilingual embeddings.

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# libgomp1: OpenMP runtime onnxruntime links against. ca-certificates: HTTPS
# egress (e.g. first-run embedding-model fetch, connectors).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -r graphnosis \
 && useradd -r -g graphnosis -m -d /home/graphnosis graphnosis

COPY --from=builder --chown=graphnosis:graphnosis /app /app

ENV NODE_ENV=production \
    GRAPHNOSIS_HTTP_UI=1 \
    GRAPHNOSIS_BIND=0.0.0.0 \
    GRAPHNOSIS_HTTP_UI_PORT=3456 \
    GRAPHNOSIS_HTTP_UI_STATIC=/app/apps/desktop/dist \
    GRAPHNOSIS_CORTEX=/data/cortex \
    GRAPHNOSIS_EMBED_CACHE=/data/models
# Embedding model cache on the /data volume so the ~90 MB download happens once
# and survives container recreation (otherwise every fresh container re-fetches
# it). The graphnosis user must be able to write /data — chown the host mount to
# the container's graphnosis uid, or use a named volume.
# Provide at runtime (-e): GRAPHNOSIS_PASSPHRASE, GRAPHNOSIS_HTTP_UI_TOKEN.

# Cortex lives on a mounted volume so it persists across container restarts.
VOLUME ["/data"]
EXPOSE 3456
USER graphnosis

# Liveness: the UI root must answer. Node 22 has global fetch — no curl needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GRAPHNOSIS_HTTP_UI_PORT||3456)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/desktop-sidecar/dist/index.js"]
