let root;
let input;
let resultsNode;
let state = {
  open: false,
  query: "",
  results: [],
  activeIndex: 0
};

function sendMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function isEditableTarget(target) {
  if (!target) {
    return false;
  }

  const tagName = target.tagName?.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function ensureRoot() {
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = "bookmark-quick-search-root";
  root.innerHTML = `
    <div class="bookmark-search-backdrop"></div>
    <section class="bookmark-search-modal" role="dialog" aria-modal="true" aria-label="Bookmark quick search">
      <div class="bookmark-search-topbar">
        <p class="bookmark-search-kicker">Bookmark Quick Search</p>
        <h1 class="bookmark-search-title">搜索书签</h1>
      </div>
      <label class="bookmark-search-inputbar">
        <span class="bookmark-search-glyph">/</span>
        <input class="bookmark-search-input" type="search" placeholder="搜索标题、文件夹、网址">
      </label>
      <div class="bookmark-search-hint">支持空格 / AND 进行组合搜索，所有关键词都必须命中。</div>
      <div class="bookmark-search-results"></div>
      <div class="bookmark-search-footer">
        <span class="bookmark-chip"><kbd>↑ ↓</kbd> 导航</span>
        <span class="bookmark-chip"><kbd>Enter</kbd> 新标签打开</span>
        <span class="bookmark-chip"><kbd>Esc</kbd> 关闭</span>
      </div>
    </section>
  `;

  document.documentElement.appendChild(root);
  input = root.querySelector(".bookmark-search-input");
  resultsNode = root.querySelector(".bookmark-search-results");

  root.querySelector(".bookmark-search-backdrop").addEventListener("click", closeOverlay);
  input.addEventListener("input", () => {
    state.query = input.value;
    runSearch().catch(console.error);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      openActiveResult().catch(console.error);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeOverlay();
    }
  });

  resultsNode.addEventListener("click", (event) => {
    const item = event.target.closest(".bookmark-search-item");
    if (!item) {
      return;
    }

    const index = Number(item.dataset.index);
    if (Number.isNaN(index)) {
      return;
    }

    state.activeIndex = index;
    openActiveResult().catch(console.error);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const isShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        ((event.ctrlKey && !event.metaKey) || (!event.ctrlKey && event.metaKey));

      if (!isShortcut) {
        if (event.key === "Escape" && state.open) {
          event.preventDefault();
          closeOverlay();
        }
        return;
      }

      if (!state.open && isEditableTarget(event.target)) {
        return;
      }

      event.preventDefault();
      toggleOverlay();
    },
    true
  );

  return root;
}

function openOverlay() {
  ensureRoot();
  root.classList.add("visible");
  state.open = true;
  input.value = state.query;
  requestAnimationFrame(() => input.focus());
  renderResults();
}

function closeOverlay() {
  if (!root) {
    return;
  }

  root.classList.remove("visible");
  state.open = false;
}

function toggleOverlay() {
  if (state.open) {
    closeOverlay();
  } else {
    openOverlay();
  }
}

function renderResults() {
  if (!resultsNode) {
    return;
  }

  if (!state.query.trim()) {
    resultsNode.innerHTML = '<div class="bookmark-search-empty">输入关键词搜索书签</div>';
    return;
  }

  if (!state.results.length) {
    resultsNode.innerHTML = '<div class="bookmark-search-empty">没有找到匹配的书签</div>';
    return;
  }

  resultsNode.innerHTML = state.results
    .map(
      (result, index) => `
        <article class="bookmark-search-item ${index === state.activeIndex ? "active" : ""}" data-index="${index}">
          <strong>${result.title || "(无标题书签)"}</strong>
          <p>${result.folderPath || "根目录"}</p>
          <p>${result.url}</p>
        </article>
      `
    )
    .join("");
}

async function runSearch() {
  if (!state.query.trim()) {
    state.results = [];
    state.activeIndex = 0;
    renderResults();
    return;
  }

  const result = await sendMessage("SEARCH_BOOKMARKS", {
    query: state.query,
    limit: 20
  });

  state.results = result.ok ? result.results : [];
  state.activeIndex = 0;
  renderResults();
}

function moveActive(step) {
  if (!state.results.length) {
    return;
  }

  state.activeIndex = (state.activeIndex + step + state.results.length) % state.results.length;
  renderResults();
}

async function openActiveResult() {
  const result = state.results[state.activeIndex];
  if (!result?.url) {
    return;
  }

  await sendMessage("OPEN_BOOKMARK_TAB", { url: result.url });
  closeOverlay();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TOGGLE_QUICK_SEARCH") {
    toggleOverlay();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "OPEN_QUICK_SEARCH") {
    openOverlay();
    sendResponse({ ok: true });
  }
});

ensureRoot();
