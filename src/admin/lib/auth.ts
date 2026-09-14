/**
 * 后台认证：GitHub 个人访问令牌（PAT）登录 + HMAC 签名会话 Cookie。
 *
 * 登录流程：
 *  1. 用户在 /admin/login/ 粘贴 GitHub PAT；
 *  2. 服务端调用 GitHub API `GET /user` 校验令牌并获取用户身份；
 *  3. 若设置了 ADMIN_GITHUB_USERS（逗号分隔的 GitHub 用户名白名单），
 *     则只允许名单内的用户登录；未设置时允许任何有效令牌（本地使用场景）；
 *  4. 校验通过后签发 httpOnly 的签名会话 Cookie（默认 7 天有效）。
 *
 * 环境变量：
 *  - ADMIN_GITHUB_USERS  可选。允许登录的 GitHub 用户名白名单（逗号分隔）
 *  - ADMIN_SECRET        可选。会话签名密钥；未设置时自动生成并保存到 .admin/session-secret
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { APIContext } from "astro";
import type * as undiciTypes from "undici";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { adminConfig, resolveAllowedUsers } from "../config";

export const SESSION_COOKIE = "firefly_admin_session";

/** 会话有效期（秒）：7 天 */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type AdminSession = {
	login: string;
	name: string;
	avatar: string;
	/** 过期时间（Unix 秒） */
	exp: number;
	/** AES 加密的 GitHub 令牌（线上模式读写仓库用），仅存在于签名 Cookie 内 */
	et?: string;
};

/** 会话解密后携带的完整信息（含可用的 GitHub 令牌） */
export type ResolvedSession = AdminSession & { token?: string };

let cachedSecret: string | null = null;

function getSecret(): string {
	if (cachedSecret) return cachedSecret;
	if (process.env.ADMIN_SECRET) {
		cachedSecret = process.env.ADMIN_SECRET;
		return cachedSecret;
	}
	const file = path.join(process.cwd(), ".admin", "session-secret");
	try {
		const existing = fs.readFileSync(file, "utf-8").trim();
		if (existing.length >= 32) {
			cachedSecret = existing;
			return cachedSecret;
		}
	} catch {
		/* 文件不存在则生成新的 */
	}
	const secret = crypto.randomBytes(48).toString("hex");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, secret, "utf-8");
	cachedSecret = secret;
	return cachedSecret;
}

function sign(data: string): string {
	return crypto
		.createHmac("sha256", getSecret())
		.update(data)
		.digest("base64url");
}

/** AES-256-GCM 加密（密钥由会话签名密钥派生），用于把 GitHub 令牌放进会话 */
function encryptString(plain: string): string {
	const key = crypto.createHash("sha256").update(getSecret()).digest();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(plain, "utf-8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return [
		iv.toString("base64url"),
		tag.toString("base64url"),
		encrypted.toString("base64url"),
	].join(".");
}

function decryptString(payload: string): string | null {
	try {
		const [ivPart, tagPart, dataPart] = payload.split(".");
		if (!ivPart || !tagPart || !dataPart) return null;
		const decipher = crypto.createDecipheriv(
			"aes-256-gcm",
			crypto.createHash("sha256").update(getSecret()).digest(),
			Buffer.from(ivPart, "base64url"),
		);
		decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
		return Buffer.concat([
			decipher.update(Buffer.from(dataPart, "base64url")),
			decipher.final(),
		]).toString("utf-8");
	} catch {
		return null;
	}
}

export type SessionUser = {
	login: string;
	name: string;
	avatar: string;
};

/**
 * 创建会话令牌。githubToken：线上模式下用于读写仓库的 GitHub 令牌
 * （OAuth 换取的或用户登录用的 PAT），加密后随会话存储。
 */
export function createSessionToken(
	user: SessionUser,
	githubToken?: string,
): string {
	const session: AdminSession = {
		...user,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
		...(githubToken ? { et: encryptString(githubToken) } : {}),
	};
	const data = Buffer.from(JSON.stringify(session), "utf-8").toString(
		"base64url",
	);
	return `${data}.${sign(data)}`;
}

export function verifySessionToken(
	token: string | undefined,
): ResolvedSession | null {
	if (!token) return null;
	const dotIndex = token.indexOf(".");
	if (dotIndex <= 0) return null;
	const data = token.slice(0, dotIndex);
	const sig = token.slice(dotIndex + 1);
	const expected = sign(data);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	try {
		const session = JSON.parse(
			Buffer.from(data, "base64url").toString("utf-8"),
		) as AdminSession;
		if (!session || typeof session.login !== "string") return null;
		if (typeof session.exp !== "number" || session.exp * 1000 < Date.now()) {
			return null;
		}
		const resolved: ResolvedSession = { ...session };
		if (session.et) {
			resolved.token = decryptString(session.et) ?? undefined;
		}
		return resolved;
	} catch {
		return null;
	}
}

