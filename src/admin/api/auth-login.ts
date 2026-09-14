import type { APIRoute } from "astro";
import { adminConfig } from "../config";
import {
	getClientIp,
	isLoginAllowed,
	isSameOrigin,
	recordLoginFailure,
	setSessionCookie,
	validateGithubToken,
} from "../lib/auth";
import { errorResponse, okResponse, readJsonBody } from "../lib/http";

export const POST: APIRoute = async (Astro) => {
	if (!isSameOrigin(Astro)) {
		return errorResponse("跨站请求被拒绝", 403);
	}
	const ip = getClientIp(Astro);
	if (!isLoginAllowed(ip)) {
		return errorResponse("尝试次数过多，请 10 分钟后再试", 429);
	}
	const body = await readJsonBody(Astro.request);
	const token = typeof body?.token === "string" ? body.token.trim() : "";
	if (!token) {
		return errorResponse("请输入 GitHub 令牌", 400);
	}
	const result = await validateGithubToken(token);
	if (!result.ok) {
		recordLoginFailure(ip);
		return errorResponse(result.message, result.status);
	}
	// 令牌具有仓库写权限时（或配置了 ADMIN_GITHUB_TOKEN），随会话保存用于线上模式的仓库读写
	const keepToken = result.repoScope || Boolean(adminConfig.githubToken);
	setSessionCookie(Astro, result.user, keepToken ? token : undefined);
	return okResponse({
		user: result.user,
		// 白名单未配置时提示站长：任何持有有效令牌的 GitHub 用户都能登录后台
		restricted: result.restricted,
		repoScope: result.repoScope,
	});
};
