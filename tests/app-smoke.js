// App-level jsdom smoke tests: loads the REAL index.html body markup plus logic.js, sync.js,
// and app.js inline (same source-concatenation trick as smoke-sync.js), so these exercise the
// actual DOM wiring in app.js — not just the pure logic (test.js) or the sync engine against a
// fake Supabase (smoke-sync.js). No real network, no real Google sign-in: fetch and the GIS
// global are stubbed per scenario. Run from this directory:
// `NODE_PATH=<path to a jsdom install> node app-smoke.js` (see CLAUDE.md for the exact command).
const { JSDOM } = require("jsdom");
const fs = require("fs");
const assert = require("assert");

const indexHtml = fs.readFileSync("../index.html", "utf8");
const logicSrc = fs
  .readFileSync("../logic.js", "utf8")
  .split("\n")
  .filter((l) => l.indexOf("if (typeof module") !== 0)
  .join("\n");
const syncSrc = fs.readFileSync("../sync.js", "utf8");
const appSrc = fs.readFileSync("../app.js", "utf8");

// Pull the real <body> markup out of index.html so these tests stay in sync with the shipped
// page's element ids/structure, then drop the external script tags (GSI + our three files) and
// inline our own copies instead — this is the only way to run them in jsdom (no real network).
function buildPage() {
  const m = indexHtml.match(/<body>([\s\S]*)<\/body>/);
  if (!m) throw new Error("could not find <body> in ../index.html");
  const body = m[1].replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "");
  return "<!doctype html><html><body>" + body + "<script>" + logicSrc + "</script><script>" + syncSrc + "</script><script>" + appSrc + "</script></body></html>";
}
const PAGE = buildPage();

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
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fakeGoogle(tokenResponse) {
  return {
    accounts: {
      oauth2: {
        initTokenClient(opts) {
          return {
            requestAccessToken() {
              setTimeout(() => opts.callback(tokenResponse), 5);
            },
          };
        },
        revoke() {},
      },
    },
  };
}

// ---------- scenarios ----------

async function scenario1() {
  const doc0 = { journals: [{ id: "j1", name: "Journal", entries: [{ timestamp: "2026-01-01T00:00:00.000Z", text: "hello" }] }] };
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_v1", JSON.stringify(doc0));
    w.fetch = async () => {
      throw new Error("no network calls expected when a cache is already present");
    };
  });
  const win = dom.window;
  await wait(300);
  assert.strictEqual(win.document.getElementById("journal-section").classList.contains("hidden"), false, "main UI should render immediately from the cache");
  assert.strictEqual(win.document.getElementById("import-section").classList.contains("hidden"), true);
  assert.strictEqual(win.document.querySelector("#entries .entry p").textContent, "hello");
  win.close();
  console.log("scenario 1 (cache present: renders immediately, no network, no sign-in) ok");
}

async function scenario2() {
  const driveJournals = [{ id: "jd", name: "Imported", entries: [{ timestamp: "2026-02-02T00:00:00.000Z", text: "from drive" }] }];
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_google_has_signed_in", "true");
    w.google = fakeGoogle({ access_token: "tok", expires_in: 3600 });
    w.fetch = async (url) => {
      if (url.indexOf("drive/v3/files?") >= 0) return { ok: true, json: async () => ({ files: [{ id: "file1", name: "journal-entries.json" }] }) };
      if (url.indexOf("drive/v3/files/file1?alt=media") >= 0) return { ok: true, text: async () => JSON.stringify({ journals: driveJournals }) };
      throw new Error("unexpected fetch: " + url);
    };
  });
  const win = dom.window;
  await wait(500);
  const cache = JSON.parse(win.localStorage.getItem("journal_app_v1") || "null");
  assert(cache, "the one-time import should have written the cache");
  assert.strictEqual(cache.journals[0].entries[0].text, "from drive");
  assert.strictEqual(win.localStorage.getItem("journal_app_v1:imported"), "true");
  assert.strictEqual(win.document.querySelector("#entries .entry p").textContent, "from drive");
  win.close();
  console.log("scenario 2 (no cache + prior Drive sign-in: one-time import populates the cache) ok");
}

