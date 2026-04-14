import {
  CONFLICT_TYPE,
  SCHEMA_VERSION,
  SYNC_STATUS
} from "./constants.js";
import { buildSnapshotFromTree, summarizeNormalizedTree } from "./bookmarks.js";
import {
  getDeviceId,
  getSettings,
  saveSettings,
  getSyncState,
  patchSyncState
} from "./storage.js";
import { createBackupProvider } from "./providers/gist.js";

export function determineSyncPlan({
  localSnapshot,
  remoteBundle,
  syncState,
  forcePush = false
}) {
  const remoteVersion = remoteBundle.manifest?.latestVersion ?? null;
  const remoteTree = remoteBundle.tree ?? null;
  const baselineVersionId = syncState.lastKnownRemoteVersionId ?? null;
  const baselineTreeHash = syncState.lastSyncedTreeHash ?? null;
  const localTreeHash = localSnapshot.metadata.treeHash;

  if (!remoteVersion) {
    return {
      type: "push_local",
      conflictType: CONFLICT_TYPE.localAhead,
      expectedRevision: null
    };
  }

  if (remoteTree && remoteVersion.treeHash === localTreeHash) {
    return {
      type: "adopt_remote",
      conflictType: CONFLICT_TYPE.none,
      remoteVersion,
      remoteTree
    };
  }

  if (!baselineVersionId || !baselineTreeHash) {
    if (forcePush) {
      return {
        type: "push_local",
        conflictType: CONFLICT_TYPE.localAhead,
        expectedRevision: remoteVersion.versionId
      };
    }

    return {
      type: "conflict",
      conflictType: CONFLICT_TYPE.diverged,
      remoteVersion,
      remoteTree
    };
  }

  const localChanged = baselineTreeHash !== localTreeHash;
  const remoteChanged = baselineVersionId !== remoteVersion.versionId;

  if (remoteChanged && localChanged) {
    if (forcePush) {
      return {
        type: "push_local",
        conflictType: CONFLICT_TYPE.localAhead,
        expectedRevision: remoteVersion.versionId
      };
    }

    return {
      type: "conflict",
      conflictType: CONFLICT_TYPE.diverged,
      remoteVersion,
      remoteTree
    };
  }

  if (remoteChanged && !localChanged) {
    return {
      type: "adopt_remote",
      conflictType: CONFLICT_TYPE.remoteAhead,
      remoteVersion,
      remoteTree
    };
  }

  if (!remoteChanged && localChanged) {
    return {
      type: "push_local",
      conflictType: CONFLICT_TYPE.localAhead,
      expectedRevision: remoteVersion.versionId
    };
  }

  return {
    type: "noop",
    conflictType: CONFLICT_TYPE.none,
    remoteVersion,
    remoteTree
  };
}

async function callBookmarksGetTree() {
  return chrome.bookmarks.getTree();
}

function rootKeyForNode(node, index) {
  if (!node) {
    return `root-${index}`;
  }

  if (node.id === "1" || node.id === "2" || node.id === "3") {
    return node.id;
  }

  if (!node.url && typeof node.title === "string") {
    return node.title.toLowerCase();
  }

  return `root-${index}`;
}

async function clearChildren(bookmarkApi, parentNode) {
  const children = (parentNode.children ?? []).slice();
  for (const child of children) {
    if (Array.isArray(child.children)) {
      await bookmarkApi.removeTree(child.id);
    } else {
      await bookmarkApi.remove(child.id);
    }
  }
}

async function recreateChildren(bookmarkApi, parentId, children) {
  for (const child of children ?? []) {
    const created = await bookmarkApi.create({
      parentId,
      index: typeof child.index === "number" ? child.index : undefined,
      title: child.title ?? "",
      url: child.url ?? undefined
    });

    if (Array.isArray(child.children) && child.children.length > 0) {
      await recreateChildren(bookmarkApi, created.id, child.children);
    }
  }
}

