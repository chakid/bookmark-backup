import { searchBookmarksTree } from "./lib/bookmarks.js";
import { createBackupProvider } from "./lib/providers/gist.js";
import {
  getDeviceId,
  getSettings,
  getSyncState,
  resetSyncState,
  saveSettings
} from "./lib/storage.js";
import { maskToken } from "./lib/utils.js";

function sendMessage(type, extra = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          error: "Background service worker did not respond in time"
        });
      }
    }, timeoutMs);

    chrome.runtime
      .sendMessage({ type, ...extra })
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            error: error.message
          });
        }
      });
  });
}

function formatDate(value) {
  if (!value) {
    return "未同步";
  }

  return new Date(value).toLocaleString();
}

function setMessage(text, isError = false) {
  const node = document.querySelector("#message");
  node.textContent = text;
  node.style.color = isError ? "#b42318" : "#0f766e";
}

function renderGrid(targetId, items) {
  const node = document.querySelector(targetId);
  node.innerHTML = items
    .map(
      ([title, value]) => `
        <div>
          <dt>${title}</dt>
          <dd>${value}</dd>
        </div>
      `
    )
    .join("");
}

function renderStatus(statusPayload) {
  const { syncState, settings, deviceId } = statusPayload;

  renderGrid("#status-grid", [
    ["状态", syncState.status],
    ["最近备份", formatDate(syncState.lastSyncAt)],
    ["最近恢复", formatDate(syncState.lastRestoreAt)],
    ["远端版本", syncState.lastKnownRemoteVersionId ?? "暂无"],
    ["远端比较", syncState.remoteComparison ?? "none"],
    ["Gist ID", syncState.gistId || settings.gistId || "尚未创建"],
    ["设备 ID", deviceId]
  ]);

  const remoteSummary = syncState.remoteSnapshotSummary;
  renderGrid(
    "#remote-summary-grid",
    remoteSummary
      ? [
          ["快照版本", remoteSummary.versionId],
          ["生成时间", formatDate(remoteSummary.createdAt)],
          ["文件夹数", String(remoteSummary.folderCount)],
          ["书签数", String(remoteSummary.bookmarkCount)]
        ]
      : [
          ["快照版本", "未读取"],
          ["生成时间", "未读取"],
          ["文件夹数", "-"],
          ["书签数", "-"]
        ]
  );

  const conflictPanel = document.querySelector("#conflict-panel");
  const conflictDetail = document.querySelector("#conflict-detail");
  if (syncState.conflict) {
    conflictPanel.hidden = false;
    conflictDetail.textContent = JSON.stringify(syncState.conflict, null, 2);
  } else {
    conflictPanel.hidden = true;
    conflictDetail.textContent = "";
  }
}

function renderSearchResults(results) {
  const container = document.querySelector("#search-results");
  if (!results.length) {
    container.innerHTML = '<p class="search-empty">没有找到匹配的书签。</p>';
    return;
  }

  container.innerHTML = results
    .map(
      (result) => `
        <article class="search-item" data-url="${result.url}">
          <h3>${result.title || "(无标题书签)"}</h3>
          <p>文件夹：${result.folderPath || "根目录"}</p>
          <p>网址：${result.url}</p>
        </article>
      `
    )
    .join("");
}

