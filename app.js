// ---- Google Sign-In (Google Identity Services) ----
// Drive is no longer required for the app to open or work (see CLAUDE.md / the Supabase sync
// migration). It's used only for the one-time import of pre-existing Drive data on an upgraded
// device, and for the manual "Back up to Drive" action — there is no sign-in wall.
// The client ID is not a secret in this flow — there's no server to hold a
// client secret, so Google expects it embedded in front-end code. Access is
// actually restricted via the Authorized JavaScript origins configured for
// this client ID in Google Cloud Console, not by hiding the ID.
const GOOGLE_CLIENT_ID = "619264296955-86r1crbhgret4jf27bb1hjm75jo3vlka.apps.googleusercontent.com";
// drive.file: the app can only see/create files it created itself (or files
// the user picks via a Picker UI, which this app doesn't use). That's exactly
// what the journal file needs — no broader Drive access required.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const JOURNAL_FILENAME = "journal-entries.json";

// Prefixed because journal-app and pwa-starter are both served from
// https://jenfly.github.io (different paths, same origin), so localStorage
// is shared between them — unprefixed keys would collide.
const TOKEN_STORAGE_KEY = "journal_app_google_access_token";
const HAS_SIGNED_IN_KEY = "journal_app_google_has_signed_in";
const LAST_JOURNAL_KEY = "journal_app_last_journal_id";

// ---- Local cache: the always-used local copy (see logic.js for validDoc/isPristine/etc.) ----
const CACHE_KEY = "journal_app_v1";
const IMPORTED_KEY = "journal_app_v1:imported";
const DRIVE_BACKUP_AT_KEY = "journal_app_drive_backup_at";

const importSection = document.getElementById("import-section");
const importBtn = document.getElementById("import-btn");
const appStatus = document.getElementById("status");
const saveErrorEl = document.getElementById("save-error");
const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsCloseBtn = document.getElementById("settings-close-btn");
const syncToast = document.getElementById("sync-toast");
const syncSignedOut = document.getElementById("sync-signed-out");
const syncSignedIn = document.getElementById("sync-signed-in");
const syncChoose = document.getElementById("sync-choose");
const syncEmailEl = document.getElementById("sync-email");
const syncStatusText = document.getElementById("sync-status-text");
const syncSigninBtn = document.getElementById("sync-signin-btn");
const syncNowBtn = document.getElementById("sync-now-btn");
const syncSignoutBtn = document.getElementById("sync-signout-btn");
const syncChooseText = document.getElementById("sync-choose-text");
const syncChooseMergeBtn = document.getElementById("sync-choose-merge-btn");
const syncChooseCloudBtn = document.getElementById("sync-choose-cloud-btn");
const syncChooseDeviceBtn = document.getElementById("sync-choose-device-btn");
const backupBtn = document.getElementById("backup-btn");
const backupStatus = document.getElementById("backup-status");
const signoutBtn = document.getElementById("signout-btn");
const journalSection = document.getElementById("journal-section");
const entriesList = document.getElementById("entries");
const emptyState = document.getElementById("empty");
const fab = document.getElementById("fab");
const editorOverlay = document.getElementById("editor-overlay");
const editorPanel = document.getElementById("editor-panel");
const editorTitle = document.getElementById("editor-title");
const editorTextarea = document.getElementById("editor-textarea");
const editorCancelBtn = document.getElementById("editor-cancel-btn");
const editorDoneBtn = document.getElementById("editor-done-btn");
const deleteBtn = document.getElementById("delete-btn");
const confirmDeletePanel = document.getElementById("confirm-delete-panel");
const confirmDeleteCancelBtn = document.getElementById("confirm-delete-cancel-btn");
const confirmDeleteBtn = document.getElementById("confirm-delete-btn");

