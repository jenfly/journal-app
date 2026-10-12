/* ---------- Cloud sync (Supabase) ----------
   Optional. Until the user signs in, the app behaves exactly as before (localStorage only).
   Once signed in, the whole journal document is kept as one JSON document in the shared
   Supabase table `app_data` (one row per user per app, app = 'journal'). localStorage stays
   the copy the app reads and writes, so everything works offline and instantly; this file
   only pushes changes up in the background and pulls/merges changes made on other devices.

   This is the same sync layer used by wellness-balance-app and meal-planner (shared Supabase
   project, shared session, shared table — each app just has its own `app` tag and `doc`
   shape). See wellness-balance-app's misc/Shared-Supabase-Sync-Design.md for the full design.

   The pure decision logic (syncPlan, canonJSON, validDoc, isPristine, mergeDocs, journalCounts)
   lives in logic.js, loaded before this file — this file is the stateful/network half only.

   No dependencies: it talks to Supabase Auth and the REST API with fetch. Sign-in is Google
   through Supabase using the PKCE flow. The publishable key below is meant to be public;
   row-level security on the table is what keeps each user's rows private.

   Conflicts: a plain pull or push (only one side changed) is an exact whole-document replace
   — unambiguous, no risk. When BOTH sides changed since the last sync, this app never does a
   blind last-write-wins replace (unlike the sibling apps) — entries are irreplaceable, so it
   always merges instead (see logic.js's mergeDocs; union-only, nothing is ever deleted by a
   merge). The cloud row is only updated if it still has the version this device last saw
   (compare-and-swap on updated_at); if it changed again mid-merge, the next pass just merges
   again against the newer version (merges are idempotent, so this converges).
   The first time a device links to an account that already has a cloud copy, and the two
   differ: a pristine (freshly-installed, untouched) local copy silently adopts the cloud
   copy; otherwise the user is asked — merge both (primary), use the cloud copy, or keep this
   device's copy. The decision logic is syncPlan() in logic.js. */
