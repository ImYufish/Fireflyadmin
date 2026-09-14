import type { APIRoute } from "astro";
import { adminConfig } from "../config";
import {
	createOAuthTicket,
	exchangeOAuthCode,
	OAUTH_STATE_COOKIE,
	validateGithubToken,
} from "../lib/auth";

/**
 * GET /api/admin/auth/callback/ —— GitHub OAuth 回调：
 * 校验 state → 用授权码换取访问令牌 → 读取用户身份 → 发放一次性票据
 * → 跳到同站登录页由页面脚本建立会话。
 *
 * 不在回调响应里直接写会话 Cookie：从 GitHub 跨站重定向回来的
 * Set-Cookie 可能被浏览器丢弃，导致"授权后回到登录页"。
 */
export const GET: APIRoute = async (Astro) => {
	const loginUrl = new URL("/admin/login/", Astro.url.origin);
	const fail = (message: string) => {
		loginUrl.search = "";
		loginUrl.searchParams.set("error", message);
		return Astro.redirect(loginUrl.href);
	};

	const clientId = adminConfig.githubClientId;
	const clientSecret = adminConfig.githubClientSecret;
	if (!clientId || !clientSecret) {
		return fail("后台未配置 GitHub OAuth App");
	}

	const url = Astro.url;
	const state = url.searchParams.get("state") ?? undefined;
	const cookieState = Astro.cookies.get(OAUTH_STATE_COOKIE)?.value;
	Astro.cookies.delete(OAUTH_STATE_COOKIE, { path: "/" });
	if (!state || !cookieState || state !== cookieState) {
		return fail("OAuth 状态校验失败，请重新登录");
	}

	const code = url.searchParams.get("code");
	if (!code) {
		return fail(
			url.searchParams.get("error_description") ?? "GitHub 授权被取消",
		);
	}

	const exchange = await exchangeOAuthCode(
		code,
		new URL("/api/admin/auth/callback/", Astro.url.origin).href,
	);
	if (!exchange.ok) return fail(exchange.message);

	const check = await validateGithubToken(exchange.accessToken);
	if (!check.ok) return fail(check.message);

	// 同站桥接：票据 60 秒有效、一次性，由登录页脚本换取会话 Cookie。
	// 授权包含 repo 权限时把访问令牌（加密后）随票据带入会话，供线上模式读写仓库。
	const ticket = createOAuthTicket(
		check.user,
		check.repoScope ? exchange.accessToken : undefined,
	);
	loginUrl.search = "";
	loginUrl.searchParams.set("bridge", ticket);
	return Astro.redirect(loginUrl.href);
};