const journalTitleBtn = document.getElementById("journal-title-btn");
const journalTitleText = document.getElementById("journal-title");
const journalMenu = document.getElementById("journal-menu");
const journalMenuList = document.getElementById("journal-menu-list");
const journalNewBtn = document.getElementById("journal-new-btn");
const journalExportBtn = document.getElementById("journal-export-btn");
const journalOverlay = document.getElementById("journal-overlay");
const journalNamePanel = document.getElementById("journal-name-panel");
const journalNameTitle = document.getElementById("journal-name-title");
const journalNameInput = document.getElementById("journal-name-input");
const journalNameCancelBtn = document.getElementById("journal-name-cancel-btn");
const journalNameSaveBtn = document.getElementById("journal-name-save-btn");
const journalDeletePanel = document.getElementById("journal-delete-panel");
const journalDeleteText = document.getElementById("journal-delete-text");
const journalDeleteCancelBtn = document.getElementById("journal-delete-cancel-btn");
const journalDeleteConfirmBtn = document.getElementById("journal-delete-confirm-btn");

let tokenClient;
let accessToken = null;
let journals = [];
let activeJournalId = null;
let editingTimestamp = null;
let journalNameMode = null; // "create" | "rename"
let journalNameTargetId = null;
let journalDeleteTargetId = null;
let pendingTokenResolve = null;
let pendingTokenReject = null;

function loadStoredToken() {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt) return token;
  } catch {
    // fall through to cleanup below
  }
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  return null;
}

function storeToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, expiresAt }));
  localStorage.setItem(HAS_SIGNED_IN_KEY, "true");
}

function openSettingsPanel() {
  settingsOverlay.classList.remove("hidden");
  settingsBtn.setAttribute("aria-expanded", "true");
  renderSyncUI();
}

function closeSettingsPanel() {
  settingsOverlay.classList.add("hidden");
  settingsBtn.setAttribute("aria-expanded", "false");
}

function closeJournalMenu() {
  journalMenu.classList.add("hidden");
  journalTitleBtn.setAttribute("aria-expanded", "false");
}

// handleTokenResponse / error_callback resolve or reject whichever request is currently
// pending — requestDriveToken below promisifies the single callback GIS gives us.
function handleTokenResponse(response) {
  if (response.error) {
    console.warn("Google token request did not complete:", response.error);
    if (pendingTokenReject) pendingTokenReject(new Error(response.error));
    pendingTokenResolve = pendingTokenReject = null;
    return;
  }
  accessToken = response.access_token;
  storeToken(accessToken, response.expires_in);
  if (pendingTokenResolve) pendingTokenResolve(accessToken);
  pendingTokenResolve = pendingTokenReject = null;
}

function requestDriveToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("Google Sign-In unavailable"));
      return;
    }
    pendingTokenResolve = resolve;
    pendingTokenReject = reject;
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "none" });
  });
}

window.addEventListener("load", () => {
  if (typeof google === "undefined" || !google.accounts) {
    console.warn("Google Sign-In failed to load — Drive import/backup unavailable, journal still works locally");
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: handleTokenResponse,
    error_callback: (err) => {
      console.warn("Google auth error:", err);
      if (pendingTokenReject) pendingTokenReject(new Error((err && err.type) || "auth-error"));
      pendingTokenResolve = pendingTokenReject = null;
    },
  });

  accessToken = loadStoredToken();
});

// "Disconnect Google Drive" — unrelated to the journal itself (which lives in localStorage):
// this only revokes the Drive token used for backup/import. Supabase sign-out (when sync
// exists) is a separate action in its own section.
signoutBtn.addEventListener("click", () => {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(HAS_SIGNED_IN_KEY);
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeJournalMenu();
  openSettingsPanel();
});

settingsCloseBtn.addEventListener("click", closeSettingsPanel);

journalTitleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !journalMenu.classList.contains("hidden");
  if (isOpen) {
    closeJournalMenu();
  } else {
    journalMenu.classList.remove("hidden");
    journalTitleBtn.setAttribute("aria-expanded", "true");
  }
});

document.addEventListener("click", (e) => {
  if (!journalMenu.classList.contains("hidden") && !e.target.closest(".journal-switcher")) {
    closeJournalMenu();
  }
});

