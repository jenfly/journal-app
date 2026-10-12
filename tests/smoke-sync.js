// Cloud sync (sync.js) against a fake in-memory Supabase: no real network, no real Google
// sign-in — sessions are seeded straight into localStorage (mirrors signing in on a device),
// and window.fetch is a stand-in for Supabase Auth's /auth/v1/token and PostgREST's
// /rest/v1/app_data. Loads only logic.js + sync.js (not the full app.js/UI). Run from this
// directory: `NODE_PATH=<path to a jsdom install> node smoke-sync.js` (jsdom is a dev-only
// tool dependency, not installed in the repo itself — see CLAUDE.md for the exact command).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const assert = require("assert");

const logicSrc = fs
  .readFileSync("../logic.js", "utf8")
  .split("\n")
  .filter((l) => l.indexOf("if (typeof module") !== 0)
  .join("\n");
const syncSrc = fs.readFileSync("../sync.js", "utf8");
const PAGE = "<!doctype html><html><body><script>" + logicSrc + "</script><script>" + syncSrc + "</script></body></html>";

const SESSION_KEY = "jenfly-supabase-auth",
  APP_KEY = "journal_app_v1";

function boot(setup) {
  return new JSDOM(PAGE, {
    runScripts: "dangerously",
    url: "https://example.com/",
    beforeParse(w) {
      w.scrollTo = () => {};
      setup(w);
    },
  });
}
function seedSession(win, user, overrides) {
  const s = Object.assign(
    { access_token: "tok-" + user.id, refresh_token: "ref-" + user.id, expires_at: Date.now() + 3600000, user },
    overrides || {}
  );
  win.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}
function seedMeta(win, meta) {
  win.localStorage.setItem(APP_KEY + ":sync-meta", JSON.stringify(meta));
}
function readMeta(win) {
  const v = win.localStorage.getItem(APP_KEY + ":sync-meta");
  return v ? JSON.parse(v) : null;
}
function readPreSync(win) {
  const v = win.localStorage.getItem(APP_KEY + ":pre-sync-copy");
  return v ? JSON.parse(v) : null;
}
function makeCfg(initial) {
  const h = { state: initial, applied: [], pulled: 0, merged: [], errors: [], statuses: [], busy: false };
  h.cfg = {
    key: APP_KEY,
    getState: () => h.state,
    applyState(doc) {
      h.state = JSON.parse(JSON.stringify(doc));
      h.applied.push(doc);
    },
    busy: () => h.busy,
    onChange(st) {
      h.statuses.push(st);
    },
    onError(msg) {
      h.errors.push(msg);
    },
    onPulled() {
      h.pulled++;
    },
    onMerged(stats) {
      h.merged.push(stats);
    },
  };
  return h;
}

// ---------- doc builders ----------
function journal(id, name, entries) {
  return { id, name, entries: entries || [] };
}
function entry(ts, text) {
  return { timestamp: ts, text };
}
function doc(journals) {
  return { journals };
}
function pristineDoc(id) {
  return doc([journal(id || "j0", "Journal", [])]);
}

