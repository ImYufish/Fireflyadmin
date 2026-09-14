/**
 * 后台管理（/admin）专属配置。
 *
 * 这里的配置只影响后台本身，与博客前台无关；
 * 博客的主题色、暗色模式等仍由 src/config/siteConfig.ts 控制，后台会自动跟随。
 *
 * ⚠️ 安全约定：本文件**不得写入任何真实密钥**。所有敏感项（OAuth Secret、
 * 令牌、账号密码、图床 Token）一律从环境变量读取，开发时写在项目根目录的
 * `.env`（已被 .gitignore 忽略），部署时填到平台的加密环境变量里。
 * 可提交给他人参考的模板见 `.env.example`。
 */

export type GithubRepoConfig = { owner: string; repo: string; branch: string };

export type AdminConfig = {
	githubClientId: string;
	githubClientSecret: string;
	loginBackgroundApi: string;
	allowedUsers: string[];
	githubProxy: string;
	mode: "local" | "github" | "auto";
	githubRepo: GithubRepoConfig;
	githubToken: string;
	waline: { serverURL: string; email: string; password: string };
	imageBed: { url: string; token: string };
	umami: { url: string; username: string; password: string; websiteId: string };
};

/**
 * GitHub OAuth App 登录（推荐，无需个人令牌）：
 *   1. 打开 https://github.com/settings/developers → "New OAuth App"；
 *   2. Homepage URL 填 http://localhost:4321（按实际部署地址）；
 *   3. Authorization callback URL 填
 *      http://localhost:4321/api/admin/auth/callback/
 *   4. 把 Client ID / Client Secret 写到 `.env`：
 *        ADMIN_GITHUB_CLIENT_ID=Iv1.xxxxxxxx
 *        ADMIN_GITHUB_CLIENT_SECRET=xxxxxxxx
 *
 * 未配置时登录页仅显示「令牌登录」。
 */
