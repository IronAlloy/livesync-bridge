// Gives the bridge a minimal "active replicator" so the library can fetch chunk
// documents it does not hold.
//
// Problem: when LiveSync Commonlib reads a document whose chunks are not yet
// available locally, its ChunkFetcher calls
// `services.replicator.getActiveReplicator().fetchRemoteChunks(ids)`. The bridge
// never configures a replicator (its "local" database IS the remote CouchDB), so
// that returns undefined, the library logs "No active replicator was found to
// request missing chunks", the claim times out and the document fails to load
// ("WATCH: DOCUMENT LOAD FAILED ... Corrupted document"). Older builds crashed the
// whole process here ("Method not implemented").
//
// Typical trigger: a client (e.g. the Obsidian plugin) replicates the file document
// a moment BEFORE its chunk documents, so the bridge reads the document first. The
// chunks exist (or arrive within seconds) in the same database, so fetching them
// directly, with a short bounded retry, is enough.

import type { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";

/** Waits (ms) between attempts while chunks are still missing; bounds the total wait. */
export const CHUNK_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

type ChunkDoc = { _id: string; data: string; [key: string]: unknown };
type AllDocsRow = { id?: string; key?: string; error?: string; value?: { deleted?: boolean }; doc?: ChunkDoc | null };
type ChunkDb = {
    allDocs(opts: { keys: string[]; include_docs: boolean }): Promise<{ rows: AllDocsRow[] }>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createChunkReplicator(
    getDb: () => ChunkDb,
    log: (message: string) => void,
    delays: number[] = CHUNK_RETRY_DELAYS_MS,
    wait: (ms: number) => Promise<void> = sleep,
) {
    return {
        // Contract used by Commonlib's ChunkFetcher: resolve to the chunk documents
        // that were found, or `false` when none could be found.
        async fetchRemoteChunks(ids: string[], _showResult: boolean): Promise<ChunkDoc[] | false> {
            let wanted = [...new Set(ids)];
            const found = new Map<string, ChunkDoc>();
            for (let attempt = 0;; attempt++) {
                try {
                    const res = await getDb().allDocs({ keys: wanted, include_docs: true });
                    for (const row of res.rows) {
                        const doc = row.doc;
                        if (
                            doc && !row.error && !row.value?.deleted &&
                            typeof doc._id === "string" && typeof doc.data === "string"
                        ) {
                            found.set(doc._id, doc);
                        }
                    }
                } catch (ex) {
                    log(`chunk fetch attempt ${attempt + 1} failed: ${ex instanceof Error ? ex.message : String(ex)}`);
                }
                wanted = wanted.filter((id) => !found.has(id));
                if (wanted.length === 0 || attempt >= delays.length) break;
                await wait(delays[attempt]);
            }
            if (wanted.length > 0) {
                log(`chunk fetch: ${wanted.length} of ${ids.length} chunk(s) still missing after ${delays.length} retries`);
            }
            return found.size > 0 ? [...found.values()] : false;
        },
        closeReplication() {},
    };
}

/**
 * Make `man.services.replicator.getActiveReplicator()` return a chunk-fetching
 * replicator. Overridden on the instance (not just assigned to `_activeReplicator`)
 * because the library resets its own field when it (re)initialises the database.
 */
export function installChunkFetcher(man: DirectFileManipulator, log: (message: string) => void): void {
    const replicator = createChunkReplicator(
        // deno-lint-ignore no-explicit-any
        () => (man.liveSyncLocalDB as any).localDatabase as ChunkDb,
        log,
    );
    // deno-lint-ignore no-explicit-any
    const svc = man.services.replicator as any;
    svc.getActiveReplicator = () => svc._activeReplicator ?? replicator;
}
