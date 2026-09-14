import type { APIRoute } from "astro";
import { consumeOAuthTicket, setSessionCookie } from "../lib/auth";
import { errorResponse, okResponse, readJsonBody } from "../lib/http";

/**
 * POST /api/admin/auth/session/ —— 用 OAuth 桥接票据建立会话。
 * 由同站登录页的脚本调用（同站请求写 Cookie 不会被浏览器丢弃）。
 * 票据一次性、60 秒有效、HMAC 签名。
 */
export const POST: APIRoute = async (Astro) => {
	const body = await readJsonBody(Astro.request);
	const ticket = typeof body?.ticket === "string" ? body.ticket : "";
	const result = consumeOAuthTicket(ticket);
	if (!result) {
		return errorResponse("登录票据无效或已过期，请重新登录", 401);
	}
	setSessionCookie(Astro, result.user, result.token);
	return okResponse({ user: result.user });
};
