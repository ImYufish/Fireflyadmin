/**
 * GET /api/admin/dashboard/ —— 仪表盘聚合数据：
 *   - 文章统计（总数 / 草稿 / 分类 / 标签 / 最近文章），本地与 GitHub 后端通用
 *   - 评论：Waline（读取博客 commentConfig 的 serverURL，公开 API）
 *   - 访问统计：Umami（需要后台账号，见 src/admin/config.ts 的 umami 配置）
 *
 * Waline / Umami 结果带 5 分钟内存缓存，避免每次进入仪表盘都打外部接口。
 */

import type { APIRoute } from "astro";
import { commentConfig } from "../../config/commentConfig";
import { adminConfig, resolveBackendMode } from "../config";
import { githubFetch, requireApiSession } from "../lib/auth";
import { okResponse } from "../lib/http";
import { listPosts, type PostMeta } from "../lib/posts";

/* ------------------------------ 缓存 ------------------------------ */

type CacheEntry = { at: number; data: unknown };
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
	const hit = cache.get(key);
	const ttl =
		hit?.data && (hit.data as { ok?: boolean }).ok === false
			? 30 * 1000
			: CACHE_TTL;
	if (hit && Date.now() - hit.at < ttl) return hit.data as T;
	const data = await fetcher();
	cache.set(key, { at: Date.now(), data });
	return data;
}

/* ------------------------------ Waline ------------------------------ */

type WalineComment = {
	nick: string;
	comment: string;
	insertedAt?: string;
	/** 管理接口（type=list）返回毫秒时间戳 */
	time?: number | string;
	url?: string;
};

let walineToken: { token: string; at: number } | null = null;

/** Waline 管理端登录（/api/token），令牌缓存 1 小时 */
async function walineLogin(serverURL: string): Promise<string | null> {
	if (walineToken && Date.now() - walineToken.at < 60 * 60 * 1000) {
		return walineToken.token;
	}
	const { email, password } = adminConfig.waline;
	if (!email || !password) return null;
	try {
		const res = await githubFetch(`${serverURL}/api/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const json = (await res.json()) as {
			errno?: number;
			data?: { token?: string; accessToken?: string };
			accessToken?: string;
		};
		const token =
			json.data?.token ?? json.data?.accessToken ?? json.accessToken;
		if (!token) return null;
		walineToken = { token, at: Date.now() };
		return token;
	} catch {
		return null;
	}
}

function walineServerURL(): string | null {
	const blogWaline = (
		commentConfig as { type?: string; waline?: { serverURL?: string } }
	).waline;
	const serverURL =
		adminConfig.waline?.serverURL?.replace(/\/+$/, "") ||
		blogWaline?.serverURL?.replace(/\/+$/, "");
	return serverURL || null;
}

/**
 * 全站最新评论：用管理员令牌走管理接口（type=list，与 Waline 官方管理面板
 * 相同的调用方式），不受文章 path 匹配限制；
 * 未登录/未配置管理员时退化为公开接口按文章路径批量查询。
 */
async function fetchWaline(paths: string[]): Promise<Record<string, unknown>> {
	const serverURL = walineServerURL();
	if (!serverURL) {
		return {
			ok: false,
			reason:
				"未配置 Waline：在 src/admin/config.ts 填写 waline.serverURL，或启用博客评论（commentConfig.type=waline）",
		};
	}
	const token = await walineLogin(serverURL);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		let query = "page=1&pageSize=8&sortBy=insertedAt_desc";
		if (token) {
			// 管理接口：type=list 按时间倒序返回全站已审核评论
			headers.Authorization = `Bearer ${token}`;
			query = "type=list&status=approved&page=1&pageSize=8";
		} else {
			// 公开接口新版强制要求 path，取最近文章路径批量匹配
			const pathQuery =
				paths.length > 0 ? `&path=${encodeURIComponent(paths.join(","))}` : "";
			query += pathQuery;
		}
		const res = await githubFetch(`${serverURL}/api/comment?${query}`, {
			headers,
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok)
			return { ok: false, reason: `Waline 接口错误（${res.status}）` };
		const json = (await res.json()) as {
			errno?: number;
			errmsg?: unknown;
			data?: {
				data?: WalineComment[];
				count?: number;
				totalPages?: number;
				pageSize?: number;
			};
		};
		if (json.errno !== 0 || !json.data) {
			return {
				ok: false,
				reason: `Waline 返回异常：${JSON.stringify(json.errmsg ?? "")}`,
			};
		}
		const latest = (json.data.data ?? []).map((c) => ({
			nick: c.nick,
			content: stripHtml(c.comment ?? "").slice(0, 80),
			time: c.time ?? c.insertedAt ?? "",
			url: c.url ?? "",
		}));
		// 管理接口响应没有 count，用 pageSize=1 的 totalPages 精确换算总数
		let total = json.data.count ?? latest.length;
		if (token && json.data.count === undefined) {
			const countRes = await githubFetch(
				`${serverURL}/api/comment?type=list&status=approved&page=1&pageSize=1`,
				{ headers, signal: AbortSignal.timeout(8000) },
			);
			if (countRes.ok) {
				const countJson = (await countRes.json().catch(() => null)) as {
					errno?: number;
					data?: { totalPages?: number };
				} | null;
				if (
					countJson?.errno === 0 &&
					countJson.data?.totalPages !== undefined
				) {
					total = countJson.data.totalPages;
				}
			}
		}
		return { ok: true, total, latest };
	} catch {
		return { ok: false, reason: "无法连接 Waline 服务" };
	}
}

/** 去掉评论 HTML 标签，保留纯文本 */
function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

/* ------------------------------ Umami ------------------------------ */

let umamiToken: { token: string; at: number } | null = null;

async function umamiLogin(): Promise<string | null> {
	if (umamiToken && Date.now() - umamiToken.at < 60 * 60 * 1000) {
		return umamiToken.token;
	}
	const { url, username, password } = adminConfig.umami;
	if (!url || !username || !password) return null;
	try {
		const res = await githubFetch(`${url.replace(/\/+$/, "")}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, password }),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { token?: string };
		if (!json.token) return null;
		umamiToken = { token: json.token, at: Date.now() };
		return json.token;
	} catch {
		return null;
	}
}