export const adminConfig: AdminConfig = {
	githubClientId: process.env.ADMIN_GITHUB_CLIENT_ID ?? "",
	githubClientSecret: process.env.ADMIN_GITHUB_CLIENT_SECRET ?? "",

	/**
	 * 登录页背景的动漫随机图 API（每次刷新随机一张）。
	 * 留空则使用纯主题色渐变背景。常见可用：
	 *   https://t.alcy.cc/ycy
	 *   https://www.dmoe.cc/random.php
	 *   https://api.paugram.com/wallpaper/
	 */
	loginBackgroundApi: "https://t.alcy.cc/ycy",

	/**
	 * 允许登录后台的 GitHub 用户名白名单。
	 * 与环境变量 ADMIN_GITHUB_USERS 的并集生效；两者都为空 = 不限制。
	 * 线上部署务必填写，例如 ADMIN_GITHUB_USERS=your-name
	 */
	allowedUsers: [] as string[],

	/**
	 * 访问 GitHub API 使用的代理（服务器侧网络受限时填写），
	 * 例如 Clash 默认 "http://127.0.0.1:7890"。
	 * 也可用环境变量 ADMIN_GITHUB_PROXY；未设置时自动尝试
	 * HTTPS_PROXY / HTTP_PROXY 环境变量。留空则直连。
	 * 注意：不要把本地代理地址写死，部署到线上会连不上。
	 */
	githubProxy: process.env.ADMIN_GITHUB_PROXY ?? "",

	/**
	 * 后端模式：
	 *   "local"  —— 直接读写本机项目文件（默认开发环境，pnpm dev）
	 *   "github" —— 通过 GitHub Contents API 读写仓库（线上部署用）
	 *   "auto"   —— 开发环境用 local，生产构建（ADMIN_ENABLE=true 的
	 *               SSR 部署）且下方仓库已配置时用 github
	 */
	mode:
		(process.env.ADMIN_MODE as "local" | "github" | "auto" | undefined) ??
		"auto",

	/**
	 * 【线上模式】要管理的 GitHub 仓库（填你博客源码仓库）：
	 *   ADMIN_GITHUB_REPO="owner/repo"、ADMIN_GITHUB_BRANCH="main"
	 * 也可用 ADMIN_GITHUB_REPO_OWNER / ADMIN_GITHUB_REPO_NAME 分别指定。
	 */
	githubRepo: (() => {
		const fromEnv = process.env.ADMIN_GITHUB_REPO ?? "";
		const [owner = "", repo = ""] = fromEnv.split("/");
		return {
			owner: process.env.ADMIN_GITHUB_REPO_OWNER ?? owner,
			repo: process.env.ADMIN_GITHUB_REPO_NAME ?? repo,
			branch: process.env.ADMIN_GITHUB_BRANCH ?? "main",
		};
	})(),

	/**
	 * 【线上模式】具有仓库写权限的 GitHub 令牌（PAT，勾选 repo 权限）。
	 * 配置后线上后台用它读写仓库（与登录者身份无关）；
	 * 不配置时，需用 OAuth（repo 权限）登录，会话里会带上个人令牌。
	 * 用环境变量 ADMIN_GITHUB_TOKEN 设置，**不要写在这里**。
	 */
	githubToken: process.env.ADMIN_GITHUB_TOKEN ?? "",

	/**
	 * 仪表盘的 Waline 评论接入（可选）：填你的 Waline 后端服务地址。
	 * 留空时自动使用博客 commentConfig.waline.serverURL。
	 * 环境变量 ADMIN_WALINE_SERVER_URL 优先。
	 *
	 * 再填上 Waline 管理员账号（后端注册的邮箱 + 密码）后，
	 * 仪表盘会通过管理接口拉取「全站」最新评论，不再依赖文章路径匹配；
	 * 不填时退化为按文章路径查询（部分评论可能显示不出来）。
	 * 用环境变量 ADMIN_WALINE_EMAIL / ADMIN_WALINE_PASSWORD 设置。
	 */
	waline: {
		serverURL: process.env.ADMIN_WALINE_SERVER_URL ?? "",
		email: process.env.ADMIN_WALINE_EMAIL ?? "",
		password: process.env.ADMIN_WALINE_PASSWORD ?? "",
	},

	/**
	 * 【图片管理】CloudFlare ImgBed（cfbed）图床接入（可选）。
	 * 填写后侧栏出现「图片管理」页：上传 / 浏览 / 复制外链 / 删除图床图片，
	 * 编辑器的图片按钮也可直接上传并插入外链。
	 *   url   —— 图床地址，如 https://bed.example.com（不带尾斜杠）
	 *   token —— 图床 API Token（图床控制台 → API Token，需勾选
	 *            upload / list / delete 三种权限，imgbed_ 开头）
	 * 用环境变量 ADMIN_IMGBED_URL / ADMIN_IMGBED_TOKEN 设置。
	 */
	imageBed: {
		url: process.env.ADMIN_IMGBED_URL ?? "",
		token: process.env.ADMIN_IMGBED_TOKEN ?? "",
	},

	/**
	 * 仪表盘的 Umami 统计接入（可选）：填写 Umami 后台账号后，
	 * 仪表盘会展示访问量 / 访客数统计卡与趋势图。
	 * ADMIN_UMAMI_URL / ADMIN_UMAMI_USERNAME / ADMIN_UMAMI_PASSWORD /
	 * ADMIN_UMAMI_WEBSITE_ID（websiteId 也可留空自动取该账号下的第一个站点）
	 */
	umami: {
		url: process.env.ADMIN_UMAMI_URL ?? "",
		username: process.env.ADMIN_UMAMI_USERNAME ?? "",
		password: process.env.ADMIN_UMAMI_PASSWORD ?? "",
		websiteId: process.env.ADMIN_UMAMI_WEBSITE_ID ?? "",
	},
};

/** 汇总生效的登录白名单（配置 + 环境变量 ADMIN_GITHUB_USERS） */
export function resolveAllowedUsers(): string[] {
	const fromEnv = (process.env.ADMIN_GITHUB_USERS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const fromConfig = adminConfig.allowedUsers
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set([...fromEnv, ...fromConfig])];
}

/** 已完整配置的 GitHub 仓库；未配置时返回 null */
export function resolveGithubRepo(): GithubRepoConfig | null {
	const { owner, repo, branch } = adminConfig.githubRepo;
	if (!owner || !repo) return null;
	return { owner, repo, branch: branch || "main" };
}

/** 当前文件后端模式："local" 读写本机项目文件；"github" 读写 GitHub 仓库 */
export function resolveBackendMode(): "local" | "github" {
	const mode = adminConfig.mode;
	if (mode === "local" || mode === "github") return mode;
	// auto：生产构建（SSR 部署）且仓库已配置 → github；否则本地文件
	return import.meta.env.PROD && resolveGithubRepo() ? "github" : "local";
}