export class SyncEngine {
  constructor({
    bookmarkTreeLoader = callBookmarksGetTree,
    settingsLoader = getSettings,
    settingsSaver = saveSettings,
    syncStateLoader = getSyncState,
    syncStatePatcher = patchSyncState,
    deviceIdLoader = getDeviceId,
    providerFactory = createBackupProvider,
    bookmarkApi = chrome.bookmarks
  } = {}) {
    this.bookmarkTreeLoader = bookmarkTreeLoader;
    this.settingsLoader = settingsLoader;
    this.settingsSaver = settingsSaver;
    this.syncStateLoader = syncStateLoader;
    this.syncStatePatcher = syncStatePatcher;
    this.deviceIdLoader = deviceIdLoader;
    this.providerFactory = providerFactory;
    this.bookmarkApi = bookmarkApi;
  }

  async setStatus(statusPatch) {
    return this.syncStatePatcher(statusPatch);
  }

  async buildLocalSnapshot(sourceRevision) {
    const [deviceId, rawTree] = await Promise.all([
      this.deviceIdLoader(),
      this.bookmarkTreeLoader()
    ]);

    const snapshot = await buildSnapshotFromTree(rawTree, sourceRevision, deviceId);
    snapshot.metadata.schemaVersion = SCHEMA_VERSION;
    return snapshot;
  }

  async verifyProvider() {
    const settings = await this.settingsLoader();
    if (!settings.gistToken) {
      await this.setStatus({
        status: SYNC_STATUS.authError,
        lastError: "Missing GitHub token"
      });

      return {
        ok: false,
        reason: "Missing GitHub token"
      };
    }

    const provider = this.providerFactory(settings);
    return provider.verifyConfig();
  }

  async loadRemoteSnapshotSummary() {
    const settings = await this.settingsLoader();
    if (!settings.gistToken) {
      return {
        ok: false,
        error: "Missing GitHub token"
      };
    }

    const provider = this.providerFactory(settings);
    const remoteBundle = await provider.loadLatest();
    if (!remoteBundle.manifest?.latestVersion || !remoteBundle.tree) {
      return {
        ok: false,
        error: "No remote backup found in the configured Gist"
      };
    }

    const summary = {
      ...summarizeNormalizedTree(remoteBundle.tree),
      versionId: remoteBundle.manifest.latestVersion.versionId,
      createdAt: remoteBundle.manifest.latestVersion.createdAt,
      treeHash: remoteBundle.manifest.latestVersion.treeHash
    };

    await this.setStatus({
      remoteSnapshotSummary: summary,
      gistId: settings.gistId
    });

    return {
      ok: true,
      summary
    };
  }

