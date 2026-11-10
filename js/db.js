// Tiny IndexedDB wrapper: keeps the project, slide images and recorded parts in this browser only.
const NAME = "slidecast", STORE = "kv";
let dbp;
function open() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode); const s = t.objectStore(STORE); const out = fn(s);
    t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const db = {
  get: k => tx("readonly", s => s.get(k)),
  set: (k, v) => tx("readwrite", s => s.put(v, k)),
  del: k => tx("readwrite", s => s.delete(k)),
  keys: () => tx("readonly", s => s.getAllKeys()),
  async clear() { await tx("readwrite", s => s.clear()); },
};
