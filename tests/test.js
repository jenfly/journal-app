// Pure logic tests — no DOM, no network. Run from this directory: `node test.js`.
// All test data is invented; never put real journal entries here.
const assert = require("assert");
const { validDoc, canonJSON, normalizeDoc, isPristine, journalCounts, syncPlan, mergeDocs } = require("../logic.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

function journal(id, name, entries) {
  return { id, name, entries: entries || [] };
}
function entry(timestamp, text, extra) {
  return Object.assign({ timestamp, text }, extra || {});
}
function doc(journals) {
  return { journals };
}
function pristineDoc() {
  return doc([journal("j-pristine", "Journal", [])]);
}

// ---------- validDoc ----------

test("validDoc accepts a well-formed doc", () => {
  assert.strictEqual(
    validDoc(doc([journal("j1", "Journal", [entry("2026-01-01T00:00:00.000Z", "hi")])])),
    true
  );
});

test("validDoc accepts a journal with zero entries", () => {
  assert.strictEqual(validDoc(doc([journal("j1", "Journal", [])])), true);
});

test("validDoc rejects a missing journals field", () => {
  assert.strictEqual(validDoc({}), false);
});

test("validDoc rejects an empty journals array", () => {
  assert.strictEqual(validDoc(doc([])), false);
});

test("validDoc rejects null/undefined doc", () => {
  assert.strictEqual(validDoc(null), false);
  assert.strictEqual(validDoc(undefined), false);
});

test("validDoc rejects a journal missing an id", () => {
  assert.strictEqual(validDoc(doc([{ name: "Journal", entries: [] }])), false);
});

test("validDoc rejects a journal missing a name", () => {
  assert.strictEqual(validDoc(doc([{ id: "j1", entries: [] }])), false);
});

test("validDoc rejects a journal whose entries is not an array", () => {
  assert.strictEqual(validDoc(doc([{ id: "j1", name: "Journal", entries: "nope" }])), false);
});

test("validDoc rejects a non-string timestamp", () => {
  assert.strictEqual(validDoc(doc([journal("j1", "Journal", [{ timestamp: 123, text: "hi" }])])), false);
});

test("validDoc rejects a non-string text", () => {
  assert.strictEqual(
    validDoc(doc([journal("j1", "Journal", [{ timestamp: "2026-01-01T00:00:00.000Z", text: 5 }])])),
    false
  );
});

// ---------- canonJSON ----------

test("canonJSON is key-order independent for objects", () => {
  assert.strictEqual(canonJSON({ a: 1, b: 2 }), canonJSON({ b: 2, a: 1 }));
});

test("canonJSON is NOT order independent for arrays (order matters)", () => {
  assert.notStrictEqual(canonJSON([1, 2]), canonJSON([2, 1]));
});

test("canonJSON treats explicit undefined values as absent", () => {
  assert.strictEqual(canonJSON({ a: 1, b: undefined }), canonJSON({ a: 1 }));
});

test("canonJSON matches across deeply nested docs regardless of key order", () => {
  const a = doc([journal("j1", "Journal", [entry("t1", "hi")])]);
  const b = { journals: [{ entries: [{ text: "hi", timestamp: "t1" }], name: "Journal", id: "j1" }] };
  assert.strictEqual(canonJSON(a), canonJSON(b));
});

// ---------- normalizeDoc ----------

test("normalizeDoc deep-copies so mutating the copy doesn't affect the original", () => {
  const original = doc([journal("j1", "Journal", [entry("t1", "hi")])]);
  const copy = normalizeDoc(original);
  copy.journals[0].entries[0].text = "changed";
  assert.strictEqual(original.journals[0].entries[0].text, "hi");
});

// ---------- isPristine ----------

test("isPristine is true for the default fresh document", () => {
  assert.strictEqual(isPristine(pristineDoc()), true);
});

test("isPristine is false once an entry exists", () => {
  assert.strictEqual(isPristine(doc([journal("j1", "Journal", [entry("t1", "hi")])])), false);
});

test("isPristine is false if the single journal isn't named 'Journal'", () => {
  assert.strictEqual(isPristine(doc([journal("j1", "My Diary", [])])), false);
});

test("isPristine is false with more than one journal", () => {
  assert.strictEqual(isPristine(doc([journal("j1", "Journal", []), journal("j2", "Other", [])])), false);
});

// ---------- journalCounts ----------

test("journalCounts sums entries across journals", () => {
  const d = doc([
    journal("j1", "A", [entry("t1", "x"), entry("t2", "y")]),
    journal("j2", "B", [entry("t3", "z")]),
  ]);
  assert.deepStrictEqual(journalCounts(d), { journals: 2, entries: 3 });
});

// ---------- syncPlan ----------

test("syncPlan: no remote, local not pristine -> push-new", () => {
  assert.strictEqual(syncPlan({ remoteAt: null, dirty: false }, null, false, false), "push-new");
});

test("syncPlan: no remote, local pristine -> noop (never seed an empty cloud row)", () => {
  assert.strictEqual(syncPlan({ remoteAt: null, dirty: false }, null, false, true), "noop");
});

test("syncPlan: first link, copies match -> adopt", () => {
  const remote = { updated_at: "2026-01-01T00:00:00.000Z", doc: pristineDoc() };
  assert.strictEqual(syncPlan({ remoteAt: null, dirty: false }, remote, true, false), "adopt");
});

test("syncPlan: first link, copies differ, local pristine -> pull (silent adopt of cloud)", () => {
  const remote = { updated_at: "2026-01-01T00:00:00.000Z", doc: doc([journal("j1", "Real", [])]) };
  assert.strictEqual(syncPlan({ remoteAt: null, dirty: false }, remote, false, true), "pull");
});

test("syncPlan: first link, copies differ, local NOT pristine -> choose", () => {
  const remote = { updated_at: "2026-01-01T00:00:00.000Z", doc: doc([journal("j1", "Real", [])]) };
  assert.strictEqual(syncPlan({ remoteAt: null, dirty: false }, remote, false, false), "choose");
});

test("syncPlan: unchanged on both sides -> noop", () => {
  const remote = { updated_at: "2026-01-01T00:00:00.000Z", doc: pristineDoc() };
  const meta = { remoteAt: "2026-01-01T00:00:00.000Z", dirty: false };
  assert.strictEqual(syncPlan(meta, remote, true, false), "noop");
});

test("syncPlan: same remote version, locally dirty -> push", () => {
  const remote = { updated_at: "2026-01-01T00:00:00.000Z", doc: pristineDoc() };
  const meta = { remoteAt: "2026-01-01T00:00:00.000Z", dirty: true };
  assert.strictEqual(syncPlan(meta, remote, false, false), "push");
});

test("syncPlan: remote moved on, nothing dirty here -> pull", () => {
  const remote = { updated_at: "2026-01-02T00:00:00.000Z", doc: pristineDoc() };
  const meta = { remoteAt: "2026-01-01T00:00:00.000Z", dirty: false };
  assert.strictEqual(syncPlan(meta, remote, false, false), "pull");
});

test("syncPlan: remote moved on AND locally dirty -> merge (never a plain replace)", () => {
  const remote = { updated_at: "2026-01-02T00:00:00.000Z", doc: pristineDoc() };
  const meta = { remoteAt: "2026-01-01T00:00:00.000Z", dirty: true };
  assert.strictEqual(syncPlan(meta, remote, false, false), "merge");
});

// ---------- mergeDocs ----------

test("mergeDocs: entry added only on local is kept", () => {
  const remote = doc([journal("j1", "J", [entry("t1", "a")])]);
  const local = doc([journal("j1", "J", [entry("t1", "a"), entry("t2", "local-only")])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  assert.deepStrictEqual(
    merged.journals[0].entries.map((e) => e.timestamp),
    ["t1", "t2"]
  );
});

test("mergeDocs: entry added only on remote is kept", () => {
  const local = doc([journal("j1", "J", [entry("t1", "a")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "a"), entry("t2", "remote-only")])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: false });
  assert.deepStrictEqual(
    merged.journals[0].entries.map((e) => e.timestamp),
    ["t1", "t2"]
  );
});

test("mergeDocs: entries added on both sides are both kept", () => {
  const local = doc([journal("j1", "J", [entry("t1", "a"), entry("t2", "local-only")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "a"), entry("t3", "remote-only")])]);
  const { doc: merged, stats } = mergeDocs(local, remote, { localNewer: true });
  assert.deepStrictEqual(
    merged.journals[0].entries.map((e) => e.timestamp),
    ["t1", "t2", "t3"]
  );
  assert.strictEqual(stats.entriesAdded, 2);
});

test("mergeDocs: same timestamp, same text -> no conflict, one copy kept", () => {
  const local = doc([journal("j1", "J", [entry("t1", "same")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "same")])]);
  const { doc: merged, stats, replaced } = mergeDocs(local, remote, { localNewer: true });
  assert.strictEqual(merged.journals[0].entries.length, 1);
  assert.strictEqual(stats.entryConflicts, 0);
  assert.strictEqual(replaced.length, 0);
});

