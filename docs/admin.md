# Firefly 后台管理（/admin）

Firefly 内置的博客后台管理面板，直接集成在 Astro 项目中，通过 `/admin` 路由访问。

## 功能

- **GitHub 登录**，两种方式任选：
  - **OAuth App 一键登录（推荐）**：在 GitHub 官方页面完成授权，无需创建令牌；
  - **个人访问令牌（PAT）登录**：粘贴 PAT 验证身份，签发 7 天有效的签名会话 Cookie（httpOnly + SameSite=Strict），令牌本身不会被保存。
- **主题与博客完全一致**：颜色全部来自博客主题变量（`src/styles/variables.styl`），在 `siteConfig` 里修改主题色（hue）、暗色模式，后台跟着变；侧边栏的明暗切换与博客使用同一个存储键。
- **无刷新导航**：后台页面间切换只替换主内容区（对齐博客 swup 的体感），编辑器有未保存内容时离开会先确认。
- **登录页动漫背景**：背景图来自随机二次元图片 API（可在 `src/admin/config.ts` 配置或更换）。
- **仪表盘**：文章 / 草稿 / 分类 / 标签统计、最近发布、待发布草稿。
- **文章管理**：全部文章列表（含草稿），支持搜索过滤、新建文章（中文标题自动转拼音文件名与 slug，与 `pnpm new-post` 逻辑一致）。
- **文件编辑器**：
  - 文件树（`src/content` 与 `src/config`），支持新建文件 / 文件夹、重命名、删除；
  - CodeMirror 6 编辑器，Markdown / YAML / TS / JSON / HTML / CSS 语法高亮，明暗主题自动跟随；
  - **Markdown 工具栏与快捷键**，覆盖主题支持的全部语法：标题、粗体、斜体、删除线、行内/块级代码、链接、图片、列表、任务列表、表格、分割线、引用，以及主题扩展——Callout（`> [!NOTE]`）、容器指令（`:::tip`）、剧透（`:spoiler[]`）、内部链接（`[[slug|文字]]`）、KaTeX 公式、Mermaid 图表、PlantUML、Tab 代码组、GitHub 仓库卡片、图片网格（`[grid]`）；
  - frontmatter 可视化表单（标题、日期、标签、分类、草稿、置顶、加密等），与编辑器内容双向同步；YAML 块可整体折叠（打开文件时自动折叠，点折叠标记或工具栏 YAML 按钮切换）；
  - `Ctrl+S` 保存，可开启防抖自动保存；
  - 快捷键：`Ctrl+B` 粗体、`Ctrl+I` 斜体、`Ctrl+Shift+X` 删除线、`Ctrl+E` 行内代码、`Ctrl+Alt+C` 代码块、`Ctrl+K` 链接、`Ctrl+Shift+M` 行内公式、`Ctrl+Shift+Q` 引用、`Ctrl+Shift+8/7/9` 无序/有序/任务列表、`Ctrl+Alt+1/2/3` 一二三级标题。
