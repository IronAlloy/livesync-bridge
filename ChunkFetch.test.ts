import { createChunkReplicator } from "./ChunkFetch.ts";

function assertEquals(actual: unknown, expected: unknown, msg = "") {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg} expected ${e} but got ${a}`);
}

const chunk = (id: string) => ({ _id: id, data: `data-${id}` });
const noWait = () => Promise.resolve();

Deno.test("returns chunks that are present immediately", async () => {
    const calls: string[][] = [];
    const db = {
        allDocs: (o: { keys: string[] }) => {
            calls.push(o.keys);
            return Promise.resolve({ rows: o.keys.map((k) => ({ id: k, key: k, doc: chunk(k) })) });
        },
    };
    const r = createChunkReplicator(() => db, () => {}, [10, 10], noWait);
    const got = await r.fetchRemoteChunks(["h:a", "h:b"], false);
    assertEquals((got as { _id: string }[]).map((c) => c._id), ["h:a", "h:b"]);
    assertEquals(calls.length, 1, "one query when nothing is missing");
});

Deno.test("retries until a late chunk appears (document-before-chunks race)", async () => {
    let attempt = 0;
    const db = {
        allDocs: (o: { keys: string[] }) => {
            attempt++;
            return Promise.resolve({
                rows: o.keys.map((k) =>
                    k === "h:late" && attempt < 3 ? { key: k, error: "not_found" } : { id: k, key: k, doc: chunk(k) }
                ),
            });
        },
    };
    const r = createChunkReplicator(() => db, () => {}, [1, 1, 1, 1], noWait);
    const got = await r.fetchRemoteChunks(["h:a", "h:late"], false);
    assertEquals((got as { _id: string }[]).map((c) => c._id).sort(), ["h:a", "h:late"]);
    assertEquals(attempt, 3, "stopped as soon as everything was found");
});

Deno.test("re-queries only the chunks that are still missing", async () => {
    const asked: string[][] = [];
    let n = 0;
    const db = {
        allDocs: (o: { keys: string[] }) => {
            asked.push([...o.keys]);
            n++;
            return Promise.resolve({
                rows: o.keys.map((k) => (k === "h:slow" && n < 2 ? { key: k, error: "not_found" } : { id: k, key: k, doc: chunk(k) })),
            });
        },
    };
    const r = createChunkReplicator(() => db, () => {}, [1, 1], noWait);
    await r.fetchRemoteChunks(["h:a", "h:slow"], false);
    assertEquals(asked, [["h:a", "h:slow"], ["h:slow"]]);
});

Deno.test("gives up after the bounded retries and returns what it found", async () => {
    let n = 0;
    const logs: string[] = [];
    const db = {
        allDocs: (o: { keys: string[] }) => {
            n++;
            return Promise.resolve({ rows: o.keys.map((k) => (k === "h:never" ? { key: k, error: "not_found" } : { id: k, key: k, doc: chunk(k) })) });
        },
    };
    const r = createChunkReplicator(() => db, (m) => logs.push(m), [1, 1, 1], noWait);
    const got = await r.fetchRemoteChunks(["h:a", "h:never"], false);
    assertEquals((got as { _id: string }[]).map((c) => c._id), ["h:a"]);
    assertEquals(n, 4, "initial attempt + 3 retries");
    assertEquals(logs.some((m) => m.includes("1 of 2")), true, "reports what is still missing");
});

Deno.test("returns false when no chunk can be found", async () => {
    const db = { allDocs: (o: { keys: string[] }) => Promise.resolve({ rows: o.keys.map((k) => ({ key: k, error: "not_found" })) }) };
    const r = createChunkReplicator(() => db, () => {}, [1], noWait);
    assertEquals(await r.fetchRemoteChunks(["h:x"], false), false);
});

Deno.test("ignores deleted, malformed and duplicate-id entries; survives a thrown query", async () => {
    let n = 0;
    const db = {
        allDocs: (o: { keys: string[] }) => {
            n++;
            if (n === 1) return Promise.reject(new Error("connection reset"));
            return Promise.resolve({
                rows: [
                    { id: "h:del", key: "h:del", value: { deleted: true }, doc: null },
                    { id: "h:bad", key: "h:bad", doc: { _id: "h:bad" } as never },
                    { id: "h:ok", key: "h:ok", doc: chunk("h:ok") },
                ].filter((row) => o.keys.includes(row.key)),
            });
        },
    };
    const logs: string[] = [];
    const r = createChunkReplicator(() => db, (m) => logs.push(m), [1, 1], noWait);
    const got = await r.fetchRemoteChunks(["h:ok", "h:ok", "h:del", "h:bad"], false);
    assertEquals((got as { _id: string }[]).map((c) => c._id), ["h:ok"]);
    assertEquals(logs.some((m) => m.includes("connection reset")), true, "logs the thrown error and retries");
});