  async sync({ reason = "manual", forcePush = false } = {}) {
    const settings = await this.settingsLoader();

    if (!settings.autoSyncEnabled && reason === "bookmark-event") {
      return {
        ok: true,
        skipped: true,
        reason: "Auto sync disabled"
      };
    }

    if (!settings.gistToken) {
      await this.setStatus({
        status: SYNC_STATUS.authError,
        lastError: "Missing GitHub token",
        lastSyncReason: reason,
        isSyncing: false
      });

      return {
        ok: false,
        error: "Missing GitHub token"
      };
    }

    const provider = this.providerFactory(settings);
    const syncState = await this.syncStateLoader();

    await this.setStatus({
      status: SYNC_STATUS.syncing,
      lastError: null,
      lastSyncReason: reason,
      isSyncing: true
    });

    try {
      const remoteBundle = await provider.loadLatest();
      const localSnapshot = await this.buildLocalSnapshot(
        remoteBundle.manifest?.latestVersion?.versionId ?? syncState.lastKnownRemoteVersionId ?? null
      );

      const plan = determineSyncPlan({
        localSnapshot,
        remoteBundle,
        syncState,
        forcePush
      });

      if (plan.type === "noop") {
        await this.setStatus({
          status: SYNC_STATUS.success,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          lastObservedLocalTreeHash: localSnapshot.metadata.treeHash,
          pendingLocalChanges: false,
          isSyncing: false,
          remoteComparison: CONFLICT_TYPE.none
        });

        return {
          ok: true,
          action: plan.type
        };
      }

      if (plan.type === "adopt_remote") {
        const remoteSummary = plan.remoteTree ? summarizeNormalizedTree(plan.remoteTree) : null;
        await this.setStatus({
          status: SYNC_STATUS.success,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          lastKnownRemoteVersionId: plan.remoteVersion.versionId,
          lastKnownRemoteTreeHash: plan.remoteVersion.treeHash,
          lastSyncedTreeHash: plan.remoteVersion.treeHash,
          lastObservedLocalTreeHash: localSnapshot.metadata.treeHash,
          pendingLocalChanges: false,
          remoteComparison: plan.conflictType,
          remoteSnapshotSummary: remoteSummary
            ? {
                ...remoteSummary,
                versionId: plan.remoteVersion.versionId,
                createdAt: plan.remoteVersion.createdAt,
                treeHash: plan.remoteVersion.treeHash
              }
            : null,
          conflict: null,
          gistId: settings.gistId,
          isSyncing: false
        });

        return {
          ok: true,
          action: plan.type,
          remoteComparison: plan.conflictType
        };
      }

      if (plan.type === "push_local") {
        const saveResult = await provider.saveVersion(localSnapshot, plan.expectedRevision);
        const nextGistId = saveResult.gistId || settings.gistId;

        if (nextGistId && nextGistId !== settings.gistId) {
          await this.settingsSaver({
            ...settings,
            gistId: nextGistId
          });
        }

        await this.setStatus({
          status: SYNC_STATUS.success,
          lastSyncAt: localSnapshot.metadata.createdAt,
          lastError: null,
          lastKnownRemoteVersionId: localSnapshot.metadata.versionId,
          lastKnownRemoteTreeHash: localSnapshot.metadata.treeHash,
          lastSyncedTreeHash: localSnapshot.metadata.treeHash,
          lastObservedLocalTreeHash: localSnapshot.metadata.treeHash,
          pendingLocalChanges: false,
          remoteComparison: CONFLICT_TYPE.none,
          remoteSnapshotSummary: {
            ...summarizeNormalizedTree(localSnapshot.normalizedTree),
            versionId: localSnapshot.metadata.versionId,
            createdAt: localSnapshot.metadata.createdAt,
            treeHash: localSnapshot.metadata.treeHash
          },
          conflict: null,
          gistId: nextGistId,
          isSyncing: false
        });

        return {
          ok: true,
          action: plan.type,
          gistId: nextGistId,
          versionId: localSnapshot.metadata.versionId
        };
      }

      const conflictRecord = {
        type: plan.conflictType,
        detectedAt: new Date().toISOString(),
        localVersion: localSnapshot.metadata,
        remoteVersion: plan.remoteVersion,
        localTree: localSnapshot.normalizedTree,
        remoteTree: plan.remoteTree
      };

      await provider.saveConflict(conflictRecord, remoteBundle.manifest);

      await this.setStatus({
        status: SYNC_STATUS.conflict,
        lastError: "Local bookmarks and remote backup both changed since the last known baseline.",
        lastObservedLocalTreeHash: localSnapshot.metadata.treeHash,
        pendingLocalChanges: true,
        remoteComparison: plan.conflictType,
        remoteSnapshotSummary: {
          ...summarizeNormalizedTree(plan.remoteTree ?? []),
          versionId: plan.remoteVersion.versionId,
          createdAt: plan.remoteVersion.createdAt,
          treeHash: plan.remoteVersion.treeHash
        },
        conflict: conflictRecord,
        gistId: settings.gistId,
        isSyncing: false
      });

      return {
        ok: false,
        action: plan.type,
        conflict: conflictRecord
      };
    } catch (error) {
      const status =
        error.status === 401 || error.status === 403
          ? SYNC_STATUS.authError
          : SYNC_STATUS.networkError;
      const message =
        error.status === 404
          ? "Configured Gist ID was not found. Clear the Gist ID field to auto-create a new private Gist, or enter a valid existing Gist ID."
          : error.message;

      await this.setStatus({
        status,
        lastError: message,
        isSyncing: false
      });

      return {
        ok: false,
        error: message
      };
    }
  }

