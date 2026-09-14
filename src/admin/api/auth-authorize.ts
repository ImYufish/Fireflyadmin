import type { APIRoute } from "astro";
import { adminConfig, resolveGithubRepo } from "../config";
import { createOAuthState, OAUTH_STATE_COOKIE } from "../lib/auth";
import { errorResponse } from "../lib/http";

/**
 * GET /api/admin/auth/authorize/ —— 发起 GitHub OAuth 登录，
 * 302 跳转到 GitHub 授权页。已配置线上仓库时申请 repo 权限
 * （授权后可在线上后台读写仓库）。
 */
export const GET: APIRoute = async (Astro) => {
	const clientId = adminConfig.githubClientId;
	if (!clientId) {
		return errorResponse(
			"后台未配置 GitHub OAuth App，请在 src/admin/config.ts 或环境变量中设置 clientId",
			400,
		);
	}
	const state = createOAuthState();
	Astro.cookies.set(OAUTH_STATE_COOKIE, state, {
		path: "/",
		httpOnly: true,
		sameSite: "lax", // OAuth 跳转回来时浏览器会带 Cookie，需 lax 而非 strict
		maxAge: 600,
	});
	const redirectUri = new URL("/api/admin/auth/callback/", Astro.url.origin)
		.href;
	const scope = resolveGithubRepo() ? "repo read:user" : "read:user";
	const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("scope", scope);
	authorizeUrl.searchParams.set("state", state);
	authorizeUrl.searchParams.set("allow_signup", "true");
	return Astro.redirect(authorizeUrl.href);
};