function umamiConfigured(): boolean {
	const { url, username, password } = adminConfig.umami;
	return Boolean(url && username && password);
}

type UmamiRange = "24h" | "7d" | "30d" | "90d" | "12m";

/** Umami 返回的是 UTC 时间，统一转成北京时间标签 */
function beijingLabel(x: string, unit: "hour" | "day" | "month"): string {
	const d = new Date(x);
	if (Number.isNaN(d.getTime())) return x;
	const options: Intl.DateTimeFormatOptions =
		unit === "hour"
			? { hour: "2-digit", minute: "2-digit", hour12: false }
			: unit === "month"
				? { year: "numeric", month: "2-digit" }
				: { month: "2-digit", day: "2-digit" };
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		...options,
	})
		.format(d)
		.replace(/\//g, "-");
}

function rangeToQuery(range: UmamiRange): {
	startMsAgo: number;
	unit: "hour" | "day" | "month";
} {
	switch (range) {
		case "24h":
			return { startMsAgo: 24 * 3600000, unit: "hour" };
		case "7d":
			return { startMsAgo: 7 * 86400000, unit: "day" };
		case "90d":
			return { startMsAgo: 90 * 86400000, unit: "day" };
		case "12m":
			return { startMsAgo: 365 * 86400000, unit: "month" };
		default:
			return { startMsAgo: 30 * 86400000, unit: "day" };
	}
}