- **实时预览**：预览面板内嵌的就是博客本身的文章页面（`/posts/<slug>/`），KaTeX、Mermaid、PlantUML、代码块、callouts、加密文章等**所有博客渲染特性与前台完全一致**；保存后自动刷新预览，dev 模式下草稿同样可见。
- **图片管理**：独立的「图片管理」页，支持两种存储目标一键切换：
  - **本地项目**（默认）：上传到项目 `public/images/`（自动重命名、防重名、中文转拼音），正文以 `/images/…` 相对路径引用；线上 GitHub 模式下上传/删除会自动提交 commit；
  - **cfbed 图床**：接入 [CloudFlare ImgBed](https://cfbed.sanyue.de/api/upload.html) API，上传（多选与拖拽）、浏览、搜索、复制外链、删除图床图片；
  - 编辑器的图片按钮弹窗里也能直接上传（跟随所选存储目标）并插入链接，或点选最近上传的图片。
- **网站配置**：配置中心列出 `src/config` 下全部配置文件（含中文说明），点击进入编辑器修改，保存后开发服务器自动热更新。
- **仪表盘数据源**：文章统计来自内容目录；访问量 / 访客数趋势图来自 [Umami](https://umami.is/) 统计（填管理员账号自动接入，支持 24h / 7d / 30d / 90d / 12m 时间范围切换）；最新评论来自 [Waline](https://waline.js.org/)（填管理员邮箱 + 密码后拉取全站评论，否则按文章路径查询）。

## 快速开始

```bash
pnpm dev
# 浏览器打开 http://localhost:4321/admin/
```

### 方式一：GitHub OAuth 登录（推荐）

1. 打开 https://github.com/settings/developers → **New OAuth App**；
2. Homepage URL 填 `http://localhost:4321`（按实际地址）；
3. **Authorization callback URL** 填 `http://localhost:4321/api/admin/auth/callback/`；
4. 复制 `.env.example` 为 `.env`，把 Client ID / Client Secret 填进去；
5. 重启 `pnpm dev`，登录页即出现「使用 GitHub 登录」按钮。

### 方式二：个人访问令牌登录

GitHub → Settings → Developer settings → [Personal access tokens](https://github.com/settings/tokens) → Generate new token。**无需勾选任何权限（scope）**即可用于登录验证（仅调用 `GET /user` 验证身份）。

## 配置

### 配置放在哪里

`src/admin/config.ts` 是所有可配置项的**唯一清单与默认值来源**，但
**敏感项一律从环境变量读取**，文件里不写任何真实密钥：

- 本地开发：复制 `.env.example` 为 `.env` 填写（`.env` 已被 `.gitignore` 忽略）；
  `.env` 由 `astro.config.mjs` 在启动时载入 `process.env`（Astro 自身只注入
  `import.meta.env`，不会写 `process.env`）；
- 线上部署：填到平台的加密环境变量里；
- 改了 `.env` 需要**重启 dev 服务器**才会生效。

千万不要把 Token / Secret / 密码提交进仓库 —— 哪怕是私有仓库，也会随
fork、CI 日志、打包产物扩散出去。

下表所有项都可用环境变量设置（环境变量优先）：

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `githubClientId` | `ADMIN_GITHUB_CLIENT_ID` | OAuth App 的 Client ID |
| `githubClientSecret` | `ADMIN_GITHUB_CLIENT_SECRET` | OAuth App 的 Client Secret |
| `loginBackgroundApi` | — | 登录页动漫随机背景 API，留空关闭 |
| `allowedUsers` | `ADMIN_GITHUB_USERS` | 允许登录的 GitHub 用户名白名单（两者并集生效；都为空 = 不限制） |
| `githubProxy` | `ADMIN_GITHUB_PROXY` | 服务器访问 GitHub 用的代理（如 `http://127.0.0.1:7890`）；未设置时自动读取 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量 |
| `waline.serverURL` | `ADMIN_WALINE_SERVER_URL` | Waline 后端地址；留空自动用博客 `commentConfig.waline.serverURL` |
| `waline.email` / `waline.password` | `ADMIN_WALINE_EMAIL` / `ADMIN_WALINE_PASSWORD` | Waline 管理员账号（后端注册的邮箱 + 密码）；填写后仪表盘通过管理接口 `comment?type=list` 拉取**全站**最新评论与总数，不受文章路径匹配限制 |
| `umami.url` / `umami.username` / `umami.password` | `ADMIN_UMAMI_URL` / `ADMIN_UMAMI_USERNAME` / `ADMIN_UMAMI_PASSWORD` | Umami 统计接入，仪表盘展示访问量 / 访客数与趋势图 |
| `imageBed.url` / `imageBed.token` | `ADMIN_IMGBED_URL` / `ADMIN_IMGBED_TOKEN` | CloudFlare ImgBed（cfbed）图床地址与 API Token（图床控制台 → API Token，勾选 upload / list / delete 权限），用于「图片管理」页与编辑器插图 |
| `mode` | `ADMIN_MODE` | 文件后端：`auto`（默认）/ `local` / `github` |
| `githubRepo` | `ADMIN_GITHUB_REPO` / `ADMIN_GITHUB_REPO_OWNER` / `ADMIN_GITHUB_REPO_NAME` / `ADMIN_GITHUB_BRANCH` | 线上 GitHub 模式要管理的仓库 |
| `githubToken` | `ADMIN_GITHUB_TOKEN` | 线上 GitHub 模式的 PAT（Contents 读写权限），所有登录者共用 |
| — | `ADMIN_SECRET` | 会话签名密钥；未设置时自动生成到 `.admin/session-secret`。**部署到无持久文件系统的平台（如 Cloudflare Workers）时必须显式设置**，否则实例重启即换密钥、已登录会话全部失效 |
| — | `ADMIN_GITHUB_TLS_STRICT` | 设为 `true` 时禁止 TLS 证书链错误的自动降级重试（见下文「网络与证书」） |

### 网络与证书

服务器侧访问 GitHub（登录验证 / OAuth 换令牌）时：

1. 优先走上面配置的代理（HTTP 代理，CONNECT 隧道）；
2. 若出现 TLS 证书链验证失败（常见于透明代理、TUN 模式或自建 CA 环境——浏览器正常但 Node 内置 CA 验证不过），会**自动改用宽松校验重试一次**并在控制台提示；
3. 想要更严谨的做法：以 `NODE_USE_SYSTEM_CA=1 pnpm dev` 启动（Node 改用 Windows 系统证书库，与浏览器一致），或设 `ADMIN_GITHUB_TLS_STRICT=true` 关闭自动降级。

示例 `.env`：

```ini
ADMIN_GITHUB_USERS=your-github-username
ADMIN_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
ADMIN_GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# 服务器网络无法直连 GitHub 时：
# ADMIN_GITHUB_PROXY=http://127.0.0.1:7890
```

## 生产环境与部署（Cloudflare / Vercel / EdgeOne）

`/admin` 路由通过 Astro 集成注入，**默认只在 `astro dev` 开发服务器中启用**：
纯静态构建（默认 `pnpm build`）不包含任何后台路由，产物与原版完全一致。
日常本地写作与管理使用 `pnpm dev` 即可，无需任何额外配置。

如需在部署的站点上使用后台（SSR 模式），astro.config.mjs 会根据环境变量
自动选择 SSR adapter，三个平台均开箱即用：

| 平台 | 环境变量 | adapter | 说明 |
| --- | --- | --- | --- |
| Cloudflare Workers | `CF_WORKERS=true` | `@astrojs/cloudflare` | 项目自带配置，已在 wrangler.jsonc 就绪 |
| Vercel | 无需设置（平台自动注入 `VERCEL`） | `@astrojs/vercel` | 直接 Git 导入即可 |
| EdgeOne Pages | 平台构建环境里设 `EDGEONE=1`（或 `EO=1`） | `@edgeone/astro` | 官方 adapter，Git 导入 / CLI 部署均可 |
| 任意 Node 服务器 | `EDGEONE_NODE=1` | `@astrojs/node`（standalone） | 产物 `dist/server/entry.mjs`，`node dist/server/entry.mjs` 运行 |

无论哪个平台，开启后台都还需要：

1. 设置 `ADMIN_ENABLE=true`（平台的环境变量 / 构建环境变量）；
2. **务必**配置 `allowedUsers` / `ADMIN_GITHUB_USERS` 白名单；
3. OAuth 回调地址改为线上域名（在 GitHub OAuth App 设置中更新）：
   `https://你的域名/api/admin/auth/callback/`；
4. 敏感配置（GitHub Token、Waline/Umami/图床账号、`ADMIN_SECRET`）全部放在
   平台的加密环境变量里，不要提交进仓库。

## 线上部署（GitHub 模式）

后台默认只在本地开发（`pnpm dev`）可用；部署到线上（SSR）后，可以把后台切换为
**GitHub 模式**：文件读写通过 GitHub Contents API 直接操作博客仓库，
**保存 = 提交 commit**，推送后由部署平台自动触发重新部署。

### 启用步骤

1. **SSR 部署**：按上表设置对应平台的环境变量（如 Cloudflare：`CF_WORKERS=true`，Vercel 免设置，EdgeOne：`EDGEONE=1`）；
2. **开启后台路由**：设置环境变量 `ADMIN_ENABLE=true`；
3. **配置仓库**（填平台的环境变量，不要写进源码）：

   ```ini
   ADMIN_GITHUB_REPO=你的用户名/源码仓库名
   ADMIN_GITHUB_BRANCH=main
   ADMIN_GITHUB_TOKEN=github_pat_xxx   # PAT，需勾选仓库 Contents 读写权限
   ```

   也可以用 `ADMIN_GITHUB_REPO_OWNER` / `ADMIN_GITHUB_REPO_NAME` 分别指定。
4. **登录**：用 OAuth 登录时（仓库已配置会自动申请 repo 权限），个人令牌会加密存入会话用于仓库读写；或在配置里填一个具有 Contents 写权限的 PAT（`githubToken`），所有登录者共用；
5. **OAuth App 回调地址**：把 Authorization callback URL 改为
   `https://你的域名/api/admin/auth/callback/`。

### 模式选择

| `mode` 配置 | 行为 |
| --- | --- |
| `auto`（默认） | 开发环境 = 本地文件；生产构建 + 已配置仓库 = GitHub |
| `local` | 始终读写本机项目文件（仅本地开发有意义） |
| `github` | 始终通过 GitHub API 读写仓库 |

### GitHub 模式行为差异

- **保存 = 暂存本地草稿**（浏览器 localStorage），不产生 commit；多次修改、多个文件随意攒；
- **「发布」按钮**把全部草稿**一次性提交为单个 commit**（Git Data API：blobs → tree → commit → ref），提交后由部署平台自动重新部署；文件树与文章列表会显示未发布草稿标记，编辑器可丢弃单个文件的草稿；
- 草稿保存在当前浏览器里：换设备 / 清浏览器数据会丢失，发布前请及时发布；
- 发布以发布时刻的远端分支头为基准（单人写作的 last-write-wins）；多人同时改同一文件时后发布者覆盖；
- **新建 / 重命名 / 删除**仍是即时提交（低频操作，避免误操作堆积）；
- **GitHub 不支持空目录**：「新建文件夹」不可用，直接创建文件即可（目录随文件自动创建）；
- 文件树与文章列表有 90 秒缓存，写操作后自动失效；
- 预览面板显示的是线上已部署页面，需等部署完成后刷新。

> 注意：Cloudflare Workers 等平台没有可写的持久文件系统，因此本地模式在
> 线上不可用；GitHub 模式正是为解决这一点而设计。`ADMIN_GITHUB_TOKEN`
> 属于敏感凭据，只应保存在平台的加密环境变量中，不要提交进仓库。

## 安全机制

- OAuth 登录采用「票据桥接」：GitHub 回调只发放一次性短时票据（HMAC 签名、60 秒有效、防重放），由同站脚本换取真正的会话 Cookie，避免跨站重定向链上的 Set-Cookie 被浏览器丢弃；
- 登录接口有速率限制（同一 IP 10 分钟内最多 10 次失败尝试）；
- OAuth 回调使用签名 state（Cookie 绑定 + 10 分钟有效期）防 CSRF；
- 会话 Cookie 为 httpOnly + SameSite=Strict + HMAC-SHA256 签名，无法伪造；
- 带 Origin 头的请求会校验来源与 Host 一致；
- 文件操作仅允许 `src/content` 与 `src/config` 目录，拒绝目录穿越、隐藏文件与二进制编辑，单文件保存上限 4 MB；
- 所有后台页面均带 `noindex, nofollow`。

## 文件结构

```
src/admin/
├── integration.mjs        # 路由注入集成（astro.config.mjs 中启用）
├── config.ts              # 后台专属配置（OAuth / 背景 API / 白名单 / 代理）
├── api/                   # 后台 API 端点（登录 / OAuth / 文件 / 文章）
├── components/            # Svelte 5 组件（登录表单、文件树、编辑器等）
├── layouts/               # 后台布局（主题变量与博客同源，无刷新导航）
├── lib/                   # 认证、路径安全、文章工具、frontmatter 工具
├── pages/                 # /admin 各页面
└── styles/                # 后台样式（引用博客主题变量）
```

## 与上游（CuteLeaf/Firefly）同步

后台被刻意做成**可随时摘除的旁路模块**：业务代码 100% 收敛在 `src/admin/`，
对主题原有文件的改动只有下面这几处，合并上游时只需盯住这些点。

**对外部文件的全部改动（仅此清单）**

| 文件 | 改动 | 冲突面 |
| --- | --- | --- |
| `astro.config.mjs` | 新增 import（`@astrojs/node`、`@astrojs/vercel`、`@edgeone/astro`、`./src/admin/lib/env-loader.mjs`、`./src/admin/integration.mjs`）；调用 `loadEnvIntoProcess()`；新增「按环境变量选 SSR adapter」的 `adapter` 三元块；`integrations` 数组里加入一行 `fireflyAdmin()` | 小。冲突基本只落在 import 区与 `integrations: [` 首行 |
| `package.json` / `pnpm-lock.yaml` | 新增后台依赖（CodeMirror、Svelte、astro-icon、undici、gray-matter 等） | 依赖列表，按上游版本重装即可 |
| `.gitignore` | 忽略 `.admin/`（会话签名密钥）与 `.env` | 极小 |
| `src/admin/`、`docs/admin.md`、`.env.example` | 新增文件，与上游无交集 | 无 |

**为什么不会影响前端**

- `/admin` 路由由 `src/admin/integration.mjs` 通过 `injectRoute` 注入，**只在
  `astro dev` 或显式设置 `ADMIN_ENABLE=true` 时生效**；默认的纯静态 `pnpm build`
  注入 0 条路由，产物与上游完全一致；
- 后台样式全部写在 `src/admin/styles/admin.css`，通过布局局部引入，没有写进
  `src/styles/*`（只读引用博客的 `variables.styl` 主题变量），不参与博客前台的
  Tailwind 扫描与打包；
- 后台页面带 `noindex, nofollow`，且不进入 sitemap；
- 未开启后台时，主题的页面、组件、配置、内容目录零改动。

**合并上游的推荐姿势**

1. `git fetch` 上游后用 merge / rebase 正常拉取；
2. 若 `astro.config.mjs` 有冲突，**保留上游的其余改动**，把上表那几处补回
   （import、`loadEnvIntoProcess()`、`adapter` 三元块、`fireflyAdmin()`）；
3. 依赖冲突直接以 `pnpm install` 重解，无需手工合并 lockfile；
4. 合并后跑一次 `pnpm dev` 确认 `/admin/` 可访问、`pnpm build` 确认未注入后台路由
   （构建日志中不应出现后台 API 路由）。
