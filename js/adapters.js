// 文件系统适配器：
// - AccessAdapter：基于 File System Access API（showDirectoryFilePicker / 句柄 / createWritable）
// - FallbackAdapter：不支持时降级。导入用 <input type=file webkitdirectory/multiple>，
//   写入用 Blob + a[download]，删除/新建/目录浏览在 IndexedDB 虚拟文件系统中进行。
import { vfsLoadAll, vfsPutAll } from './storage.js';

export const isSupported =
  typeof window !== 'undefined' &&
  typeof window.showDirectoryPicker === 'function' &&
  typeof FileSystemHandle !== 'undefined' &&
  (() => {
    try {
      return 'kind' in FileSystemFileHandle.prototype && typeof FileSystemFileHandle.prototype.createWritable === 'function';
    } catch {
      return false;
    }
  })();

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'css', 'html', 'htm',
  'xml', 'csv', 'yml', 'yaml', 'ini', 'conf', 'log', 'sh', 'py', 'java', 'c', 'h',
  'cpp', 'go', 'rs', 'rb', 'php', 'sql', 'svg', 'env', 'gitignore', 'toml',
]);

export function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const table = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript',
    css: 'text/css', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/x-ms-bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip',
  };
  return table[ext] || '';
}

export function isTextualName(name, mime) {
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'image/svg+xml', 'application/javascript'].includes(mime)) return true;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function normalizeError(error) {
  if (!error) return new Error('unknown-error');
  if (error.name === 'AbortError') error.code = 'aborted';
  if (error.name === 'SecurityError') error.code = error.code || 'security';
  if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
    error.code = error.code || 'denied';
  }
  if (error.name === 'NotFoundError') error.code = 'not-found';
  if (error.name === 'QuotaExceededError') error.code = 'quota';
  return error;
}

// ---------- 原生 File System Access API 适配器 ----------

export class AccessAdapter {
  constructor(rootHandle) {
    this.root = rootHandle;
  }

  get mode() {
    return 'access';
  }

  async queryPermission(mode = 'read') {
    try {
      return await this.root.queryPermission({ mode });
    } catch {
      return 'unknown';
    }
  }

