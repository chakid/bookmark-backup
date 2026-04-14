import {
  FILE_NAMES,
  HISTORY_LIMIT,
  SCHEMA_VERSION
} from "../constants.js";

async function parseJsonFile(file) {
  if (!file) {
    return null;
  }

  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  if (!content) {
    return null;
  }
  return JSON.parse(content);
}

function toJsonContent(value) {
  return JSON.stringify(value, null, 2);
}

export class GistProvider {
  constructor(settings, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  buildHeaders() {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    if (this.settings.gistToken) {
      headers.Authorization = `Bearer ${this.settings.gistToken}`;
    }

    return headers;
  }

  async request(path, init = {}) {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        ...this.buildHeaders(),
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`GitHub API ${response.status}: ${body || response.statusText}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  async verifyConfig() {
    if (!this.settings.gistToken) {
      return {
        ok: false,
        reason: "Missing GitHub token"
      };
    }

    if (this.settings.gistId) {
      try {
        await this.request(`/gists/${this.settings.gistId}`);
        return {
          ok: true,
          reason: "Connected to existing gist"
        };
      } catch (error) {
        if (error.status === 404) {
          await this.request("/gists?per_page=1");
          return {
            ok: false,
            reason: "GitHub token is valid, but the configured Gist ID was not found"
          };
        }

        throw error;
      }
    }

    await this.request("/gists?per_page=1");
    return {
      ok: true,
      reason: "Token is valid and can access Gists"
    };
  }

  async loadLatest() {
    if (!this.settings.gistId) {
      return {
        exists: false,
        gistId: "",
        manifest: null,
        history: [],
        tree: null,
        conflicts: []
      };
    }

    let gist;
    try {
      gist = await this.request(`/gists/${this.settings.gistId}`);
    } catch (error) {
      if (error.status === 404) {
        const notFoundError = new Error("Configured Gist ID was not found");
        notFoundError.status = 404;
        throw notFoundError;
      }

      throw error;
    }
    const manifest = await parseJsonFile(gist.files[FILE_NAMES.manifest]);
    const tree = await parseJsonFile(gist.files[FILE_NAMES.tree]);
    const history = (await parseJsonFile(gist.files[FILE_NAMES.history])) ?? [];
    const conflicts = (await parseJsonFile(gist.files[FILE_NAMES.conflicts])) ?? [];

    return {
      exists: true,
      gistId: gist.id,
      gist,
      manifest,
      history,
      tree,
      conflicts
    };
  }

  async ensureGistExists(initialFiles) {
    if (this.settings.gistId) {
      return this.settings.gistId;
    }

    const gist = await this.request("/gists", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        description: "Chrome bookmark backup",
        public: false,
        files: initialFiles
      })
    });

    this.settings.gistId = gist.id;
    return gist.id;
  }

  async patchGist(gistId, files) {
    return this.request(`/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ files })
    });
  }

  async saveVersion(payload, expectedRevision = null) {
    const existing = await this.loadLatest();
    const currentLatestVersionId = existing.manifest?.latestVersion?.versionId ?? null;

    if (currentLatestVersionId !== expectedRevision) {
      const error = new Error("Remote revision changed before save");
      error.code = "REMOTE_REVISION_CHANGED";
      error.remoteVersionId = currentLatestVersionId;
      throw error;
    }

    const history = [payload.metadata, ...(existing.history ?? [])].slice(0, HISTORY_LIMIT);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: payload.metadata.createdAt,
      latestVersion: payload.metadata,
      latestConflict: null
    };

    const files = {
      [FILE_NAMES.manifest]: {
        content: toJsonContent(manifest)
      },
      [FILE_NAMES.tree]: {
        content: toJsonContent(payload.normalizedTree)
      },
      [FILE_NAMES.history]: {
        content: toJsonContent(history)
      },
      [FILE_NAMES.conflicts]: {
        content: toJsonContent(existing.conflicts ?? [])
      },
      [FILE_NAMES.latestConflict]: {
        content: "null"
      }
    };

    const gistId = await this.ensureGistExists(files);
    if (this.settings.gistId) {
      await this.patchGist(gistId, files);
    }

    return {
      gistId,
      manifest,
      history
    };
  }

  async saveConflict(conflictRecord, remoteManifest) {
    const existing = await this.loadLatest();
    const conflicts = [conflictRecord, ...(existing.conflicts ?? [])].slice(0, 10);
    const manifest = existing.manifest
      ? {
          ...existing.manifest,
          latestConflict: {
            type: conflictRecord.type,
            detectedAt: conflictRecord.detectedAt,
            localVersionId: conflictRecord.localVersion.versionId,
            remoteVersionId: conflictRecord.remoteVersion.versionId
          }
        }
      : {
          schemaVersion: SCHEMA_VERSION,
          updatedAt: conflictRecord.detectedAt,
          latestVersion: remoteManifest?.latestVersion ?? null,
          latestConflict: {
            type: conflictRecord.type,
            detectedAt: conflictRecord.detectedAt,
            localVersionId: conflictRecord.localVersion.versionId,
            remoteVersionId: conflictRecord.remoteVersion.versionId
          }
        };

    const latestConflictPayload = {
      ...conflictRecord,
      schemaVersion: SCHEMA_VERSION
    };

    const files = {
      [FILE_NAMES.manifest]: {
        content: toJsonContent(manifest)
      },
      [FILE_NAMES.conflicts]: {
        content: toJsonContent(conflicts)
      },
      [FILE_NAMES.latestConflict]: {
        content: toJsonContent(latestConflictPayload)
      }
    };

    const gistId = await this.ensureGistExists({
      [FILE_NAMES.manifest]: {
        content: toJsonContent(manifest)
      },
      [FILE_NAMES.tree]: {
        content: toJsonContent(existing.tree ?? [])
      },
      [FILE_NAMES.history]: {
        content: toJsonContent(existing.history ?? [])
      },
      [FILE_NAMES.conflicts]: {
        content: toJsonContent(conflicts)
      },
      [FILE_NAMES.latestConflict]: {
        content: toJsonContent(latestConflictPayload)
      }
    });

    await this.patchGist(gistId, files);
    return {
      gistId,
      manifest,
      conflicts
    };
  }

  async listRecentVersions(limit = HISTORY_LIMIT) {
    const latest = await this.loadLatest();
    return (latest.history ?? []).slice(0, limit);
  }
}

export function createBackupProvider(settings) {
  if (settings.providerType !== "gist") {
    throw new Error(`Provider ${settings.providerType} is not implemented yet`);
  }

  return new GistProvider(settings);
}
