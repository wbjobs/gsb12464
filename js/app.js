/* UI 主逻辑：状态面板、目录浏览、文件预览/编辑、降级模式。 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    envStatus: $('env-status'),
    permStatus: $('perm-status'),
    dirName: $('dir-name'),
    grantedAt: $('granted-at'),
    persistStatus: $('persist-status'),
    btnPick: $('btn-pick'),
    btnReauth: $('btn-reauth'),
    btnForget: $('btn-forget'),
    statusMessage: $('status-message'),
    browser: $('browser'),
    btnUp: $('btn-up'),
    breadcrumb: $('breadcrumb'),
    btnNewFile: $('btn-new-file'),
    btnRefresh: $('btn-refresh'),
    fileList: $('file-list'),
    previewName: $('preview-name'),
    previewMeta: $('preview-meta'),
    editor: $('editor'),
    btnSave: $('btn-save'),
    btnRetrySave: $('btn-retry-save'),
    btnDelete: $('btn-delete'),
    saveStatus: $('save-status'),
    fallback: $('fallback'),
    fallbackReason: $('fallback-reason'),
    btnFallbackOpen: $('btn-fallback-open'),
    btnFallbackOpenDir: $('btn-fallback-open-dir'),
    fallbackList: $('fallback-list'),
    fallbackPreviewName: $('fallback-preview-name'),
    fallbackPreviewMeta: $('fallback-preview-meta'),
    fallbackEditor: $('fallback-editor'),
    btnFallbackDownload: $('btn-fallback-download'),
    toast: $('toast'),
  };

  const state = {
    mode: null,            // 'fs' | 'fallback'
    dirHandle: null,       // 根目录句柄
    pathStack: [],         // 当前浏览路径（句柄栈，含根）
    currentFile: null,     // { handle, name }
    meta: null,            // { grantedAt, ... }
    persisted: false,      // 句柄是否成功持久化
    fallbackFiles: [],     // 降级模式下的 File 列表
    fallbackCurrent: null, // 降级模式下当前 File
  };

  /* ---------- 通用提示 ---------- */

  let toastTimer = null;
  function toast(msg, type = '') {
    els.toast.textContent = msg;
    els.toast.className = `toast ${type}`.trim();
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function setStatusMessage(msg, isError = false) {
    els.statusMessage.textContent = msg || '';
    els.statusMessage.classList.toggle('error', isError);
  }

  /* ---------- 状态面板渲染 ---------- */

  const PERM_LABEL = {
    granted: ['已授权', 'badge-granted'],
    prompt: ['待授权', 'badge-prompt'],
    denied: ['已拒绝', 'badge-denied'],
    'needs-gesture': ['需要用户交互', 'badge-prompt'],
    unavailable: ['不可用', 'badge-unknown'],
    unknown: ['未知', 'badge-unknown'],
  };

  function renderPermBadge(stateName) {
    const [label, cls] = PERM_LABEL[stateName] || PERM_LABEL.unknown;
    els.permStatus.textContent = label;
    els.permStatus.className = `badge ${cls}`;
  }

  function renderStatusPanel() {
    els.dirName.textContent = state.dirHandle ? state.dirHandle.name : '—';
    els.grantedAt.textContent = state.meta && state.meta.grantedAt
      ? new Date(state.meta.grantedAt).toLocaleString()
      : '—';
    els.persistStatus.textContent = state.persisted
      ? '已持久化（刷新后自动恢复）'
      : (state.dirHandle ? '仅本次会话有效（持久化失败或未启用）' : '—');
    els.btnForget.hidden = !state.dirHandle;
  }

  /* ---------- 权限失效处理 ---------- */

  function showReauthNeeded(msg) {
    els.btnReauth.hidden = false;
    renderPermBadge('prompt');
    setStatusMessage(msg || '权限已失效，请点击「重新授权」。', true);
  }

  function hideReauth() {
    els.btnReauth.hidden = true;
  }

  // 每次文件操作前调用；权限不足时引导重新授权，返回 false
  async function ensureFsPermission() {
    if (!state.dirHandle) return false;
    const { state: perm } = await FSAccess.ensurePermission(state.dirHandle, 'readwrite');
    renderPermBadge(perm);
    if (perm === 'granted') {
      hideReauth();
      return true;
    }
    if (perm === 'needs-gesture') {
      showReauthNeeded('浏览器要求用户交互后才能授权，请点击「重新授权」。');
    } else if (perm === 'denied') {
      showReauthNeeded('权限被拒绝。请在浏览器地址栏的站点设置中允许文件访问后，点击「重新授权」。');
    } else {
      showReauthNeeded();
    }
    return false;
  }

  /* ---------- FS 模式：目录浏览 ---------- */

  function currentDir() {
    return state.pathStack[state.pathStack.length - 1] || null;
  }

  function renderBreadcrumb() {
    els.breadcrumb.textContent = '/' + state.pathStack.map((h) => h.name).join('/');
    els.btnUp.disabled = state.pathStack.length <= 1;
  }

  async function refreshList() {
    if (!currentDir()) return;
    if (!(await ensureFsPermission())) return;
    try {
      const entries = await FSAccess.listDirectory(currentDir());
      renderBreadcrumb();
      els.fileList.innerHTML = '';
      if (entries.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '（空目录）';
        els.fileList.appendChild(li);
        return;
      }
      for (const entry of entries) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="icon">${entry.kind === 'directory' ? '📁' : '📄'}</span>`;
        li.appendChild(document.createTextNode(entry.name));
        li.title = entry.name;
        li.addEventListener('click', () => {
          if (entry.kind === 'directory') {
            state.pathStack.push(entry.handle);
            refreshList();
          } else {
            openFile(entry.handle, entry.name, li);
          }
        });
        els.fileList.appendChild(li);
      }
    } catch (err) {
      handleFsError(err, '读取目录失败');
    }
  }

  async function openFile(fileHandle, name, liEl) {
    if (!(await ensureFsPermission())) return;
    try {
      const { text, truncated, size, lastModified } = await FSAccess.readFile(fileHandle);
      state.currentFile = { handle: fileHandle, name };
      els.previewName.textContent = name;
      els.previewMeta.textContent =
        `${size} 字节 · 修改于 ${new Date(lastModified).toLocaleString()}` +
        (truncated ? ' · 仅预览前 512KB' : '');
      els.editor.value = text;
      els.btnSave.disabled = false;
      els.btnDelete.disabled = false;
      els.btnRetrySave.hidden = true;
      els.saveStatus.textContent = '';
      if (liEl) {
        els.fileList.querySelectorAll('li.active').forEach((n) => n.classList.remove('active'));
        liEl.classList.add('active');
      }
    } catch (err) {
      handleFsError(err, '读取文件失败');
    }
  }

  async function saveCurrentFile() {
    if (!state.currentFile) return;
    if (!(await ensureFsPermission())) return;
    els.btnSave.disabled = true;
    els.saveStatus.textContent = '写入中…';
    const result = await FSAccess.writeFile(state.currentFile.handle, els.editor.value);
    els.btnSave.disabled = false;
    if (result.ok) {
      els.btnRetrySave.hidden = true;
      els.saveStatus.textContent = `已保存（第 ${result.attempts} 次尝试）`;
      toast('保存成功', 'ok');
    } else {
      // 自动重试仍失败：提供手动重试入口
      els.btnRetrySave.hidden = false;
      els.saveStatus.textContent = `写入失败：${result.error ? result.error.message : '未知错误'}`;
      toast('写入失败，可点击「重试」', 'error');
    }
  }

  async function createNewFile() {
    if (!(await ensureFsPermission())) return;
    const name = window.prompt('新文件名（相对当前目录）：');
    if (!name) return;
    if (name.includes('/') || name.includes('\\')) {
      toast('文件名不能包含路径分隔符', 'error');
      return;
    }
    try {
      await FSAccess.createFile(currentDir(), name, '');
      toast(`已创建 ${name}`, 'ok');
      refreshList();
    } catch (err) {
      handleFsError(err, '新建文件失败');
    }
  }

  async function deleteCurrentFile() {
    if (!state.currentFile) return;
    if (!(await ensureFsPermission())) return;
    const { name } = state.currentFile;
    if (!window.confirm(`确定删除「${name}」？此操作不可撤销。`)) return;
    try {
      await FSAccess.deleteEntry(currentDir(), name);
      state.currentFile = null;
      els.previewName.textContent = '未选择文件';
      els.previewMeta.textContent = '';
      els.editor.value = '';
      els.btnSave.disabled = true;
      els.btnDelete.disabled = true;
      toast(`已删除 ${name}`, 'ok');
      refreshList();
    } catch (err) {
      handleFsError(err, '删除失败');
    }
  }

  function handleFsError(err, prefix) {
    console.error(prefix, err);
    if (err && (err.name === 'NotAllowedError' || err.code === 'NEEDS_GESTURE')) {
      showReauthNeeded('操作被浏览器拦截（权限失效或缺少用户交互），请重新授权。');
      return;
    }
    toast(`${prefix}：${err && err.message ? err.message : err}`, 'error');
  }

  /* ---------- FS 模式：授权流程 ---------- */

  async function enterFsMode(handle, meta, persisted) {
    state.mode = 'fs';
    state.dirHandle = handle;
    state.pathStack = [handle];
    state.meta = meta;
    state.persisted = persisted;
    els.browser.hidden = false;
    els.fallback.hidden = true;
    renderPermBadge('granted');
    hideReauth();
    setStatusMessage('');
    renderStatusPanel();
    await refreshList();
  }

  async function pickDirectory() {
    try {
      const handle = await FSAccess.pickDirectory('readwrite');
      const grantedAt = Date.now();
      const persisted = await HandleStore.saveDirectoryHandle(handle, { grantedAt });
      if (!persisted) {
        toast('句柄持久化失败，本次授权仅在当前会话有效', 'error');
      }
      await enterFsMode(handle, { grantedAt }, persisted);
    } catch (err) {
      if (err.code === 'ABORTED') return; // 用户取消，不提示
      if (err.code === 'NOT_SUPPORTED' || err.code === 'INSECURE_CONTEXT') {
        enterFallbackMode(err.message);
        return;
      }
      handleFsError(err, '无法打开目录');
    }
  }

  async function reauthorize() {
    if (!state.dirHandle) {
      await pickDirectory();
      return;
    }
    const perm = await FSAccess.requestPermission(state.dirHandle, 'readwrite');
    renderPermBadge(perm);
    if (perm === 'granted') {
      state.meta = { ...(state.meta || {}), grantedAt: Date.now() };
      await HandleStore.saveDirectoryHandle(state.dirHandle, state.meta);
      hideReauth();
      setStatusMessage('');
      renderStatusPanel();
      toast('已重新授权', 'ok');
      refreshList();
    } else if (perm === 'denied') {
      setStatusMessage('权限被拒绝。请在浏览器站点设置中允许文件访问后重试。', true);
    } else if (perm === 'needs-gesture') {
      setStatusMessage('需要用户交互：请点击页面任意按钮后再试。', true);
    } else {
      setStatusMessage('无法申请权限，请重新选择目录。', true);
    }
  }

  async function forgetHandle() {
    await HandleStore.clear();
    state.dirHandle = null;
    state.pathStack = [];
    state.currentFile = null;
    state.meta = null;
    state.persisted = false;
    els.browser.hidden = true;
    els.btnReauth.hidden = true;
    renderPermBadge('unknown');
    renderStatusPanel();
    setStatusMessage('已清除保存的授权。');
  }

  /* ---------- 降级模式 ---------- */

  function enterFallbackMode(reason) {
    state.mode = 'fallback';
    els.browser.hidden = true;
    els.fallback.hidden = false;
    els.btnPick.hidden = true;
    els.btnReauth.hidden = true;
    els.fallbackReason.textContent = reason || '';
    renderPermBadge('unavailable');
    renderStatusPanel();
  }

  function renderFallbackList() {
    els.fallbackList.innerHTML = '';
    if (state.fallbackFiles.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '（尚未选择文件）';
      els.fallbackList.appendChild(li);
      return;
    }
    for (const file of state.fallbackFiles) {
      const li = document.createElement('li');
      const rel = file.webkitRelativePath || file.name;
      li.innerHTML = '<span class="icon">📄</span>';
      li.appendChild(document.createTextNode(rel));
      li.title = rel;
      li.addEventListener('click', async () => {
        try {
          const { text, truncated, size, lastModified } = await Fallback.readFile(file);
          state.fallbackCurrent = file;
          els.fallbackPreviewName.textContent = rel;
          els.fallbackPreviewMeta.textContent =
            `${size} 字节 · 修改于 ${new Date(lastModified).toLocaleString()}` +
            (truncated ? ' · 仅预览前 512KB' : '');
          els.fallbackEditor.value = text;
          els.btnFallbackDownload.disabled = false;
          els.fallbackList.querySelectorAll('li.active').forEach((n) => n.classList.remove('active'));
          li.classList.add('active');
        } catch (err) {
          toast(`读取失败：${err.message}`, 'error');
        }
      });
      els.fallbackList.appendChild(li);
    }
  }

  async function fallbackPick(directory) {
    try {
      const files = await Fallback.pickFiles({ directory });
      if (files.length === 0) return;
      state.fallbackFiles = files;
      renderFallbackList();
      toast(`已读取 ${files.length} 个文件`, 'ok');
    } catch (err) {
      toast(`选择文件失败：${err.message}`, 'error');
    }
  }

  function fallbackDownload() {
    if (!state.fallbackCurrent) return;
    Fallback.downloadFile(state.fallbackCurrent.name, els.fallbackEditor.value);
    toast('已开始下载（请在下载目录中查收并手动覆盖原文件）', 'ok');
  }

  /* ---------- 初始化 ---------- */

  async function init() {
    const env = FSAccess.checkEnvironment();

    if (!env.secure) {
      els.envStatus.textContent = '非安全上下文（需要 HTTPS 或 localhost）';
      enterFallbackMode('当前页面不在安全上下文中，File System Access API 被禁用。');
      return;
    }
    if (!env.supported) {
      els.envStatus.textContent = '浏览器不支持 File System Access API';
      enterFallbackMode('当前浏览器不支持 File System Access API（建议使用 Chrome / Edge 86+）。');
      return;
    }
    els.envStatus.textContent = '安全上下文 · 支持 File System Access API';

    // 尝试恢复持久化的目录句柄
    const { handle, meta } = await HandleStore.loadDirectoryHandle();
    if (!handle) {
      renderPermBadge('unknown');
      renderStatusPanel();
      setStatusMessage(HandleStore.isAvailable()
        ? '尚未授权目录，请点击「选择目录并授权」。'
        : '句柄持久化不可用（可能处于隐私模式），授权仅在当前会话有效。');
      return;
    }

    state.dirHandle = handle;
    state.meta = meta;
    state.persisted = true;
    renderStatusPanel();

    const perm = await FSAccess.queryPermission(handle, 'readwrite');
    renderPermBadge(perm);
    if (perm === 'granted') {
      await enterFsMode(handle, meta, true);
    } else if (perm === 'denied') {
      showReauthNeeded('之前的授权已被拒绝，请重新授权或重新选择目录。');
    } else {
      // prompt / unavailable：需要用户手势才能弹权限框，不能自动调用
      showReauthNeeded('已恢复上次授权的目录，需要点击「重新授权」确认访问。');
    }
  }

  /* ---------- 事件绑定 ---------- */

  els.btnPick.addEventListener('click', pickDirectory);
  els.btnReauth.addEventListener('click', reauthorize);
  els.btnForget.addEventListener('click', forgetHandle);
  els.btnUp.addEventListener('click', () => {
    if (state.pathStack.length > 1) {
      state.pathStack.pop();
      refreshList();
    }
  });
  els.btnNewFile.addEventListener('click', createNewFile);
  els.btnRefresh.addEventListener('click', refreshList);
  els.btnSave.addEventListener('click', saveCurrentFile);
  els.btnRetrySave.addEventListener('click', saveCurrentFile);
  els.btnDelete.addEventListener('click', deleteCurrentFile);
  els.btnFallbackOpen.addEventListener('click', () => fallbackPick(false));
  els.btnFallbackOpenDir.addEventListener('click', () => fallbackPick(true));
  els.btnFallbackDownload.addEventListener('click', fallbackDownload);

  init();
})();
