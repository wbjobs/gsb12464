# 本地文件管理器（File System Access API 演示）

纯原生 HTML/CSS/JS（无框架、无构建步骤），演示在网页中安全地读写本地文件，
并对权限、兼容性与各类异常做了完整处理。

## 运行

需要通过 HTTP(S) 访问（`file://` 不是安全上下文，会自动进入降级模式）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

推荐 Chrome / Edge 86+。Firefox、Safari 不支持 File System Access API，会自动进入降级模式。

## 功能

- 申请目录访问权限（`showDirectoryPicker`，readwrite 模式）
- 浏览目录（可进入子目录、返回上级）、打开文件、预览内容（>512KB 截断预览）
- 写入文件（失败自动指数退避重试 3 次，仍失败提供手动重试按钮）
- 新建文件、删除文件（带确认）
- 状态面板：环境、权限状态、目录句柄名、授权时间、句柄持久化状态
- 目录句柄持久化到 IndexedDB，刷新后自动恢复；权限失效时显示「重新授权」
- 不支持 / 非安全上下文时降级：文件选择器读取 + Blob 下载保存

## 异常处理对照

| 场景 | 行为 |
| --- | --- |
| 权限被拒 | 状态面板显示「已拒绝」，提示去站点设置，可重新申请 |
| 浏览器不支持 | 进入降级模式（文件选择 + 下载） |
| 非安全上下文 | 进入降级模式并说明原因 |
| 句柄持久化失败 | 降级为内存句柄，仅当前会话有效，并提示 |
| 权限失效 | 操作前检测，显示「重新授权」按钮（用户手势触发） |
| 写入失败 | 自动重试 3 次（指数退避），失败后显示手动「重试」 |
| 用户未交互 | `navigator.userActivation` 预判 + 捕获 `SecurityError`，不崩溃 |
| 降级模式删除 | 明确提示不支持，引导系统文件管理器 |

## 文件结构

- `index.html` — 页面结构（状态面板 / 主模式 / 降级模式）
- `css/style.css` — 样式
- `js/db.js` — IndexedDB 句柄持久化（失败静默降级）
- `js/fs-access.js` — File System Access API 封装（权限、读写删、重试）
- `js/fallback.js` — 降级方案（`<input type=file>` / Blob 下载）
- `js/app.js` — UI 主逻辑与状态机
