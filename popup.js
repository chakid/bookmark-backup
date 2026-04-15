function sendMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function formatDate(value) {
  if (!value) {
    return "尚未同步";
  }

  return new Date(value).toLocaleString();
}

function getLatestVersionText(syncState, settings) {
  const versionId = syncState.lastKnownRemoteVersionId || syncState.remoteSnapshotSummary?.versionId || "";
  if (versionId) {
    return `最近一次版本：${versionId}`;
  }

  const gistId = syncState.gistId || settings.gistId || "";
  if (gistId) {
    return `Gist ID：${gistId}`;
  }

  return "尚未同步";
}

function setSyncDetail(text, tone = "info") {
  const node = document.querySelector("#sync-detail");
  if (!node) {
    return;
  }

  node.dataset.tone = tone;
  node.textContent = text;
}

function setSearchSummary(summary) {
  const node = document.querySelector("#search-summary");
  if (!node || !summary) {
    return;
  }

  node.textContent = `文件夹 ${summary.folderCount} · 书签 ${summary.bookmarkCount}`;
}

function buildManualSyncMessage(result) {
  if (!result?.ok) {
    return {
      tone: "error",
      text: result?.error || "备份失败"
    };
  }

  if (result.action === "push_local") {
    return {
      tone: "success",
      text: result.versionId ? `最近一次版本：${result.versionId}` : "已备份到 Gist"
    };
  }

  if (result.action === "adopt_remote" || result.action === "noop") {
    return {
      tone: "info",
      text: "本地与远端已经一致"
    };
  }

  return {
    tone: "success",
    text: "备份完成"
  };
}

function renderSearchResults(results) {
  const node = document.querySelector("#search-results");
  if (!node) {
    return;
  }

  if (!results.length) {
    node.innerHTML = "";
    return;
  }

  node.innerHTML = results
    .map(
      (result) => `
        <article class="search-item">
          <a class="search-link" href="${result.url}" data-url="${result.url}">
            <strong>${result.title || "(无标题书签)"}</strong>
            <p>${result.folderPath || "根目录"}</p>
            <p>${result.url}</p>
          </a>
        </article>
      `
    )
    .join("");
}

async function loadSearchSummary() {
  const result = await sendMessage("LOAD_SEARCH_SUMMARY");
  if (result?.ok) {
    setSearchSummary(result.summary);
  }
}

async function runSearch() {
  const input = document.querySelector("#search-input");
  if (!input) {
    return;
  }

  const query = input.value.trim();
  if (!query) {
    renderSearchResults([]);
    return;
  }

  const result = await sendMessage("SEARCH_BOOKMARKS", { query, limit: 12 });
  renderSearchResults(result.ok ? result.results : []);
  if (!result.ok) {
    setSyncDetail(result.error || "搜索失败", "error");
  }
}

async function refresh({ preserveDetail = false } = {}) {
  const [statusPayload] = await Promise.all([
    sendMessage("LOAD_STATUS"),
    loadSearchSummary()
  ]);
  const { syncState, settings } = statusPayload;

  const lastSyncNode = document.querySelector("#last-sync");
  if (lastSyncNode) {
    lastSyncNode.textContent = formatDate(syncState.lastSyncAt);
  }

  if (!preserveDetail) {
    setSyncDetail(
      syncState.lastError ? syncState.lastError : getLatestVersionText(syncState, settings),
      syncState.lastError ? "error" : "info"
    );
  }

  const conflictCard = document.querySelector("#conflict-card");
  const conflictText = document.querySelector("#conflict-text");
  if (!conflictCard || !conflictText) {
    return;
  }

  if (syncState.conflict) {
    conflictCard.hidden = false;
    conflictText.textContent =
      `本地 ${syncState.conflict.localVersion.versionId} / 远端 ${syncState.conflict.remoteVersion.versionId}`;
  } else {
    conflictCard.hidden = true;
  }
}

document.querySelector("#search-input")?.addEventListener("input", () => {
  runSearch().catch((error) => {
    setSyncDetail(error.message, "error");
  });
});

document.querySelector("#search-results")?.addEventListener("click", async (event) => {
  const link = event.target.closest(".search-link");
  if (!link) {
    return;
  }

  event.preventDefault();
  const url = link.dataset.url;
  if (!url) {
    return;
  }

  await sendMessage("OPEN_BOOKMARK_TAB", { url });
});

document.querySelector("#load-remote-btn")?.addEventListener("click", async () => {
  setSyncDetail("正在读取远端最新快照...", "progress");
  const result = await sendMessage("LOAD_REMOTE_SUMMARY");
  await refresh({ preserveDetail: true });
  setSyncDetail(result.ok ? "已读取远端快照" : result.error || "读取失败", result.ok ? "success" : "error");
});

document.querySelector("#restore-btn")?.addEventListener("click", async () => {
  setSyncDetail("正在恢复远端快照到本地...", "progress");
  const result = await sendMessage("RESTORE_LATEST");
  await refresh({ preserveDetail: true });
  setSyncDetail(
    result.ok ? "已恢复远端快照到本地" : result.error || "恢复失败",
    result.ok ? "success" : "error"
  );
});

document.querySelector("#sync-btn")?.addEventListener("click", async () => {
  setSyncDetail("正在执行手动备份...", "progress");
  const result = await sendMessage("SYNC_NOW");
  await refresh({ preserveDetail: true });
  const feedback = buildManualSyncMessage(result);
  setSyncDetail(feedback.text, feedback.tone);
});

document.querySelector("#options-btn")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh().catch((error) => {
  setSyncDetail(error.message, "error");
});