async function scenario2b() {
  const existingCache = { journals: [{ id: "jex", name: "Existing", entries: [{ timestamp: "2026-03-03T00:00:00.000Z", text: "existing cache" }] }] };
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_v1", JSON.stringify(existingCache));
    w.localStorage.setItem("journal_app_google_has_signed_in", "true"); // would trigger import if the cache were absent
    w.fetch = async () => {
      throw new Error("no Drive call expected: an existing cache must short-circuit the import path entirely");
    };
  });
  const win = dom.window;
  await wait(300);
  assert.strictEqual(win.document.querySelector("#entries .entry p").textContent, "existing cache", "an existing cache must never be overwritten by the import path");
  assert.strictEqual(win.localStorage.getItem("journal_app_v1:imported"), null, "the import flag should not be set when the import path never ran");
  win.close();
  console.log("scenario 2b (an existing cache always short-circuits the import path, never overwritten) ok");
}

async function scenario3() {
  const doc0 = { journals: [{ id: "j1", name: "Journal", entries: [] }] };
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_v1", JSON.stringify(doc0));
    w.fetch = async () => {
      throw new Error("no network expected");
    };
  });
  const win = dom.window;
  await wait(300);

  // Simulate a quota-exceeded / private-mode write failure on the next save. jsdom's
  // `localStorage` is a getter-backed object (a fresh instance each access), so monkey-patching
  // `localStorage.setItem` directly has no effect on later calls — instead make the
  // `JSON.stringify` inside saveLocal()'s own try block throw, which the app can't tell apart
  // from a real storage-write failure (both land in the same catch).
  const realStringify = win.JSON.stringify;
  win.JSON.stringify = (v) => {
    if (v && v.journals) throw new win.DOMException("QuotaExceededError");
    return realStringify(v);
  };

  win.document.getElementById("fab").click();
  win.document.getElementById("editor-textarea").value = "this will fail to save";
  win.document.getElementById("editor-done-btn").click();
  await wait(100);

  assert.strictEqual(win.document.getElementById("save-error").classList.contains("hidden"), false, "a failed local write must show a persistent, visible error");
  win.close();
  console.log("scenario 3 (a failed localStorage write surfaces a visible, persistent error) ok");
}

async function scenario4() {
  const doc0 = { journals: [{ id: "j1", name: "Journal", entries: [{ timestamp: "2026-04-04T00:00:00.000Z", text: "to back up" }] }] };
  let patchedBody = null;
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_v1", JSON.stringify(doc0));
    w.google = fakeGoogle({ access_token: "tok", expires_in: 3600 });
    w.fetch = async (url, opts) => {
      const method = (opts && opts.method) || "GET";
      if (url.indexOf("drive/v3/files?") >= 0) return { ok: true, json: async () => ({ files: [] }) }; // no existing Drive file
      if (url.indexOf("uploadType=multipart") >= 0) return { ok: true, json: async () => ({ id: "newfile" }) };
      if (url.indexOf("uploadType=media") >= 0 && method === "PATCH") {
        patchedBody = JSON.parse(opts.body);
        return { ok: true, text: async () => "" };
      }
      throw new Error("unexpected fetch: " + method + " " + url);
    };
  });
  const win = dom.window;
  await wait(300);
  win.document.getElementById("settings-btn").click();
  await wait(50);
  win.document.getElementById("backup-btn").click();
  await wait(300);
  assert(patchedBody, "backup should have written to Drive");
  assert.strictEqual(patchedBody.journals[0].entries[0].text, "to back up");
  assert(win.localStorage.getItem("journal_app_drive_backup_at"), "the backup time should be recorded");
  win.close();
  console.log("scenario 4 (Drive backup creates the file if missing and writes the current doc) ok");
}

async function scenario5() {
  const dom = boot((w) => {
    w.localStorage.setItem("journal_app_google_has_signed_in", "true");
    w.google = fakeGoogle({ access_token: "tok", expires_in: 3600 });
    w.fetch = async (url) => {
      if (url.indexOf("drive/v3/files?") >= 0) return { ok: true, json: async () => ({ files: [{ id: "file1" }] }) };
      if (url.indexOf("alt=media") >= 0) return { ok: true, text: async () => JSON.stringify({ journals: [{ id: "bad" }] }) }; // missing name/entries
      throw new Error("unexpected fetch: " + url);
    };
  });
  const win = dom.window;
  await wait(500);
  assert.strictEqual(win.localStorage.getItem("journal_app_v1"), null, "invalid Drive data must never be written to the cache");
  assert.strictEqual(win.localStorage.getItem("journal_app_v1:imported"), null);
  assert.strictEqual(win.document.getElementById("import-section").classList.contains("hidden"), false, "the import prompt should still be showing, offering a retry");
  win.close();
  console.log("scenario 5 (the one-time import validates before writing the cache; invalid data is rejected) ok");
}

(async function () {
  await scenario1();
  await scenario2();
  await scenario2b();
  await scenario3();
  await scenario4();
  await scenario5();
  console.log("app-smoke ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
