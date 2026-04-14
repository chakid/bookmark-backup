import test from "node:test";
import assert from "node:assert/strict";

import { determineSyncPlan } from "../lib/sync-engine.js";
import { searchBookmarksTree, summarizeNormalizedTree } from "../lib/bookmarks.js";

const baseLocalSnapshot = {
  normalizedTree: [{ id: "1", title: "root", index: 0 }],
  metadata: {
    versionId: "local-v2",
    deviceId: "device-a",
    createdAt: "2026-04-14T10:00:00.000Z",
    sourceRevision: "remote-v1",
    treeHash: "hash-local"
  }
};

test("pushes local snapshot when there is no remote version", () => {
  const plan = determineSyncPlan({
    localSnapshot: baseLocalSnapshot,
    remoteBundle: {
      manifest: null,
      tree: null
    },
    syncState: {
      lastKnownRemoteVersionId: null,
      lastSyncedTreeHash: null
    }
  });

  assert.equal(plan.type, "push_local");
  assert.equal(plan.expectedRevision, null);
});

test("adopts remote when hashes already match", () => {
  const plan = determineSyncPlan({
    localSnapshot: {
      ...baseLocalSnapshot,
      metadata: {
        ...baseLocalSnapshot.metadata,
        treeHash: "same-hash"
      }
    },
    remoteBundle: {
      manifest: {
        latestVersion: {
          versionId: "remote-v2",
          treeHash: "same-hash"
        }
      },
      tree: [{ id: "1", title: "root", index: 0 }]
    },
    syncState: {
      lastKnownRemoteVersionId: "remote-v1",
      lastSyncedTreeHash: "same-hash"
    }
  });

  assert.equal(plan.type, "adopt_remote");
  assert.equal(plan.conflictType, "none");
});

test("detects divergence when both remote and local changed", () => {
  const plan = determineSyncPlan({
    localSnapshot: baseLocalSnapshot,
    remoteBundle: {
      manifest: {
        latestVersion: {
          versionId: "remote-v3",
          treeHash: "hash-remote"
        }
      },
      tree: [{ id: "1", title: "remote", index: 0 }]
    },
    syncState: {
      lastKnownRemoteVersionId: "remote-v1",
      lastSyncedTreeHash: "hash-old"
    }
  });

  assert.equal(plan.type, "conflict");
  assert.equal(plan.conflictType, "diverged");
});

test("pushes local version when only local changed", () => {
  const plan = determineSyncPlan({
    localSnapshot: baseLocalSnapshot,
    remoteBundle: {
      manifest: {
        latestVersion: {
          versionId: "remote-v1",
          treeHash: "hash-old"
        }
      },
      tree: [{ id: "1", title: "old", index: 0 }]
    },
    syncState: {
      lastKnownRemoteVersionId: "remote-v1",
      lastSyncedTreeHash: "hash-old"
    }
  });

  assert.equal(plan.type, "push_local");
  assert.equal(plan.expectedRevision, "remote-v1");
});

test("adopts remote when only remote changed", () => {
  const plan = determineSyncPlan({
    localSnapshot: {
      ...baseLocalSnapshot,
      metadata: {
        ...baseLocalSnapshot.metadata,
        treeHash: "hash-old"
      }
    },
    remoteBundle: {
      manifest: {
        latestVersion: {
          versionId: "remote-v2",
          treeHash: "hash-remote"
        }
      },
      tree: [{ id: "1", title: "remote", index: 0 }]
    },
    syncState: {
      lastKnownRemoteVersionId: "remote-v1",
      lastSyncedTreeHash: "hash-old"
    }
  });

  assert.equal(plan.type, "adopt_remote");
  assert.equal(plan.conflictType, "remote_ahead");
});

test("summarizes normalized tree counts for restore preview", () => {
  const summary = summarizeNormalizedTree([
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          title: "Bookmarks bar",
          children: [
            { id: "10", title: "Example", url: "https://example.com" },
            {
              id: "11",
              title: "Folder",
              children: [{ id: "12", title: "Nested", url: "https://nested.example.com" }]
            }
          ]
        }
      ]
    }
  ]);

  assert.equal(summary.rootCount, 1);
  assert.equal(summary.folderCount, 3);
  assert.equal(summary.bookmarkCount, 2);
});

test("searches bookmarks by title, folder path, and url fuzzily", () => {
  const results = searchBookmarksTree(
    [
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [
              {
                id: "11",
                title: "Work",
                children: [
                  {
                    id: "111",
                    title: "OpenAI Docs",
                    url: "https://platform.openai.com/docs"
                  }
                ]
              },
              {
                id: "12",
                title: "Personal",
                children: [
                  {
                    id: "121",
                    title: "Recipes",
                    url: "https://example.com/food"
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    "wrok docs"
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "OpenAI Docs");
  assert.match(results[0].folderPath, /Work/);

  const urlResults = searchBookmarksTree(
    [
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [
              {
                id: "10",
                title: "Recipes",
                url: "https://example.com/food"
              }
            ]
          }
        ]
      }
    ],
    "exm food"
  );

  assert.equal(urlResults.length, 1);
  assert.equal(urlResults[0].title, "Recipes");
});

test("treats explicit AND as an AND separator in bookmark search", () => {
  const results = searchBookmarksTree(
    [
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [
              {
                id: "11",
                title: "OpenAI Platform",
                url: "https://platform.openai.com/docs"
              }
            ]
          }
        ]
      }
    ],
    "openai and docs"
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "OpenAI Platform");
});
