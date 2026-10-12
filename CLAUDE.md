# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-optimized journal PWA. Plain HTML/JS/CSS — no framework, no build step, no custom backend (a shared Supabase project provides sync; see below — no server code of our own, no `supabase-js`, just `fetch` against Supabase's REST API). This is Stage 3 of a staged PWA project; Stages 1 & 2 (bare PWA shell, Google auth wiring) were built in the separate [`pwa-starter`](https://github.com/jenfly/pwa-starter) repo and this repo was copied from that finished shell.

`localStorage` is the always-used local copy of the journal data (offline-first, instant). Supabase keeps it in sync across devices in the background once the user signs in. Google Drive is an optional manual backup, not the primary store. See [wellness-balance-app](https://github.com/jenfly/wellness-balance-app)'s `misc/Shared-Supabase-Sync-Design.md` for the full design shared across jenfly's three PWAs (wellness-balance-app, meal-planner, journal-app); this app's own migration plan and decisions were recorded in the Claude Code session that built it — see README.md's "Cloud sync" section.

## Running locally

Service workers, Google Sign-In, and the Supabase sign-in redirect do not work from `file://`, so the app must be served over HTTP:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` (it's in Supabase's auth redirect allow-list, same as the deployed GitHub Pages origin). There is no build/lint tooling in this repo (no `package.json`) — it's six static files (`index.html`, `logic.js`, `sync.js`, `app.js`, `styles.css`, `sw.js`) served as-is.

For real-device testing over LAN, find the dev machine's IP (`ip addr` / `hostname -I`) and open `http://<ip>:8000` on the phone — but Google Drive sign-in (backup/import) won't work there, since Google's Authorized JavaScript origins only include `localhost` and the deployed GitHub Pages origin, not arbitrary LAN IPs. Supabase sync still works over LAN once already signed in elsewhere, since the shared session lives in `localStorage` (signing in fresh over a LAN IP would hit the same redirect-allow-list problem).

### Tests

`logic.js` is pure (no DOM, no `localStorage`) and loadable directly in Node; `sync.js` and `app.js` need a DOM, so their tests run against [jsdom](https://github.com/jsdom/jsdom), a dev-only tool dependency **not** installed in the repo (keeps the no-npm-deps rule intact for the shipped app). Install it once to a user-writable location and point `NODE_PATH` at it:

```
npm install --prefix ~/.local jsdom
cd tests
node test.js                                              # pure logic.js — no jsdom needed
NODE_PATH=~/.local/node_modules node smoke-sync.js         # sync.js against a fake in-memory Supabase
NODE_PATH=~/.local/node_modules node app-smoke.js          # app.js DOM wiring, loads the real index.html
```

All test data is invented — never commit real journal entries.

## Critical gotcha: service worker caching

`sw.js` caches the app shell **cache-first**, keyed by `CACHE_NAME`, from the file list in `APP_SHELL`. **Any time `index.html`, `logic.js`, `sync.js`, `app.js`, `styles.css`, `manifest.json`, or an icon changes (including adding a new cached file), `CACHE_NAME` in `sw.js` must be bumped in the same change**, and a new file must be added to `APP_SHELL`. Otherwise the browser sees no diff in `sw.js` itself, never installs the new service worker, and keeps serving the stale cached shell indefinitely — no server restart or hard-refresh fixes this, only a `CACHE_NAME` bump does.

The fetch handler bypasses the cache entirely for cross-origin requests (`if (new URL(event.request.url).origin !== self.location.origin) return;`) — Supabase, Google Identity Services, and Drive calls always go straight to the network.

## Architecture

### Doc shape

```
{ journals: [ { id: string, name: string, entries: [ { timestamp: ISO string, text: string } ] } ] }
```

An entry's `timestamp` (`new Date().toISOString()`) is both its display time and its identity — it never changes once set; editing an entry only changes `text`. A journal's `id` (`crypto.randomUUID()`) is generated only when a journal is created by the user (or by the legacy-Drive-format migration in `loadJournalsFromDrive`) — never regenerated for an existing journal. Entries are sorted newest-first at render time, not stored pre-sorted.

### Files, top to bottom

1. **`logic.js`** — pure, no DOM, no `localStorage`: `validDoc`, `canonJSON` (key-order-independent compare, since Postgres `jsonb` reorders keys), `normalizeDoc`, `isPristine` (exactly one journal named "Journal" with zero entries — the default fresh-install state), `journalCounts`, `syncPlan`, and `mergeDocs`. Loaded before `sync.js` and `app.js`; also `require`-able directly from Node for `tests/test.js`.
2. **`sync.js`** — the Supabase sync engine (`window.Sync`: `init`, `noteLocalChange`, `signIn`, `signOut`, `syncNow`, `resolveChoice`, `status`), ported from meal-planner/wellness-balance-app's shared design but with two departures specific to this app (entries are irreplaceable, unlike a meal plan or a wellness check-in):
   - A **pristine** local doc (see above) is never pushed and never prompts the user — it either stays a no-op (no cloud row yet) or silently adopts whatever the cloud already has (first link, cloud row exists).
   - When both this device and the cloud changed since the last sync, it never does a last-write-wins whole-document replace. It always **merges** instead (see "Merge on conflict" below), applies the merged doc locally immediately, and pushes it with compare-and-swap on `updated_at` — retried (idempotently; merges are safe to redo) if the row changed again mid-merge.
   - `sync.js` handles the PKCE sign-in redirect by capturing `?code=`/`?error_description=` from the URL synchronously at script load, before `app.js` runs.
3. **`app.js`** — the rest: the `localStorage` cache layer (`loadLocal`/`saveLocal`), the startup flow, the one-time Drive import, the settings panel (sync section + Drive backup), the editor/journal-switcher UI, and `Sync.init` wiring. Plain DOM queries + event listeners against the elements declared in `index.html`.
4. **Service worker registration** — registered at the bottom of `app.js`, only for installability + app-shell offline support.

### Startup flow

1. `loadLocal()` reads `journal_app_v1` from `localStorage`. If present and valid (`validDoc`): render immediately — no network, no sign-in. This is the normal path.
2. If absent, and this device signed in to Drive before (`journal_app_google_has_signed_in`) but the one-time import hasn't run yet (`journal_app_v1:imported` unset): try a silent Drive token first, then show an explicit "Import your journal from Google Drive" button on failure. Validates the imported doc (`validDoc`; a legacy flat-array Drive file gets wrapped into one journal automatically by `loadJournalsFromDrive`) before ever writing the cache — an invalid/unreachable import leaves the cache untouched and the button visible for a retry.
3. Otherwise (a genuinely new device/user): create the pristine default doc — one journal named "Journal", no entries.
4. `enterApp()` is the common tail of all three paths: renders the UI and calls `Sync.init(...)`. Until/unless the user signs in to sync, the app is local-only and fully offline-capable.

### Saving

`saveLocal()` writes `{ journals }` to `localStorage` synchronously, then calls `Sync.noteLocalChange()` (guarded — a no-op if `sync.js` failed to load or no one's signed in to sync). A failed write (quota, private browsing) shows a persistent, visible error (`#save-error`) rather than failing silently; the in-memory `journals` is left untouched either way, so nothing is lost for the rest of the session. A `storage` event listener picks up changes saved in another tab/window of the same cache when this tab isn't mid-edit (`busy()`).

### Merge on conflict

Decided 2026-10-12, union-only (never deletes anything a merge might be ambiguous about):

- Journals are matched by `id`; the merged result is the **union** of both sides' journals (one present on only one side is kept as-is).
- Entries within a journal are matched by `timestamp`; the merged result is the union of both sides' entries. An entry deleted on one device while the other device changed *anything* before the next sync **reappears** — it has to be deleted again. This is a deliberate, accepted limitation of the "never silently lose data" design, not a bug.
- When the *same* journal id or entry timestamp has different content on both sides (a real edit conflict, not an addition), the newer side wins for that one piece (`meta.editedAt` on this device vs. the cloud row's `updated_at`) and the losing piece is recorded in a small `:pre-sync-copy` audit record (not two whole documents — see `sync.js`'s `keepMergeRecord`).
- `tests/test.js` covers the full rule set plus a randomized property test (no-loss, idempotent, commutative up to tie-breaks).

### `localStorage` keys

All new keys are prefixed `journal_app_` because `journal-app`, `pwa-starter`, `meal-planner`, and `wellness-balance-app` all serve from `https://jenfly.github.io` (different paths, same origin) — `localStorage` is origin-scoped, not path-scoped. Never remove the prefix.

| Key | Owner | Contents |
| --- | --- | --- |
| `journal_app_v1` | `app.js` | the whole document `{ journals: [...] }` — the always-used local copy |
| `journal_app_v1:sync-meta` | `sync.js` | `{ userId, remoteAt, dirty, editedAt, syncedAt }` |
| `journal_app_v1:pre-sync-copy` | `sync.js` | the one safety record of whatever the last sync pass replaced or tie-broke |
| `journal_app_v1:sb-verifier` | `sync.js` | PKCE verifier, transient during sign-in |
| `journal_app_v1:imported` | `app.js` | set once the one-time Drive-to-cache import has completed |
| `journal_app_drive_backup_at` | `app.js` | last successful manual "Back up to Drive" time (ms) |
| `journal_app_google_access_token` | `app.js` | cached Drive OAuth token + expiry |
| `journal_app_google_has_signed_in` | `app.js` | whether this device has ever signed in to Drive (drives the import path) |
| `journal_app_last_journal_id` | `app.js` | which journal was last open — device-local on purpose, **never synced** |
| `jenfly-supabase-auth` | `sync.js` | the Supabase session — **shared** across all three apps on this origin; signing in or out here signs in/out of all of them |

### Google Drive: optional manual backup only

Kept Drive functions (`driveApiFetch`, `findJournalFileId`, `createJournalFile`, `loadJournalsFromDrive`, `saveJournalsToDrive`) serve exactly two purposes now, both using the `drive.file` OAuth scope via Google Identity Services (`google.accounts.oauth2.initTokenClient`, no backend): the one-time import above, and the settings panel's "Back up to Drive" action (finds-or-creates `journal-entries.json`, overwrites it with the current doc). **There is deliberately no restore-from-Drive action** — with the local cache (and Supabase sync) as the real store, Drive is a one-way manual safety copy. `GOOGLE_CLIENT_ID` in `app.js` is not treated as secret (see README for why) and is still shared with `pwa-starter`'s OAuth client (same origin).

### Supabase sync

No `supabase-js`, no CDN script, no bundler — `sync.js` talks to Supabase Auth and PostgREST directly via `fetch`. Sign-in is Google through Supabase (PKCE flow), **separate from** the Drive OAuth client above — do not merge them. The publishable key in `sync.js` is meant to be public; row-level security on the shared `app_data` table (`user_id`, `app` = `'journal'`, `doc` jsonb, `updated_at`) is what actually keeps each user's rows private. Conflict handling is `syncPlan` + `mergeDocs` in `logic.js` (see "Merge on conflict" above) — this app is the one of the three siblings that merges instead of last-write-wins, because losing a journal entry is worse than losing a meal plan or a wellness check-in.

## Working with Google OAuth setup

If Drive import/backup calls start failing with auth errors, the likely causes are covered in the README's "Google Drive setup" section: OAuth consent screen must stay in Testing with the account added as a test user, and the OAuth client's Authorized JavaScript origins must include whatever origin is being tested from. This is separate from Supabase's own Google OAuth client (used for sync sign-in) — don't conflate the two if debugging an auth failure; check which one actually failed first.

## UI changes need screenshots

Any UI change (the settings panel states especially: signed-out, signed-in, syncing/offline/error, first-link choose) should be verified by rendering the real page (`python3 -m http.server` + a headless browser) and capturing screenshots before considering the change done — this repo follows the same convention as its sibling apps.

## Deployment

Deployed via GitHub Pages from the `main` branch. Work directly on `main`, or on a short-lived feature branch merged back into `main` — changes go live as soon as they land there.
