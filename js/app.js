// 主控逻辑：环境检测、权限申请/重新授权、目录浏览、文件预览、写入/新建/删除、写入重试、降级。
import { isSupported, AccessAdapter, FallbackAdapter, guessMime, isTextualName, formatSize } from './adapters.js';
import { kvGet, kvSet, isMemoryFallback } from './storage.js';

const ROOT_KEY = 'root-handle';
const GRANTED_AT_KEY = 'granted-at';
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 文本预览最大 2MB

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.adapter = null;
    this.crumbs = [];
    this.currentEntry = null;
    this.currentInfo = null;
    this.currentText = '';
    this.currentMime = '';
    this.writePendingBlob = null;
    this.envOk = true;
    this.envReason = '';
    this.memoryStorage = false;
    this.lastGrantedAt = null;
  }

  init() {
    this.bindEvents();
    this.boot().catch((error) => {
      this.setBanner('error', `初始化失败：${this.describeError(error)}。可使用降级模式继续。`, false, () => this.enableImportFallback());
    });
  }

  async boot() {
    const secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : true;
    this.memoryStorage = await isMemoryFallback();

    if (!secure) {
      this.envOk = false;
      this.envReason = 'non-secure';
      this.setBanner('error', '当前为非安全上下文（HTTP 或 file:// 之外的不安全环境）。File System Access API 需要 HTTPS 或 http://localhost/，已为你切换到文件选择 + 下载的降级模式。');
      await this.startFallback('非安全上下文，已自动降级');
      return;
    }

    if (!isSupported) {
      this.envOk = false;
      this.envReason = 'unsupported';
      this.setBanner('warn', '当前浏览器不支持 File System Access API（建议使用桌面版 Chrome / Edge 最新版本）。已降级：可用「导入文件」选择本地文件，编辑后通过浏览器下载保存。');
      await this.startFallback('浏览器不支持，已自动降级');
      return;
    }

    // 支持原生 API：先尝试恢复上次的目录句柄（不弹任何授权框，避免无交互调用崩溃）。
    await this.tryRestoreHandle();
    if (!this.adapter) {
      this.setPermState('prompt', '等待授权');
      this.setMode('未连接目录');
      this.setStatus('点击「申请目录访问权限」选择一个本地文件夹');
    }
  }

  async tryRestoreHandle() {
    let handle = null;
    try {
      handle = await kvGet(ROOT_KEY);
    } catch {
      handle = null;
    }
    if (!handle || typeof handle !== 'object' || typeof handle.queryPermission !== 'function') {
      if (this.memoryStorage) {
        this.setBanner('warn', 'IndexedDB 不可用，目录句柄无法跨会话持久化，本次会话内功能正常；刷新后需要重新选择目录。');
      }
      return;
    }

    const adapter = new AccessAdapter(handle);
    let state = 'prompt';
    try {
      state = await adapter.queryPermission('readwrite');
    } catch {
      state = 'prompt';
    }

    this.lastGrantedAt = await this.safeGetGrantedAt();
    if (state === 'granted') {
      this.adapter = adapter;
      this.setMode(`已连接：${handle.name}`);
      this.setHandleInfo(handle.name, this.lastGrantedAt);
      this.setPermState('granted', '已授权（可读写）');
      this.setDot('ok');
      this.enableFsActions(true);
      this.setBanner('info', `已恢复上次目录「${handle.name}」。`, true);
      try {
        await this.refresh();
      } catch (error) {
        this.handleFsError(error, '读取已恢复目录失败');
      }
    } else {
      // 句柄还在，但权限已失效 —— 展示并等待用户手势重新申请。
      this.staleHandle = handle;
      this.setMode('权限已失效');
      this.setHandleInfo(handle.name, this.lastGrantedAt);
      this.setPermState('prompt', '需要重新授权');
      this.setDot('warn');
      $('btnReauth').classList.remove('hidden');
      this.setBanner('warn', `目录「${handle.name}」的授权已失效（浏览器会在重启或一段时间后回收权限）。点击「重新授权」继续访问；也可以重新选择目录。`);
      this.setStatus('权限已失效，请重新授权');
    }
  }

  async safeGetGrantedAt() {
    try {
      return await kvGet(GRANTED_AT_KEY);
    } catch {
      return null;
    }
  }

  async startFallback(reason) {
    const adapter = new FallbackAdapter();
    try {
      await adapter.load();
    } catch {
      // 即便虚拟 FS 读取失败也不影响空会话使用。
    }
    this.adapter = adapter;
    this.setMode('降级模式（文件选择 + 下载）');
    this.setHandleInfo(adapter.rootName, null);
    this.setPermState('prompt', '降级模式 · 无需授权');
    this.enableFsActions(true);
    $('btnPick').textContent = '选择文件导入';
    $('btnReauth').classList.add('hidden');
    this.setDot('warn');
    await this.refresh();
    this.setStatus(reason);
  }

  bindEvents() {
    $('btnPick').addEventListener('click', () => this.onPick());
    $('btnReauth').addEventListener('click', () => this.onReauth());
    $('btnRefresh').addEventListener('click', () => this.safeRefresh());
    $('btnNewFile').addEventListener('click', () => this.onCreate('file'));
    $('btnNewFolder').addEventListener('click', () => this.onCreate('directory'));
    $('btnSave').addEventListener('click', () => this.onSave());
    $('btnDownload').addEventListener('click', () => this.onDownload());
    $('btnDelete').addEventListener('click', () => this.onDelete());

    // 快捷键：Ctrl/⌘+S 保存（阻止浏览器默认保存网页）。
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (!$('btnSave').disabled) {
          event.preventDefault();
          this.onSave();
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.checkPermissionSilently();
    });
    window.addEventListener('focus', () => this.checkPermissionSilently());
  }

  // 用户未交互场景（页面加载、自动轮询）下只做查询，绝不调用 requestPermission。
  async checkPermissionSilently() {
    if (!this.adapter || this.adapter.mode !== 'access' || !this.adapter.root) return;
    try {
      const state = await this.adapter.queryPermission('readwrite');
      if (state === 'granted') {
        this.setPermState('granted', '已授权（可读写）');
        this.setDot('ok');
        $('btnReauth').classList.add('hidden');
      } else if (state === 'denied') {
        this.setPermState('denied', '权限被拒绝');
        this.setDot('err');
      } else if (state === 'prompt') {
        // 连接中的目录权限被回收。
        if (this.adapter) {
          this.setPermState('prompt', '需要重新授权');
          this.setDot('warn');
          $('btnReauth').classList.remove('hidden');
          this.setBanner('warn', '检测到目录权限已失效。点击「重新授权」恢复访问。');
          this.setStatus('权限已失效，请重新授权');
        }
      }
    } catch {
      // 查询权限失败不应影响页面其它功能。
    }
  }

  async onPick() {
    if (this.adapter && this.adapter.mode === 'fallback') {
      await this.onImport();
      return;
    }
    if (!isSupported || window.isSecureContext === false) {
      await this.onImport();
      return;
    }
    let handle;
    try {
      // 必须在点击手势的调用栈中触发。
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        this.toast('已取消选择目录', 'warn');
        this.setStatus('未选择目录');
        return;
      }
      if (error && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) {
        this.setPermState('denied', '权限被拒绝');
        this.setDot('err');
        this.setBanner('error', '浏览器拒绝了目录访问（可能是权限策略限制或连续触发被拦截）。请检查浏览器站点权限后重试；也可使用文件选择 + 下载的降级模式。', false, () => this.enableImportFallback());
        return;
      }
      this.setBanner('error', `打开目录失败：${this.describeError(error)}。已提供降级操作。`, false, () => this.enableImportFallback());
      return;
    }

    const adapter = new AccessAdapter(handle);
    let state = 'prompt';
    try {
      state = await adapter.requestPermission('readwrite');
    } catch (error) {
      if (error.code === 'denied' || error.name === 'NotAllowedError') {
        this.setPermState('denied', '权限被拒绝');
        this.setDot('err');
        this.setBanner('error', '目录访问权限被拒绝。你可以重新点击授权，或使用降级模式。', false, () => this.enableImportFallback());
        return;
      }
    }

    if (state !== 'granted') {
      this.setPermState('denied', '权限被拒绝');
      this.setDot('err');
      this.setBanner('error', '未获得目录访问授权。你可以重新点击授权，或使用降级模式。', false, () => this.enableImportFallback());
      return;
    }

    // 授权成功：持久化句柄；失败则降级为「仅本会话有效」。
    const grantedAt = Date.now();
    let persisted = true;
    try {
      await kvSet(ROOT_KEY, handle);
      await kvSet(GRANTED_AT_KEY, grantedAt);
    } catch (error) {
      persisted = false;
      this.memoryStorage = true;
    }

    this.adapter = adapter;
    this.staleHandle = null;
    this.crumbs = [];
    this.lastGrantedAt = grantedAt;
    this.setMode(`已连接：${handle.name}`);
    this.setHandleInfo(handle.name, grantedAt);
    this.setPermState('granted', '已授权（可读写）');
    this.setDot('ok');
    this.enableFsActions(true);
    $('btnReauth').classList.add('hidden');
    this.clearBanner();
    this.setBanner('info', persisted
      ? `已授权访问「${handle.name}」，句柄与授权时间已保存，下次打开可快速恢复。`
      : `已授权访问「${handle.name}」，但句柄持久化失败（IndexedDB 受限），刷新后需重新选择目录。`, true);
    await this.safeRefresh();
    this.toast('目录授权成功', 'ok');
  }

  async onReauth() {
    const handle = (this.adapter && this.adapter.mode === 'access' && this.adapter.root)
      ? this.adapter.root
      : this.staleHandle;
    if (!handle) {
      $('btnReauth').classList.add('hidden');
      return;
    }
    const adapter = new AccessAdapter(handle);
    let state;
    try {
      state = await adapter.requestPermission('readwrite');
    } catch (error) {
      if (error.code === 'denied' || error.name === 'NotAllowedError') {
        this.setPermState('denied', '权限被拒绝');
        this.setDot('err');
        this.toast('重新授权被拒绝，可稍后再试', 'error');
        return;
      }
      this.toast(`授权失败：${this.describeError(error)}`, 'error');
      return;
    }
    if (state !== 'granted') {
      this.setPermState('denied', '权限被拒绝');
      this.setDot('err');
      return;
    }

    const grantedAt = Date.now();
    try {
      await kvSet(ROOT_KEY, handle);
      await kvSet(GRANTED_AT_KEY, grantedAt);
    } catch {
      // 持久化失败不影响当前会话使用。
    }
    this.adapter = adapter;
    this.staleHandle = null;
    this.lastGrantedAt = grantedAt;
    this.setHandleInfo(handle.name, grantedAt);
    this.setPermState('granted', '已授权（可读写）');
    this.setDot('ok');
    this.enableFsActions(true);
    $('btnReauth').classList.add('hidden');
    this.clearBanner();
    this.toast('重新授权成功', 'ok');
    await this.safeRefresh();
  }

  async enableImportFallback() {
    await this.startFallback('已切换到降级模式（文件选择 + 下载）');
  }

  async onImport() {
    if (!this.adapter || this.adapter.mode !== 'fallback') {
      await this.startFallback('降级模式');
    }
    const directoryMode = await this.confirmChoices();
    if (directoryMode === null) return;
    try {
      const count = await this.adapter.importFiles(directoryMode);
      if (count === 0) {
        this.toast('未选择任何文件', 'warn');
        return;
      }
      this.crumbs = [];
      await this.safeRefresh();
      this.toast(`已导入 ${count} 个文件到浏览器会话`, 'ok');
    } catch (error) {
      this.toast(`导入失败：${this.describeError(error)}`, 'error');
    }
  }

  confirmChoices() {
    return new Promise((resolve) => {
      this.openModal({
        title: '导入方式（降级模式）',
        body: '浏览器无法直接读写本地磁盘。\n选择「整个文件夹」或「多个文件」导入到浏览器会话；编辑保存时会通过下载写回副本。',
        actions: [
          { label: '整个文件夹', primary: true, run: () => resolve(true) },
          { label: '选择文件', run: () => resolve(false) },
          { label: '取消', run: () => resolve(null) },
        ],
      });
    });
  }

  async safeRefresh() {
    if (!this.adapter) return;
    try {
      await this.refresh();
    } catch (error) {
      this.handleFsError(error, '读取目录失败');
    }
  }

  async refresh() {
    const entries = await this.adapter.listDir(this.crumbs);
    this.renderCrumbs();
    this.renderEntries(entries);
    this.setStatus(`${this.crumbs.length ? this.crumbs.join('/') : '根目录'} · ${entries.length} 个条目`);
  }

  renderCrumbs() {
    const host = $('crumbs');
    host.replaceChildren();
    const rootLabel = this.adapter.mode === 'fallback' ? '已导入文件' : this.adapter.root.name;
    host.appendChild(this.makeCrumb(rootLabel, 0));
    this.crumbs.forEach((part, index) => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      host.appendChild(sep);
      host.appendChild(this.makeCrumb(part, index + 1));
    });
  }

  makeCrumb(label, depth) {
    const link = document.createElement('a');
    link.textContent = label;
    const current = depth === this.crumbs.length;
    if (current) link.style.color = 'var(--text)';
    link.addEventListener('click', () => {
      if (current) return;
      this.crumbs = this.crumbs.slice(0, depth);
      this.closeFile();
      this.safeRefresh();
    });
    return link;
  }

  renderEntries(entries) {
    const list = $('entryList');
    list.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-tip';
      empty.textContent = this.adapter.mode === 'fallback'
        ? '会话中还没有文件，点击「导入文件」或「＋ 新文件」'
        : '空文件夹';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement('li');
      item.tabIndex = 0;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entry.kind === 'directory' ? '📁' : '📄';
      const name = document.createElement('span');
      name.textContent = entry.name;
      item.append(icon, name);
      if (entry.kind === 'file') {
        item.addEventListener('click', () => {
          this.selectRow(item);
          this.openFile(entry.path);
        });
        item.addEventListener('dblclick', () => this.openFile(entry.path));
      } else {
        const enter = () => {
          this.crumbs = entry.path.slice();
          this.closeFile();
          this.safeRefresh();
        };
        item.addEventListener('click', () => this.selectRow(item));
        item.addEventListener('dblclick', enter);
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            enter();
          }
        });
      }
      list.appendChild(item);
    }
  }

  selectRow(row) {
    document.querySelectorAll('.entry-list li.selected').forEach((el) => el.classList.remove('selected'));
    row.classList.add('selected');
  }

  async openFile(pathParts) {
    try {
      const info = await this.adapter.readFile(pathParts);
      this.currentEntry = pathParts.slice();
      this.currentInfo = info;
      this.currentMime = info.mime || guessMime(info.name);
      this.currentText = '';
      this.resetViewerPanels();
      $('viewerEmpty').classList.add('hidden');
      $('viewerFile').classList.remove('hidden');
      $('fileName').textContent = info.name;
      $('fileMeta').textContent = `${formatSize(info.size)}${this.currentMime ? ` · ${this.currentMime}` : ''}`;
      $('btnDelete').disabled = false;
      this.renderPreview(info);
      this.setStatus(`已打开：${pathParts.join('/')}`);
    } catch (error) {
      this.handleFsError(error, '打开文件失败');
    }
  }

  resetViewerPanels() {
    $('textPreview').classList.add('hidden');
    $('mediaPreview').classList.add('hidden');
    $('infoCard').classList.add('hidden');
    $('mediaPreview').replaceChildren();
    $('btnSave').disabled = true;
  }

  renderPreview(info) {
    const mime = this.currentMime;
    const textual = isTextualName(info.name, mime);
    if (mime.startsWith('image/')) {
      const url = URL.createObjectURL(info.blob);
      const img = document.createElement('img');
      img.src = url;
      img.alt = info.name;
      $('mediaPreview').appendChild(img);
      $('mediaPreview').classList.remove('hidden');
      return;
    }
    if (mime.startsWith('video/')) {
      const url = URL.createObjectURL(info.blob);
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      $('mediaPreview').appendChild(video);
      $('mediaPreview').classList.remove('hidden');
      return;
    }
    if (mime.startsWith('audio/')) {
      const url = URL.createObjectURL(info.blob);
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      $('mediaPreview').appendChild(audio);
      $('mediaPreview').classList.remove('hidden');
      return;
    }
    if (mime === 'application/pdf') {
      const url = URL.createObjectURL(info.blob);
      const frame = document.createElement('iframe');
      frame.src = url;
      $('mediaPreview').appendChild(frame);
      $('mediaPreview').classList.remove('hidden');
      return;
    }
    if (textual && info.size <= TEXT_PREVIEW_LIMIT) {
      this.loadTextPreview(info.blob);
      return;
    }
    this.showInfoCard(
      textual ? '📝' : '📦',
      textual ? '文本文件过大，已跳过编辑器预览。' : '不支持预览此二进制文件。',
      '可使用「下载副本」保存，' + (this.adapter.mode === 'access' ? '也可在本地用对应程序打开。' : '在本地用对应程序打开。')
    );
  }

  async loadTextPreview(blob) {
    try {
      this.currentText = await blob.text();
      const editor = $('editor');
      editor.value = this.currentText;
      $('textPreview').classList.remove('hidden');
      $('btnSave').disabled = false;
    } catch {
      this.showInfoCard('⚠️', '文件内容读取失败。', '可能编码不受支持或文件已损坏。');
    }
  }

  showInfoCard(icon, title, detail) {
    const card = $('infoCard');
    card.replaceChildren();
    const iconEl = document.createElement('span');
    iconEl.className = 'big-icon';
    iconEl.textContent = icon;
    const titleEl = document.createElement('p');
    titleEl.textContent = title;
    const detailEl = document.createElement('p');
    detailEl.textContent = detail;
    card.append(iconEl, titleEl, detailEl);
    card.classList.remove('hidden');
  }

  closeFile() {
    this.currentEntry = null;
    this.currentInfo = null;
    this.currentText = '';
    this.writePendingBlob = null;
    $('viewerFile').classList.add('hidden');
    $('viewerEmpty').classList.remove('hidden');
    $('btnSave').disabled = true;
    $('btnDelete').disabled = true;
  }

  buildBlobFromEditor() {
    const content = $('editor').value;
    const mime = this.currentMime && (this.currentMime.startsWith('text/') || this.currentMime === 'application/json' || this.currentMime === 'image/svg+xml')
      ? `${this.currentMime};charset=utf-8`
      : 'text/plain;charset=utf-8';
    return new Blob([content], { type: mime });
  }

  async onSave() {
    if (!this.currentEntry) return;
    const blob = this.writePendingBlob || this.buildBlobFromEditor();
    this.writePendingBlob = blob;
    $('btnSave').disabled = true;
    this.setStatus('正在写入文件…');
    try {
      const result = await this.adapter.writeFile(this.currentEntry, blob);
      this.writePendingBlob = null;
      this.currentText = $('editor').value;
      if (this.currentInfo) this.currentInfo.size = blob.size;
      $('fileMeta').textContent = `${formatSize(blob.size)}${this.currentMime ? ` · ${this.currentMime}` : ''}`;
      this.toast(result.downloaded ? '已保存并触发浏览器下载' : '写入成功', 'ok');
      this.setStatus(result.downloaded ? '降级模式：已通过下载保存副本' : `已写入：${this.currentEntry.join('/')}`);
    } catch (error) {
      this.handleWriteError(error, blob);
    } finally {
      $('btnSave').disabled = false;
    }
  }

  handleWriteError(error, blob) {
    const denied = error.code === 'denied' || error.name === 'NotAllowedError';
    const quota = error.code === 'quota' || error.name === 'QuotaExceededError';
    const reason = this.describeError(error);
    this.setStatus(`写入失败：${reason}`);

    const actions = [
      {
        label: '重试写入',
        primary: true,
        run: () => {
          // 原生模式下重试会重新走 requestPermission（仍在点击手势中）。
          this.onSave();
        },
      },
    ];
    if (this.adapter.mode === 'access') {
      actions.push({
        label: '下载副本',
        run: () => {
          this.downloadBlob(blob, this.currentEntry[this.currentEntry.length - 1]);
          this.toast('已通过下载保留修改内容', 'ok');
        },
      });
    }
    actions.push({ label: '取消', run: () => {} });

    let body;
    if (denied) {
      body = `写入需要读写授权，但当前未获得权限。\n失败原因：${reason}\n点击「重试写入」将重新申请权限；若浏览器持续拒绝，可「下载副本」保留修改。`;
    } else if (quota) {
      body = `写入失败：磁盘或浏览器存储空间不足。\n失败原因：${reason}\n清理空间后可「重试写入」，或先「下载副本」。`;
    } else {
      body = `写入失败：${reason}\n你可以直接「重试写入」；编辑器中的修改不会丢失，也可「下载副本」先保留内容。`;
    }
    this.openModal({
      title: '写入失败，是否重试？',
      body,
      actions,
    });
  }

  async onDownload() {
    if (!this.currentEntry && !this.currentInfo) return;
    try {
      if (this.adapter.mode === 'fallback' || this.currentText !== '' || !this.adapter) {
        // 编辑器打开中：优先下载当前内容；未修改时两者一致。
        const blob = $('textPreview').classList.contains('hidden')
          ? this.currentInfo.blob
          : this.buildBlobFromEditor();
        this.downloadBlob(blob, this.currentInfo.name);
      } else {
        await this.adapter.download(this.currentEntry, this.currentInfo.name);
      }
      this.toast('已开始下载', 'ok');
    } catch (error) {
      this.toast(`下载失败：${this.describeError(error)}`, 'error');
    }
  }

  downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async onDelete() {
    if (!this.currentEntry) return;
    const display = this.currentEntry.join('/');
    const confirmed = await this.confirmPromise(
      '确认删除',
      `确定删除「${display}」吗？\n${this.adapter.mode === 'access' ? '原生模式下会直接从磁盘删除（文件夹将递归删除）。' : '降级模式下仅删除浏览器会话中的副本，不会影响磁盘原文件。'}此操作不可撤销。`
    );
    if (!confirmed) return;
    try {
      await this.adapter.remove(this.currentEntry);
      const removed = this.currentEntry.slice();
      this.closeFile();
      await this.refresh();
      this.toast(`已删除：${removed.join('/')}`, 'ok');
    } catch (error) {
      this.handleFsError(error, '删除失败');
    }
  }

  async onCreate(kind) {
    if (!this.adapter) return;
    const label = kind === 'directory' ? '新文件夹' : '新文件';
    const defaultName = kind === 'directory' ? '新建文件夹' : '新建文件.txt';
    const name = await this.promptPromise(`${label}名称`, `在「${this.crumbs.length ? this.crumbs.join('/') : (this.adapter.mode === 'fallback' ? '会话根目录' : this.adapter.root.name)}」下创建${label}：`, defaultName);
    if (name === null) return;
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!clean) {
      this.toast('名称无效', 'warn');
      return;
    }
    try {
      const targetPath = [...this.crumbs, clean];
      if (kind === 'directory') {
        await this.adapter.createDirectory(targetPath);
      } else {
        await this.adapter.createFile(targetPath);
      }
      await this.refresh();
      this.toast(`已创建${label}：${clean}`, 'ok');
    } catch (error) {
      if (error.code === 'exists') {
        this.toast('已存在同名条目，请换一个名称', 'warn');
      } else {
        this.handleFsError(error, `创建${label}失败`);
      }
    }
  }

  handleFsError(error, context) {
    const denied = error.code === 'denied' || error.name === 'NotAllowedError';
    const notFound = error.code === 'not-found' || error.name === 'NotFoundError';
    if (denied) {
      this.setPermState('prompt', '需要重新授权');
      this.setDot('warn');
      $('btnReauth').classList.remove('hidden');
      this.setBanner('error', `${context}：权限被拒绝或已失效。点击「重新授权」后重试。`);
      this.toast(`${context}：需要重新授权`, 'error');
    } else if (notFound) {
      this.toast(`${context}：文件或目录不存在，可能已在磁盘上被移动或删除`, 'warn');
      this.safeRefresh();
    } else {
      this.toast(`${context}：${this.describeError(error)}`, 'error');
    }
    this.setStatus(`${context}：${this.describeError(error)}`);
  }

  describeError(error) {
    if (!error) return '未知错误';
    if (error.code === 'aborted' || error.name === 'AbortError') return '操作已取消';
    if (error.code === 'denied' || error.name === 'NotAllowedError') return '权限被拒绝';
    if (error.name === 'SecurityError') return '安全限制（可能需要安全上下文或用户手势）';
    if (error.name === 'NotFoundError') return '文件或目录不存在';
    if (error.name === 'QuotaExceededError') return '存储空间不足';
    return error.message || String(error);
  }

  // ---------- UI 辅助 ----------

  setPermState(kind, text) {
    const el = $('permState');
    el.className = `perm-badge ${kind}`;
    el.textContent = text;
  }

  setMode(text) {
    $('modeState').textContent = text;
  }

  setHandleInfo(name, grantedAt) {
    $('dirHandle').textContent = name || '尚未获取';
    $('grantedAt').textContent = grantedAt ? this.formatTime(grantedAt) : '—';
  }

  formatTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  setDot(kind) {
    $('brandDot').className = `brand-dot ${kind || ''}`.trim();
  }

  setStatus(text) {
    $('statusMessage').textContent = text;
  }

  enableFsActions(enabled) {
    $('btnNewFile').disabled = !enabled;
    $('btnNewFolder').disabled = !enabled;
  }

  setBanner(kind, message, autoDismiss = false, action) {
    const banner = $('banner');
    banner.className = `banner ${kind}`;
    banner.replaceChildren();
    const text = document.createElement('span');
    text.textContent = message;
    banner.appendChild(text);
    if (typeof action === 'function') {
      const button = document.createElement('button');
      button.className = 'btn small warn';
      button.textContent = '使用降级模式';
      button.style.marginLeft = '10px';
      button.addEventListener('click', () => action());
      banner.appendChild(button);
    }
    const close = document.createElement('button');
    close.className = 'banner-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', () => this.clearBanner());
    banner.appendChild(close);
    if (autoDismiss) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = setTimeout(() => this.clearBanner(), 8000);
    }
  }

  clearBanner() {
    $('banner').className = 'banner hidden';
    $('banner').replaceChildren();
  }

  toast(message, kind = '') {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(() => el.remove(), 260);
    }, 3800);
  }

  openModal({ title, body, actions }) {
    const host = $('modalHost');
    host.replaceChildren();
    const modal = document.createElement('div');
    modal.className = 'modal';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = body;
    const actionsBar = document.createElement('div');
    actionsBar.className = 'modal-actions';
    for (const item of actions) {
      const button = document.createElement('button');
      button.className = `btn ${item.primary ? 'primary' : ''}`;
      button.textContent = item.label;
      button.addEventListener('click', () => {
        this.closeModal();
        item.run();
      });
      actionsBar.appendChild(button);
    }
    modal.append(heading, paragraph, actionsBar);
    host.appendChild(modal);
    host.classList.remove('hidden');
    const firstButton = actionsBar.querySelector('button');
    if (firstButton) firstButton.focus();
  }

  closeModal() {
    const host = $('modalHost');
    host.classList.add('hidden');
    host.replaceChildren();
  }

  confirmPromise(title, body) {
    return new Promise((resolve) => {
      this.openModal({
        title,
        body,
        actions: [
          { label: '确认', primary: true, run: () => resolve(true) },
          { label: '取消', run: () => resolve(false) },
        ],
      });
    });
  }

  promptPromise(title, body, defaultValue) {
    return new Promise((resolve) => {
      const host = $('modalHost');
      host.replaceChildren();
      const modal = document.createElement('div');
      modal.className = 'modal';
      const heading = document.createElement('h2');
      heading.textContent = title;
      const paragraph = document.createElement('p');
      paragraph.textContent = body;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue;
      input.style.cssText = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:0.92rem;margin-bottom:16px;';
      const actionsBar = document.createElement('div');
      actionsBar.className = 'modal-actions';
      const submit = () => resolve(input.value);
      const cancelButton = document.createElement('button');
      cancelButton.className = 'btn';
      cancelButton.textContent = '取消';
      cancelButton.addEventListener('click', () => {
        this.closeModal();
        resolve(null);
      });
      const okButton = document.createElement('button');
      okButton.className = 'btn primary';
      okButton.textContent = '创建';
      okButton.addEventListener('click', () => {
        this.closeModal();
        submit();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          this.closeModal();
          submit();
        }
      });
      actionsBar.append(cancelButton, okButton);
      modal.append(heading, paragraph, input, actionsBar);
      host.appendChild(modal);
      host.classList.remove('hidden');
      input.focus();
      input.select();
    });
  }
}

// 全局兜底：任何未预期错误都不能让页面白屏崩溃。
window.addEventListener('error', (event) => {
  const host = document.getElementById('toastHost');
  if (host) {
    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.textContent = `发生未预期错误：${event.message || '未知错误'}`;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }
});

const app = new App();
app.init();
