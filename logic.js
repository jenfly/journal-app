/* ---------- Pure sync/merge logic (no DOM) ----------
   doc shape: { journals: [ { id, name, entries: [ { timestamp, text } ] } ] }
   id: string, unique per journal, generated only when a journal is created.
   timestamp: ISO string, both an entry's display time and its merge key — never changes once set.

   This file has no DOM access and no localStorage access, so it can be loaded directly in
   Node for tests (see tests/test.js) as well as in the browser (loaded before sync.js, which
   is loaded before app.js — see index.html). */

// A doc that fails this is REJECTED outright (never "repaired" by dropping items — dropping
// is data loss). journals must be a non-empty array; every journal needs a string id/name and
// an entries array; every entry needs a string timestamp and string text.
function validDoc(d) {
  if (!d || !Array.isArray(d.journals) || d.journals.length === 0) return false;
  for (const j of d.journals) {
    if (!j || typeof j.id !== "string" || typeof j.name !== "string" || !Array.isArray(j.entries)) {
      return false;
    }
    for (const e of j.entries) {
      if (!e || typeof e.timestamp !== "string" || typeof e.text !== "string") return false;
    }
  }
  return true;
}

// Key-order-independent text form of a JSON value (Postgres jsonb does not keep key order).
function canonJSON(v) {
  if (Array.isArray(v)) return "[" + v.map(canonJSON).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonJSON(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

// Deep copy, preserving unknown/extra fields on journals and entries.
function normalizeDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

// A freshly-created, never-touched document: exactly one journal named "Journal" with no
// entries. Two pristine devices have different journal ids (generated per device), so a
// pristine local doc must never be pushed or merged — see syncPlan and the doc's
// "Pristine-document rule".
function isPristine(doc) {
  return (
    !!doc &&
    Array.isArray(doc.journals) &&
    doc.journals.length === 1 &&
    doc.journals[0].name === "Journal" &&
    Array.isArray(doc.journals[0].entries) &&
    doc.journals[0].entries.length === 0
  );
}

function journalCounts(doc) {
  const journals = doc.journals.length;
  const entries = doc.journals.reduce((n, j) => n + j.entries.length, 0);
  return { journals, entries };
}

/* ---------- Cloud sync decision (pure) ----------
   meta         = { userId, remoteAt, dirty, editedAt, syncedAt } for this device, persisted locally
   remote       = null (no cloud copy yet) or { updated_at, doc }
   same         = the cloud doc and the local state hold identical content (canonJSON compare)
   localPristine = isPristine(local) — see isPristine above
   Returns what the sync pass should do:
     noop       nothing changed anywhere (or: no cloud row, and local is pristine — nothing to seed)
     push-new   no cloud copy, local is not pristine: create the cloud copy from this device
     adopt      first link and both copies already match: just record the cloud version
     pull       first link, local is pristine, cloud has a row: adopt the cloud copy silently
                OR: only the cloud changed since the last sync: exact replace is correct
     choose     first link, copies differ, local is NOT pristine: ask the user which to keep (or merge)
     push       only this device changed: update the cloud copy
     merge      both this device and the cloud changed since the last sync: never replace, always merge */
function syncPlan(meta, remote, same, localPristine) {
  if (!remote) return localPristine ? "noop" : "push-new";
  if (!meta.remoteAt) {
    if (same) return "adopt";
    return localPristine ? "pull" : "choose";
  }
  if (remote.updated_at === meta.remoteAt) return meta.dirty ? "push" : "noop";
  if (!meta.dirty) return "pull";
  return "merge";
}

/* ---------- Merge on conflict (the part not to improvise — see the design doc's
   "Merge on conflict" section for the full rules this implements) ----------
   mergeDocs(local, remote, { localNewer }) -> { doc, replaced, stats }

   - Journals are matched by id; the result is the union of both sides' journals.
   - Entries are matched by timestamp within a journal; the result is the union of both
     sides' entries (deletions are never propagated by a merge — union-only, decided 2026-10-12).
   - When the same journal id or entry timestamp exists on both sides with different content,
     the NEWER side (per opts.localNewer) wins for that one piece, and the losing piece is
     recorded in `replaced` for the pre-sync safety record.
   - Unknown/extra fields on journals and entries are preserved (spread, not rebuilt).
   - Merged entries within a journal are sorted ascending by timestamp (deterministic output).
   Throws 'bad-remote-doc' if either input fails validDoc, and 'bad-merge-result' if the
   combined output somehow fails validDoc — callers must change nothing in either case. */
function mergeDocs(local, remote, opts) {
  if (!validDoc(local) || !validDoc(remote)) throw new Error("bad-remote-doc");

  const localNewer = !!(opts && opts.localNewer);
  const winner = localNewer ? local : remote;
  const loser = localNewer ? remote : local;
  const loserSide = localNewer ? "cloud" : "device";
  const replaced = [];
  const stats = { journalsAdded: 0, entriesAdded: 0, entryConflicts: 0, renamed: 0 };

  const loserById = new Map(loser.journals.map((j) => [j.id, j]));
  const seen = new Set();
  const out = [];

  for (const wj of winner.journals) {
    seen.add(wj.id);
    const lj = loserById.get(wj.id);
    out.push(lj ? mergeJournal(wj, lj) : cloneJournal(wj));
  }
  for (const lj of loser.journals) {
    if (seen.has(lj.id)) continue;
    stats.journalsAdded++;
    out.push(cloneJournal(lj));
  }

  const doc = Object.assign({}, winner, { journals: out });
  if (!validDoc(doc)) throw new Error("bad-merge-result");
  return { doc, replaced, stats };

  function cloneJournal(j) {
    return Object.assign({}, j, { entries: j.entries.map((e) => Object.assign({}, e)) });
  }

  function mergeJournal(wj, lj) {
    if (wj.name !== lj.name) {
      replaced.push({ kind: "journal-name", journalId: wj.id, text: lj.name, from: loserSide });
      stats.renamed++;
    }
    const wMap = new Map(wj.entries.map((e) => [e.timestamp, e]));
    const lMap = new Map(lj.entries.map((e) => [e.timestamp, e]));
    const allTs = new Set([...wMap.keys(), ...lMap.keys()]);
    const merged = [];
    for (const ts of allTs) {
      const we = wMap.get(ts);
      const le = lMap.get(ts);
      if (we && le) {
        if (we.text !== le.text) {
          replaced.push({ kind: "entry", journalId: wj.id, timestamp: ts, text: le.text, from: loserSide });
          stats.entryConflicts++;
        }
        merged.push(Object.assign({}, we));
      } else if (we) {
        merged.push(Object.assign({}, we));
        stats.entriesAdded++;
      } else {
        merged.push(Object.assign({}, le));
        stats.entriesAdded++;
      }
    }
    merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return Object.assign({}, wj, { entries: merged });
  }
}

if (typeof module !== "undefined") {
  module.exports = { validDoc, canonJSON, normalizeDoc, isPristine, journalCounts, syncPlan, mergeDocs };
}