(function (root) {
  "use strict";

  var SUPABASE_URL = "https://rrremrggallytwfyfjpa.supabase.co";
  var SUPABASE_KEY = "sb_publishable_TYvABVg0SSAn4YarBCFSQw_sPXF6jEo";
  var APP = "journal";
  // Shared by every app on this origin, so signing in once covers all of them.
  var SESSION_KEY = "jenfly-supabase-auth";
  var PUSH_DELAY = 2500,
    RETRY_DELAY = 60000,
    MAX_REPASS = 3;

  /* The sign-in redirect lands back here with ?code=... (or ?error_description=...). Grab it now,
     synchronously, and take it out of the address bar before any other script rewrites the URL. */
  var redirect = { code: null, error: null };
  try {
    var qs0 = new URLSearchParams(root.location.search);
    if (qs0.has("code") || qs0.has("error_description")) {
      redirect.code = qs0.get("code");
      redirect.error = qs0.get("error_description") || qs0.get("error");
      ["code", "error", "error_code", "error_description"].forEach(function (k) {
        qs0.delete(k);
      });
      var rest0 = qs0.toString();
      root.history.replaceState(
        root.history.state,
        "",
        root.location.pathname + (rest0 ? "?" + rest0 : "") + root.location.hash
      );
    }
  } catch (e) {
    /* old browser: no redirect handling */
  }

  var cfg = null,
    session = null,
    meta = null,
    choice = null;
  var phase = "idle",
    lastError = null;
  var timer = null,
    retryTimer = null,
    running = null,
    again = 0,
    applying = false,
    changeSeq = 0,
    refreshing = null;

  /* ---------- storage helpers ---------- */
  function readJSON(k) {
    try {
      var v = root.localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  }
  function writeJSON(k, v) {
    try {
      root.localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e) {
      return false;
    }
  }
  function metaKey() {
    return cfg.key + ":sync-meta";
  }
  function loadMeta() {
    var m = readJSON(metaKey());
    return m && typeof m === "object"
      ? m
      : { userId: null, remoteAt: null, dirty: false, editedAt: null, syncedAt: null };
  }
  function saveMeta() {
    writeJSON(metaKey(), meta);
  }
  function loadSession() {
    var s = readJSON(SESSION_KEY);
    return s && s.access_token && s.refresh_token && s.user && s.user.id ? s : null;
  }
  function clearSession() {
    session = null;
    try {
      root.localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
  }
  // Whole-document replacement safety record (plain pull/choose "use cloud"/"keep device").
  function keepCopy(which, doc) {
    writeJSON(cfg.key + ":pre-sync-copy", { at: Date.now(), which: which, doc: doc });
  }
  // Merge safety record: only the pieces a merge resolved by tie-break, not two whole docs —
  // a merge itself never destroys anything (union-only), so this is just the audit trail.
  function keepMergeRecord(replaced) {
    writeJSON(cfg.key + ":pre-sync-copy", { at: Date.now(), which: "merge", replaced: replaced });
  }

  function emit() {
    if (cfg && cfg.onChange) {
      try {
        cfg.onChange(status());
      } catch (e) {
        /* UI problem must not break sync */
      }
    }
  }
  function setPhase(p) {
    phase = p;
    emit();
  }

  /* ---------- auth ---------- */
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return root.btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function makePkce() {
    var rnd = new Uint8Array(48);
    root.crypto.getRandomValues(rnd);
    var verifier = b64url(rnd);
    return root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (h) {
      return { verifier: verifier, challenge: b64url(new Uint8Array(h)) };
    });
  }
  function authPost(path, body) {
    return root
      .fetch(SUPABASE_URL + path, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (j) {
            return { ok: r.ok, status: r.status, json: j };
          });
      });
  }
  function storeSession(resp) {
    var user = resp.user && resp.user.id ? { id: resp.user.id, email: resp.user.email } : session && session.user;
    if (!resp.access_token || !resp.refresh_token || !user) throw new Error("auth-failed");
    session = {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
      user: user,
    };
    writeJSON(SESSION_KEY, session);
  }
  function signIn() {
    if (!cfg) return Promise.resolve();
    return makePkce().then(function (p) {
      try {
        root.localStorage.setItem(cfg.key + ":sb-verifier", p.verifier);
      } catch (e) {
        throw new Error("storage-unavailable");
      }
      var q = new URLSearchParams({
        provider: "google",
        redirect_to: root.location.origin + root.location.pathname,
        code_challenge: p.challenge,
        code_challenge_method: "s256",
      });
      root.location.href = SUPABASE_URL + "/auth/v1/authorize?" + q.toString();
    });
  }
  function finishRedirect() {
    if (redirect.error) {
      lastError = redirect.error;
      var e = redirect.error;
      redirect.error = null;
      if (cfg.onError) cfg.onError("Google sign-in did not finish: " + e);
      return Promise.resolve(false);
    }
    if (!redirect.code) return Promise.resolve(false);
    var code = redirect.code,
      verifier = null;
    redirect.code = null;
    try {
      verifier = root.localStorage.getItem(cfg.key + ":sb-verifier");
      root.localStorage.removeItem(cfg.key + ":sb-verifier");
    } catch (e) {
      /* ignore */
    }
    if (!verifier) return Promise.resolve(false); // a ?code= we did not start
    setPhase("signing-in");
    return authPost("/auth/v1/token?grant_type=pkce", { auth_code: code, code_verifier: verifier })
      .then(function (r) {
        if (!r.ok) throw new Error("auth-failed");
        storeSession(r.json);
        return true;
      })
      .catch(function (e) {
        lastError = e && e.message;
        phase = "idle";
        if (cfg.onError) cfg.onError("Could not finish signing in — try again.");
        emit();
        return false;
      });
  }
  // Returns a valid access token, refreshing it when it is about to expire. Another tab or app on
  // this origin may already have refreshed the shared session, so re-read it first.
  function getToken(force) {
    session = loadSession() || session;
    if (!session) return Promise.reject(new Error("signed-out"));
    if (!force && Date.now() < session.expires_at - 60000) return Promise.resolve(session.access_token);
    if (refreshing) return refreshing;
    var used = session.refresh_token;
    refreshing = authPost("/auth/v1/token?grant_type=refresh_token", { refresh_token: used })
      .then(function (r) {
        if (r.ok && r.json.access_token) {
          storeSession(r.json);
          return session.access_token;
        }
        if (r.status >= 400 && r.status < 500) {
          var latest = loadSession();
          if (latest && latest.refresh_token !== used) {
            session = latest;
            return session.access_token;
          }
          clearSession();
          throw new Error("signed-out");
        }
        throw new Error("auth-failed");
      })
      .then(
        function (t) {
          refreshing = null;
          return t;
        },
        function (e) {
          refreshing = null;
          throw e;
        }
      );
    return refreshing;
  }

  /* ---------- REST (PostgREST) ---------- */
  function rest(method, query, body, token) {
    var opts = { method: method, headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + token, Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers.Prefer = "return=representation";
      opts.body = JSON.stringify(body);
      if (opts.body.length < 30000) opts.keepalive = true; // lets a last push survive the page closing
    }
    return root.fetch(SUPABASE_URL + "/rest/v1/app_data" + query, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try {
          j = t ? JSON.parse(t) : null;
        } catch (e) {
          /* not JSON */
        }
        return { ok: r.ok, status: r.status, json: j };
      });
    });
  }
  // Runs a REST call; if the token was rejected, refreshes it and tries once more.
  function authed(call) {
    return getToken()
      .then(call)
      .then(function (r) {
        if (r.status !== 401) return r;
        return getToken(true).then(call);
      });
  }
  function httpError(r) {
    var e = new Error("http-" + r.status);
    e.status = r.status;
    return e;
  }
  function fetchRemote() {
    return authed(function (t) {
      return rest("GET", "?app=eq." + APP + "&select=doc,updated_at", undefined, t);
    }).then(function (r) {
      if (!r.ok || !Array.isArray(r.json)) throw httpError(r);
      return r.json[0] || null;
    });
  }

  /* ---------- one sync pass ---------- */
  function applyRemote(doc) {
    applying = true;
    try {
      cfg.applyState(doc);
    } finally {
      applying = false;
    }
  }
  function finish(seq) {
    meta.syncedAt = Date.now();
    if (seq !== undefined) meta.dirty = seq !== changeSeq; // edits made while the request was in flight stay unsynced
    saveMeta();
    lastError = null;
  }
  function pushNew(local, seq) {
    return authed(function (t) {
      return rest("POST", "", { app: APP, doc: local }, t);
    }).then(function (r) {
      if (r.status === 409) {
        again++;
        return;
      } // another device created it first: look again
      if (!r.ok || !Array.isArray(r.json) || !r.json[0]) throw httpError(r);
      meta.remoteAt = r.json[0].updated_at;
      finish(seq);
    });
  }
  function pushUpdate(local, expectedAt, seq) {
    return authed(function (t) {
      return rest("PATCH", "?app=eq." + APP + "&updated_at=eq." + encodeURIComponent(expectedAt), { doc: local }, t);
    }).then(function (r) {
      if (!r.ok || !Array.isArray(r.json)) throw httpError(r);
      if (!r.json.length) {
        again++;
        return;
      } // cloud copy changed since we looked: look again
      meta.remoteAt = r.json[0].updated_at;
      finish(seq);
    });
  }
  function execute(plan, remote, local, seq) {
    if (remote && !validDoc(remote.doc)) throw new Error("bad-remote-doc");
    switch (plan) {
      case "noop":
        finish();
        return;
      case "adopt":
        meta.remoteAt = remote.updated_at;
        meta.dirty = false;
        finish();
        return;
      case "choose":
        choice = { doc: remote.doc, remoteAt: remote.updated_at };
        return;
      case "push-new":
        return pushNew(local, seq);
      case "push":
        return pushUpdate(local, meta.remoteAt, seq);
      case "merge": {
        if (cfg.busy && cfg.busy()) {
          scheduleRetry(5000); // user is mid-edit: take it a moment later, never merge under an open editor
          return;
        }
        var res = mergeDocs(local, remote.doc, { localNewer: (meta.editedAt || 0) > Date.parse(remote.updated_at) });
        keepMergeRecord(res.replaced);
        applyRemote(res.doc);
        if (cfg.onMerged) cfg.onMerged(res.stats);
        // meta.remoteAt/dirty are only updated once this push actually succeeds (inside
        // pushUpdate -> finish); if it fails or loses the compare-and-swap race, the merged
        // doc stays applied locally and dirty stays true, so the next pass merges again
        // (harmlessly — mergeDocs is idempotent) against whatever the cloud has by then.
        return pushUpdate(res.doc, remote.updated_at, seq);
      }
      case "pull":
        if (cfg.busy && cfg.busy()) {
          scheduleRetry(5000); // user is mid-edit: take it a moment later
          return;
        }
        if (meta.dirty) keepCopy("device", local);
        applyRemote(remote.doc);
        meta.remoteAt = remote.updated_at;
        meta.dirty = false;
        meta.editedAt = null;
        finish();
        if (cfg.onPulled) cfg.onPulled();
        return;
    }
  }
  function pass() {
    meta = loadMeta();
    return getToken()
      .then(function () {
        session = loadSession() || session;
        if (meta.userId !== session.user.id) {
          meta = { userId: session.user.id, remoteAt: null, dirty: false, editedAt: null, syncedAt: null };
          saveMeta();
        }
        return fetchRemote();
      })
      .then(function (remote) {
        var local = cfg.getState(),
          seq = changeSeq;
        var same = !!remote && validDoc(remote.doc) && canonJSON(remote.doc) === canonJSON(local);
        var plan = syncPlan(meta, remote, same, isPristine(local));
        return execute(plan, remote, local, seq);
      });
  }
  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(run, ms || RETRY_DELAY);
  }
  function guarded(work) {
    if (running) {
      again = Math.max(again, 1);
      return running;
    }
    clearTimeout(retryTimer);
    setPhase("syncing");
    running = work()
      .then(function () {
        running = null;
        if (choice) {
          setPhase("choose");
          return;
        }
        if (again && again <= MAX_REPASS) {
          var n = again;
          again = 0;
          return guarded(function () {
            return pass();
          }).then(function () {
            again = Math.max(again, 0);
          });
        }
        again = 0;
        setPhase("idle");
      })
      .catch(function (e) {
        running = null;
        again = 0;
        lastError = e && e.message;
        if (lastError === "signed-out") {
          phase = "idle";
          emit();
          return;
        }
        var offline = (root.navigator && root.navigator.onLine === false) || e instanceof TypeError;
        phase = offline ? "offline" : "error";
        emit();
        scheduleRetry();
      });
    return running;
  }
  function run() {
    return cfg && loadSession() ? guarded(function () { return pass(); }) : Promise.resolve();
  }

  /* ---------- public API ---------- */
  function noteLocalChange() {
    if (!cfg || applying || !loadSession()) return;
    meta = loadMeta();
    meta.dirty = true;
    meta.editedAt = Date.now();
    changeSeq++;
    saveMeta();
    clearTimeout(timer);
    timer = setTimeout(run, PUSH_DELAY);
  }
  // After the first sign-in on a device whose copy differs from the cloud's, the user picks
  // one of three: merge both (primary — never discards entries), use the cloud copy, or keep
  // this device's copy (the latter two each discard one whole side, recorded once locally).
  function resolveChoice(which) {
    if (!choice) return Promise.resolve();
    var c = choice;
    choice = null;
    return guarded(function () {
      meta = loadMeta();
      if (which === "cloud") {
        keepCopy("device", cfg.getState());
        applyRemote(c.doc);
        meta.remoteAt = c.remoteAt;
        meta.dirty = false;
        meta.editedAt = null;
        finish();
        if (cfg.onPulled) cfg.onPulled();
        return Promise.resolve();
      }
      if (which === "merge") {
        var local = cfg.getState();
        var res = mergeDocs(local, c.doc, { localNewer: (meta.editedAt || 0) > Date.parse(c.remoteAt) });
        keepMergeRecord(res.replaced);
        applyRemote(res.doc);
        if (cfg.onMerged) cfg.onMerged(res.stats);
        return pushUpdate(res.doc, c.remoteAt, changeSeq);
      }
      keepCopy("cloud", c.doc);
      return pushUpdate(cfg.getState(), c.remoteAt, changeSeq);
    });
  }
  function signOut() {
    clearSession();
    choice = null;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    meta = loadMeta();
    lastError = null;
    setPhase("idle");
  }
  function status() {
    var s = loadSession(),
      m = meta || (cfg ? loadMeta() : {});
    return {
      signedIn: !!s,
      email: s ? s.user.email : null,
      phase: phase,
      syncedAt: m.syncedAt || null,
      dirty: !!m.dirty,
      error: lastError,
      choice: choice
        ? {
            cloud: journalCounts(choice.doc),
            device: journalCounts(cfg.getState()),
          }
        : null,
    };
  }
  function init(options) {
    cfg = options;
    meta = loadMeta();
    session = loadSession();
    root.document.addEventListener("visibilitychange", function () {
      if (root.document.hidden) {
        if (loadMeta().dirty) run();
      } else run();
    });
    root.addEventListener("online", run);
    return finishRedirect().then(function () {
      return run();
    });
  }

  root.Sync = {
    init: init,
    noteLocalChange: noteLocalChange,
    signIn: signIn,
    signOut: signOut,
    syncNow: run,
    resolveChoice: resolveChoice,
    status: status,
  };
})(typeof window !== "undefined" ? window : globalThis);
