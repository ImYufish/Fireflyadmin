<script lang="ts">
import { onMount } from "svelte";

type Stats = {
	mode: string;
	posts: {
		total: number;
		published: number;
		drafts: number;
		tags: number;
		categories: Array<{ name: string; count: number }>;
		recent: Array<{
			title: string;
			url: string;
			path: string;
			category: string;
			tags: string[];
			published: string;
			draft: boolean;
			password: boolean;
		}>;
	};
	comments: {
		ok: boolean;
		reason?: string;
		total?: number;
		latest?: Array<{
			nick: string;
			content: string;
			time: string;
			url: string;
		}>;
	};
	umami: {
		ok: boolean;
		reason?: string;
		pageviews?: number;
		visitors?: number;
		pageviewsDelta?: number | null;
		visitorsDelta?: number | null;
		series?: Array<{ date: string; value: number }>;
		range?: string;
	};
};

let data = $state<Stats | null>(null);
let loading = $state(true);
let loadError = $state("");
type UmamiRange = "24h" | "7d" | "30d" | "90d" | "12m";
const RANGES: Array<{ key: UmamiRange; label: string }> = [
	{ key: "24h", label: "最近 24 小时" },
	{ key: "7d", label: "最近 7 天" },
	{ key: "30d", label: "最近 30 天" },
	{ key: "90d", label: "最近 90 天" },
	{ key: "12m", label: "最近 12 个月" },
];

let range = $state<UmamiRange>("24h");
let rangeOpen = $state(false);
let chartLoading = $state(false);
let hoverIdx = $state<number | null>(null);
/** 趋势图独立数据（统计卡保持初始 30 天总量不受范围切换影响） */
let chartData = $state<{
	ok: boolean;
	reason?: string;
	series: Array<{ date: string; value: number }>;
} | null>(null);

onMount(async () => {
	try {
		const res = await fetch("/api/admin/dashboard/");
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.ok) {
			loadError = json?.error ?? `加载失败（${res.status}）`;
			return;
		}
		data = json;
		// 统计卡固定 30 天；趋势图默认展示 24 小时
		if (data.umami.ok) void loadChart(range);
	} catch {
		loadError = "网络请求失败";
	} finally {
		loading = false;
	}
});

const greeting = $derived.by(() => {
	const h = new Date().getHours();
	if (h < 5) return "夜深了";
	if (h < 11) return "早上好";
	if (h < 14) return "中午好";
	if (h < 18) return "下午好";
	return "晚上好";
});

function relativeTime(iso: string): string {
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "";
	const diff = Date.now() - t;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "刚刚";
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	const day = Math.floor(hour / 24);
	if (day < 30) return `${day} 天前`;
	return new Date(t).toLocaleDateString("zh-CN");
}

function fmt(n: number): string {
	return n.toLocaleString("zh-CN");
}

async function loadChart(r: UmamiRange) {
	chartLoading = true;
	try {
		const res = await fetch(`/api/admin/dashboard/?range=${r}`);
		const json = await res.json().catch(() => null);
		if (res.ok && json?.ok) {
			chartData = {
				ok: json.umami?.ok === true,
				reason: json.umami?.reason,
				series: json.umami?.series ?? [],
			};
		}
	} catch {
		/* 趋势图刷新失败保留旧数据 */
	} finally {
		chartLoading = false;
	}
}

function pickRange(r: UmamiRange) {
	if (r === range) {
		rangeOpen = false;
		return;
	}
	range = r;
	rangeOpen = false;
	void loadChart(r);
}

/* --------------------- 面积图（纯 SVG） --------------------- */

const W = 620;
const H = 200;
const PAD = 10;

const rangePoints: Record<UmamiRange, number> = {
	"24h": 24,
	"7d": 7,
	"30d": 30,
	"90d": 90,
	"12m": 12,
};

const rangeLabel = $derived(
	RANGES.find((r) => r.key === range)?.label ?? "最近 30 天",
);

/**
 * 单调三次插值（Fritsch–Carlson）转贝塞尔路径：
 * 曲线平滑、严格不过冲（不会在数据突变时甩出波谷/波峰之外）。
 */