  // 必须在用户手势中调用；prompt 状态会弹出浏览器授权框。
  async requestPermission(mode = 'readwrite') {
    try {
      const state = await this.root.requestPermission({ mode });
      return state;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async resolveHandle(pathParts) {
    let handle = this.root;
    for (const part of pathParts) {
      if (!part) continue;
      handle = await handle.getDirectoryHandle(part);
    }
    return handle;
  }

  async listDir(pathParts) {
    let dirHandle = this.root;
    try {
      dirHandle = await this.resolveHandle(pathParts);
      const entries = [];
      for await (const [name, handle] of dirHandle.entries()) {
        entries.push({
          name,
          kind: handle.kind === 'directory' ? 'directory' : 'file',
          path: [...pathParts, name],
        });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
      return entries;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async resolveFile(pathParts) {
    const name = pathParts[pathParts.length - 1];
    const parentParts = pathParts.slice(0, -1);
    const parent = await this.resolveHandle(parentParts);
    return parent.getFileHandle(name);
  }

  async readFile(pathParts) {
    try {
      const fileHandle = await this.resolveFile(pathParts);
      const file = await fileHandle.getFile();
      const mime = file.type || guessMime(file.name);
      return { name: file.name, size: file.size, mime, blob: file };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async ensureWritable() {
    const state = await this.requestPermission('readwrite');
    if (state !== 'granted') {
      const error = new Error('写入权限未授予');
      error.code = 'denied';
      throw error;
    }
  }

  async writeFile(pathParts, blob) {
    try {
      await this.ensureWritable();
      const fileHandle = await this.resolveFile(pathParts);
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { downloaded: false };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async createFile(pathParts) {
    try {
      await this.ensureWritable();
      const name = pathParts[pathParts.length - 1];
      const parent = await this.resolveHandle(pathParts.slice(0, -1));
      await parent.getFileHandle(name, { create: true });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async createDirectory(pathParts) {
    try {
      await this.ensureWritable();
      const name = pathParts[pathParts.length - 1];
      const parent = await this.resolveHandle(pathParts.slice(0, -1));
      await parent.getDirectoryHandle(name, { create: true });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async remove(pathParts) {
    try {
      await this.ensureWritable();
      const name = pathParts[pathParts.length - 1];
      const parent = await this.resolveHandle(pathParts.slice(0, -1));
      // 通过列举判断类型，避免对不存在的条目误报。
      let kind = 'file';
      for await (const [entryName, handle] of parent.entries()) {
        if (entryName === name) {
          kind = handle.kind === 'directory' ? 'directory' : 'file';
          break;
        }
      }
      if (kind === 'directory') {
        await parent.removeEntry(name, { recursive: true });
      } else {
        await parent.removeEntry(name);
      }
    } catch (error) {
      throw normalizeError(error);
    }
  }

  // 原生模式下载副本：读取后触发浏览器下载。
  async download(pathParts, fallbackName) {
    const info = await this.readFile(pathParts);
    triggerDownload(info.blob, fallbackName || info.name);
  }
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export { triggerDownload };

function joinPath(parts) {
  return parts.filter(Boolean).join('/');
}

function splitIntoDirs(filePath) {
  return filePath.split('/').slice(0, -1);
}

function pickFiles(directoryMode) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (directoryMode) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    } else {
      input.multiple = true;
    }
    input.style.display = 'none';
    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      cleanup();
      resolve(files);
    });
    // 用户取消选择不会触发 change，监听窗口焦点意义不大；提供取消超时不可靠，因此不做 reject。
    document.body.appendChild(input);
    input.click();
    setTimeout(cleanup, 10 * 60 * 1000);
  });
}

// ---------- 降级适配器：虚拟文件系统 + 文件选择 + Blob 下载 ----------

export class FallbackAdapter {
  constructor() {
    // nodes: path -> { kind, name, blob }
    this.nodes = {};
    this.rootName = '本地文件（降级模式）';
  }

  get mode() {
    return 'fallback';
  }

  async load() {
    this.nodes = await vfsLoadAll();
  }

  async persist() {
    await vfsPutAll(this.nodes);
  }

  uniquePath(baseParts) {
    let candidate = joinPath(baseParts);
    let counter = 1;
    const dot = baseParts[baseParts.length - 1].lastIndexOf('.');
    const stem = dot > 0 ? baseParts[baseParts.length - 1].slice(0, dot) : baseParts[baseParts.length - 1];
    const ext = dot > 0 ? baseParts[baseParts.length - 1].slice(dot) : '';
    while (this.nodes[candidate]) {
      const nextName = `${stem} (${counter})${ext}`;
      candidate = joinPath([...baseParts.slice(0, -1), nextName]);
      counter += 1;
    }
    return candidate.split('/');
  }

  ensureDirChain(dirParts) {
    let accumulated = [];
    for (const part of dirParts) {
      accumulated = [...accumulated, part];
      const path = joinPath(accumulated);
      if (!this.nodes[path]) {
        this.nodes[path] = { kind: 'directory', name: part };
      }
    }
  }

  async importFiles(directoryMode) {
    const files = await pickFiles(directoryMode);
    for (const file of files) {
      const rel = file.webkitRelativePath && directoryMode
        ? file.webkitRelativePath.split('/').slice(1).join('/')
        : file.name;
      const parts = rel ? rel.split('/') : [file.name];
      const unique = this.uniquePath(parts);
      this.ensureDirChain(unique.slice(0, -1));
      this.nodes[joinPath(unique)] = { kind: 'file', name: unique[unique.length - 1], blob: file };
    }
    await this.persist();
    return files.length;
  }

  async listDir(pathParts) {
    const prefix = joinPath(pathParts);
    const depth = pathParts.filter(Boolean).length;
    const seen = new Map();
    for (const [path, node] of Object.entries(this.nodes)) {
      const segments = path.split('/');
      if (segments.length <= depth) continue;
      if (depth > 0 && segments.slice(0, depth).join('/') !== prefix) continue;
      const name = segments[depth];
      if (!seen.has(name)) {
        const entryPath = segments.slice(0, depth + 1).join('/');
        const entryNode = this.nodes[entryPath];
        seen.set(name, {
          name,
          kind: entryNode ? entryNode.kind : 'directory',
          path: [...pathParts, name],
        });
      }
    }
    const entries = Array.from(seen.values());
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return entries;
  }

  async readFile(pathParts) {
    const path = joinPath(pathParts);
    const node = this.nodes[path];
    if (!node || node.kind !== 'file') {
      const error = new Error('文件不存在（可能仅存在于浏览器会话中）');
      error.code = 'not-found';
      throw error;
    }
    const blob = node.blob;
    return { name: node.name, size: blob.size, mime: blob.type || guessMime(node.name), blob };
  }

  async writeFile(pathParts, blob) {
    const path = joinPath(pathParts);
    this.nodes[path] = { kind: 'file', name: pathParts[pathParts.length - 1], blob };
    await this.persist();
    // 降级模式下浏览器无法直接改磁盘文件，保存即下载，覆盖「写文件」基本操作。
    triggerDownload(blob, pathParts[pathParts.length - 1]);
    return { downloaded: true };
  }

  async createFile(pathParts) {
    const path = joinPath(pathParts);
    if (this.nodes[path]) {
      const error = new Error('同名文件已存在');
      error.code = 'exists';
      throw error;
    }
    this.ensureDirChain(pathParts.slice(0, -1));
    this.nodes[path] = {
      kind: 'file',
      name: pathParts[pathParts.length - 1],
      blob: new Blob([''], { type: guessMime(pathParts[pathParts.length - 1]) || 'text/plain' }),
    };
    await this.persist();
    // 空文件也提供下载，保证「新建文件」在磁盘上可落地。
    triggerDownload(this.nodes[path].blob, pathParts[pathParts.length - 1]);
  }

  async createDirectory(pathParts) {
    const path = joinPath(pathParts);
    if (this.nodes[path]) {
      const error = new Error('同名文件夹已存在');
      error.code = 'exists';
      throw error;
    }
    this.ensureDirChain(pathParts);
    await this.persist();
  }

  async remove(pathParts) {
    const prefix = joinPath(pathParts);
    for (const path of Object.keys(this.nodes)) {
      if (path === prefix || path.startsWith(`${prefix}/`)) delete this.nodes[path];
    }
    await this.persist();
  }

  async download(pathParts, fallbackName) {
    const info = await this.readFile(pathParts);
    triggerDownload(info.blob, fallbackName || info.name);
  }
}
