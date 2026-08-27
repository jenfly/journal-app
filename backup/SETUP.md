# Journal backup — setup

A local script that downloads `journal-entries.json` from Google Drive once a day
and keeps the last 31 daily snapshots in `~/Dropbox/Backups/JournalBackups/`, so a
Drive-side mistake doesn't cost you the journal. Full snapshot each day, no
incremental/delta logic — the file is small and each snapshot is independently
a complete, directly-restorable copy.

This uses a **separate** OAuth client from the one in `app.js`. The app's
client is a "Web application" type client using the browser-only implicit
flow, which never issues a refresh token and can't run unattended. This
backup script needs its own "Desktop app" client that can mint a refresh
token once and then run headlessly from cron.

## 1. Create the OAuth client (one-time, Google Cloud Console)

In the same Google Cloud project used for the existing Web client:

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   Type: **Desktop app**. Name it e.g. `journal-backup-cli`. Download the
   JSON — this is `client_secret.json`.
2. **APIs & Services → OAuth consent screen → Publish App** (Testing →
   Production). This is required so refresh tokens don't hit Google's 7-day
   Testing-mode expiry, which would otherwise silently break the daily cron
   job about once a week. You'll see a one-time "Google hasn't verified this
   app" warning during step 4 below — expected, since this is a personal-use
   client that won't go through Google's verification review. Click
   "Advanced" → "Go to journal-backup-cli (unsafe)" to proceed.
3. Move the downloaded file to `~/.config/journal-backup/client_secret.json`.
   **Never commit this file or put it in the repo** — unlike the existing
   Web client, this one has a real secret, and this repo is public.

```
mkdir -p ~/.config/journal-backup
chmod 700 ~/.config/journal-backup
mv ~/Downloads/client_secret_*.json ~/.config/journal-backup/client_secret.json
chmod 600 ~/.config/journal-backup/client_secret.json
```

## 2. Set up the Python environment

`pip` isn't on this machine's global PATH (Debian/Mint externally-managed
environment), so use a venv — kept inside this `backup/` folder (it's
gitignored, so nothing lands in version control):

```
cd /home/jennifer/Projects/journal-app
python3 -m venv backup/venv
backup/venv/bin/pip install -r backup/requirements.txt
```

## 3. First-run interactive auth (one-time)

```
backup/venv/bin/python3 backup/journal_backup.py --interactive-auth
```

This opens a browser. Sign in as `jenfly@gmail.com`, click through the
unverified-app warning, and approve read-only Drive access. This saves
`~/.config/journal-backup/token.json`, which contains a refresh token —
after this, no browser interaction is needed again unless that token is
revoked (the script will tell you clearly if that happens; just re-run this
step).

## 4. Test a manual run

```
backup/venv/bin/python3 backup/journal_backup.py
```

Confirm a new `journal-entries-<today>.json` shows up in
`~/Dropbox/Backups/JournalBackups/`, and check `~/.config/journal-backup/backup.log`
for a success line.

## 5. Add the daily cron job

```
crontab -e
```

Add (confirm your UID with `id -u` first — this assumes 1000, the usual
first-user UID on Mint):

```
0 3 * * * DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /home/jennifer/Projects/journal-app/backup/venv/bin/python3 /home/jennifer/Projects/journal-app/backup/journal_backup.py >> /home/jennifer/.config/journal-backup/backup.log 2>&1
```

Runs daily at 3:00 AM. The `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS` vars let the
script's failure notifications (`notify-send`) reach your desktop session,
since cron jobs don't inherit it by default — if a run fails and you're not
logged in, the log file is the reliable fallback.

## Restoring a snapshot

Every snapshot is a complete, self-contained copy of `journal-entries.json`
— restoring means replacing the current Drive file's content with a chosen
snapshot's content, no merging or replay needed.

1. Pick the snapshot, e.g. `~/Dropbox/Backups/JournalBackups/journal-entries-2026-08-20.json`.
2. Either:
   - **Via Drive's web UI**: open `journal-entries.json` in Drive, use
     "Manage versions" / upload-to-replace with the snapshot file, or
   - **Via a one-off authenticated request**, mirroring what `app.js`'s
     `saveJournalsToDrive` does (`PATCH
     https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media`
     with the snapshot's bytes as the body and `Content-Type:
     application/json`), using a Drive-writable access token (e.g. copied
     from the app's own signed-in session via browser devtools, or a
     short-lived token from this backup client if its scope is temporarily
     widened).
3. Reload the journal-app PWA and confirm the expected entries appear.
