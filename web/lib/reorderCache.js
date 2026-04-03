/** @type {Map<string, { expiresAt: number; payload: unknown }>} */
const store = new Map();

const TTL_MS = 5 * 60 * 1000;

export function reorderCacheKey(shop, leadTimeDays, bufferPct) {
  return `${shop}:${leadTimeDays}:${bufferPct}`;
}

export function getReorderCache(key) {
  const row = store.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    store.delete(key);
    return null;
  }
  return row.payload;
}

export function setReorderCache(key, payload) {
  store.set(key, { expiresAt: Date.now() + TTL_MS, payload });
}
