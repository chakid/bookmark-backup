export function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortObject(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

export async function sha256Hex(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createVersionId(createdAt, treeHash) {
  const compactTime = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${compactTime}-${treeHash.slice(0, 12)}`;
}

export function maskToken(token) {
  if (!token) {
    return "";
  }

  if (token.length <= 8) {
    return `${token.slice(0, 2)}***${token.slice(-2)}`;
  }

  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}
