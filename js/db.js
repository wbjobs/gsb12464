/* IndexedDB 持久化层：保存目录句柄与授权元信息。
 * 句柄本身可结构化克隆存入 IndexedDB；若浏览器不支持持久化句柄，
 * 所有函数静默降级为 no-op，由上层走降级流程。 */
'use strict';

const DB_NAME = 'fs-access-web';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const STORE_META = 'meta';

let dbPromise = null;
let persistenceAvailable = true;

function openDb() {
  if (!persistenceAvailable) return Promise.reject(new Error('persistence disabled'));
  if (!('indexedDB' in window)) {
    persistenceAvailable = false;
    return Promise.reject(new Error('indexedDB unavailable'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        persistenceAvailable = false;
        reject(req.error || new Error('indexedDB open failed'));
      };
    });
    // 打开失败后允许下次重试
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function idbReq(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const HandleStore = {
  isAvailable: () => persistenceAvailable,

  async saveDirectoryHandle(handle, meta) {
    try {
      await idbReq(STORE_HANDLES, 'readwrite', (s) => s.put(handle, 'directory'));
      await idbReq(STORE_META, 'readwrite', (s) => s.put({
        name: handle.name,
        grantedAt: Date.now(),
        ...meta,
      }, 'directory'));
      return true;
    } catch (err) {
      // 持久化失败（如隐私模式）：降级为仅内存句柄
      console.warn('句柄持久化失败，降级为内存句柄:', err);
      return false;
    }
  },

  async loadDirectoryHandle() {
    try {
      const handle = await idbReq(STORE_HANDLES, 'readonly', (s) => s.get('directory'));
      const meta = await idbReq(STORE_META, 'readonly', (s) => s.get('directory'));
      return { handle: handle || null, meta: meta || null };
    } catch (err) {
      console.warn('句柄读取失败:', err);
      return { handle: null, meta: null };
    }
  },

  async clear() {
    try {
      await idbReq(STORE_HANDLES, 'readwrite', (s) => s.delete('directory'));
      await idbReq(STORE_META, 'readwrite', (s) => s.delete('directory'));
    } catch (err) {
      console.warn('句柄清理失败:', err);
    }
  },
};