test("mergeDocs: same timestamp, different text, localNewer=true -> local text wins", () => {
  const local = doc([journal("j1", "J", [entry("t1", "local-edit")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "remote-edit")])]);
  const { doc: merged, replaced, stats } = mergeDocs(local, remote, { localNewer: true });
  assert.strictEqual(merged.journals[0].entries[0].text, "local-edit");
  assert.strictEqual(stats.entryConflicts, 1);
  assert.strictEqual(replaced[0].text, "remote-edit");
  assert.strictEqual(replaced[0].from, "cloud");
});

test("mergeDocs: same timestamp, different text, localNewer=false -> remote text wins", () => {
  const local = doc([journal("j1", "J", [entry("t1", "local-edit")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "remote-edit")])]);
  const { doc: merged, replaced } = mergeDocs(local, remote, { localNewer: false });
  assert.strictEqual(merged.journals[0].entries[0].text, "remote-edit");
  assert.strictEqual(replaced[0].text, "local-edit");
  assert.strictEqual(replaced[0].from, "device");
});

test("mergeDocs: journal added only on one side is kept (union of journals)", () => {
  const local = doc([journal("j1", "J1", []), journal("j2", "Local Only", [])]);
  const remote = doc([journal("j1", "J1", [])]);
  const { doc: merged, stats } = mergeDocs(local, remote, { localNewer: true });
  assert.strictEqual(merged.journals.length, 2);
  assert(merged.journals.some((j) => j.id === "j2"));
  assert.strictEqual(stats.journalsAdded, 0); // j2 came from the winner (local), not appended from the loser
});