function monotonePath(pts: Array<{ x: number; y: number }>): string {
	const n = pts.length;
	if (n === 0) return "";
	if (n === 1) return `M ${pts[0].x} ${pts[0].y}`;
	const dx: number[] = [];
	const m: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		dx[i] = pts[i + 1].x - pts[i].x;
		m[i] = (pts[i + 1].y - pts[i].y) / dx[i];
	}
	const t: number[] = [m[0]];
	for (let i = 1; i < n - 1; i++) {
		if (m[i - 1] * m[i] <= 0) {
			t[i] = 0;
		} else {
			const w1 = 2 * dx[i] + dx[i - 1];
			const w2 = dx[i] + 2 * dx[i - 1];
			t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
		}
	}
	t[n - 1] = m[n - 2];
	let path = `M ${pts[0].x} ${pts[0].y}`;
	for (let i = 0; i < n - 1; i++) {
		const cx1 = pts[i].x + dx[i] / 3;
		const cy1 = pts[i].y + (t[i] * dx[i]) / 3;
		const cx2 = pts[i + 1].x - dx[i] / 3;
		const cy2 = pts[i + 1].y - (t[i + 1] * dx[i]) / 3;
		path += ` C ${cx1} ${cy1} ${cx2} ${cy2} ${pts[i + 1].x} ${pts[i + 1].y}`;
	}
	return path;
}

const chart = $derived.by(() => {
	const series = (chartData?.series ?? []).slice(-rangePoints[range]);
	if (series.length === 0) return null;
	const niceMax = (v: number) => {
		const pow = 10 ** Math.floor(Math.log10(v));
		return Math.ceil(v / pow) * pow;
	};
	const max = niceMax(Math.max(...series.map((p) => p.value), 1));
	const stepX = (W - PAD * 2) / Math.max(series.length - 1, 1);
	const points = series.map((p, i) => ({
		x: PAD + i * stepX,
		y: H - 26 - (p.value / max) * (H - 52),
		...p,
	}));
	const line = monotonePath(points);
	const area = `${line} L ${points[points.length - 1].x} ${H - 26} L ${points[0].x} ${H - 26} Z`;
	const gridLines = [0.25, 0.5, 0.75, 1].map((f) => ({
		y: H - 26 - f * (H - 52),
		label: fmt(Math.round(max * f)),
	}));
	return { points, line, area, max, series, gridLines };
});

/* --------------------- 趋势图 hover --------------------- */

function chartHover(event: MouseEvent) {
	if (!chart || chart.points.length === 0) return;
	const target = event.currentTarget as SVGSVGElement;
	const rect = target.getBoundingClientRect();
	if (rect.width === 0) return;
	const x = ((event.clientX - rect.left) / rect.width) * W;
	let best = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < chart.points.length; i++) {
		const dist = Math.abs(chart.points[i].x - x);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	hoverIdx = best;
}

/* --------------------- 分类环形图（纯 SVG） --------------------- */

const DONUT_R = 52;
const DONUT_C = 2 * Math.PI * DONUT_R;
const PALETTE = [
	"var(--admin-accent)",
	"var(--admin-info)",
	"var(--admin-success)",
	"var(--admin-warn)",
	"var(--admin-danger)",
	"var(--admin-text-faint)",
];

const donut = $derived.by(() => {
	const cats = (data?.posts.categories ?? []).slice(0, 5);
	const total = cats.reduce((sum, c) => sum + c.count, 0);
	if (total === 0) return null;
	let offset = 0;
	const segments = cats.map((c, i) => {
		const frac = c.count / total;
		const seg = {
			...c,
			color: PALETTE[i % PALETTE.length],
			dash: frac * DONUT_C,
			offset,
			pct: Math.round(frac * 100),
		};
		offset += frac * DONUT_C;
		return seg;
	});
	return { segments, total };
});
</script>