async function loadLocalStatusPayload() {
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

async function runSearch() {
  const query = document.querySelector("#search-input").value.trim();
  if (!query) {
    renderSearchResults([]);
    return;
  }

  try {
    const rawTree = await chrome.bookmarks.getTree();
    renderSearchResults(searchBookmarksTree(rawTree, query, 30));
  } catch (error) {
    setMessage(error.message || "搜索失败", true);
  }
}

async function loadPage() {
  const settings = await getSettings();
  const statusPayload = await loadLocalStatusPayload();

  document.querySelector("#providerType").value = settings.providerType;
  document.querySelector("#gistId").value = settings.gistId ?? "";
  document.querySelector("#autoSyncEnabled").checked = Boolean(settings.autoSyncEnabled);
  document.querySelector("#debounceMs").value = settings.debounceMs ?? 5000;
  document.querySelector("#token-hint").textContent = settings.gistToken
    ? `已保存 Token：${maskToken(settings.gistToken)}`
    : "尚未保存 Token";

  renderStatus(statusPayload);

  if (statusPayload.syncState.lastError) {
    setMessage(statusPayload.syncState.lastError, true);
  } else {
    setMessage("");
  }
}

document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const current = await getSettings();
    const payload = {
      providerType: document.querySelector("#providerType").value,
      gistId: document.querySelector("#gistId").value.trim(),
      autoSyncEnabled: document.querySelector("#autoSyncEnabled").checked,
      debounceMs: Number(document.querySelector("#debounceMs").value) || 5000
    };

    const tokenValue = document.querySelector("#gistToken").value.trim();
    if (tokenValue) {
      payload.gistToken = tokenValue;
    }

    setMessage("正在保存设置...");
    const saved = await saveSettings(payload);

    const connectionChanged =
      current.providerType !== saved.providerType ||
      current.gistId !== saved.gistId ||
      current.gistToken !== saved.gistToken;

    if (connectionChanged) {
      await resetSyncState({
        gistId: saved.gistId
      });
    }

    document.querySelector("#gistToken").value = "";
    document.querySelector("#token-hint").textContent = saved.gistToken
      ? `已保存 Token：${maskToken(saved.gistToken)}`
      : "尚未保存 Token";

    setMessage("设置已保存");
    await loadPage();
  } catch (error) {
    setMessage(error.message || "保存失败", true);
  }
});

document.querySelector("#verify-btn").addEventListener("click", async () => {
  try {
    setMessage("正在验证连接...");
    const settings = await getSettings();
    const provider = createBackupProvider(settings);
    const result = await provider.verifyConfig();
    setMessage(result.ok ? result.reason : result.error || result.reason, !result.ok);
  } catch (error) {
    setMessage(error.message || "验证失败", true);
  }
});

document.querySelector("#sync-btn").addEventListener("click", async () => {
  setMessage("正在执行手动备份...");
  const result = await sendMessage("SYNC_NOW");
  setMessage(result.ok ? "备份已完成" : result.error || "备份失败", !result.ok);
  await loadPage();
});

document.querySelector("#load-remote-btn").addEventListener("click", async () => {
  setMessage("正在读取远端最新快照...");
  const result = await sendMessage("LOAD_REMOTE_SUMMARY");
  setMessage(result.ok ? "已读取远端最新快照" : result.error || "读取失败", !result.ok);
  await loadPage();
});

document.querySelector("#restore-btn").addEventListener("click", async () => {
  setMessage("正在把远端最新快照恢复到本地书签...");
  const result = await sendMessage("RESTORE_LATEST");
  setMessage(result.ok ? "已恢复远端最新快照到本地书签" : result.error || "恢复失败", !result.ok);
  await loadPage();
});

document.querySelector("#use-local-btn").addEventListener("click", async () => {
  setMessage("正在以本地版本覆盖远端...");
  const result = await sendMessage("RESOLVE_CONFLICT", { strategy: "use_local" });
  setMessage(result.ok ? "冲突已按本地版本解决" : result.error || "冲突处理失败", !result.ok);
  await loadPage();
});

document.querySelector("#accept-remote-btn").addEventListener("click", async () => {
  const result = await sendMessage("RESOLVE_CONFLICT", { strategy: "accept_remote" });
  setMessage(result.ok ? "已接受远端作为最新基线" : result.error || "冲突处理失败", !result.ok);
  await loadPage();
});

document.querySelector("#search-btn").addEventListener("click", runSearch);
document.querySelector("#search-results").addEventListener("click", async (event) => {
  const item = event.target.closest(".search-item");
  if (!item?.dataset.url) {
    return;
  }

  await chrome.tabs.create({ url: item.dataset.url });
});
document.querySelector("#search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch().catch((error) => {
      setMessage(error.message, true);
    });
  }
});

loadPage().catch((error) => {
  setMessage(error.message, true);
});