// ---- Drive-backed storage ----
// Kept for two purposes only: the one-time import below, and a manual "Back up to Drive"
// action (not yet built — see the Supabase sync handoff doc). Journals live in a single JSON
// file in the user's Drive, shaped as { journals: [{id, name, entries: [{timestamp, text}]}] }.
// drive.file scope means files.list only ever sees files this app created, so the query below
// can't collide with unrelated files of the same name elsewhere in the user's Drive.

function generateJournalId() {
  return crypto.randomUUID();
}

function getActiveJournal() {
  return journals.find((j) => j.id === activeJournalId) || journals[0];
}

async function driveApiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  return res;
}

async function findJournalFileId() {
  const q = encodeURIComponent(`name='${JOURNAL_FILENAME}' and trashed=false`);
  const res = await driveApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`
  );
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function createJournalFile() {
  const defaultJournals = [{ id: generateJournalId(), name: "Journal", entries: [] }];
  const boundary = "journal_app_boundary";
  const metadata = { name: JOURNAL_FILENAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify({ journals: defaultJournals })}\r\n` +
    `--${boundary}--`;

  const res = await driveApiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  const data = await res.json();
  return { fileId: data.id, journals: defaultJournals };
}

async function loadJournalsFromDrive(fileId) {
  const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const text = await res.text();

  let parsed;
  try {
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (Array.isArray(parsed)) {
    return {
      journals: [{ id: generateJournalId(), name: "Journal", entries: parsed }],
      migrated: true,
    };
  }
  if (parsed && Array.isArray(parsed.journals) && parsed.journals.length) {
    return { journals: parsed.journals, migrated: false };
  }
  return {
    journals: [{ id: generateJournalId(), name: "Journal", entries: [] }],
    migrated: true,
  };
}

async function saveJournalsToDrive(fileId, journalsToSave) {
  await driveApiFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ journals: journalsToSave }),
  });
}

// Manual "Back up to Drive" — the only remaining write path to Drive. There is deliberately
// no restore action: with the local cache (and, later, Supabase sync) as the real store,
// Drive is a one-way manual safety copy. Reuses an already-granted token if one is cached;
// otherwise asks for consent (an infrequent, user-initiated action, so a prompt here is
// expected, unlike the silent-first startup/import paths).
function renderBackupStatus() {
  const at = localStorage.getItem(DRIVE_BACKUP_AT_KEY);
  backupStatus.classList.remove("error");
  backupStatus.textContent = at
    ? "Last backup: " + formatTimestamp(new Date(Number(at)).toISOString())
    : "Never backed up to Drive.";
}

async function backupToDrive() {
  backupBtn.disabled = true;
  backupStatus.classList.remove("error");
  backupStatus.textContent = "Backing up…";
  try {
    if (!accessToken) await requestDriveToken(true);
    let fileId = await findJournalFileId();
    if (!fileId) {
      const created = await createJournalFile();
      fileId = created.fileId;
    }
    await saveJournalsToDrive(fileId, journals);
    localStorage.setItem(DRIVE_BACKUP_AT_KEY, String(Date.now()));
    renderBackupStatus();
  } catch (err) {
    console.error(err);
    accessToken = null; // force a fresh consent request if the user retries
    backupStatus.textContent = "Backup failed — try again.";
    backupStatus.classList.add("error");
  } finally {
    backupBtn.disabled = false;
  }
}

backupBtn.addEventListener("click", backupToDrive);

// ---- Local cache: load/save, startup flow, one-time Drive import ----
// loadLocal/saveLocal are the only read/write path for journals now. validDoc comes from
// logic.js (loaded before this file — see index.html).

function loadLocal() {
  let raw;
  try {
    raw = localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validDoc(parsed) ? parsed : null;
}

function setSaveError(show) {
  saveErrorEl.classList.toggle("hidden", !show);
}

// Writes the doc to localStorage synchronously. Returns whether the write succeeded. A failed
// write (quota, private mode) surfaces a persistent, visible error rather than failing silently
// — the in-memory `journals` is left untouched either way, so nothing is lost this session.
function saveLocal() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ journals }));
  } catch (err) {
    console.error(err);
    setSaveError(true);
    return false;
  }
  setSaveError(false);
  if (window.Sync) window.Sync.noteLocalChange();
  return true;
}

