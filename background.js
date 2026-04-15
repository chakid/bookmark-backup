import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./lib/constants.js";
import {
  buildBookmarkSearchIndex,
  normalizeBookmarkTree,
  searchBookmarkIndex,
  summarizeNormalizedTree
} from "./lib/bookmarks.js";
import { maskToken } from "./lib/utils.js";
import {
  getPublicStatus,
  getSettings,
  getSyncState,
  patchSyncState,
  resetSyncState,
  saveSettings
} from "./lib/storage.js";
import { SyncEngine } from "./lib/sync-engine.js";

let syncTimer = null;
let bookmarkMutationLocks = 0;
let bookmarkSearchCache = null;
let engineInstance = null;
const SYNC_ALARM_NAME = "bookmarkBackup.sync";

function getEngine() {
  if (!engineInstance) {
    engineInstance = new SyncEngine();
  }

  return engineInstance;
}

async function readSearchCacheFromStorage() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.searchCache);
  return result[STORAGE_KEYS.searchCache] ?? null;
}

async function writeSearchCache(index) {
  bookmarkSearchCache = index;
  await chrome.storage.local.set({
    [STORAGE_KEYS.searchCache]: index
  });
}

async function refreshSearchCache() {
  const rawTree = await chrome.bookmarks.getTree();
  const index = buildBookmarkSearchIndex(rawTree);
  await writeSearchCache(index);
  return index;
}

async function loadSearchSummary() {
  const rawTree = await chrome.bookmarks.getTree();
  return summarizeNormalizedTree(normalizeBookmarkTree(rawTree));
}

async function ensureSearchCache() {
  if (bookmarkSearchCache) {
    return bookmarkSearchCache;
  }

  const cached = await readSearchCacheFromStorage();
  if (cached) {
    bookmarkSearchCache = cached;
    return cached;
  }

  return refreshSearchCache();
}

async function scheduleSync(reason, forceImmediate = false) {
  const settings = await getSettings();
  const delay = forceImmediate ? 0 : Math.max(5000, settings.debounceMs ?? DEFAULT_SETTINGS.debounceMs);

  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.scheduledSync]: {
      reason
    }
  });

  await chrome.alarms.clear(SYNC_ALARM_NAME);
  await chrome.alarms.create(SYNC_ALARM_NAME, {
    when: Date.now() + delay
  });
}

async function markLocalChange(reason) {
  if (bookmarkMutationLocks > 0) {
    return;
  }

  await refreshSearchCache();
  const currentState = await getSyncState();
  await patchSyncState({
    pendingLocalChanges: true,
    lastError: null,
    status: currentState.status === "conflict" ? currentState.status : "idle"
  });
  await scheduleSync(reason);
}

async function withBookmarkMutationLock(task) {
  bookmarkMutationLocks += 1;
  try {
    return await task();
  } finally {
    setTimeout(() => {
      bookmarkMutationLocks = Math.max(0, bookmarkMutationLocks - 1);
    }, 500);
  }
}

async function handleSettingsSave(nextSettings) {
  const current = await getSettings();
  const saved = await saveSettings(nextSettings);
  const connectionChanged =
    current.providerType !== saved.providerType ||
    current.gistId !== saved.gistId ||
    current.gistToken !== saved.gistToken;

  if (connectionChanged) {
    await resetSyncState({
      gistId: saved.gistId
    });
  }

  return {
    ok: true,
    settings: {
      ...saved,
      gistToken: "",
      gistTokenMasked: maskToken(saved.gistToken)
    }
  };
}

async function sendToActiveTab(message) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!activeTab?.id) {
    return {
      ok: false,
      error: "No active tab available"
    };
  }

  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  Promise.resolve()
    .then(() => refreshSearchCache())
    .catch(console.error);
  Promise.resolve()
    .then(() => scheduleSync("install", true))
    .catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  Promise.resolve()
    .then(() => refreshSearchCache())
    .catch(console.error);
  Promise.resolve()
    .then(() => scheduleSync("startup", true))
    .catch(console.error);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-quick-search") {
    return;
  }

  sendToActiveTab({ type: "TOGGLE_QUICK_SEARCH" }).catch(console.error);
});

chrome.bookmarks.onCreated.addListener(() => {
  markLocalChange("bookmark-event").catch(console.error);
});

chrome.bookmarks.onRemoved.addListener(() => {
  markLocalChange("bookmark-event").catch(console.error);
});

chrome.bookmarks.onChanged.addListener(() => {
  markLocalChange("bookmark-event").catch(console.error);
});

chrome.bookmarks.onMoved.addListener(() => {
  markLocalChange("bookmark-event").catch(console.error);
});

chrome.bookmarks.onChildrenReordered.addListener(() => {
  markLocalChange("bookmark-event").catch(console.error);
});

chrome.bookmarks.onImportEnded.addListener(() => {
  markLocalChange("import-ended").catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM_NAME) {
    return;
  }

  Promise.resolve()
    .then(async () => {
      const result = await chrome.storage.local.get(STORAGE_KEYS.scheduledSync);
      const scheduledSync = result[STORAGE_KEYS.scheduledSync];
      await chrome.storage.local.remove(STORAGE_KEYS.scheduledSync);
      await getEngine().sync({
        reason: scheduledSync?.reason ?? "scheduled"
      });
    })
    .catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "LOAD_STATUS":
        return getPublicStatus();
      case "LOAD_SETTINGS": {
        const settings = await getSettings();
        return {
          ...settings,
          gistToken: "",
          gistTokenMasked: maskToken(settings.gistToken)
        };
      }
      case "SAVE_SETTINGS":
        return handleSettingsSave(message.payload ?? {});
      case "VERIFY_PROVIDER":
        return getEngine().verifyProvider();
      case "SYNC_NOW":
        return getEngine().sync({ reason: "manual", forcePush: true });
      case "LOAD_REMOTE_SUMMARY":
        return getEngine().loadRemoteSnapshotSummary();
      case "RESTORE_LATEST":
        return withBookmarkMutationLock(async () => {
          const result = await getEngine().restoreLatestToLocal();
          await refreshSearchCache();
          return result;
        });
      case "SEARCH_BOOKMARKS": {
        const index = await ensureSearchCache();
        return {
          ok: true,
          results: searchBookmarkIndex(index, message.query ?? "", message.limit ?? 20)
        };
      }
      case "LOAD_SEARCH_SUMMARY":
        return {
          ok: true,
          summary: await loadSearchSummary()
        };
      case "OPEN_BOOKMARK_TAB":
        await chrome.tabs.create({ url: message.url });
        return { ok: true };
      case "RESOLVE_CONFLICT":
        return getEngine().resolveConflict(message.strategy);
      default:
        return {
          ok: false,
          error: "Unknown message type"
        };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });

  return true;
});
