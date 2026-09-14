/** 后台 API 通用 JSON 响应助手 */

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function okResponse(data: Record<string, unknown> = {}): Response {
	return jsonResponse({ ok: true, ...data });
}

export function errorResponse(error: string, status = 400): Response {
	return jsonResponse({ ok: false, error }, status);
}

/**
 * 归一化异常信息后再返回给前端。
 *
 * 底层 fs 错误（EPERM / EBUSY / 被安全软件拦截等）的 message 里常带服务器
 * 绝对路径，直接透出等于对外泄露部署结构；这里改为记录到服务端日志、
 * 只回一句通用提示。项目自己抛的、带中文说明的错误原样保留。
 */
export function safeErrorMessage(
	error: unknown,
	fallback = "操作失败",
): string {
	if (!(error instanceof Error) || !error.message) return fallback;
	const raw = error.message;
	if (/[A-Za-z]:[\\/]/.test(raw) || raw.includes(process.cwd())) {
		console.error("[firefly-admin]", raw);
		return `${fallback}（详情见服务端日志）`;
	}
	return raw;
}

/** 解析 JSON 请求体，失败返回 null */
export async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown> | null> {
	try {
		const body = await request.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		return body as Record<string, unknown>;
	} catch {
		return null;
	}
}
