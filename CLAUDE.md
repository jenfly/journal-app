# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-optimized journal PWA that stores entries in the user's own Google Drive. Plain HTML/JS/CSS — no framework, no build step, no backend. This is Stage 3 of a staged PWA project; Stages 1 & 2 (bare PWA shell, Google auth wiring) were built in the separate [`pwa-starter`](https://github.com/jenfly/pwa-starter) repo and this repo was copied from that finished shell.

## Running locally

Service workers and Google Sign-In do not work from `file://`, so the app must be served over HTTP:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. There is no build/lint/test tooling in this repo (no `package.json`) — it's four static files (`index.html`, `app.js`, `styles.css`, `sw.js`) served as-is.

For real-device testing over LAN, find the dev machine's IP (`ip addr` / `hostname -I`) and open `http://<ip>:8000` on the phone — but sign-in itself won't work there, since Google's Authorized JavaScript origins only include `localhost` and the deployed GitHub Pages origin, not arbitrary LAN IPs.

## Critical gotcha: service worker caching

`sw.js` caches the app shell **cache-first**, keyed by `CACHE_NAME`. **Any time `index.html`, `app.js`, `styles.css`, `manifest.json`, or an icon changes, `CACHE_NAME` in `sw.js` must be bumped in the same change.** Otherwise the browser sees no diff in `sw.js` itself, never installs the new service worker, and keeps serving the stale cached shell indefinitely — no server restart or hard-refresh fixes this, only a `CACHE_NAME` bump does.

## Architecture

Everything is driven by `app.js`, a single script with no modules/bundler. Rough structure, top to bottom:

1. **Google Sign-In** (Google Identity Services, loaded via `<script src="https://accounts.google.com/gsi/client">` in `index.html`). `google.accounts.oauth2.initTokenClient` is used directly — no backend, no server-side session. `GOOGLE_CLIENT_ID` is embedded in `app.js` and is not treated as secret (see README for why); access is actually scoped by the Authorized JavaScript origins configured on that OAuth client in Google Cloud Console, and by the `drive.file` OAuth scope (the app can only see/create files it created itself).
   - Auth persistence (avoiding forcing a login every visit) is layered: cache the access token + expiry in `localStorage` (`journal_app_google_access_token`), and if that's expired but a prior sign-in happened (`journal_app_google_has_signed_in`), attempt a silent `requestAccessToken({ prompt: "none" })` before falling back to an interactive prompt. Both `localStorage` keys are prefixed with `journal_app_` because `journal-app` and `pwa-starter` share the `https://jenfly.github.io` origin (localStorage is origin-scoped, not path-scoped) — never remove the prefix.
2. **Drive-backed journal storage** — entries are one JSON array of `{timestamp, text}` objects in a single Drive file (`journal-entries.json`), created automatically on first sign-in if it doesn't already exist (`findJournalFileId` → `createJournalFile` fallback). Reads/writes are whole-file: `loadEntriesFromDrive` / `saveEntriesToDrive` fetch or overwrite the entire JSON blob — there is no per-entry API call or partial update. Sorting is newest-first, computed at render time from the `timestamp` ISO string, not stored pre-sorted.
3. **UI wiring** — plain DOM queries + event listeners against the elements declared in `index.html` (entries list, `+` FAB, a single editor overlay reused for both create and edit, a settings (⋮) menu holding sign-out, and a confirm/cancel sub-panel for delete). There's one editor overlay element that swaps between its "editor" and "confirm delete" panels rather than separate modals.
4. **Service worker registration** — registered at the bottom of `app.js`, only for installability + app-shell offline support. Entries themselves always require network access (no offline queue/sync for Drive writes).

## Working with Google OAuth setup

If Drive calls start failing with auth errors, the likely causes are covered in the README's "Google Sign-In setup" section: OAuth consent screen must stay in Testing with the account added as a test user, and the OAuth client's Authorized JavaScript origins must include whatever origin is being tested from. `app.js` currently reuses the same OAuth client as `pwa-starter` (same `https://jenfly.github.io` origin, matched by origin not path) — don't assume a new client needs to be created unless that reuse is intentionally being split apart.

## Deployment

Deployed via GitHub Pages from the `main` branch. `develop` is the working branch; changes land on `main` (and thus go live) once merged.