test("mergeDocs: journal added only on the loser side counts as journalsAdded", () => {
  const local = doc([journal("j1", "J1", [])]);
  const remote = doc([journal("j1", "J1", []), journal("j2", "Remote Only", [])]);
  const { doc: merged, stats } = mergeDocs(local, remote, { localNewer: true }); // local is winner, remote is loser
  assert.strictEqual(merged.journals.length, 2);
  assert.strictEqual(stats.journalsAdded, 1);
});

test("mergeDocs: same journal renamed differently on both sides -> newer name wins, other recorded", () => {
  const local = doc([journal("j1", "Local Name", [])]);
  const remote = doc([journal("j1", "Remote Name", [])]);
  const { doc: merged, replaced, stats } = mergeDocs(local, remote, { localNewer: true });
  assert.strictEqual(merged.journals[0].name, "Local Name");
  assert.strictEqual(stats.renamed, 1);
  assert.strictEqual(replaced[0].kind, "journal-name");
  assert.strictEqual(replaced[0].text, "Remote Name");
});

test("mergeDocs: journals in different orders -> winner's order wins", () => {
  const local = doc([journal("j2", "Second", []), journal("j1", "First", [])]);
  const remote = doc([journal("j1", "First", []), journal("j2", "Second", [])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  assert.deepStrictEqual(merged.journals.map((j) => j.id), ["j2", "j1"]);
});

test("mergeDocs: unknown extra fields on journals and entries are preserved", () => {
  const local = doc([
    Object.assign(journal("j1", "J", [entry("t1", "a", { mood: "calm" })]), { color: "blue" }),
  ]);
  const remote = doc([journal("j1", "J", [])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  assert.strictEqual(merged.journals[0].color, "blue");
  assert.strictEqual(merged.journals[0].entries[0].mood, "calm");
});

test("mergeDocs: empty entries arrays on both sides produce an empty merged journal", () => {
  const local = doc([journal("j1", "J", [])]);
  const remote = doc([journal("j1", "J", [])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  assert.deepStrictEqual(merged.journals[0].entries, []);
});

test("mergeDocs: large journal merges correctly (performance sanity)", () => {
  const localEntries = [];
  const remoteEntries = [];
  for (let i = 0; i < 3000; i++) {
    const ts = "2026-01-01T00:00:" + String(i % 60).padStart(2, "0") + "." + String(i).padStart(6, "0") + "Z";
    localEntries.push(entry(ts, "local-" + i));
  }
  for (let i = 3000; i < 6000; i++) {
    const ts = "2026-01-01T00:00:" + String(i % 60).padStart(2, "0") + "." + String(i).padStart(6, "0") + "Z";
    remoteEntries.push(entry(ts, "remote-" + i));
  }
  const local = doc([journal("j1", "Big", localEntries)]);
  const remote = doc([journal("j1", "Big", remoteEntries)]);
  const start = Date.now();
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  const elapsed = Date.now() - start;
  assert.strictEqual(merged.journals[0].entries.length, 6000);
  assert(elapsed < 2000, "merge of 6000 entries took " + elapsed + "ms, expected well under 2000ms");
});

test("mergeDocs: merged entries are sorted ascending by timestamp", () => {
  const local = doc([journal("j1", "J", [entry("t3", "c"), entry("t1", "a")])]);
  const remote = doc([journal("j1", "J", [entry("t2", "b")])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  assert.deepStrictEqual(
    merged.journals[0].entries.map((e) => e.timestamp),
    ["t1", "t2", "t3"]
  );
});

test("mergeDocs: deletion is NOT propagated — a concurrently-deleted entry reappears (union-only, decided 2026-10-12)", () => {
  // local deleted t2 (which existed at the last sync); remote still has it plus its own new entry t3.
  const local = doc([journal("j1", "J", [entry("t1", "a")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "a"), entry("t2", "b"), entry("t3", "c")])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: false });
  assert.deepStrictEqual(
    merged.journals[0].entries.map((e) => e.timestamp),
    ["t1", "t2", "t3"],
    "t2 should reappear since a merge never deletes"
  );
});

test("mergeDocs: throws on an invalid remote doc and changes nothing", () => {
  const local = doc([journal("j1", "J", [])]);
  assert.throws(() => mergeDocs(local, { journals: [] }, { localNewer: true }), /bad-remote-doc/);
});

test("mergeDocs: throws on an invalid local doc", () => {
  const remote = doc([journal("j1", "J", [])]);
  assert.throws(() => mergeDocs({ journals: "nope" }, remote, { localNewer: true }), /bad-remote-doc/);
});

// ---------- Required properties ----------

function sameDoc(a, b) {
  return canonJSON(a) === canonJSON(b);
}

test("property: no loss — every entry timestamp from either input appears in the output", () => {
  const local = doc([journal("j1", "J", [entry("t1", "a"), entry("t2", "local-only")])]);
  const remote = doc([journal("j1", "J", [entry("t1", "a"), entry("t3", "remote-only")])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  const ts = new Set(merged.journals[0].entries.map((e) => e.timestamp));
  assert(ts.has("t1") && ts.has("t2") && ts.has("t3"));
});

test("property: no loss — every journal id from either input appears in the output", () => {
  const local = doc([journal("j1", "A", []), journal("j2", "Local Only", [])]);
  const remote = doc([journal("j1", "A", []), journal("j3", "Remote Only", [])]);
  const { doc: merged } = mergeDocs(local, remote, { localNewer: true });
  const ids = new Set(merged.journals.map((j) => j.id));
  assert(ids.has("j1") && ids.has("j2") && ids.has("j3"));
});

test("property: idempotent — merge(merge(a, b), b) equals merge(a, b)", () => {
  const a = doc([journal("j1", "A", [entry("t1", "a1"), entry("t2", "a2")])]);
  const b = doc([journal("j1", "A", [entry("t2", "b2-conflict"), entry("t3", "b3")])]);
  const m = mergeDocs(a, b, { localNewer: true }).doc;
  const m2 = mergeDocs(m, b, { localNewer: true }).doc;
  assert(sameDoc(m, m2));
});

test("property: idempotent — merge(m, a) equals m when m = merge(a, b)", () => {
  const a = doc([journal("j1", "A", [entry("t1", "a1"), entry("t2", "a2")])]);
  const b = doc([journal("j1", "A", [entry("t2", "b2-conflict"), entry("t3", "b3")])]);
  const m = mergeDocs(a, b, { localNewer: true }).doc;
  const m2 = mergeDocs(m, a, { localNewer: true }).doc;
  assert(sameDoc(m, m2));
});

test("property: commutative up to tie-breaks — swapping local/remote with the matching localNewer flip gives the same doc", () => {
  const a = doc([journal("j1", "A", [entry("t1", "a1"), entry("t2", "a2-conflict")])]);
  const b = doc([journal("j1", "A", [entry("t2", "b2-conflict"), entry("t3", "b3")])]);
  const m1 = mergeDocs(a, b, { localNewer: true }).doc; // a is "local" and newer
  const m2 = mergeDocs(b, a, { localNewer: false }).doc; // same a is newer, now passed as "remote"
  assert(sameDoc(m1, m2));
});

test("property: single-sided change untouched — merge(a, a) equals a", () => {
  const a = doc([journal("j1", "A", [entry("t1", "a1"), entry("t2", "a2")])]);
  const m = mergeDocs(a, a, { localNewer: true }).doc;
  assert(sameDoc(m, a));
});

test("property: single-sided change untouched — merging with a doc that only added entries equals the superset", () => {
  const a = doc([journal("j1", "A", [entry("t1", "a1")])]);
  const bOnlyAdds = doc([journal("j1", "A", [entry("t1", "a1"), entry("t2", "new")])]);
  const m = mergeDocs(a, bOnlyAdds, { localNewer: false }).doc; // remote (b) is newer, it only added
  assert(sameDoc(m, bOnlyAdds));
});

// ---------- Randomized property test over generated docs ----------
// Deterministic PRNG (mulberry32) so a failure is reproducible from the printed seed.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDoc(rng, journalIds, timestampPool) {
  const journals = journalIds
    .filter(() => rng() > 0.2) // this side is missing some journals entirely
    .map((jid) => {
      const entries = timestampPool
        .filter(() => rng() > 0.4) // and some entries within a journal it does have
        .map((ts) => entry(ts, jid + "-" + ts + "-" + Math.floor(rng() * 1000)));
      return journal(jid, "Journal " + jid, entries);
    });
  return doc(journals.length ? journals : [journal(journalIds[0], "Journal " + journalIds[0], [])]);
}

test("randomized property: no-loss and idempotence hold across many generated doc pairs", () => {
  const journalIds = ["j1", "j2", "j3"];
  const timestampPool = ["t1", "t2", "t3", "t4", "t5", "t6"];
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    const a = randomDoc(rng, journalIds, timestampPool);
    const b = randomDoc(rng, journalIds, timestampPool);
    const localNewer = rng() > 0.5;
    let m;
    try {
      m = mergeDocs(a, b, { localNewer });
    } catch (e) {
      throw new Error("seed " + seed + " threw: " + e.message);
    }

    // no-loss: every (journalId, timestamp) pair present on either side survives.
    for (const side of [a, b]) {
      for (const j of side.journals) {
        assert(
          m.doc.journals.some((mj) => mj.id === j.id),
          "seed " + seed + ": journal " + j.id + " lost"
        );
        const mj = m.doc.journals.find((mj) => mj.id === j.id);
        const mts = new Set(mj.entries.map((e) => e.timestamp));
        for (const e of j.entries) {
          assert(mts.has(e.timestamp), "seed " + seed + ": entry " + j.id + "/" + e.timestamp + " lost");
        }
      }
    }

    // idempotent: merging the result with either original input again changes nothing.
    const again1 = mergeDocs(m.doc, a, { localNewer: true }).doc;
    assert(sameDoc(m.doc, again1), "seed " + seed + ": merge(m, a) !== m");
    const again2 = mergeDocs(m.doc, b, { localNewer: true }).doc;
    assert(sameDoc(m.doc, again2), "seed " + seed + ": merge(m, b) !== m");
  }
});

console.log(passed + " tests passed");
