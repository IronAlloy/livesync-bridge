# syntax=docker/dockerfile:1.7
#
# WISE production image of this fork. Build context = the repository root:
#   docker build -f docker/wise/Dockerfile -t livesync-bridge:wise .
# The image contains EXACTLY the commit that is checked out (no `git clone`, no patch
# files): upstream + the PRs/fixes merged on the `wise` branch. See docker/wise/README.md.
# Published by CI (.github/workflows/wise-image.yml) on every push to the `wise` branch.
#
# Reproducibility: the Deno base image is pinned by CONTENT DIGEST (a tag can be
# re-pushed, a digest cannot) and dependencies by deno.lock (`--frozen`).
ARG DENO_VERSION=2.6.9
# Multi-arch index digest of denoland/deno:2.6.9 (checked 2026-10-01). To bump: pick the
# new tag, copy its index digest from Docker Hub, test, then update both.
ARG DENO_DIGEST=sha256:2221eafd8a7556693307ad9889a79d4974e1844a6964acbe466ab9faa15d37bf

# ----------------------------------------------------------------------------
# Stage 1 - resolve dependencies from the checked-out sources.
# ----------------------------------------------------------------------------
FROM denoland/deno:${DENO_VERSION}@${DENO_DIGEST} AS builder
WORKDIR /app
# Pin the deno cache inside /app so stage 2's COPY carries JSR/npm metadata forward;
# otherwise the runtime image would fetch jsr.io at startup (fails without egress).
ENV DENO_DIR=/app/.deno_cache
COPY . /app
RUN deno install --allow-import --frozen \
    && deno cache main.ts
# /app/dat is a bind-mount target in production - ship it empty.
RUN find /app/dat -mindepth 1 -delete

# ----------------------------------------------------------------------------
# Stage 2 - runtime.
# ----------------------------------------------------------------------------
FROM denoland/deno:${DENO_VERSION}@${DENO_DIGEST}

LABEL org.opencontainers.image.source="https://github.com/IronAlloy/livesync-bridge" \
      org.opencontainers.image.description="Obsidian Self-hosted LiveSync bridge (CouchDB <-> filesystem), WISE build" \
      org.opencontainers.image.licenses="MIT"

ENV DENO_DIR=/app/.deno_cache \
    DENO_NO_UPDATE_CHECK=1
WORKDIR /app

# The base image's bundled "deno" user is uid 1993; we run as uid 1000 so host
# bind-mounts (the casefold vault volume) are owned by an ordinary user. Give it a real
# passwd/group entry, otherwise the process is an anonymous "I have no name!" uid.
RUN groupadd --gid 1000 bridge \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/sh bridge

# CASE-INSENSITIVITY REQUIRED: the storage peer (scanOfflineChanges=true) resolves its
# baseDir under /app/data. That bind MUST be on a case-INSENSITIVE filesystem (ext4
# casefold / APFS): on case-sensitive storage a case-only rename resurrects the
# old-case directory and the offline scan duplicates it across CouchDB.
COPY --from=builder --chown=bridge:bridge /app /app

# Offline-scan memory: the storage peer records which files its startup scan already
# handled in Deno localStorage under $DENO_DIR/location_data. The directory must exist,
# owned by the bridge user, so a named volume mounted here is writable and the state
# survives container RECREATION (e.g. an image update).
RUN mkdir -p /app/.deno_cache/location_data \
    && chown bridge:bridge /app/.deno_cache/location_data

USER bridge:bridge

# The bridge exposes no HTTP port. It writes a heartbeat to $LSB_HEALTH_FILE (default
# /tmp/lsb-health.json) every 10 s: {ts, ok, restartWorthy, peers}. Healthy = file fresh
# (a wedged event loop stops updating it) AND every peer syncing AND not restart-worthy.
# (A bare `deno eval 'Deno.exit(0)'` only proves Deno can start and stays "healthy"
# through a crash loop.) Compose must not override this healthcheck.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["deno", "eval", "const f=Deno.env.get('LSB_HEALTH_FILE')??'/tmp/lsb-health.json';try{const h=JSON.parse(Deno.readTextFileSync(f));Deno.exit(h.ok&&!h.restartWorthy&&Date.now()-h.ts<60000?0:1)}catch{Deno.exit(1)}"]

CMD ["task", "run"]