{#if loading}
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		{#each Array(4) as _, i (i)}
			<div class="h-24 animate-pulse rounded-2xl bg-(--admin-soft)"></div>
		{/each}
	</div>
{:else if loadError}
	<div class="admin-alert admin-alert-danger">{loadError}</div>
{:else if data}
	<!-- 统计卡片 -->
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		<div class="admin-stat-card">
			<div class="admin-stat-icon" style="color: var(--admin-accent)">
				<svg viewBox="0 0 24 24" fill="currentColor" class="h-6 w-6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z"></path></svg>
			</div>
			<div>
				<div class="admin-stat-label">文章总数</div>
				<div class="admin-stat-value">{fmt(data.posts.total)}</div>
				{#if data.posts.drafts > 0}
					<div class="admin-stat-sub">含 {data.posts.drafts} 篇草稿</div>
				{:else}
					<div class="admin-stat-sub">全部已发布</div>
				{/if}
			</div>
		</div>

		<div class="admin-stat-card">
			<div class="admin-stat-icon" style="color: var(--admin-success)">
				<svg viewBox="0 0 24 24" fill="currentColor" class="h-6 w-6"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2M7 9h10v2H7zm0-3h10v2H7z"></path></svg>
			</div>
			<div>
				<div class="admin-stat-label">评论总数</div>
				{#if data.comments.ok}
					<div class="admin-stat-value">{fmt(data.comments.total ?? 0)}</div>
					<div class="admin-stat-sub">Waline</div>
				{:else}
					<div class="admin-stat-value">—</div>
					<div class="admin-stat-sub" title={data.comments.reason}>未接入</div>
				{/if}
			</div>
		</div>

		<div class="admin-stat-card">
			<div class="admin-stat-icon" style="color: var(--admin-info)">
				<svg viewBox="0 0 24 24" fill="currentColor" class="h-6 w-6"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7m0 11.5A4.5 4.5 0 1 1 16.5 12 4.5 4.5 0 0 1 12 16.5m0-7A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5"></path></svg>
			</div>
			<div>
				<div class="admin-stat-label">总访问量</div>
				{#if data.umami.ok}
					<div class="admin-stat-value">{fmt(data.umami.pageviews ?? 0)}</div>
					<div class="admin-stat-sub">
						{#if data.umami.pageviewsDelta !== null}
							<span class:up={(data.umami.pageviewsDelta ?? 0) >= 0} class:down={(data.umami.pageviewsDelta ?? 0) < 0}>
								{(data.umami.pageviewsDelta ?? 0) >= 0 ? "+" : ""}{data.umami.pageviewsDelta}%
							</span>
							较上月
						{:else}
							近 30 天
						{/if}
					</div>
				{:else}
					<div class="admin-stat-value">—</div>
					<div class="admin-stat-sub" title={data.umami.reason}>未接入</div>
				{/if}
			</div>
		</div>

		<div class="admin-stat-card">
			<div class="admin-stat-icon" style="color: var(--admin-warn)">
				<svg viewBox="0 0 24 24" fill="currentColor" class="h-6 w-6"><path d="M12 4a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4m0 10c4.4 0 8 1.8 8 4v2H4v-2c0-2.2 3.6-4 8-4"></path></svg>
			</div>
			<div>
				<div class="admin-stat-label">访客数</div>
				{#if data.umami.ok}
					<div class="admin-stat-value">{fmt(data.umami.visitors ?? 0)}</div>
					<div class="admin-stat-sub">
						{#if data.umami.visitorsDelta !== null}
							<span class:up={(data.umami.visitorsDelta ?? 0) >= 0} class:down={(data.umami.visitorsDelta ?? 0) < 0}>
								{(data.umami.visitorsDelta ?? 0) >= 0 ? "+" : ""}{data.umami.visitorsDelta}%
							</span>
							较上月
						{:else}
							近 30 天
						{/if}
					</div>
				{:else}
					<div class="admin-stat-value">—</div>
					<div class="admin-stat-sub" title={data.umami.reason}>未接入</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- 图表行 -->
	<div class="mt-5 grid gap-5 lg:grid-cols-5">
		<!-- 访问量趋势 -->
		<div class="admin-panel p-5 lg:col-span-3">
			<div class="mb-4 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-(--admin-text-strong)">访问量趋势</h2>
				{#if data.umami.ok}
					<div class="relative">
						<button
							type="button"
							class="flex items-center gap-1.5 rounded-lg border border-(--admin-line) px-3 py-1.5 text-xs text-(--admin-text) transition-colors hover:bg-(--admin-panel-hover)"
							onclick={() => (rangeOpen = !rangeOpen)}
						>
							{rangeLabel}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="currentColor"
								class="h-3.5 w-3.5 transition-transform {rangeOpen ? 'rotate-180' : ''}"
							>
								<path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"></path>
							</svg>
						</button>
						{#if rangeOpen}
							<div
								class="admin-fade-in absolute top-full right-0 z-20 mt-1.5 w-44 rounded-xl border border-(--admin-line) bg-(--admin-panel) p-1.5 shadow-xl"
							>
								{#each RANGES as r (r.key)}
									<button
										type="button"
										class="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs transition-colors {range === r.key ? 'bg-(--admin-accent-soft) font-medium text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
										onclick={() => pickRange(r.key)}
									>
										{r.label}
										{#if range === r.key}
											<svg viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"></path></svg>
										{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
			{#if data.umami.ok && chart}
				<div class="relative" onmousemove={chartHover} onmouseleave={() => (hoverIdx = null)} role="img" aria-label="访问量趋势">
					<svg viewBox="0 0 {W} {H}" class="w-full">
						<defs>
							<linearGradient id="pv-area" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stop-color="var(--admin-accent)" stop-opacity="0.28"></stop>
								<stop offset="55%" stop-color="var(--admin-accent)" stop-opacity="0.08"></stop>
								<stop offset="100%" stop-color="var(--admin-accent)" stop-opacity="0"></stop>
							</linearGradient>
						</defs>
						{#each chart.gridLines as gl, i (i)}
							<line x1={PAD} x2={W - PAD} y1={gl.y} y2={gl.y} class="chart-grid"></line>
							<text x={PAD} y={gl.y - 4} class="chart-label">{gl.label}</text>
						{/each}
						<line x1={PAD} x2={W - PAD} y1={H - 26} y2={H - 26} stroke="var(--admin-line)" stroke-width="1"></line>
						<path d={chart.area} fill="url(#pv-area)" class="chart-area"></path>
						<path d={chart.line} fill="none" stroke="var(--admin-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pathLength="1" class="chart-line"></path>
						{#if hoverIdx !== null && chart.points[hoverIdx]}
							<line
								x1={chart.points[hoverIdx].x}
								x2={chart.points[hoverIdx].x}
								y1={H - 26}
								y2={chart.points[hoverIdx].y}
								class="chart-cursor"
							></line>
							<circle
								cx={chart.points[hoverIdx].x}
								cy={chart.points[hoverIdx].y}
								r="4.5"
								class="chart-dot-active"
							></circle>
						{/if}
						{#if chart.series.length > 1}
							<text x={chart.points[0].x} y={H - 6} class="chart-label">{chart.series[0].date}</text>
							<text x={W / 2} y={H - 6} text-anchor="middle" class="chart-label">
								{chart.series[Math.floor(chart.series.length / 2)].date}
							</text>
							<text x={W - PAD} y={H - 6} text-anchor="end" class="chart-label">
								{chart.series[chart.series.length - 1].date}
							</text>
						{/if}
					</svg>
					{#if hoverIdx !== null && chart.points[hoverIdx]}
						<div
							class="chart-tooltip admin-fade-in pointer-events-none"
							style={`left: ${(chart.points[hoverIdx].x / W) * 100}%; top: ${(chart.points[hoverIdx].y / H) * 100}%`}
						>
							<div class="font-semibold">{chart.points[hoverIdx].date}</div>
							<div>{fmt(chart.points[hoverIdx].value)} 次访问</div>
						</div>
					{/if}
					{#if chartLoading}
						<div class="absolute inset-0 flex items-center justify-center bg-(--admin-panel)/60">
							<svg class="h-6 w-6 animate-spin text-(--admin-accent)" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z"></path>
							</svg>
						</div>
					{/if}
				</div>
			{:else if !data.umami.ok}
				<div class="flex h-44 flex-col items-center justify-center gap-1.5 text-center text-(--admin-text-faint)">
					<svg viewBox="0 0 24 24" fill="currentColor" class="h-8 w-8 text-(--admin-text-faint)"><path d="M3 3h2v18H3zm4 12h4v6H7zm6-8h4v14h-4zm6-4h4v18h-4z" opacity="0.4"></path></svg>
					<p class="text-sm">{data.umami.reason}</p>
					<p class="text-xs">在 src/admin/config.ts 填写 Umami 账号后展示访问统计</p>
				</div>
			{:else}
				<div class="flex h-44 items-center justify-center">
					<svg class="h-6 w-6 animate-spin text-(--admin-accent)" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z"></path>
					</svg>
				</div>
			{/if}
		</div>

		<!-- 分类环形图 -->
		<div class="admin-panel p-5 lg:col-span-2">
			<div class="mb-4 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-(--admin-text-strong)">文章分类</h2>
				<a href="/admin/posts/" class="text-xs text-(--admin-accent-hover) hover:underline">查看全部</a>
			</div>
			{#if donut}
				<div class="flex items-center gap-5">
					<svg viewBox="0 0 140 140" class="h-36 w-36 shrink-0 -rotate-90" role="img" aria-label="分类占比">
						{#each donut.segments as seg (seg.name)}
							<circle
								cx="70"
								cy="70"
								r={DONUT_R}
								fill="none"
								stroke={seg.color}
								stroke-width="16"
								stroke-dasharray="{seg.dash} {DONUT_C - seg.dash}"
								stroke-dashoffset={-seg.offset}
							>
								<title>{seg.name} · {seg.count} 篇（{seg.pct}%）</title>
							</circle>
						{/each}
					</svg>
					<ul class="min-w-0 flex-1 space-y-2">
						{#each donut.segments as seg (seg.name)}
							<li class="flex items-center gap-2 text-xs">
								<span class="h-2.5 w-2.5 shrink-0 rounded-full" style={`background: ${seg.color}`}></span>
								<span class="min-w-0 flex-1 truncate text-(--admin-text)">{seg.name}</span>
								<span class="font-mono text-(--admin-text-faint)">{seg.count}（{seg.pct}%）</span>
							</li>
						{/each}
					</ul>
				</div>
			{:else}
				<p class="py-10 text-center text-sm text-(--admin-text-faint)">暂无分类数据</p>
			{/if}
		</div>
	</div>

	<!-- 最新文章 / 最新评论 -->
	<div class="mt-5 grid gap-5 lg:grid-cols-2">
		<div class="admin-panel p-5">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-(--admin-text-strong)">最新文章</h2>
				<a href="/admin/posts/" class="text-xs text-(--admin-accent-hover) hover:underline">查看全部</a>
			</div>
			<ul class="divide-y divide-(--admin-divider)">
				{#each data.posts.recent as post (post.path)}
					<li class="flex items-center gap-3 py-2.5">
						<div class="min-w-0 flex-1">
							<a
								href={`/admin/editor/?file=${encodeURIComponent(post.path)}`}
								class="block truncate text-sm text-(--admin-text-strong) hover:text-(--admin-accent-hover)"
							>
								{post.title}
							</a>
							<div class="mt-0.5 flex items-center gap-2 text-[11px] text-(--admin-text-faint)">
								<span>{post.published ? post.published.slice(0, 10) : "—"}</span>
								{#if post.category}<span>· {post.category}</span>{/if}
								{#if post.draft}<span class="admin-badge-warn rounded px-1 py-0.5 text-[10px]">草稿</span>{/if}
							</div>
						</div>
						<a
							href={post.url}
							target="_blank"
							class="shrink-0 rounded-md p-1.5 text-(--admin-text-faint) transition-colors hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
							title="在前台查看"
						>
							<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M14 3v2h3.6l-9.1 9.1 1.4 1.4L19 6.4V10h2V3zM5 5h6v2H7v10h10v-4h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2"></path></svg>
						</a>
					</li>
				{/each}
			</ul>
		</div>

		<div class="admin-panel p-5">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-(--admin-text-strong)">最新评论</h2>
				{#if data.comments.ok}
					<span class="text-xs text-(--admin-text-faint)">共 {fmt(data.comments.total ?? 0)} 条</span>
				{/if}
			</div>
			{#if data.comments.ok}
				<ul class="divide-y divide-(--admin-divider)">
					{#each data.comments.latest ?? [] as c, i (i)}
						<li class="flex gap-3 py-2.5">
							<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--admin-soft) text-xs font-bold text-(--admin-text-strong)">
								{c.nick.slice(0, 1).toUpperCase()}
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="text-xs font-semibold text-(--admin-text-strong)">{c.nick}</span>
									<span class="text-[11px] text-(--admin-text-faint)">{relativeTime(c.time)}</span>
								</div>
								<p class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-(--admin-text)">{c.content}</p>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="flex h-40 flex-col items-center justify-center gap-1.5 text-center text-(--admin-text-faint)">
					<svg viewBox="0 0 24 24" fill="currentColor" class="h-8 w-8"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2M7 9h10v2H7z" opacity="0.4"></path></svg>
					<p class="text-sm">{data.comments.reason}</p>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.admin-stat-card {
		display: flex;
		align-items: center;
		gap: 14px;
		border-radius: 1rem;
		border: 1px solid var(--admin-line);
		background: var(--admin-panel);
		padding: 18px 20px;
		transition:
			transform 0.15s ease,
			box-shadow 0.15s ease;
	}
	.admin-stat-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 10px 28px -14px rgb(0 0 0 / 0.35);
	}
	.admin-stat-icon {
		display: flex;
		height: 48px;
		width: 48px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border-radius: 14px;
		background: color-mix(in oklab, currentColor 14%, transparent);
	}
	.admin-stat-label {
		font-size: 12px;
		color: var(--admin-text-faint);
	}
	.admin-stat-value {
		font-size: 26px;
		font-weight: 700;
		line-height: 1.2;
		color: var(--admin-text-strong);
		font-variant-numeric: tabular-nums;
	}
	.admin-stat-sub {
		margin-top: 2px;
		font-size: 11px;
		color: var(--admin-text-faint);
	}
	.admin-stat-sub .up {
		color: var(--admin-success);
		font-weight: 600;
	}
	.admin-stat-sub .down {
		color: var(--admin-danger);
		font-weight: 600;
	}
	.admin-panel {
		border-radius: 1rem;
		border: 1px solid var(--admin-line);
		background: var(--admin-panel);
	}
	.chart-label {
		font-size: 10px;
		fill: var(--admin-text-faint);
	}
	.chart-grid {
		stroke: var(--admin-divider);
		stroke-width: 1;
		stroke-dasharray: 2 6;
		opacity: 0.7;
	}
	.chart-line {
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: chart-draw 1.1s ease-out forwards;
		filter: drop-shadow(0 5px 6px color-mix(in oklab, var(--admin-accent) 30%, transparent));
	}
	.chart-area {
		opacity: 0;
		animation: chart-fade 0.8s ease-out 0.4s forwards;
	}
	.chart-cursor {
		stroke: var(--admin-accent);
		stroke-width: 1;
		stroke-dasharray: 3 4;
		opacity: 0.5;
	}
	.chart-dot-active {
		fill: var(--admin-panel);
		stroke: var(--admin-accent);
		stroke-width: 2.5;
		filter: drop-shadow(0 0 6px color-mix(in oklab, var(--admin-accent) 45%, transparent));
		animation: chart-dot-pop 0.15s ease-out;
		transition: cx 0.06s linear, cy 0.06s linear;
	}
	@keyframes chart-dot-pop {
		from {
			r: 2;
		}
		to {
			r: 4.5;
		}
	}
	@keyframes chart-draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes chart-fade {
		to {
			opacity: 1;
		}
	}
	.chart-tooltip {
		position: absolute;
		transform: translate(-50%, -130%);
		background: var(--admin-text-strong);
		color: var(--admin-panel);
		border-radius: 8px;
		padding: 5px 9px;
		font-size: 11px;
		line-height: 1.4;
		white-space: nowrap;
		box-shadow: 0 6px 20px -6px rgb(0 0 0 / 0.4);
		pointer-events: none;
	}
	.line-clamp-2 {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
