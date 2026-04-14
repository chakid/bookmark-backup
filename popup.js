function sendMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function formatDate(value) {
  if (!value) {
    return "尚未同步";
  }

  return new Date(value).toLocaleString();
}

function renderRemoteSummary(syncState) {
  const summary = syncState.remoteSnapshotSummary;
  if (!summary) {
    document.querySelector("#remote-version").textContent = "未读取";
    document.querySelector("#remote-summary").textContent =
      "可先读取远端最新快照，再决定是否恢复到本地书签。";
    return;
  }

  document.querySelector("#remote-version").textContent = summary.versionId;
  document.querySelector("#remote-summary").textContent =
    `${formatDate(summary.createdAt)} | ${summary.folderCount} 个文件夹 | ${summary.bookmarkCount} 个书签`;
}

function renderSearchResults(results) {
  const node = document.querySelector("#search-results");
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

async function runSearch() {
  const query = document.querySelector("#search-input").value.trim();
  if (!query) {
    renderSearchResults([]);
    return;
  }

  const result = await sendMessage("SEARCH_BOOKMARKS", { query, limit: 12 });
  renderSearchResults(result.ok ? result.results : []);
  if (!result.ok) {
    document.querySelector("#subtext").textContent = result.error || "搜索失败";
  }
}

async function refresh() {
  const payload = await sendMessage("LOAD_STATUS");
  const { syncState, settings } = payload;

  document.querySelector("#status").textContent = syncState.status;
  document.querySelector("#last-sync").textContent = formatDate(syncState.lastSyncAt);
  document.querySelector("#gist-id").textContent =
    syncState.gistId || settings.gistId || "还没有创建远端 Gist";
  document.querySelector("#subtext").textContent =
    syncState.lastError ||
    (syncState.remoteComparison === "remote_ahead"
      ? "远端已经更新，可以读取快照后恢复到本地。"
      : "支持空格 / AND 进行组合搜索。");

  const conflictCard = document.querySelector("#conflict-card");
  if (syncState.conflict) {
    conflictCard.hidden = false;
    document.querySelector("#conflict-text").textContent =
      `本地 ${syncState.conflict.localVersion.versionId} / 远端 ${syncState.conflict.remoteVersion.versionId}`;
  } else {
    conflictCard.hidden = true;
  }

  renderRemoteSummary(syncState);
}

document.querySelector("#search-input").addEventListener("input", () => {
  runSearch().catch((error) => {
    document.querySelector("#subtext").textContent = error.message;
  });
});

document.querySelector("#search-results").addEventListener("click", async (event) => {
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

document.querySelector("#load-remote-btn").addEventListener("click", async () => {
  document.querySelector("#subtext").textContent = "正在读取远端最新快照...";
  const result = await sendMessage("LOAD_REMOTE_SUMMARY");
  document.querySelector("#subtext").textContent = result.ok
    ? "已读取远端最新快照"
    : result.error || "读取失败";
  await refresh();
});

document.querySelector("#restore-btn").addEventListener("click", async () => {
  document.querySelector("#subtext").textContent = "正在恢复远端快照到本地...";
  const result = await sendMessage("RESTORE_LATEST");
  document.querySelector("#subtext").textContent = result.ok
    ? "已恢复远端最新快照到本地"
    : result.error || "恢复失败";
  await refresh();
});

document.querySelector("#sync-btn").addEventListener("click", async () => {
  document.querySelector("#subtext").textContent = "正在执行手动备份...";
  const result = await sendMessage("SYNC_NOW");
  document.querySelector("#subtext").textContent = result.ok
    ? "备份完成"
    : result.error || "备份失败";
  await refresh();
});

document.querySelector("#options-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh().catch((error) => {
  document.querySelector("#subtext").textContent = error.message;
});