function resolveActiveJournalId() {
  const stored = localStorage.getItem(LAST_JOURNAL_KEY);
  if (stored && journals.some((j) => j.id === stored)) return stored;
  return journals[0].id;
}

function showMainUI(show) {
  journalSection.classList.toggle("hidden", !show);
  fab.classList.toggle("hidden", !show);
  settingsBtn.classList.toggle("hidden", !show);
  journalTitleBtn.disabled = !show;
}

function startFresh() {
  journals = [{ id: generateJournalId(), name: "Journal", entries: [] }];
  activeJournalId = journals[0].id;
  saveLocal();
}

function enterApp() {
  activeJournalId = resolveActiveJournalId();
  showMainUI(true);
  renderJournalMenu();
  renderActiveJournal();
  renderBackupStatus();
  initSync();
}

// ---- Supabase sync wiring (sync.js) ----
// Entries are irreplaceable, so unlike the sibling apps this one never does a blind
// last-write-wins replace when both sides changed — see logic.js's mergeDocs and
// syncPlan's 'merge' outcome, which sync.js always takes instead.

function initSync() {
  if (!window.Sync) return; // sync.js failed to load; the app still works local-only
  window.Sync.init({
    key: CACHE_KEY,
    getState: () => ({ journals }),
    applyState,
    busy,
    onChange: renderSyncUIIfRelevant,
    onError: (msg) => showSyncToast(msg, true),
    onPulled: () => showSyncToast("Updated from another device.", false),
    onMerged: (stats) => {
      let msg = "Merged changes from another device.";
      if (stats && stats.entryConflicts > 0) {
        msg += ` ${stats.entryConflicts} entr${stats.entryConflicts === 1 ? "y" : "ies"} edited on both devices — the newer edit was kept.`;
      }
      showSyncToast(msg, false);
    },
  });
}

// sync.js already validates the remote doc (validDoc) before ever calling this, both for a
// plain pull and for a merge result — no need to re-validate here.
function applyState(remoteDoc) {
  journals = JSON.parse(JSON.stringify(remoteDoc.journals));
  if (!journals.some((j) => j.id === activeJournalId)) activeJournalId = journals[0].id;
  saveLocal();
  renderJournalMenu();
  renderActiveJournal();
}

function showSyncToast(text, isError) {
  syncToast.textContent = text;
  syncToast.classList.toggle("hidden", !text);
  syncToast.classList.toggle("error", !!isError);
}

