/**
 * Firefly 后台管理（/admin）路由注入
 *
 * 默认仅在 `astro dev` 开发服务器下启用；
 * 生产构建需要显式设置环境变量 ADMIN_ENABLE=true，并且项目必须以 SSR 模式部署
 * （例如 CF_WORKERS=true 启用 Cloudflare adapter）。纯静态构建不注入这些路由，
 * 不影响正常的静态部署。
 */

const adminRoutes = [
	{ pattern: "/admin", entrypoint: "./src/admin/pages/index.astro" },
	{ pattern: "/admin/login", entrypoint: "./src/admin/pages/login.astro" },
	{ pattern: "/admin/posts", entrypoint: "./src/admin/pages/posts.astro" },
	{ pattern: "/admin/editor", entrypoint: "./src/admin/pages/editor.astro" },
	{ pattern: "/admin/config", entrypoint: "./src/admin/pages/config.astro" },
	{
		pattern: "/admin/config-editor",
		entrypoint: "./src/admin/pages/config-editor.astro",
	},
	{
		pattern: "/admin/images",
		entrypoint: "./src/admin/pages/images.astro",
	},
	{
		pattern: "/api/admin/images",
		entrypoint: "./src/admin/api/images.ts",
	},
	{
		pattern: "/api/admin/image-raw",
		entrypoint: "./src/admin/api/images-raw.ts",
	},
	{
		pattern: "/api/admin/auth/login",
		entrypoint: "./src/admin/api/auth-login.ts",
	},
	{
		pattern: "/api/admin/auth/authorize",
		entrypoint: "./src/admin/api/auth-authorize.ts",
	},
	{
		pattern: "/api/admin/auth/callback",
		entrypoint: "./src/admin/api/auth-callback.ts",
	},
	{
		pattern: "/api/admin/auth/session",
		entrypoint: "./src/admin/api/auth-session.ts",
	},
	{
		pattern: "/api/admin/publish",
		entrypoint: "./src/admin/api/publish.ts",
	},
	{
		pattern: "/api/admin/dashboard",
		entrypoint: "./src/admin/api/dashboard.ts",
	},
	{
		pattern: "/api/admin/auth/logout",
		entrypoint: "./src/admin/api/auth-logout.ts",
	},
	{ pattern: "/api/admin/auth/me", entrypoint: "./src/admin/api/auth-me.ts" },
	{ pattern: "/api/admin/posts", entrypoint: "./src/admin/api/posts.ts" },
	{
		pattern: "/api/admin/files/tree",
		entrypoint: "./src/admin/api/files-tree.ts",
	},
	{
		pattern: "/api/admin/files/file",
		entrypoint: "./src/admin/api/files-file.ts",
	},
];

export default function fireflyAdmin() {
	return {
		name: "firefly-admin",
		hooks: {
			"astro:config:setup"({ command, injectRoute }) {
				const enabled =
					command === "dev" || process.env.ADMIN_ENABLE === "true";
				if (!enabled) return;
				for (const route of adminRoutes) {
					injectRoute({
						pattern: route.pattern,
						entrypoint: route.entrypoint,
						prerender: false,
					});
				}
			},
		},
	};
}
