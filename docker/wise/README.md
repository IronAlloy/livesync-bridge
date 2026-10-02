# WISE build of livesync-bridge

This fork (`IronAlloy/livesync-bridge`) is the single source of the WISE platform's
`ghcr.io/ironalloy/livesync-bridge` image: code, Dockerfile, CI and notes live here.
Upstream is [`vrtmrz/livesync-bridge`](https://github.com/vrtmrz/livesync-bridge).

## Branches

| Branch | What it is |
|---|---|
| `main` | Mirror of upstream `main`. Never commit here; upstream PRs branch from it. |
| `fix/*`, `feat/*` | Clean, single-purpose branches based on upstream `main`, meant as upstream PRs (no WISE files). |
| **`wise`** | What we build and run: upstream + the PRs/fixes below + `docker/wise/` + `.github/workflows/wise-image.yml`. Pushing to it publishes the image. |

## What `wise` adds on top of upstream (as of 2026-10-02, upstream `c3760be`)

| Change | Why |
|---|---|
| upstream PR **#65** (danieldebuhr) persist watch checkpoint, abort stalled `_changes` feeds | A restart resumes where it stopped instead of skipping changes made while it was down; a silently dead connection no longer stalls the feed forever. |
| upstream PR **#75** (nuggie) retry `put()`/`delete()` on transient network failures | A network blip no longer loses a change. |
| **fix: fetch missing chunks directly from CouchDB** (`ChunkFetch.ts`; upstream issue #41) | Without it a document that arrives before its chunks fails to load (older builds: process crash `Method not implemented`). |

Both PRs were read in full before merging (no network calls, `eval` or process
execution; pure retry/checkpoint logic). Not merged: #72, #74 (not needed), #45, #31
(conflict with the above).

## Image

* Built from `docker/wise/Dockerfile` with the repository root as context:
  `docker build -f docker/wise/Dockerfile -t livesync-bridge:wise .`
* The image is exactly the checked-out commit: no `git clone`, no patch files.
* Tags: `:latest` and `:<commit sha>` (pin the SHA tag/digest in production).
* **Pinned**: Deno base image by content digest (`ARG DENO_DIGEST`), dependencies by
  `deno.lock` (`--frozen`), source by the commit.
* Runs as uid 1000 (`bridge`). The vault bind mount **must be on a case-insensitive
  filesystem** (ext4 casefold / APFS): the storage peer runs with
  `scanOfflineChanges: true` and on case-sensitive storage a case-only rename duplicates
  directories across CouchDB. (WISE: `wise-docker-compose` `docs/CASEFOLD-VAULT.md`.)

### Health check

`HEALTHCHECK` reads the bridge's heartbeat (`/tmp/lsb-health.json`, every 10 s:
`{ts, ok, restartWorthy, peers}`): healthy = fresh (< 60 s) **and** every peer syncing
**and** not restart-worthy. Do not override `healthcheck:` in compose.

### Offline-scan state

The storage peer keeps its scan memory in Deno `localStorage` under
`/app/.deno_cache/location_data`. Mount a **named volume** there so it survives
container recreation (the directory is created owned by uid 1000).

## Releasing

1. Work on a branch; open a PR into `wise` (CI runs check, lint, unit and integration
   tests, and builds the image without publishing).
2. Merge to `wise` => CI publishes `:latest` and `:<sha>`.
3. Production pulls by digest/SHA and swaps the container; rollback = previous SHA tag.

Publishing needs either a `GHCR_PAT` repository secret or the package granting this
repository Write access (GitHub -> Packages -> livesync-bridge -> Package settings ->
Manage Actions access).

## Updating from upstream

```bash
git fetch upstream            # upstream = vrtmrz/livesync-bridge
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout wise && git merge main   # re-run: deno task check lint test
```

Drop a PR from `wise` once upstream has merged it (the merge will report it as already
applied). Re-test the missing-chunk behaviour (document replicated before its chunks)
after every upstream library bump.