export function getSession(context: APIContext): ResolvedSession | null {
	return verifySessionToken(context.cookies.get(SESSION_COOKIE)?.value);
}

export function setSessionCookie(
	context: APIContext,
	user: SessionUser,
	githubToken?: string,
): void {
	context.cookies.set(SESSION_COOKIE, createSessionToken(user, githubToken), {
		path: "/",
		httpOnly: true,
		sameSite: "strict",
		maxAge: SESSION_TTL_SECONDS,
		// 生产环境（https 部署）启用 Secure，本地 dev 仍走 http
		secure: import.meta.env.PROD,
	});
}

export function clearSessionCookie(context: APIContext): void {
	context.cookies.delete(SESSION_COOKIE, { path: "/" });
}

/* ------------------------- 登录失败速率限制 ------------------------- */

const attempts = new Map<string, { count: number; resetAt: number }>();
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function getClientIp(context: APIContext): string {
	const forwarded = context.request.headers.get("x-forwarded-for");
	if (forwarded) return forwarded.split(",")[0].trim();
	return context.request.headers.get("x-real-ip") ?? "local";
}

/** 是否允许该 IP 尝试登录 */
export function isLoginAllowed(ip: string): boolean {
	const record = attempts.get(ip);
	if (!record) return true;
	if (record.resetAt < Date.now()) {
		attempts.delete(ip);
		return true;
	}
	return record.count < ATTEMPT_LIMIT;
}

export function recordLoginFailure(ip: string): void {
	const record = attempts.get(ip);
	if (!record || record.resetAt < Date.now()) {
		attempts.set(ip, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW_MS });
		return;
	}
	record.count += 1;
}

/* ------------------------- GitHub 网络访问（支持代理） ------------------------- */

/**
 * 必须使用 npm undici 自带的 fetch（而非 Node 内置 fetch）：
 * 两份 undici 的 Dispatcher 接口不兼容，内置 fetch 收到 npm undici 的
 * ProxyAgent 会抛 "invalid onRequestStart method"。
 */
let strictAgent: Agent | ProxyAgent | null | undefined;
let lenientAgent: Agent | ProxyAgent | null | undefined;

