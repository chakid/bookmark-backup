export const SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
  settings: "bookmarkBackup.settings",
  settingsBackup: "bookmarkBackup.settings.backup",
  syncState: "bookmarkBackup.syncState",
  deviceId: "bookmarkBackup.deviceId",
  searchCache: "bookmarkBackup.searchCache",
  scheduledSync: "bookmarkBackup.scheduledSync"
};

export const FILE_NAMES = {
  manifest: "bookmark-backup.manifest.json",
  tree: "bookmark-backup.tree.json",
  history: "bookmark-backup.history.json",
  conflicts: "bookmark-backup.conflicts.json",
  latestConflict: "bookmark-backup.conflict.latest.json"
};

export const PROVIDER_TYPES = {
  gist: "gist",
  webdav: "webdav",
  localFolder: "local-folder"
};

export const SYNC_STATUS = {
  idle: "idle",
  syncing: "syncing",
  success: "success",
  conflict: "conflict",
  authError: "auth_error",
  networkError: "network_error"
};

export const CONFLICT_TYPE = {
  none: "none",
  remoteAhead: "remote_ahead",
  localAhead: "local_ahead",
  diverged: "diverged"
};

export const DEFAULT_SETTINGS = {
  providerType: PROVIDER_TYPES.gist,
  gistToken: "",
  gistId: "",
  autoSyncEnabled: true,
  debounceMs: 5000
};

export const DEFAULT_SYNC_STATE = {
  status: SYNC_STATUS.idle,
  lastSyncAt: null,
  lastRestoreAt: null,
  lastSyncReason: null,
  lastError: null,
  lastKnownRemoteVersionId: null,
  lastKnownRemoteTreeHash: null,
  lastSyncedTreeHash: null,
  lastObservedLocalTreeHash: null,
  pendingLocalChanges: false,
  remoteComparison: CONFLICT_TYPE.none,
  remoteSnapshotSummary: null,
  conflict: null,
  gistId: "",
  isSyncing: false
};

export const HISTORY_LIMIT = 20;
