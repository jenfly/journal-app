#!/usr/bin/env python3
"""Daily backup of journal-entries.json from Google Drive to a local Dropbox-synced folder.

Setup: see SETUP.md in this directory. Run with --interactive-auth once before
the first unattended (cron) run.
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import requests
from google.auth.exceptions import RefreshError, TransportError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

CONFIG_DIR = Path.home() / ".config" / "journal-backup"
CLIENT_SECRET_PATH = CONFIG_DIR / "client_secret.json"
TOKEN_PATH = CONFIG_DIR / "token.json"
LOG_PATH = CONFIG_DIR / "backup.log"

BACKUP_DIR = Path.home() / "Dropbox" / "Backups"  / "JournalBackups"
JOURNAL_FILENAME = "journal-entries.json"
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
RETENTION_DAYS = 31
FILENAME_RE = re.compile(r"^journal-entries-(\d{4}-\d{2}-\d{2})\.json$")

# The systemd timer's Persistent=true catch-up fires the moment the session
# wakes from sleep, which can race Wi-Fi reassociation/DHCP/DNS by a minute
# or more. Retry network errors with backoff instead of failing on the first
# attempt (~16 min total across the last two runs before giving up).
NETWORK_RETRY_DELAYS_SEC = [30, 60, 120, 240, 480]
NETWORK_ERRORS = (requests.exceptions.ConnectionError, TransportError)


class BackupError(Exception):
    pass


def notify_failure(message: str) -> None:
    logging.error(message)
    try:
        subprocess.run(
            ["notify-send", "-u", "critical", "Journal backup failed", message],
            check=False,
        )
    except FileNotFoundError:
        pass


def fatal(message: str, exc: Exception | None = None) -> None:
    if exc is not None:
        logging.error(message, exc_info=exc)
    notify_failure(message)
    sys.exit(1)


def run_interactive_auth() -> None:
    if not CLIENT_SECRET_PATH.exists():
        print(f"Missing {CLIENT_SECRET_PATH} — see SETUP.md.", file=sys.stderr)
        sys.exit(1)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(CONFIG_DIR, 0o700)

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_PATH), SCOPES)
    creds = flow.run_local_server(port=0)

    TOKEN_PATH.write_text(creds.to_json())
    os.chmod(TOKEN_PATH, 0o600)
    print(f"Saved credentials to {TOKEN_PATH}")


def load_credentials() -> Credentials:
    if not TOKEN_PATH.exists():
        fatal(f"{TOKEN_PATH} not found — run with --interactive-auth first.")

    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError as e:
            fatal(
                "Google Drive auth refresh failed — token likely revoked. "
                "Re-run with --interactive-auth to reauthenticate.",
                e,
            )
        TOKEN_PATH.write_text(creds.to_json())
        os.chmod(TOKEN_PATH, 0o600)

    return creds


def find_journal_file_id(creds: Credentials) -> str:
    q = f"name='{JOURNAL_FILENAME}' and trashed=false"
    resp = requests.get(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {creds.token}"},
        params={"q": q, "fields": "files(id,name)", "spaces": "drive"},
    )
    if not resp.ok:
        raise BackupError(f"Drive files.list failed: {resp.status_code} {resp.text[:200]}")
    files = resp.json().get("files", [])
    if not files:
        raise BackupError(f"{JOURNAL_FILENAME} not found in Drive")
    return files[0]["id"]


def download_file_content(creds: Credentials, file_id: str) -> bytes:
    resp = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {creds.token}"},
        params={"alt": "media"},
    )
    if not resp.ok:
        raise BackupError(f"Drive files.get failed: {resp.status_code} {resp.text[:200]}")
    content = resp.content
    try:
        json.loads(content)
    except json.JSONDecodeError as e:
        raise BackupError(f"Downloaded content is not valid JSON: {e}") from e
    return content


def write_snapshot(content: bytes, run_date: date) -> Path:
    if not BACKUP_DIR.parent.exists():
        raise BackupError(f"{BACKUP_DIR.parent} does not exist — is Dropbox installed/synced?")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    target = BACKUP_DIR / f"journal-entries-{run_date.isoformat()}.json"
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(content)
    os.replace(tmp, target)
    return target


def purge_old_snapshots(today: date) -> None:
    dated = []
    for path in BACKUP_DIR.glob("journal-entries-*.json"):
        m = FILENAME_RE.match(path.name)
        if not m:
            logging.warning(f"Skipping unrecognized file in backup dir: {path.name}")
            continue
        dated.append((date.fromisoformat(m.group(1)), path))

    dated.sort(key=lambda pair: pair[0], reverse=True)
    for _, path in dated[RETENTION_DAYS:]:
        path.unlink()
        logging.info(f"Purged old snapshot: {path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interactive-auth", action="store_true")
    args = parser.parse_args()

    if args.interactive_auth:
        run_interactive_auth()
        return

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_PATH,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    for attempt, delay in enumerate([0, *NETWORK_RETRY_DELAYS_SEC]):
        if delay:
            logging.warning(f"Network error, retrying in {delay}s (attempt {attempt + 1})")
            time.sleep(delay)
        try:
            creds = load_credentials()
            file_id = find_journal_file_id(creds)
            content = download_file_content(creds, file_id)
            snapshot_path = write_snapshot(content, date.today())
            purge_old_snapshots(date.today())
            logging.info(f"Backup OK: {snapshot_path}")
            return
        except BackupError as e:
            fatal(str(e), e)
        except NETWORK_ERRORS as e:
            last_network_error = e
        except Exception as e:
            fatal(f"Unexpected error: {e}", e)

    fatal(
        f"Backup failed after {len(NETWORK_RETRY_DELAYS_SEC) + 1} attempts "
        "due to network errors (is the machine online?)",
        last_network_error,
    )


if __name__ == "__main__":
    main()