  async resolveConflict(strategy) {
    const syncState = await this.syncStateLoader();
    const conflict = syncState.conflict;

    if (!conflict) {
      return {
        ok: false,
        error: "No active conflict"
      };
    }

    if (strategy === "accept_remote") {
      await this.setStatus({
        status: SYNC_STATUS.success,
        lastSyncAt: new Date().toISOString(),
        lastKnownRemoteVersionId: conflict.remoteVersion.versionId,
        lastKnownRemoteTreeHash: conflict.remoteVersion.treeHash,
        lastSyncedTreeHash: conflict.remoteVersion.treeHash,
        remoteComparison: CONFLICT_TYPE.remoteAhead,
        pendingLocalChanges: false,
        conflict: null,
        lastError: null
      });

      return {
        ok: true,
        action: "accept_remote"
      };
    }

    if (strategy === "use_local") {
      return this.sync({
        reason: "conflict-resolution",
        forcePush: true
      });
    }

    return {
      ok: false,
      error: `Unknown conflict strategy: ${strategy}`
    };
  }

  async restoreLatestToLocal() {
    const settings = await this.settingsLoader();
    if (!settings.gistToken) {
      return {
        ok: false,
        error: "Missing GitHub token"
      };
    }

    const provider = this.providerFactory(settings);
    await this.setStatus({
      status: SYNC_STATUS.syncing,
      lastError: null,
      isSyncing: true
    });

    try {
      const remoteBundle = await provider.loadLatest();
      if (!remoteBundle.manifest?.latestVersion || !remoteBundle.tree?.length) {
        throw new Error("No remote backup found in the configured Gist");
      }

      const localTree = await this.bookmarkTreeLoader();
      const localRoot = localTree[0];
      const remoteRoot = remoteBundle.tree[0];

      if (!localRoot || !remoteRoot) {
        throw new Error("Unable to resolve local or remote bookmark root");
      }

      const localRootMap = new Map(
        (localRoot.children ?? []).map((node, index) => [rootKeyForNode(node, index), node])
      );

      const remoteRootMap = new Map(
        (remoteRoot.children ?? []).map((node, index) => [rootKeyForNode(node, index), node])
      );

      for (const [key, localNode] of localRootMap) {
        const remoteNode = remoteRootMap.get(key);
        await clearChildren(this.bookmarkApi, localNode);
        await recreateChildren(this.bookmarkApi, localNode.id, remoteNode?.children ?? []);
      }

      await this.setStatus({
        status: SYNC_STATUS.success,
        lastRestoreAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
        lastKnownRemoteVersionId: remoteBundle.manifest.latestVersion.versionId,
        lastKnownRemoteTreeHash: remoteBundle.manifest.latestVersion.treeHash,
        lastSyncedTreeHash: remoteBundle.manifest.latestVersion.treeHash,
        lastObservedLocalTreeHash: remoteBundle.manifest.latestVersion.treeHash,
        pendingLocalChanges: false,
        remoteComparison: CONFLICT_TYPE.none,
        remoteSnapshotSummary: {
          ...summarizeNormalizedTree(remoteBundle.tree),
          versionId: remoteBundle.manifest.latestVersion.versionId,
          createdAt: remoteBundle.manifest.latestVersion.createdAt,
          treeHash: remoteBundle.manifest.latestVersion.treeHash
        },
        conflict: null,
        gistId: settings.gistId,
        isSyncing: false,
        lastError: null
      });

      return {
        ok: true,
        restoredVersionId: remoteBundle.manifest.latestVersion.versionId
      };
    } catch (error) {
      await this.setStatus({
        status: SYNC_STATUS.networkError,
        lastError: error.message,
        isSyncing: false
      });

      return {
        ok: false,
        error: error.message
      };
    }
  }
}
