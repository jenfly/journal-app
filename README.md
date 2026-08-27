# journal-app

A mobile-optimized journal app that stores entries in the user's own Google Drive. Plain HTML/JS/CSS, no framework or build step — Stage 3 of a staged PWA project (Stage 1 & 2 were built in the [`pwa-starter`](https://github.com/jenfly/pwa-starter) repo).

**What's here:**
- Google Sign-In via [Google Identity Services](https://developers.google.com/identity/gsi/web), scoped to `drive.file` so the app can only see files it creates itself.
- Journal entries stored as a single JSON file (`journal-entries.json`) in the user's Drive, created automatically on first sign-in.
- Entries list, newest first; a `+` button opens an editor for a new entry; tapping an existing entry opens it for editing.
- Manifest + service worker for installability and basic offline support (app shell only — entries require network access to load/save).

## Local setup

1. Serve the app over HTTP (service workers and Google Sign-In don't work from `file://`):
   ```
   python3 -m http.server 8000
   ```
2. Open `http://localhost:8000`.

## Google Sign-In setup

The app needs an OAuth client ID to sign in:

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project, then enable the **Google Drive API** under *APIs & Services → Library*.
2. Under *APIs & Services → OAuth consent screen*, set it to **External**, keep publish status as **Testing**, and add your Google account under **Test users**.
3. Under *APIs & Services → Credentials*, create an **OAuth client ID** of type **Web application**. Add these to **Authorized JavaScript origins**:
   - `http://localhost:8000`
   - `https://jenfly.github.io`
4. Copy the client ID into `GOOGLE_CLIENT_ID` in `app.js`. (This ID isn't secret — there's no backend to hold a client secret in this flow, so Google expects it embedded in front-end code. Access is actually restricted by the Authorized JavaScript origins above, not by hiding the ID.)

`app.js` currently reuses the OAuth client created for `pwa-starter`, since Authorized JavaScript origins are matched by origin, not path, and both apps share the `https://jenfly.github.io` origin. Create a separate client here instead if that reuse becomes undesirable.

## Backups

A local script keeps a rolling 31-day backup of the journal data outside
Drive — see [`backup/SETUP.md`](backup/SETUP.md) for setup.

## Deployment

Deployed via GitHub Pages from the `main` branch.