function formatRelativeTime(ms) {
  const mins = Math.round(Math.max(0, Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return mins + " min ago";
  const hours = Math.round(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return hours + " hours ago";
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : days + " days ago";
}

function syncStatusLabel(st) {
  if (st.phase === "syncing" || st.phase === "signing-in") return "Syncing…";
  if (st.phase === "offline") return "Offline — will sync when back online";
  if (st.phase === "error") return "Sync error" + (st.error ? ": " + st.error : "") + " — will retry";
  if (st.dirty) return "Changes pending…";
  if (st.syncedAt) return "Synced " + formatRelativeTime(st.syncedAt);
  return "Not yet synced";
}

function renderSyncUI() {
  if (!window.Sync) {
    syncSignedOut.classList.remove("hidden");
    syncSignedIn.classList.add("hidden");
    syncChoose.classList.add("hidden");
    return;
  }
  const st = window.Sync.status();

  syncChoose.classList.toggle("hidden", st.phase !== "choose");
  if (st.phase === "choose") {
    syncSignedOut.classList.add("hidden");
    syncSignedIn.classList.add("hidden");
    const c = st.choice;
    syncChooseText.textContent = c
      ? `This device has ${c.device.journals} journal(s) and ${c.device.entries} entries. ` +
        `The cloud has ${c.cloud.journals} journal(s) and ${c.cloud.entries} entries. ` +
        `Merge both to keep everything, or replace one side.`
      : "";
    return;
  }

  syncSignedOut.classList.toggle("hidden", st.signedIn);
  syncSignedIn.classList.toggle("hidden", !st.signedIn);
  if (st.signedIn) {
    syncEmailEl.textContent = st.email;
    syncStatusText.textContent = syncStatusLabel(st);
  }
}

// Re-render the sync section only while the settings panel is open; if a first-link choice
// just arrived and nothing else is mid-edit, open the panel so the user sees it.
function renderSyncUIIfRelevant(status) {
  if (!settingsOverlay.classList.contains("hidden")) renderSyncUI();
  if (status.phase === "choose" && settingsOverlay.classList.contains("hidden") && !busy()) {
    openSettingsPanel();
  }
}

syncSigninBtn.addEventListener("click", () => window.Sync && window.Sync.signIn());
syncSignoutBtn.addEventListener("click", () => window.Sync && window.Sync.signOut());
syncNowBtn.addEventListener("click", () => window.Sync && window.Sync.syncNow());
syncChooseMergeBtn.addEventListener("click", () => window.Sync && window.Sync.resolveChoice("merge"));
syncChooseCloudBtn.addEventListener("click", () => window.Sync && window.Sync.resolveChoice("cloud"));
syncChooseDeviceBtn.addEventListener("click", () => window.Sync && window.Sync.resolveChoice("device"));

// The existing-user upgrade path: this device has signed in to Drive before (so it may hold
// real entries there) but has no local cache yet. Tries a silent token first; if that fails,
// leaves the "Import your journal from Google Drive" button up for the user to tap. Never
// writes the cache unless the imported doc validates, and never runs once `imported` is set.
async function attemptImport(interactive) {
  appStatus.textContent = interactive
    ? "Importing your journal…"
    : "Checking for a previous Google Drive backup…";
  importBtn.classList.add("hidden");
  try {
    await requestDriveToken(interactive);
    const fileId = await findJournalFileId();
    if (!fileId) {
      // Signed in before, but no Drive file exists — nothing to import.
      startFresh();
      finishImport();
      return;
    }
    const loaded = await loadJournalsFromDrive(fileId);
    const importedDoc = { journals: loaded.journals };
    if (!validDoc(importedDoc)) throw new Error("Imported Drive data failed validation");
    journals = importedDoc.journals;
    activeJournalId = resolveActiveJournalId();
    saveLocal();
    finishImport();
  } catch (err) {
    console.error(err);
    appStatus.textContent = interactive
      ? "Could not import — check your connection and try again."
      : "We found a previous sign-in on this device. Import your journal to continue.";
    importBtn.classList.remove("hidden");
  }
}

function finishImport() {
  localStorage.setItem(IMPORTED_KEY, "true");
  importSection.classList.add("hidden");
  appStatus.textContent = "";
  enterApp();
  // One-time nudge, since this import only ever runs once per device (gated by IMPORTED_KEY).
  showSyncToast("Your journal was imported. Turn on sync in Settings to keep it updated across devices.", false);
}

importBtn.addEventListener("click", () => attemptImport(true));

async function initApp() {
  const cached = loadLocal();
  if (cached) {
    journals = cached.journals;
    enterApp();
    return;
  }

  const hasSignedIn = localStorage.getItem(HAS_SIGNED_IN_KEY) === "true";
  const alreadyImported = localStorage.getItem(IMPORTED_KEY) === "true";

  if (hasSignedIn && !alreadyImported) {
    importSection.classList.remove("hidden");
    await attemptImport(false);
    return;
  }

  startFresh();
  enterApp();
}

window.addEventListener("load", initApp);

// Two open tabs/windows (browser tab plus installed PWA) on the same cache: if the other one
// changed it while this one is idle (and nothing here is mid-edit), pick up the new state
// instead of silently overwriting it on this tab's next save.
function busy() {
  if (!editorOverlay.classList.contains("hidden")) return true;
  if (!journalOverlay.classList.contains("hidden")) return true;
  const active = document.activeElement;
  return !!(active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT"));
}

window.addEventListener("storage", (e) => {
  if (e.key !== CACHE_KEY || busy()) return;
  const cached = loadLocal();
  if (!cached) return;
  journals = cached.journals;
  if (!journals.some((j) => j.id === activeJournalId)) activeJournalId = journals[0].id;
  renderJournalMenu();
  renderActiveJournal();
});

function formatTimestamp(iso) {
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  let hours = d.getHours() % 12;
  if (hours === 0) hours = 12;
  const ampm = d.getHours() >= 12 ? "pm" : "am";
  return `${year}-${month}-${day} ${hours}:${minutes}${ampm}`;
}

function renderActiveJournal() {
  const journal = getActiveJournal();
  journalTitleText.textContent = journal.name;
  renderEntries();
}

function setActiveJournal(id) {
  activeJournalId = id;
  localStorage.setItem(LAST_JOURNAL_KEY, id);
  renderActiveJournal();
  renderJournalMenu();
  closeJournalMenu();
}

function renderJournalMenu() {
  journalMenuList.innerHTML = "";
  for (const journal of journals) {
    const row = document.createElement("div");
    row.className = "journal-menu-row";

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "journal-menu-name" + (journal.id === activeJournalId ? " active" : "");
    nameBtn.textContent = journal.name;
    nameBtn.addEventListener("click", () => setActiveJournal(journal.id));
    row.appendChild(nameBtn);

    const renameJournalBtn = document.createElement("button");
    renameJournalBtn.type = "button";
    renameJournalBtn.className = "icon-btn small";
    renameJournalBtn.setAttribute("aria-label", `Rename ${journal.name}`);
    renameJournalBtn.textContent = "✎";
    renameJournalBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openJournalNamePanel("rename", journal);
    });
    row.appendChild(renameJournalBtn);

    const deleteJournalBtn = document.createElement("button");
    deleteJournalBtn.type = "button";
    deleteJournalBtn.className = "icon-btn small danger";
    deleteJournalBtn.setAttribute("aria-label", `Delete ${journal.name}`);
    deleteJournalBtn.textContent = "\u{1F5D1}";
    deleteJournalBtn.disabled = journals.length <= 1;
    deleteJournalBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openJournalDeletePanel(journal);
    });
    row.appendChild(deleteJournalBtn);

    journalMenuList.appendChild(row);
  }
}

