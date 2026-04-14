import { createVersionId, sha256Hex, stableStringify } from "./utils.js";

function normalizeNode(node, parentId = null) {
  const normalized = {
    id: node.id,
    parentId,
    index: typeof node.index === "number" ? node.index : 0,
    title: node.title ?? "",
    url: node.url ?? null,
    dateAdded: node.dateAdded ?? null,
    dateGroupModified: node.dateGroupModified ?? null
  };

  if (Array.isArray(node.children) && node.children.length > 0) {
    normalized.children = node.children
      .slice()
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((child) => normalizeNode(child, node.id));
  }

  return normalized;
}

export function normalizeBookmarkTree(rawTree) {
  return rawTree.map((node) => normalizeNode(node, null));
}

export async function buildSnapshotFromTree(rawTree, sourceRevision = null, deviceId = "unknown-device") {
  const normalizedTree = normalizeBookmarkTree(rawTree);
  const serializedTree = stableStringify(normalizedTree);
  const treeHash = await sha256Hex(serializedTree);
  const createdAt = new Date().toISOString();

  return {
    normalizedTree,
    treeHash,
    serializedTree,
    metadata: {
      versionId: createVersionId(createdAt, treeHash),
      deviceId,
      createdAt,
      sourceRevision,
      treeHash
    }
  };
}

export function summarizeNormalizedTree(normalizedTree) {
  const summary = {
    rootCount: Array.isArray(normalizedTree) ? normalizedTree.length : 0,
    folderCount: 0,
    bookmarkCount: 0
  };

  function visit(node) {
    const isFolder = Array.isArray(node.children);
    if (isFolder) {
      summary.folderCount += 1;
      node.children.forEach(visit);
      return;
    }

    summary.bookmarkCount += 1;
  }

  (normalizedTree ?? []).forEach(visit);
  return summary;
}

function normalizeSearchText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function tokenizeQuery(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token && token !== "and" && token !== "&&" && token !== "且");
}

function fuzzyIncludes(haystack, query) {
  if (!query) {
    return true;
  }

  if (haystack.includes(query)) {
    return true;
  }

  let queryIndex = 0;
  for (let index = 0; index < haystack.length && queryIndex < query.length; index += 1) {
    if (haystack[index] === query[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === query.length;
}

function isEditDistanceWithinOne(source, target) {
  if (Math.abs(source.length - target.length) > 1) {
    return false;
  }

  let sourceIndex = 0;
  let targetIndex = 0;
  let edits = 0;

  while (sourceIndex < source.length && targetIndex < target.length) {
    if (source[sourceIndex] === target[targetIndex]) {
      sourceIndex += 1;
      targetIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) {
      return false;
    }

    if (source.length > target.length) {
      sourceIndex += 1;
    } else if (source.length < target.length) {
      targetIndex += 1;
    } else {
      sourceIndex += 1;
      targetIndex += 1;
    }
  }

  if (sourceIndex < source.length || targetIndex < target.length) {
    edits += 1;
  }

  return edits <= 1;
}

function hasNearWordMatch(fieldValue, token) {
  if (!fieldValue || token.length < 3) {
    return false;
  }

  const words = fieldValue.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    if (word === token) {
      return true;
    }

    if (word.length === token.length) {
      if (isEditDistanceWithinOne(word, token)) {
        return true;
      }

      for (let index = 0; index < word.length - 1; index += 1) {
        const swapped =
          word.slice(0, index) +
          word[index + 1] +
          word[index] +
          word.slice(index + 2);
        if (swapped === token) {
          return true;
        }
      }
    }

    return isEditDistanceWithinOne(word, token);
  });
}

function buildFolderPath(segments) {
  return segments.filter(Boolean).join(" / ");
}

export function buildBookmarkSearchIndex(rawTree) {
  const index = [];

  function visit(node, folderSegments) {
    const nextSegments =
      node.title && !node.url ? [...folderSegments, node.title] : folderSegments;

    if (node.url) {
      const folderPath = buildFolderPath(folderSegments);
      index.push({
        id: node.id,
        title: node.title ?? "",
        url: node.url ?? "",
        folderPath,
        normalizedTitle: normalizeSearchText(node.title ?? ""),
        normalizedFolderPath: normalizeSearchText(folderPath),
        normalizedUrl: normalizeSearchText(node.url ?? "")
      });
    }

    (node.children ?? []).forEach((child) => visit(child, nextSegments));
  }

  (rawTree ?? []).forEach((node) => visit(node, []));
  return index;
}

function scoreField(fieldValue, token, exactWeight, fuzzyWeight) {
  if (!fieldValue) {
    return 0;
  }

  if (fieldValue.includes(token)) {
    return exactWeight;
  }

  if (fuzzyIncludes(fieldValue, token)) {
    return fuzzyWeight;
  }

  if (hasNearWordMatch(fieldValue, token)) {
    return fuzzyWeight - 10;
  }

  return 0;
}

function scoreBookmarkResult(item, tokens) {
  let score = 0;
  const normalizedTitle = item.normalizedTitle ?? normalizeSearchText(item.title);
  const normalizedFolder = item.normalizedFolderPath ?? normalizeSearchText(item.folderPath);
  const normalizedUrl = item.normalizedUrl ?? normalizeSearchText(item.url);

  for (const token of tokens) {
    const titleScore = scoreField(normalizedTitle, token, 120, 80);
    const folderScore = scoreField(normalizedFolder, token, 70, 40);
    const urlScore = scoreField(normalizedUrl, token, 90, 50);
    const bestTokenScore = Math.max(titleScore, folderScore, urlScore);

    if (!bestTokenScore) {
      return 0;
    }

    score += bestTokenScore;
  }

  score -= Math.max(0, normalizedTitle.length - tokens.join("").length) * 0.1;
  return score;
}

export function searchBookmarksTree(rawTree, rawQuery, limit = 20) {
  return searchBookmarkIndex(buildBookmarkSearchIndex(rawTree), rawQuery, limit);
}

export function searchBookmarkIndex(index, rawQuery, limit = 20) {
  const tokens = tokenizeQuery(rawQuery);
  if (!tokens.length) {
    return [];
  }

  const results = [];
  for (const item of index ?? []) {
    const score = scoreBookmarkResult(item, tokens);
    if (score > 0) {
      results.push({
        id: item.id,
        title: item.title,
        url: item.url,
        folderPath: item.folderPath,
        score
      });
    }
  }

  return results
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.title.localeCompare(right.title);
    })
    .slice(0, limit);
}