// ---------- fake Supabase ----------
function makeDb() {
  return { row: null, clock: 0, refreshCalls: 0, tokenSeq: 0, failAuthOnce: false, deferPatch: false, raceOnce: false, raceDoc: null, offlineOnPatch: false, user: null };
}
function nextTs(db) {
  db.clock++;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, db.clock)).toISOString();
}
function resp(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body === undefined ? null : body),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  });
}
function query(url) {
  const q = {},
    qi = url.indexOf("?");
  if (qi < 0) return q;
  url
    .slice(qi + 1)
    .split("&")
    .forEach((p) => {
      const kv = p.split("=");
      q[kv[0]] = kv[1] !== undefined ? decodeURIComponent(kv[1]) : "";
    });
  return q;
}
function makeFetch(db) {
  return function (url, init) {
    init = init || {};
    const method = init.method || "GET";
    if (url.indexOf("/auth/v1/token") >= 0) {
      const q = query(url);
      db.refreshCalls++;
      if (q.grant_type === "refresh_token") {
        db.tokenSeq++;
        return resp(200, { access_token: "access-" + db.tokenSeq, refresh_token: "refresh-" + db.tokenSeq, expires_in: 3600, user: db.user });
      }
      return resp(400, { error: "unsupported_grant_type" });
    }
    if (url.indexOf("/rest/v1/app_data") >= 0) {
      if (db.failAuthOnce) {
        db.failAuthOnce = false;
        return resp(401, { message: "JWT expired" });
      }
      if (method === "GET") return resp(200, db.row ? [{ doc: db.row.doc, updated_at: db.row.updated_at }] : []);
      if (method === "POST") {
        if (db.row) return resp(409, { message: "duplicate key value violates unique constraint" });
        const body1 = JSON.parse(init.body);
        db.row = { doc: body1.doc, updated_at: nextTs(db) };
        return resp(201, [{ doc: db.row.doc, updated_at: db.row.updated_at }]);
      }
      if (method === "PATCH") {
        if (db.offlineOnPatch) {
          db.offlineOnPatch = false;
          const Err = db.TypeError || TypeError;
          return Promise.reject(new Err("Failed to fetch"));
        }
        if (db.raceOnce) {
          db.raceOnce = false;
          db.row = { doc: db.raceDoc || db.row.doc, updated_at: nextTs(db) }; // another device's write lands first
        }
        const q2 = query(url),
          expected = q2.updated_at ? q2.updated_at.replace(/^eq\./, "") : null;
        const body2 = JSON.parse(init.body);
        const settle = () => {
          if (!db.row || db.row.updated_at !== expected) return resp(200, []);
          db.row = { doc: body2.doc, updated_at: nextTs(db) };
          return resp(200, [{ doc: db.row.doc, updated_at: db.row.updated_at }]);
        };
        if (db.deferPatch) {
          return new Promise((resolveFetch) => {
            db._resolvePatch = () => {
              settle().then(resolveFetch);
            };
            if (db.onPatchStarted) db.onPatchStarted();
          });
        }
        return settle();
      }
    }
    return resp(404, { message: "not found" });
  };
}

// ---------- scenarios ----------
async function scenario1() {
  const db = makeDb();
  db.user = { id: "u1", email: "a@example.com" };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const localDoc = doc([journal("j1", "Journal", [entry("t1", "hello")])]);
  const h = makeCfg(localDoc);
  await win.Sync.init(h.cfg);
  assert(db.row, "push-new should have created the cloud row");
  assert.deepStrictEqual(db.row.doc, h.state);
  const meta = readMeta(win);
  assert.strictEqual(meta.dirty, false);
  assert.strictEqual(meta.remoteAt, db.row.updated_at);
  assert.strictEqual(win.Sync.status().phase, "idle");
  win.close();
  console.log("scenario 1 (first push seeds the cloud from a non-pristine local doc) ok");
}

