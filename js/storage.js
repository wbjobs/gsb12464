// IndexedDB 持久化：目录句柄、授权时间、降级模式虚拟文件系统。
// 若 IndexedDB 不可用 / 打开失败（隐私模式、配额等），自动降级为内存存储，
// 保证基本操作不崩溃 —— 但句柄无法跨会话持久化（对应「句柄持久化失败」分支）。

const DB_NAME = 'fs-access-demo';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const VFS_STORE = 'vfs';

let dbPromise = null;
let memoryFallback = false;
const memoryStore = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb-unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(VFS_STORE)) db.createObjectStore(VFS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb-open-failed'));
  });
  return dbPromise;
}

function tx(storeName, mode, runner) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        const request = runner(store);
        if (request) {
          request.onsuccess = () => {
            result = request.result;
          };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('indexeddb-tx-failed'));
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb-tx-aborted'));
      })
  );
}

export async function isMemoryFallback() {
  try {
    await openDb();
    return false;
  } catch {
    return true;
  }
}

async function withFallback(key, fallbackValue, producer) {
  try {
    return await producer();
  } catch (error) {
    memoryFallback = true;
    return fallbackValue;
  }
}

export async function kvGet(key) {
  return withFallback(key, memoryStore.has(key) ? memoryStore.get(key) : undefined, () =>
    tx(KV_STORE, 'readonly', (store) => store.get(key))
  );
}

export async function kvSet(key, value) {
  let db;
  try {
    db = await openDb();
  } catch {
    memoryFallback = true;
    memoryStore.set(key, value);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(KV_STORE, 'readwrite');
      const request = transaction.objectStore(KV_STORE).put(value, key);
      request.onsuccess = () => resolve();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('indexeddb-tx-failed'));
      transaction.onabort = () => reject(transaction.error || new Error('indexeddb-tx-aborted'));
    });
  } catch (error) {
    // 句柄无法结构化克隆 / 句柄已失效：必须告知调用方，触发「持久化失败」降级。
    if (error && (error.name === 'DataCloneError' || error.name === 'InvalidStateError')) {
      throw error;
    }
    // 其它原因（隐私模式写入被拒、配额等）退化为内存存储，不阻断主流程。
    memoryFallback = true;
    memoryStore.set(key, value);
  }
}

export async function kvDelete(key) {
  await withFallback(key, undefined, () => tx(KV_STORE, 'readwrite', (store) => store.delete(key)));
  memoryStore.delete(key);
}

// ---------- 降级模式虚拟文件系统（路径 -> { kind, name, blob, children }） ----------

export async function vfsLoadAll() {
  const data = await withFallback(
    'vfs-all',
    memoryStore.has('vfs-all') ? memoryStore.get('vfs-all') : {},
    () => tx(VFS_STORE, 'readonly', (store) => store.getAll())
  );
  // getAll 返回数组，键丢失；降级模式直接使用对象。
  if (Array.isArray(data)) {
    const map = {};
    for (const item of data) {
      if (item && typeof item === 'object' && item.__path) map[item.__path] = item;
    }
    return map;
  }
  return data || {};
}

export async function vfsPutAll(nodes) {
  const useMemory = await isMemoryFallback();
  if (useMemory) {
    memoryStore.set('vfs-all', nodes);
    return;
  }
  await new Promise((resolve, reject) => {
    openDb().then((db) => {
      const transaction = db.transaction(VFS_STORE, 'readwrite');
      const store = transaction.objectStore(VFS_STORE);
      store.clear();
      for (const [path, node] of Object.entries(nodes)) {
        store.put({ ...node, __path: path }, path);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        memoryFallback = true;
        memoryStore.set('vfs-all', nodes);
        resolve();
      };
      transaction.onabort = () => {
        memoryFallback = true;
        memoryStore.set('vfs-all', nodes);
        resolve();
      };
    }).catch(() => {
      memoryFallback = true;
      memoryStore.set('vfs-all', nodes);
      resolve();
    });
  });
}

export { memoryFallback as storageMemoryFallback };
