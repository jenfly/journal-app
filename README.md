# journal-app

A mobile-optimized journal app. Plain HTML/JS/CSS, no framework or build step — Stage 3 of a staged PWA project (Stage 1 & 2 were built in the [`pwa-starter`](https://github.com/jenfly/pwa-starter) repo).

**What's here:**
- Journal entries, grouped into one or more named journals, stored locally (`localStorage`) as the always-used copy — the app opens instantly and works fully offline, no sign-in required.
- Optional cross-device sync through a shared Supabase backend (sign in once, covers this app plus [Well Tended](https://github.com/jenfly/wellness-balance-app) and [Meal Planner](https://github.com/jenfly/meal-planner) on the same origin). Entries are never silently discarded on conflict — see "Cloud sync" below.
- Optional manual "Back up to Drive" action via [Google Identity Services](https://developers.google.com/identity/gsi/web) (`drive.file` scope, so the app can only see files it creates itself). No restore-from-Drive — the local cache and Supabase are the real store; Drive import only happens once, automatically, when upgrading a device that used the old Drive-only version of this app.
- Entries list, newest first; a `+` button opens an editor for a new entry; tapping an existing entry opens it for editing. A journal switcher for multiple named journals.
- Manifest + service worker for installability and app-shell offline support.

## Local setup

1. Serve the app over HTTP (service workers, Google Sign-In, and the Supabase sign-in redirect don't work from `file://`):
   ```
   python3 -m http.server 8000
   ```
2. Open `http://localhost:8000` — this origin is in both the Google OAuth client's Authorized JavaScript origins and Supabase's redirect allow-list already, so sign-in works locally without extra setup.

See `CLAUDE.md` for the test commands (`tests/test.js`, `tests/smoke-sync.js`, `tests/app-smoke.js`).

## Cloud sync

Entries sync across devices through a Supabase backend shared by all three of jenfly's PWAs on `https://jenfly.github.io`. Full design: [wellness-balance-app](https://github.com/jenfly/wellness-balance-app)'s `misc/Shared-Supabase-Sync-Design.md`. This app's own migration plan and decisions are recorded in the conversation that built it (the "Supabase sync: handoff to Claude Code (journal-app)" document) — ask in a Claude Code session if picking this up again and that context isn't already available.

A couple of things specific to this app (vs. the meal planner / wellness check-in siblings, which use plain last-write-wins): conflicts **merge** instead of replacing a whole document, because losing a journal entry is worse than losing a meal plan; and a brand-new, untouched ("pristine") device never pushes an empty journal or prompts the user — it just silently adopts whatever's already in the cloud.

Signing in or out of sync here signs in or out of the other two apps too (shared session, shared origin).

## Google Drive setup

Only needed for the one-time import (upgrading a device from the old Drive-only version of this app) and the optional "Back up to Drive" action — the app works fully without ever touching Drive.

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project, then enable the **Google Drive API** under *APIs & Services → Library*.
2. Under *APIs & Services → OAuth consent screen*, set it to **External**, keep publish status as **Testing**, and add your Google account under **Test users**.
3. Under *APIs & Services → Credentials*, create an **OAuth client ID** of type **Web application**. Add these to **Authorized JavaScript origins**:
   - `http://localhost:8000`
   - `https://jenfly.github.io`
4. Copy the client ID into `GOOGLE_CLIENT_ID` in `app.js`. (This ID isn't secret — there's no backend to hold a client secret in this flow, so Google expects it embedded in front-end code. Access is actually restricted by the Authorized JavaScript origins above, not by hiding the ID.)

`app.js` currently reuses the OAuth client created for `pwa-starter`, since Authorized JavaScript origins are matched by origin, not path, and both apps share the `https://jenfly.github.io` origin. Create a separate client here instead if that reuse becomes undesirable. This is a separate OAuth setup from Supabase's own Google sign-in (used for cloud sync) — don't conflate the two.

## Deployment

Deployed via GitHub Pages from the `main` branch. Work directly on `main`, or on a short-lived feature branch merged back into `main` — changes go live as soon as they land there.