async function scenario2() {
  const db = makeDb();
  db.user = { id: "u1", email: "b@example.com" };
  const cloudDoc = doc([journal("jc", "Real Journal", [entry("t1", "from cloud")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(pristineDoc("j-local"));
  await win.Sync.init(h.cfg);
  assert.strictEqual(win.Sync.status().phase, "idle", "should adopt silently, no choose prompt");
  assert.deepStrictEqual(h.state, cloudDoc, "pristine local should silently pull the cloud copy");
  assert.strictEqual(h.pulled, 1);
  const meta = readMeta(win);
  assert.strictEqual(meta.dirty, false);
  assert.strictEqual(meta.remoteAt, db.row.updated_at);
  win.close();
  console.log("scenario 2 (pristine local + existing cloud row -> silent pull, no prompt) ok");
}

async function scenario3() {
  const db = makeDb();
  db.user = { id: "u1", email: "c@example.com" };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(pristineDoc("j-local"));
  await win.Sync.init(h.cfg);
  assert.strictEqual(db.row, null, "a pristine local doc must never seed an empty cloud row");
  assert.strictEqual(h.applied.length, 0);
  const meta = readMeta(win);
  assert.strictEqual(meta.remoteAt, null);
  assert.strictEqual(win.Sync.status().phase, "idle");
  win.close();
  console.log("scenario 3 (pristine local, no cloud row -> noop, nothing pushed) ok");
}

async function scenario4a() {
  const db = makeDb();
  db.user = { id: "u1", email: "d1@example.com" };
  const cloudDoc = doc([journal("jc", "Cloud", [entry("t1", "cloud-entry")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const localDoc = doc([journal("jl", "Device", [entry("t2", "device-entry")])]);
  const h = makeCfg(localDoc);
  await win.Sync.init(h.cfg);
  const st = win.Sync.status();
  assert.strictEqual(st.phase, "choose");
  // st.choice is a plain object literal from inside sync.js's own realm, so compare fields
  // individually rather than via deepStrictEqual (which also checks prototype identity).
  assert.strictEqual(st.choice.cloud.journals, 1);
  assert.strictEqual(st.choice.cloud.entries, 1);
  assert.strictEqual(st.choice.device.journals, 1);
  assert.strictEqual(st.choice.device.entries, 1);
  await win.Sync.resolveChoice("cloud");
  assert.deepStrictEqual(h.state, cloudDoc, "choosing cloud should adopt it locally");
  assert.strictEqual(h.pulled, 1);
  assert.strictEqual(readPreSync(win).which, "device", "the replaced local copy is saved once");
  assert.strictEqual(win.Sync.status().phase, "idle");
  win.close();
  console.log("scenario 4a (first-link choose: use cloud copy) ok");
}

async function scenario4b() {
  const db = makeDb();
  db.user = { id: "u1", email: "d2@example.com" };
  const cloudDoc = doc([journal("jc", "Cloud", [entry("t1", "cloud-entry")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const localDoc = doc([journal("jl", "Device", [entry("t2", "device-entry")])]);
  const h = makeCfg(localDoc);
  await win.Sync.init(h.cfg);
  assert.strictEqual(win.Sync.status().phase, "choose");
  await win.Sync.resolveChoice("device");
  assert.deepStrictEqual(db.row.doc, localDoc, "choosing this device should push it, overwriting the cloud");
  assert.strictEqual(h.applied.length, 0, "local state itself is untouched");
  assert.strictEqual(readPreSync(win).which, "cloud", "the replaced cloud copy is saved once");
  win.close();
  console.log("scenario 4b (first-link choose: keep this device's copy) ok");
}

async function scenario4c() {
  const db = makeDb();
  db.user = { id: "u1", email: "d3@example.com" };
  const cloudDoc = doc([journal("jshared", "Shared", [entry("t1", "cloud-entry")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const localDoc = doc([journal("jshared", "Shared", [entry("t2", "device-entry")])]); // same journal id
  const h = makeCfg(localDoc);
  await win.Sync.init(h.cfg);
  assert.strictEqual(win.Sync.status().phase, "choose");
  await win.Sync.resolveChoice("merge");
  assert.strictEqual(h.applied.length, 1, "merge applies the merged doc locally");
  const mergedTs = h.state.journals[0].entries.map((e) => e.timestamp).sort();
  assert.deepStrictEqual(mergedTs, ["t1", "t2"], "merge must keep entries from both sides, never discard");
  assert.deepStrictEqual(db.row.doc, h.state, "the merged doc should have been pushed to the cloud");
  assert.strictEqual(h.merged.length, 1, "onMerged should fire once");
  assert.strictEqual(readPreSync(win).which, "merge");
  assert.strictEqual(readMeta(win).dirty, false);
  win.close();
  console.log("scenario 4c (first-link choose: merge both) ok");
}

async function scenario5() {
  const db = makeDb();
  db.user = { id: "u1", email: "e@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "original")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt (same content)
  assert.strictEqual(readMeta(win).dirty, false);
  h.state = doc([journal("j1", "Journal", [entry("t1", "original"), entry("t2", "added locally")])]);
  win.Sync.noteLocalChange();
  await win.Sync.syncNow();
  assert.deepStrictEqual(db.row.doc, h.state, "the local edit should have been pushed");
  assert.strictEqual(readMeta(win).dirty, false);
  win.close();
  console.log("scenario 5 (push after a local edit) ok");
}

async function scenario6() {
  const db = makeDb();
  db.user = { id: "u1", email: "f@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "original")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt
  const doc1 = doc([journal("j1", "Journal", [entry("t1", "original"), entry("t2", "from another device")])]);
  db.row = { doc: doc1, updated_at: nextTs(db) }; // another device changed the cloud copy; nothing dirty here
  await win.Sync.syncNow();
  assert.deepStrictEqual(h.state, doc1, "the pull should replace local with the newer remote doc");
  assert.strictEqual(h.pulled, 1);
  win.close();
  console.log("scenario 6 (pull after a remote edit, nothing dirty locally) ok");
}

async function scenario7() {
  const db = makeDb();
  db.user = { id: "u1", email: "g@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "shared base")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: new Date(Date.now() - 300000).toISOString() };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt

  // This device edits t1's text and adds t2 (dirty, editedAt = now).
  h.state = doc([journal("j1", "Journal", [entry("t1", "edited on this device"), entry("t2", "from this device")])]);
  win.Sync.noteLocalChange();

  // The cloud moved on before this device's edit (so this device is newer and should win the
  // t1 tie-break), and it independently added t3.
  const cloudDoc = doc([journal("j1", "Journal", [entry("t1", "edited on another device"), entry("t3", "from another device")])]);
  db.row = { doc: cloudDoc, updated_at: new Date(Date.now() - 100000).toISOString() };

  await win.Sync.syncNow();

  const j = h.state.journals[0];
  const byTs = {};
  j.entries.forEach((e) => (byTs[e.timestamp] = e.text));
  assert.deepStrictEqual(Object.keys(byTs).sort(), ["t1", "t2", "t3"], "merge must keep entries added on both sides, plus the conflicting one");
  assert.strictEqual(byTs.t1, "edited on this device", "the newer (local) edit should win the tie on t1");
  assert.deepStrictEqual(db.row.doc, h.state, "the merged doc should have been pushed with compare-and-swap");
  assert.strictEqual(readMeta(win).dirty, false);
  assert.strictEqual(h.merged.length, 1);
  assert.strictEqual(h.merged[0].entryConflicts, 1);
  const pre = readPreSync(win);
  assert.strictEqual(pre.which, "merge");
  assert.strictEqual(pre.replaced[0].text, "edited on another device");
  win.close();
  console.log("scenario 7 (concurrent edits incl. a same-entry conflict -> merge, newer wins tie, pushed with CAS) ok");
}

async function scenario8() {
  const db = makeDb();
  db.user = { id: "u1", email: "h@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "base")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: new Date(Date.now() - 300000).toISOString() };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt

  h.state = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t2", "local add")])]);
  win.Sync.noteLocalChange();

  const cloudDocBeforeRace = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t3", "remote add")])]);
  db.row = { doc: cloudDocBeforeRace, updated_at: new Date(Date.now() - 100000).toISOString() };

  // Simulate a third device's write landing exactly as our merge's push arrives: the
  // compare-and-swap misses, `again` fires, and the next pass must fetch the new remote and
  // re-merge (idempotently) rather than lose the third device's write.
  db.raceOnce = true;
  db.raceDoc = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t3", "remote add"), entry("t4", "third device add")])]);

  await win.Sync.syncNow();

  const ts = h.state.journals[0].entries.map((e) => e.timestamp).sort();
  assert.deepStrictEqual(ts, ["t1", "t2", "t3", "t4"], "the retried merge must still include every side, including the racing third write");
  assert.deepStrictEqual(db.row.doc, h.state);
  assert.strictEqual(readMeta(win).dirty, false);
  assert(h.merged.length >= 2, "merge should have run at least twice (lost the CAS once, retried)");
  win.close();
  console.log("scenario 8 (merge retried after a compare-and-swap loss, converges) ok");
}

async function scenario9() {
  const db = makeDb();
  db.user = { id: "u1", email: "i@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "base")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt

  h.state = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t2", "local add")])]);
  win.Sync.noteLocalChange();

  const cloudDoc = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t3", "remote add")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };

  h.busy = true;
  await win.Sync.syncNow();
  assert.strictEqual(h.applied.length, 0, "a merge must be deferred while the UI is mid-edit");
  assert.strictEqual(h.merged.length, 0);

  h.busy = false;
  await win.Sync.syncNow();
  assert.strictEqual(h.applied.length, 1);
  const ts = h.state.journals[0].entries.map((e) => e.timestamp).sort();
  assert.deepStrictEqual(ts, ["t1", "t2", "t3"]);
  win.close();
  console.log("scenario 9 (merge deferred while busy, proceeds once free) ok");
}

async function scenario10() {
  const db = makeDb();
  db.user = { id: "u1", email: "j@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "base")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    db.TypeError = w.TypeError;
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt

  h.state = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t2", "local add")])]);
  win.Sync.noteLocalChange();
  const cloudDoc = doc([journal("j1", "Journal", [entry("t1", "base"), entry("t3", "remote add")])]);
  db.row = { doc: cloudDoc, updated_at: nextTs(db) };

  db.offlineOnPatch = true;
  await win.Sync.syncNow();
  assert.strictEqual(win.Sync.status().phase, "offline", "the failed push should read as offline, not a generic error");
  assert.strictEqual(h.applied.length, 1, "the merge is applied locally even though the push has not succeeded yet");
  assert.strictEqual(readMeta(win).dirty, true, "still dirty — the push has not gone through");

  await win.Sync.syncNow(); // connectivity recovers
  assert.strictEqual(win.Sync.status().phase, "idle");
  assert.strictEqual(readMeta(win).dirty, false);
  assert.deepStrictEqual(db.row.doc, h.state);
  win.close();
  console.log("scenario 10 (merge push fails offline, then recovers) ok");
}

async function scenario11() {
  const db = makeDb();
  db.user = { id: "u1", email: "k@example.com" };
  const doc0 = doc([journal("j1", "Journal", [])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  db.failAuthOnce = true; // the very first REST call looks expired even though the session says otherwise
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg);
  assert.strictEqual(db.refreshCalls, 1, "a 401 should trigger exactly one token refresh");
  const sess = JSON.parse(win.localStorage.getItem(SESSION_KEY));
  assert.strictEqual(sess.access_token, "access-1", "the refreshed token should now be stored");
  assert.strictEqual(win.Sync.status().phase, "idle");
  assert.strictEqual(readMeta(win).dirty, false);
  win.close();
  console.log("scenario 11 (401 on a stale token, then refresh and retry) ok");
}

async function scenario12() {
  const db = makeDb();
  db.user = { id: "u1", email: "l@example.com" };
  const doc0 = doc([journal("j1", "Journal", [])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt

  h.state = doc([journal("j1", "Journal", [entry("t1", "edit1")])]);
  win.Sync.noteLocalChange();
  db.deferPatch = true;
  const patchStarted = new Promise((res) => {
    db.onPatchStarted = res;
  });
  const p = win.Sync.syncNow();
  await patchStarted; // the push for edit1 is now in flight, held open

  h.state = doc([journal("j1", "Journal", [entry("t1", "edit1"), entry("t2", "edit2")])]); // lands mid-request
  win.Sync.noteLocalChange();

  db.deferPatch = false;
  db._resolvePatch();
  await p;

  assert.deepStrictEqual(db.row.doc, doc([journal("j1", "Journal", [entry("t1", "edit1")])]), "the push should only have carried edit1 (the snapshot taken before edit2)");
  assert.strictEqual(readMeta(win).dirty, true, "edit2 happened after the snapshot, so it must still be marked unsynced");

  await win.Sync.syncNow(); // the next pass picks up edit2
  assert.deepStrictEqual(db.row.doc, h.state);
  assert.strictEqual(readMeta(win).dirty, false);
  win.close();
  console.log("scenario 12 (a local edit lands while a push is in flight, stays dirty) ok");
}

async function scenario13() {
  const db = makeDb();
  db.user = { id: "u_new", email: "new@example.com" };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
    seedMeta(w, { userId: "u_old", remoteAt: "2026-01-01T00:00:00.000Z", dirty: false, editedAt: null, syncedAt: Date.now() });
  });
  const win = dom.window;
  const h = makeCfg(doc([journal("j1", "Journal", [entry("t1", "device data for new user")])]));
  await win.Sync.init(h.cfg);
  const meta = readMeta(win);
  assert.strictEqual(meta.userId, "u_new", "meta should rebind to the newly signed-in user");
  assert.strictEqual(meta.dirty, false);
  assert(db.row, "with no stale remoteAt carried over, this pushes fresh as a brand-new row");
  assert.deepStrictEqual(db.row.doc, h.state);
  assert.strictEqual(meta.remoteAt, db.row.updated_at);
  win.close();
  console.log("scenario 13 (a different user signs in: meta rebinds, no stale remoteAt) ok");
}

async function scenario14() {
  const db = makeDb();
  db.user = { id: "u1", email: "m@example.com" };
  const doc0 = doc([journal("j1", "Journal", [entry("t1", "kept locally")])]);
  db.row = { doc: JSON.parse(JSON.stringify(doc0)), updated_at: nextTs(db) };
  const dom = boot((w) => {
    w.fetch = makeFetch(db);
    seedSession(w, db.user);
  });
  const win = dom.window;
  const h = makeCfg(JSON.parse(JSON.stringify(doc0)));
  await win.Sync.init(h.cfg); // adopt
  const stateBefore = JSON.parse(JSON.stringify(h.state));
  const appliedBefore = h.applied.length;

  win.Sync.signOut();

  assert.deepStrictEqual(h.state, stateBefore, "signing out of sync must not touch the local journal data");
  assert.strictEqual(h.applied.length, appliedBefore, "signOut must not call applyState");
  assert.strictEqual(win.localStorage.getItem(SESSION_KEY), null, "the shared session should be cleared");
  assert.strictEqual(win.Sync.status().signedIn, false);
  win.close();
  console.log("scenario 14 (sign-out clears the session but leaves local data untouched) ok");
}

(async function () {
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4a();
  await scenario4b();
  await scenario4c();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  await scenario9();
  await scenario10();
  await scenario11();
  await scenario12();
  await scenario13();
  await scenario14();
  console.log("smoke-sync ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