async function fetchUmami(range: UmamiRange): Promise<Record<string, unknown>> {
	if (!umamiConfigured()) {
		return {
			ok: false,
			reason:
				"未配置 Umami 账号（src/admin/config.ts 的 umami 或对应环境变量）",
		};
	}
	const token = await umamiLogin();
	if (!token) {
		return { ok: false, reason: "Umami 登录失败：检查地址与账号密码" };
	}
	const base = adminConfig.umami.url.replace(/\/+$/, "");
	let websiteId = adminConfig.umami.websiteId;
	try {
		if (!websiteId) {
			const res = await githubFetch(`${base}/api/websites`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(8000),
			});
			const list = (await res.json()) as { data?: Array<{ id: string }> };
			websiteId = list.data?.[0]?.id ?? "";
			if (!websiteId) return { ok: false, reason: "Umami 账号下没有站点" };
		}

		const { startMsAgo, unit } = rangeToQuery(range);
		const now = Date.now();
		const start = now - startMsAgo;
		const prevStart = start - startMsAgo;
		const headers = { Authorization: `Bearer ${token}` };
		const qs = (startAt: number, endAt: number) =>
			`startAt=${startAt}&endAt=${endAt}`;

		const [statsCur, statsPrev, pvSeries] = await Promise.all([
			fetch(`${base}/api/websites/${websiteId}/stats?${qs(start, now)}`, {
				headers,
				signal: AbortSignal.timeout(8000),
			}),
			fetch(`${base}/api/websites/${websiteId}/stats?${qs(prevStart, start)}`, {
				headers,
				signal: AbortSignal.timeout(8000),
			}),
			fetch(
				`${base}/api/websites/${websiteId}/pageviews?${qs(start, now)}&unit=${unit}`,
				{ headers, signal: AbortSignal.timeout(8000) },
			),
		]);
		if (!statsCur.ok)
			return { ok: false, reason: `Umami 接口错误（${statsCur.status}）` };
		// Umami 不同版本返回两种格式：
		//   平铺数字：{ pageviews: 3875, visitors: 721, comparison: {...} }
		//   对象格式（v2）：{ pageviews: { value }, visitors: { value } }
		const statValue = (v: unknown): number => {
			if (typeof v === "number") return v;
			if (
				v &&
				typeof v === "object" &&
				typeof (v as { value?: unknown }).value === "number"
			) {
				return (v as { value: number }).value;
			}
			return 0;
		};
		const cur = (await statsCur.json()) as Record<string, unknown>;
		const prev = statsPrev.ok
			? ((await statsPrev.json()) as Record<string, unknown>)
			: null;
		const series: Array<{ date: string; value: number }> = [];
		if (pvSeries.ok) {
			const pv = (await pvSeries.json()) as {
				pageviews: Array<{ x: string; y: number }>;
			};
			for (const point of pv.pageviews ?? []) {
				series.push({
					date: beijingLabel(point.x, unit),
					value: point.y,
				});
			}
		}
		const delta = (a: number, b: number) =>
			b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100);
		// 优先用响应自带的 comparison（上一周期），否则用前一次查询
		const cmp = (cur.comparison ?? null) as Record<string, unknown> | null;
		const prevPv = cmp
			? statValue(cmp.pageviews)
			: prev
				? statValue(prev.pageviews)
				: null;
		const prevVi = cmp
			? statValue(cmp.visitors)
			: prev
				? statValue(prev.visitors)
				: null;
		const pv = statValue(cur.pageviews);
		const vi = statValue(cur.visitors);
		return {
			ok: true,
			pageviews: pv,
			visitors: vi,
			pageviewsDelta: prevPv === null ? null : delta(pv, prevPv),
			visitorsDelta: prevVi === null ? null : delta(vi, prevVi),
			series,
			periodDays: 30,
		};
	} catch {
		return { ok: false, reason: "无法连接 Umami 服务" };
	}
}

/* ------------------------------ 文章统计 ------------------------------ */

function postStats(posts: PostMeta[]) {
	const published = posts.filter((p) => !p.draft);
	const categoryMap = new Map<string, number>();
	for (const p of published) {
		const key = p.category.trim() || "未分类";
		categoryMap.set(key, (categoryMap.get(key) ?? 0) + 1);
	}
	const categories = [...categoryMap.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count);
	const recent = posts.slice(0, 6).map((p) => ({
		title: p.title,
		url: p.url,
		path: p.path,
		category: p.category,
		tags: p.tags.slice(0, 3),
		published: p.published,
		draft: p.draft,
		password: p.password,
	}));
	return {
		total: posts.length,
		published: published.length,
		drafts: posts.length - published.length,
		tags: new Set(published.flatMap((p) => p.tags)).size,
		categories,
		recent,
	};
}

/* ------------------------------ 端点 ------------------------------ */

export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	void resolveBackendMode;

	const posts = await listPosts();
	const commentPaths = posts.slice(0, 30).map((p) => p.url);
	const rangeParam = (Astro.url.searchParams.get("range") ?? "30d") as
		| "24h"
		| "7d"
		| "30d"
		| "90d"
		| "12m";
	const range: UmamiRange = ["24h", "7d", "30d", "90d", "12m"].includes(
		rangeParam,
	)
		? rangeParam
		: "30d";
	const [comments, umami] = await Promise.all([
		cached("waline", () => fetchWaline(commentPaths)),
		cached("umami:" + range, () => fetchUmami(range)),
	]);
	return okResponse({
		mode: resolveBackendMode(),
		posts: postStats(posts),
		comments,
		umami,
		generatedAt: new Date().toISOString(),
	});
};
