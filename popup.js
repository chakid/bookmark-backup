function sendMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function formatDate(value) {
  if (!value) {
    return "尚未同步";
  }

  return new Date(value).toLocaleString();
}

function setSubtext(text, tone = "info") {
  const node = document.querySelector("#subtext");
  node.dataset.tone = tone;
  node.textContent = text;
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
      text: result.versionId
        ? `已备份到 Gist，版本 ${result.versionId}`
        : "已备份到 Gist"
    };
  }

  if (result.action === "adopt_remote" || result.action === "noop") {
    return {
      tone: "info",
      text: "本地与远端已经一致，这次没有生成新的备份版本"
    };
  }

  return {
    tone: "success",
    text: "备份完成"
  };
}

function renderRemoteSummary(syncState) {
  const summary = syncState.remoteSnapshotSummary;
  if (!summary) {
    document.querySelector("#remote-version").textContent = "未读取";
    document.querySelector("#remote-summary").textContent =
      "可以先读取远端最新快照，再决定是否恢复到本地书签。";
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
    setSubtext(result.error || "搜索失败", "error");
  }
}

async function refresh({ preserveSubtext = false } = {}) {
  const payload = await sendMessage("LOAD_STATUS");
  const { syncState, settings } = payload;

  document.querySelector("#status").textContent = syncState.status;
  document.querySelector("#last-sync").textContent = formatDate(syncState.lastSyncAt);
  document.querySelector("#gist-id").textContent =
    syncState.gistId || settings.gistId || "还没有创建远端 Gist";

  if (!preserveSubtext) {
    setSubtext(
      syncState.lastError ||
        (syncState.remoteComparison === "remote_ahead"
          ? "远端已经更新，可以先读取快照后恢复到本地。"
          : "支持空格 / AND 进行组合搜索。"),
      syncState.lastError ? "error" : "info"
    );
  }

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
    setSubtext(error.message, "error");
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
  setSubtext("正在读取远端最新快照...", "progress");
  const result = await sendMessage("LOAD_REMOTE_SUMMARY");
  await refresh({ preserveSubtext: true });
  setSubtext(result.ok ? "已读取远端最新快照" : result.error || "读取失败", result.ok ? "success" : "error");
});

document.querySelector("#restore-btn").addEventListener("click", async () => {
  setSubtext("正在恢复远端快照到本地...", "progress");
  const result = await sendMessage("RESTORE_LATEST");
  await refresh({ preserveSubtext: true });
  setSubtext(
    result.ok ? "已恢复远端最新快照到本地" : result.error || "恢复失败",
    result.ok ? "success" : "error"
  );
});

document.querySelector("#sync-btn").addEventListener("click", async () => {
  setSubtext("正在执行手动备份...", "progress");
  const result = await sendMessage("SYNC_NOW");
  await refresh({ preserveSubtext: true });
  const feedback = buildManualSyncMessage(result);
  setSubtext(feedback.text, feedback.tone);
});

document.querySelector("#options-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh().catch((error) => {
  setSubtext(error.message, "error");
});