function exportActiveJournal() {
  const journal = getActiveJournal();
  const sorted = [...journal.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const lines = [`# ${journal.name}`, ""];
  for (const entry of sorted) {
    lines.push(`## ${formatTimestamp(entry.timestamp)}`, entry.text, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${journal.name}.md`;
  a.click();
  URL.revokeObjectURL(url);
  closeJournalMenu();
}

function openJournalNamePanel(mode, journal) {
  journalNameMode = mode;
  journalNameTargetId = journal ? journal.id : null;
  journalNameTitle.textContent = mode === "rename" ? "Rename journal" : "New journal";
  journalNameInput.value = mode === "rename" ? journal.name : "";
  journalNamePanel.classList.remove("hidden");
  journalDeletePanel.classList.add("hidden");
  journalOverlay.classList.remove("hidden");
  closeJournalMenu();
  journalNameInput.focus();
}

function openJournalDeletePanel(journal) {
  journalDeleteTargetId = journal.id;
  journalDeleteText.textContent = `Delete "${journal.name}"? This can't be undone.`;
  journalDeletePanel.classList.remove("hidden");
  journalNamePanel.classList.add("hidden");
  journalOverlay.classList.remove("hidden");
  closeJournalMenu();
}

function closeJournalOverlay() {
  journalOverlay.classList.add("hidden");
  journalNamePanel.classList.remove("hidden");
  journalDeletePanel.classList.add("hidden");
  journalNameMode = null;
  journalNameTargetId = null;
  journalDeleteTargetId = null;
  journalNameInput.value = "";
}

journalNewBtn.addEventListener("click", () => openJournalNamePanel("create"));
journalExportBtn.addEventListener("click", exportActiveJournal);

journalNameCancelBtn.addEventListener("click", closeJournalOverlay);
journalDeleteCancelBtn.addEventListener("click", closeJournalOverlay);

journalNameSaveBtn.addEventListener("click", () => {
  const name = journalNameInput.value.trim();
  if (!name) return;

  if (journalNameMode === "create") {
    const newJournal = { id: generateJournalId(), name, entries: [] };
    journals.push(newJournal);
    closeJournalOverlay();
    setActiveJournal(newJournal.id);
  } else {
    const journal = journals.find((j) => j.id === journalNameTargetId);
    if (journal) journal.name = name;
    closeJournalOverlay();
    renderJournalMenu();
    if (journal && journal.id === activeJournalId) renderActiveJournal();
  }
  saveLocal();
});

journalDeleteConfirmBtn.addEventListener("click", () => {
  const targetId = journalDeleteTargetId;
  journals = journals.filter((j) => j.id !== targetId);
  closeJournalOverlay();
  if (targetId === activeJournalId) {
    setActiveJournal(journals[0].id);
  } else {
    renderJournalMenu();
  }
  saveLocal();
});

function renderEntries() {
  entriesList.innerHTML = "";
  const entries = getActiveJournal().entries;
  const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const entry of sorted) {
    const li = document.createElement("li");
    li.className = "entry";
    li.dataset.timestamp = entry.timestamp;

    const time = document.createElement("time");
    time.textContent = formatTimestamp(entry.timestamp);

    const p = document.createElement("p");
    p.textContent = entry.text;

    li.appendChild(time);
    li.appendChild(p);
    entriesList.appendChild(li);
  }
  emptyState.classList.toggle("hidden", sorted.length > 0);
}

function openEditor(entry) {
  editingTimestamp = entry ? entry.timestamp : null;
  editorTitle.textContent = entry ? "Edit entry" : "New entry";
  editorTextarea.value = entry ? entry.text : "";
  deleteBtn.classList.toggle("hidden", !entry);
  editorPanel.classList.remove("hidden");
  confirmDeletePanel.classList.add("hidden");
  editorOverlay.classList.remove("hidden");
  editorTextarea.focus();
}

function closeEditor() {
  editorOverlay.classList.add("hidden");
  editorPanel.classList.remove("hidden");
  confirmDeletePanel.classList.add("hidden");
  editingTimestamp = null;
  editorTextarea.value = "";
}

fab.addEventListener("click", () => openEditor(null));

entriesList.addEventListener("click", (e) => {
  const li = e.target.closest(".entry");
  if (!li) return;
  const entry = getActiveJournal().entries.find((en) => en.timestamp === li.dataset.timestamp);
  if (entry) openEditor(entry);
});

editorCancelBtn.addEventListener("click", closeEditor);

editorDoneBtn.addEventListener("click", () => {
  const text = editorTextarea.value.trim();
  if (!text) {
    closeEditor();
    return;
  }

  const journal = getActiveJournal();
  if (editingTimestamp) {
    const entry = journal.entries.find((en) => en.timestamp === editingTimestamp);
    if (entry) entry.text = text;
  } else {
    journal.entries.push({ timestamp: new Date().toISOString(), text });
  }

  closeEditor();
  renderEntries();
  saveLocal();
});

deleteBtn.addEventListener("click", () => {
  editorPanel.classList.add("hidden");
  confirmDeletePanel.classList.remove("hidden");
});

confirmDeleteCancelBtn.addEventListener("click", () => {
  confirmDeletePanel.classList.add("hidden");
  editorPanel.classList.remove("hidden");
});

confirmDeleteBtn.addEventListener("click", () => {
  const journal = getActiveJournal();
  journal.entries = journal.entries.filter((en) => en.timestamp !== editingTimestamp);
  closeEditor();
  renderEntries();
  saveLocal();
});

// Service worker registration — enables installability + offline shell.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
