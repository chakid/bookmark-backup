import {
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_STATE,
  STORAGE_KEYS
} from "./constants.js";

function getStorageArea() {
  return chrome.storage.local;
}

export async function readStoredValue(key, fallbackValue) {
  const result = await getStorageArea().get(key);
  return result[key] ?? fallbackValue;
}

export async function writeStoredValue(key, value) {
  await getStorageArea().set({ [key]: value });
  return value;
}

export async function getSettings() {
  const [settings, backupSettings] = await Promise.all([
    readStoredValue(STORAGE_KEYS.settings, null),
    readStoredValue(STORAGE_KEYS.settingsBackup, null)
  ]);

  const resolvedSettings = settings ?? backupSettings ?? DEFAULT_SETTINGS;

  if (!settings && backupSettings) {
    await writeStoredValue(STORAGE_KEYS.settings, backupSettings);
  }

  return { ...DEFAULT_SETTINGS, ...resolvedSettings };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  await writeStoredValue(STORAGE_KEYS.settings, merged);
  await writeStoredValue(STORAGE_KEYS.settingsBackup, merged);
  return merged;
}

export async function getSyncState() {
  const state = await readStoredValue(STORAGE_KEYS.syncState, DEFAULT_SYNC_STATE);
  return { ...DEFAULT_SYNC_STATE, ...state };
}

export async function setSyncState(nextState) {
  const state = { ...DEFAULT_SYNC_STATE, ...nextState };
  await writeStoredValue(STORAGE_KEYS.syncState, state);
  return state;
}

export async function patchSyncState(patch) {
  const current = await getSyncState();
  const nextState = { ...current, ...patch };
  await writeStoredValue(STORAGE_KEYS.syncState, nextState);
  return nextState;
}

export async function resetSyncState(overrides = {}) {
  return setSyncState({ ...DEFAULT_SYNC_STATE, ...overrides });
}

export async function getDeviceId() {
  const existingId = await readStoredValue(STORAGE_KEYS.deviceId, "");
  if (existingId) {
    return existingId;
  }

  const generatedId = `device-${crypto.randomUUID()}`;
  await writeStoredValue(STORAGE_KEYS.deviceId, generatedId);
  return generatedId;
}

export async function getPublicStatus() {
  const [settings, syncState, deviceId] = await Promise.all([
    getSettings(),
    getSyncState(),
    getDeviceId()
  ]);

  return {
    settings: {
      providerType: settings.providerType,
      gistId: settings.gistId,
      autoSyncEnabled: settings.autoSyncEnabled,
      debounceMs: settings.debounceMs,
      hasToken: Boolean(settings.gistToken)
    },
    syncState,
    deviceId
  };
}
