/* File System Access API 封装层。
 * 统一处理：支持检测、安全上下文、权限查询/申请、
 * 用户未交互（无 user activation）防护、读写删、写入重试。 */
'use strict';

const FSAccess = (() => {

  /* ---------- 环境检测 ---------- */

  function checkEnvironment() {
    const secure = window.isSecureContext === true;
    const supported = typeof window.showDirectoryPicker === 'function';
    let reason = null;
    if (!secure) reason = 'INSECURE_CONTEXT';
    else if (!supported) reason = 'NOT_SUPPORTED';
    return { secure, supported, reason };
  }

  /* ---------- 权限 ---------- */
  // 返回 'granted' | 'denied' | 'prompt' | 'needs-gesture' | 'unavailable'

  async function queryPermission(handle, mode = 'readwrite') {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unavailable';
    try {
      return await handle.queryPermission({ mode });
    } catch (err) {
      console.warn('queryPermission 失败:', err);
      return 'unavailable';
    }
  }

  async function requestPermission(handle, mode = 'readwrite') {
    if (!handle || typeof handle.requestPermission !== 'function') return 'unavailable';
    // 用户未交互时 requestPermission 会抛 SecurityError，必须捕获避免崩溃
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
      return 'needs-gesture';
    }
    try {
      return await handle.requestPermission({ mode });
    } catch (err) {
      if (err && err.name === 'SecurityError') return 'needs-gesture';
      console.warn('requestPermission 失败:', err);
      return 'unavailable';
    }
  }

  // 确保有权限；返回 { state, handle }，state 同上
  async function ensurePermission(handle, mode = 'readwrite') {
    let state = await queryPermission(handle, mode);
    if (state === 'granted') return { state, handle };
    if (state === 'prompt') {
      state = await requestPermission(handle, mode);
    }
    return { state, handle };
  }

  /* ---------- 目录选择 ---------- */

  class FSError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'FSError';
      this.code = code;
    }
  }

  async function pickDirectory(mode = 'readwrite') {
    const env = checkEnvironment();
    if (!env.secure) throw new FSError('INSECURE_CONTEXT', '当前不是安全上下文（需要 HTTPS 或 localhost）');
    if (!env.supported) throw new FSError('NOT_SUPPORTED', '当前浏览器不支持 File System Access API');
    try {
      const handle = await window.showDirectoryPicker({ mode });
      return handle;
    } catch (err) {
      if (err && err.name === 'AbortError') throw new FSError('ABORTED', '用户取消了目录选择');
      if (err && err.name === 'SecurityError') throw new FSError('NEEDS_GESTURE', '需要用户交互后才能申请权限');
      throw new FSError('PICK_FAILED', err && err.message ? err.message : '目录选择失败');
    }
  }

  /* ---------- 目录 / 文件操作 ---------- */

  async function listDirectory(dirHandle) {
    const entries = [];
    for await (const entry of dirHandle.values()) {
      entries.push({ name: entry.name, kind: entry.kind, handle: entry });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  const PREVIEW_MAX_BYTES = 512 * 1024; // 预览最多读 512KB

  async function readFile(fileHandle) {
    const file = await fileHandle.getFile();
    const truncated = file.size > PREVIEW_MAX_BYTES;
    const blob = truncated ? file.slice(0, PREVIEW_MAX_BYTES) : file;
    const text = await blob.text();
    return { text, truncated, size: file.size, lastModified: file.lastModified, type: file.type };
  }

  // 写入失败自动重试（默认 3 次，指数退避）
  async function writeFile(fileHandle, contents, { retries = 3, baseDelay = 300 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const writable = await fileHandle.createWritable();
        try {
          await writable.write(contents);
          await writable.close();
        } catch (err) {
          // 写一半失败要尽力 abort，避免留下损坏状态
          try { await writable.abort(); } catch (_) { /* ignore */ }
          throw err;
        }
        return { ok: true, attempts: attempt + 1 };
      } catch (err) {
        lastErr = err;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
        }
      }
    }
    return { ok: false, attempts: retries, error: lastErr };
  }

  async function createFile(dirHandle, name, contents = '') {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    if (contents) {
      const result = await writeFile(fileHandle, contents);
      if (!result.ok) throw result.error || new Error('写入失败');
    }
    return fileHandle;
  }

  async function deleteEntry(dirHandle, name) {
    await dirHandle.removeEntry(name, { recursive: false });
  }

  return {
    checkEnvironment,
    queryPermission,
    requestPermission,
    ensurePermission,
    pickDirectory,
    listDirectory,
    readFile,
    writeFile,
    createFile,
    deleteEntry,
    FSError,
    PREVIEW_MAX_BYTES,
  };
})();