const TLS_RETRYABLE_CODES = new Set([
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_GET_ISSUER_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

function resolveProxyUrl(): string {
	return (
		process.env.ADMIN_GITHUB_PROXY ??
		adminConfig.githubProxy ??
		process.env.HTTPS_PROXY ??
		process.env.https_proxy ??
		process.env.HTTP_PROXY ??
		process.env.http_proxy ??
		""
	);
}

/** 代理是否已配置 */
export function githubProxyConfigured(): boolean {
	return resolveProxyUrl() !== "";
}

type Dispatcher = Agent | ProxyAgent;

function getAgents(): { strict: Dispatcher | null; lenient: Dispatcher } {
	const proxy = resolveProxyUrl();
	if (strictAgent === undefined) {
		strictAgent = proxy ? new ProxyAgent(proxy) : null;
		lenientAgent = proxy
			? new ProxyAgent({
					uri: proxy,
					requestTls: { rejectUnauthorized: false },
				})
			: new Agent({ connect: { rejectUnauthorized: false } });
	}
	return { strict: strictAgent, lenient: lenientAgent as Dispatcher };
}

function isTlsVerificationError(error: unknown): boolean {
	const code =
		(error as { code?: unknown; cause?: { code?: unknown } })?.code ??
		(error as { cause?: { code?: unknown } })?.cause?.code;
	return typeof code === "string" && TLS_RETRYABLE_CODES.has(code);
}

/**
 * 服务器侧访问 github.com / api.github.com。
 * 自动使用配置的代理；当出现证书链验证错误（透明代理/自建 CA 环境）
 * 且未设置 ADMIN_GITHUB_TLS_STRICT=true 时，自动以宽松 TLS 模式重试一次。
 */
export async function githubFetch(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("User-Agent", "Firefly-Admin");
	const { strict, lenient } = getAgents();
	const signal = init.signal ?? AbortSignal.timeout(15_000);
	const doFetch = (dispatcher: Dispatcher | null) =>
		undiciFetch(url, {
			method: init.method,
			headers: Object.fromEntries(headers.entries()),
			body: (init.body as undiciTypes.BodyInit | undefined) ?? undefined,
			signal,
			...(dispatcher ? { dispatcher } : {}),
		}) as unknown as Promise<Response>;

	try {
		return await doFetch(strict);
	} catch (error) {
		if (
			!isTlsVerificationError(error) ||
			process.env.ADMIN_GITHUB_TLS_STRICT === "true"
		) {
			throw error;
		}
		if (!tlsDowngradeWarned) {
			tlsDowngradeWarned = true;
			console.warn(
				"[firefly-admin] GitHub 请求的 TLS 证书链无法用 Node 内置 CA 验证" +
					"（常见于透明代理/自建 CA 环境），已自动改用宽松校验重试。" +
					"如需禁止该行为，请设置环境变量 ADMIN_GITHUB_TLS_STRICT=true，" +
					"或以 NODE_USE_SYSTEM_CA=1 启动 dev 服务器。",
			);
		}
		return await doFetch(lenient);
	}
}

let tlsDowngradeWarned = false;

/* ------------------------- GitHub 令牌校验 ------------------------- */

export type TokenCheck =
	| {
			ok: true;
			user: SessionUser;
			restricted: boolean;
			/** 令牌是否具有仓库写权限（x-oauth-scopes 含 repo，或 fine-grained PAT） */
			repoScope: boolean;
	  }
	| { ok: false; status: number; message: string };

export async function validateGithubToken(token: string): Promise<TokenCheck> {
	if (!token || token.length < 8 || /\s/.test(token)) {
		return { ok: false, status: 400, message: "请输入有效的 GitHub 令牌" };
	}
	let res: Response;
	try {
		res = await githubFetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch {
		return {
			ok: false,
			status: 502,
			message: githubProxyConfigured()
				? "无法连接 GitHub API，请检查代理是否可用"
				: "无法连接 GitHub API：服务器网络受限时可设置 ADMIN_GITHUB_PROXY 代理，或改用下方 GitHub OAuth 登录",
		};
	}
	if (res.status === 401) {
		return { ok: false, status: 401, message: "令牌无效或已过期" };
	}
	if (res.status === 403 || res.status === 429) {
		return {
			ok: false,
			status: 429,
			message: "GitHub API 请求受限，请稍后再试",
		};
	}
	if (!res.ok) {
		return {
			ok: false,
			status: 502,
			message: `GitHub API 错误（${res.status}）`,
		};
	}
	let user: unknown;
	try {
		user = await res.json();
	} catch {
		return { ok: false, status: 502, message: "GitHub API 返回异常" };
	}
	const record = user as {
		login?: unknown;
		name?: unknown;
		avatar_url?: unknown;
	};
	const login = typeof record.login === "string" ? record.login : "";
	if (!login) {
		return { ok: false, status: 502, message: "GitHub API 未返回用户信息" };
	}
	const allowlist = resolveAllowedUsers();
	if (allowlist.length > 0 && !allowlist.includes(login.toLowerCase())) {
		return {
			ok: false,
			status: 403,
			message: `GitHub 用户「${login}」不在后台访问白名单中`,
		};
	}
	// 经典令牌：x-oauth-scopes 会列出权限；fine-grained PAT 的权限由仓库设置决定
	const scopes = (res.headers.get("x-oauth-scopes") ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase());
	const repoScope = scopes.includes("repo") || token.startsWith("github_pat_");
	return {
		ok: true,
		restricted: allowlist.length > 0,
		repoScope,
		user: {
			login,
			name:
				typeof record.name === "string" && record.name ? record.name : login,
			avatar: typeof record.avatar_url === "string" ? record.avatar_url : "",
		},
	};
}

/* ------------------------- GitHub OAuth App 登录 ------------------------- */

export const OAUTH_STATE_COOKIE = "firefly_admin_oauth";

/** 生成签名 OAuth state（防 CSRF），有效期 10 分钟 */
export function createOAuthState(): string {
	const payload = Buffer.from(
		JSON.stringify({
			n: crypto.randomBytes(16).toString("hex"),
			exp: Math.floor(Date.now() / 1000) + 600,
		}),
		"utf-8",
	).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

export function verifyOAuthState(state: string | undefined): boolean {
	if (!state) return false;
	const dotIndex = state.indexOf(".");
	if (dotIndex <= 0) return false;
	const data = state.slice(0, dotIndex);
	const sig = state.slice(dotIndex + 1);
	const expected = sign(data);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
	try {
		const parsed = JSON.parse(
			Buffer.from(data, "base64url").toString("utf-8"),
		) as { exp?: number };
		return typeof parsed.exp === "number" && parsed.exp * 1000 > Date.now();
	} catch {
		return false;
	}
}

/* --------------- OAuth 登录票据（同站建立会话用） --------------- */

/**
 * GitHub 回调不直接写会话 Cookie（跨站重定向链上的 Set-Cookie 可能被
 * 浏览器丢弃），而是发放一次性短时票据，302 回同站的登录页，
 * 由页面脚本调用同站 API 换取真正的会话 Cookie。
 */
const usedTicketIds = new Set<string>();

export function createOAuthTicket(
	user: SessionUser,
	githubToken?: string,
): string {
	const payload = Buffer.from(
		JSON.stringify({
			...user,
			jti: crypto.randomBytes(16).toString("hex"),
			exp: Math.floor(Date.now() / 1000) + 60,
			...(githubToken ? { et: encryptString(githubToken) } : {}),
		}),
		"utf-8",
	).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

/** 校验并消费票据（一次性）；有效时返回用户信息与可选的 GitHub 令牌 */
export function consumeOAuthTicket(
	ticket: string | undefined,
): { user: SessionUser; token?: string } | null {
	if (!ticket) return null;
	const dotIndex = ticket.indexOf(".");
	if (dotIndex <= 0) return null;
	const data = ticket.slice(0, dotIndex);
	const sig = ticket.slice(dotIndex + 1);
	const expected = sign(data);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(data, "base64url").toString("utf-8"),
		) as {
			jti?: unknown;
			exp?: unknown;
			login?: unknown;
			name?: unknown;
			avatar?: unknown;
			et?: unknown;
		};
		if (
			typeof parsed.jti !== "string" ||
			typeof parsed.exp !== "number" ||
			parsed.exp * 1000 < Date.now() ||
			typeof parsed.login !== "string"
		) {
			return null;
		}
		if (usedTicketIds.has(parsed.jti)) return null;
		usedTicketIds.add(parsed.jti);
		// 清理过期票据，防止集合无限增长
		if (usedTicketIds.size > 500) {
			for (const jti of usedTicketIds) usedTicketIds.delete(jti);
		}
		return {
			user: {
				login: parsed.login,
				name: typeof parsed.name === "string" ? parsed.name : parsed.login,
				avatar: typeof parsed.avatar === "string" ? parsed.avatar : "",
			},
			token:
				typeof parsed.et === "string"
					? (decryptString(parsed.et) ?? undefined)
					: undefined,
		};
	} catch {
		return null;
	}
}

export type OAuthExchange =
	| { ok: true; accessToken: string }
	| { ok: false; message: string };

/** 用授权码换取访问令牌（POST https://github.com/login/oauth/access_token） */
export async function exchangeOAuthCode(
	code: string,
	redirectUri: string,
): Promise<OAuthExchange> {
	const clientId = adminConfig.githubClientId;
	const clientSecret = adminConfig.githubClientSecret;
	if (!clientId || !clientSecret) {
		return { ok: false, message: "后台未配置 GitHub OAuth App" };
	}
	let res: Response;
	try {
		res = await githubFetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		});
	} catch {
		return {
			ok: false,
			message: githubProxyConfigured()
				? "无法连接 GitHub，请检查代理是否可用"
				: "无法连接 GitHub：服务器网络受限时可设置 ADMIN_GITHUB_PROXY 代理",
		};
	}
	if (!res.ok) {
		return { ok: false, message: `GitHub 授权失败（${res.status}）` };
	}
	const data = (await res.json().catch(() => null)) as {
		access_token?: unknown;
		error?: unknown;
		error_description?: unknown;
	} | null;
	if (!data) return { ok: false, message: "GitHub 返回异常" };
	if (typeof data.access_token === "string" && data.access_token) {
		return { ok: true, accessToken: data.access_token };
	}
	if (data.error_description) {
		return {
			ok: false,
			message: `GitHub 授权失败：${String(data.error_description)}`,
		};
	}
	return { ok: false, message: "GitHub 授权失败：未返回访问令牌" };
}

/* ------------------------- 请求守卫 ------------------------- */

/**
 * 校验请求来源：带 Origin 头时必须与 Host 一致。
 * 会话 Cookie 本身是 SameSite=Strict，这里作为纵深防御。
 */
export function isSameOrigin(context: APIContext): boolean {
	const origin = context.request.headers.get("origin");
	if (!origin) return true;
	const host = context.request.headers.get("host");
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

export function unauthorizedResponse(message = "未登录或会话已过期"): Response {
	return new Response(JSON.stringify({ ok: false, error: message }), {
		status: 401,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * API 会话守卫：返回会话；校验失败时直接返回 Response，调用方应将其透传。
 *
 * const session = await requireApiSession(Astro);
 * if (session instanceof Response) return session;
 */
export async function requireApiSession(
	context: APIContext,
): Promise<ResolvedSession | Response> {
	const session = getSession(context);
	if (!session) return unauthorizedResponse();
	if (!isSameOrigin(context)) {
		return unauthorizedResponse("跨站请求被拒绝");
	}
	return session;
}
