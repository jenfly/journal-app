// ---- Google Sign-In (Google Identity Services) ----
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

const signinBtn = document.getElementById("signin-btn");
const signoutBtn = document.getElementById("signout-btn");
const authSection = document.getElementById("auth-section");
const authStatus = document.getElementById("auth-status");
const appStatus = document.getElementById("status");
const settingsBtn = document.getElementById("settings-btn");
const settingsMenu = document.getElementById("settings-menu");
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
let journalFileId = null;
let journals = [];
let activeJournalId = null;
let editingTimestamp = null;
let journalNameMode = null; // "create" | "rename"
let journalNameTargetId = null;
let journalDeleteTargetId = null;

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

function setSignedInUI(signedIn) {
  authSection.classList.toggle("hidden", signedIn);
  settingsBtn.classList.toggle("hidden", !signedIn);
  journalSection.classList.toggle("hidden", !signedIn);
  fab.classList.toggle("hidden", !signedIn);
  journalTitleBtn.disabled = !signedIn;
  authStatus.textContent = "Sign in to view your journal";
  if (!signedIn) {
    closeSettingsMenu();
    closeJournalMenu();
    closeJournalOverlay();
    closeEditor();
    journals = [];
    activeJournalId = null;
    journalFileId = null;
    journalTitleText.textContent = "Journal";
    entriesList.innerHTML = "";
    emptyState.classList.add("hidden");
    appStatus.textContent = "";
  }
}

function closeSettingsMenu() {
  settingsMenu.classList.add("hidden");
  settingsBtn.setAttribute("aria-expanded", "false");
}

function closeJournalMenu() {
  journalMenu.classList.add("hidden");
  journalTitleBtn.setAttribute("aria-expanded", "false");
}

function handleTokenResponse(response) {
  if (response.error) {
    console.warn("Google token request did not complete:", response.error);
    setSignedInUI(false);
    return;
  }
  accessToken = response.access_token;
  storeToken(accessToken, response.expires_in);
  setSignedInUI(true);
  initJournals();
}

window.addEventListener("load", () => {
  if (typeof google === "undefined" || !google.accounts) {
    authStatus.textContent = "Google Sign-In failed to load";
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: handleTokenResponse,
    error_callback: (err) => {
      console.warn("Google auth error:", err);
      setSignedInUI(false);
    },
  });

  const cached = loadStoredToken();
  if (cached) {
    accessToken = cached;
    setSignedInUI(true);
    initJournals();
  } else if (localStorage.getItem(HAS_SIGNED_IN_KEY) === "true") {
    // Silent re-auth attempt — succeeds if the browser still has an active
    // Google session (auth persistence plan, option 1).
    tokenClient.requestAccessToken({ prompt: "none" });
  }
});

signinBtn.addEventListener("click", () => {
  tokenClient.requestAccessToken({ prompt: "consent" });
});

signoutBtn.addEventListener("click", () => {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(HAS_SIGNED_IN_KEY);
  setSignedInUI(false);
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !settingsMenu.classList.contains("hidden");
  closeJournalMenu();
  if (isOpen) {
    closeSettingsMenu();
  } else {
    settingsMenu.classList.remove("hidden");
    settingsBtn.setAttribute("aria-expanded", "true");
  }
});

journalTitleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !journalMenu.classList.contains("hidden");
  closeSettingsMenu();
  if (isOpen) {
    closeJournalMenu();
  } else {
    journalMenu.classList.remove("hidden");
    journalTitleBtn.setAttribute("aria-expanded", "true");
  }
});

document.addEventListener("click", (e) => {
  if (!settingsMenu.classList.contains("hidden") && !e.target.closest(".settings")) {
    closeSettingsMenu();
  }
  if (!journalMenu.classList.contains("hidden") && !e.target.closest(".journal-switcher")) {
    closeJournalMenu();
  }
});

// ---- Drive-backed journal storage ----
// Journals live in a single JSON file in the user's Drive, shaped as
// { journals: [{id, name, entries: [{timestamp, text}]}] }. drive.file scope
// means files.list only ever sees files this app created, so the query below
// can't collide with unrelated files of the same name elsewhere in the
// user's Drive.

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

function resolveActiveJournalId() {
  const stored = localStorage.getItem(LAST_JOURNAL_KEY);
  if (stored && journals.some((j) => j.id === stored)) return stored;
  return journals[0].id;
}

async function initJournals() {
  appStatus.textContent = "Loading journal…";
  try {
    journalFileId = await findJournalFileId();
    let migrated = false;
    if (!journalFileId) {
      const created = await createJournalFile();
      journalFileId = created.fileId;
      journals = created.journals;
    } else {
      const loaded = await loadJournalsFromDrive(journalFileId);
      journals = loaded.journals;
      migrated = loaded.migrated;
    }
    activeJournalId = resolveActiveJournalId();
    appStatus.textContent = "";
    renderJournalMenu();
    renderActiveJournal();
    if (migrated) await persistJournals();
  } catch (err) {
    console.error(err);
    appStatus.textContent = "Could not load journal from Drive";
  }
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

journalNameSaveBtn.addEventListener("click", async () => {
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
  await persistJournals();
});

journalDeleteConfirmBtn.addEventListener("click", async () => {
  const targetId = journalDeleteTargetId;
  journals = journals.filter((j) => j.id !== targetId);
  closeJournalOverlay();
  if (targetId === activeJournalId) {
    setActiveJournal(journals[0].id);
  } else {
    renderJournalMenu();
  }
  await persistJournals();
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

let pendingPersist = Promise.resolve();

function persistJournals() {
  pendingPersist = pendingPersist.then(runPersist, runPersist);
  return pendingPersist;
}

async function runPersist() {
  appStatus.textContent = "Saving…";
  try {
    await saveJournalsToDrive(journalFileId, journals);
    appStatus.textContent = "";
  } catch (err) {
    console.error(err);
    appStatus.textContent = "Save failed — try again";
  }
}

editorDoneBtn.addEventListener("click", async () => {
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
  await persistJournals();
});

deleteBtn.addEventListener("click", () => {
  editorPanel.classList.add("hidden");
  confirmDeletePanel.classList.remove("hidden");
});

confirmDeleteCancelBtn.addEventListener("click", () => {
  confirmDeletePanel.classList.add("hidden");
  editorPanel.classList.remove("hidden");
});

confirmDeleteBtn.addEventListener("click", async () => {
  const journal = getActiveJournal();
  journal.entries = journal.entries.filter((en) => en.timestamp !== editingTimestamp);
  closeEditor();
  renderEntries();
  await persistJournals();
});

// Service worker registration — enables installability + offline shell.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
