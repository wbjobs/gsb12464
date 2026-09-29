/* 降级方案：浏览器不支持 File System Access API 时，
 * 用 <input type="file"> / webkitdirectory 实现「读」，
 * 用 Blob + a[download] 实现「写」（下载保存）。
 * 删除无法降级，由 UI 明确提示。 */
'use strict';

const Fallback = (() => {

  // 通过文件选择器读入一批文件（可多选或整目录）
  function pickFiles({ directory = false, multiple = true } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      if (directory) input.setAttribute('webkitdirectory', '');
      input.addEventListener('change', () => resolve(Array.from(input.files || [])));
      // 部分浏览器取消选择不触发任何事件，用 focus 兜底
      window.addEventListener('focus', () => {
        setTimeout(() => { if (!input.files || input.files.length === 0) resolve([]); }, 400);
      }, { once: true });
      input.click();
    });
  }

  async function readFile(file) {
    const truncated = file.size > FSAccess.PREVIEW_MAX_BYTES;
    const blob = truncated ? file.slice(0, FSAccess.PREVIEW_MAX_BYTES) : file;
    const text = await blob.text();
    return { text, truncated, size: file.size, lastModified: file.lastModified, type: file.type };
  }

  // 「写入」降级为下载：编辑后的内容存为文件下载
  function downloadFile(name, contents) {
    const blob = contents instanceof Blob ? contents : new Blob([contents], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return { pickFiles, readFile, downloadFile };
})();
