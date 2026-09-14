<script lang="ts">
import { readDrafts, subscribeDrafts } from "../lib/drafts";

type PostMeta = {
	path: string;
	fileSlug: string;
	slug: string;
	url: string;
	title: string;
	published: string;
	updated?: string;
	tags: string[];
	category: string;
	draft: boolean;
	pinned: boolean;
	password: boolean;
	lang: string;
	size: number;
	mtime: number;
};

interface Props {
	posts: PostMeta[];
}

const { posts }: Props = $props();

let search = $state("");
let showDrafts = $state(true);
let category = $state("");
type SortKey = "default" | "title" | "date";
let sortKey = $state<SortKey>("default");
let sortAsc = $state(false);
let creating = $state(false);
let createTitle = $state("");
let createFilename = $state("");
let createDraft = $state(true);
let createLoading = $state(false);
let createError = $state("");
/** 有未发布草稿（线上模式）的文件路径 */
let drafts = $state<Record<string, { content: string; savedAt: number }>>({});

$effect(() => {
	drafts = readDrafts();
	return subscribeDrafts(() => {
		drafts = readDrafts();
	});
});

function hasDraft(path: string): boolean {
	return drafts[path] !== undefined;
}

const categories = $derived(
	[...new Set(posts.map((p) => p.category.trim()).filter(Boolean))].sort(
		(a, b) => a.localeCompare(b, "zh-Hans-CN"),
	),
);

function toggleSort(key: SortKey) {
	if (sortKey !== key) {
		sortKey = key;
		sortAsc = key === "title";
		return;
	}
	if (!sortAsc) {
		sortAsc = true;
	} else {
		// 二次点击回到默认排序
		sortKey = "default";
		sortAsc = false;
	}
}

const filtered = $derived.by(() => {
	const keyword = search.trim().toLowerCase();
	const list = posts.filter((post) => {
		if (!showDrafts && post.draft) return false;
		if (category && post.category.trim() !== category) return false;
		if (!keyword) return true;
		return (
			post.title.toLowerCase().includes(keyword) ||
			post.path.toLowerCase().includes(keyword) ||
			post.tags.some((tag) => tag.toLowerCase().includes(keyword)) ||
			post.category.toLowerCase().includes(keyword)
		);
	});
	if (sortKey === "title") {
		list.sort(
			(a, b) =>
				a.title.localeCompare(b.title, "zh-Hans-CN") * (sortAsc ? 1 : -1),
		);
	} else if (sortKey === "date") {
		list.sort(
			(a, b) => (a.published < b.published ? -1 : 1) * (sortAsc ? 1 : -1),
		);
	}
	return list;
});

async function handleCreate(event: SubmitEvent) {
	event.preventDefault();
	if (createLoading) return;
	createLoading = true;
	createError = "";
	try {
		const res = await fetch("/api/admin/posts/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: createTitle.trim(),
				filename: createFilename.trim(),
				draft: createDraft,
			}),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok || !data?.ok) {
			createError = data?.error ?? `创建失败（${res.status}）`;
			return;
		}
		// 创建成功后直接进入编辑器
		window.location.href = `/admin/editor/?file=${encodeURIComponent(data.path)}`;
	} catch {
		createError = "网络请求失败，请重试";
	} finally {
		createLoading = false;
	}
}

function formatDate(iso: string): string {
	return iso ? iso.slice(0, 10) : "—";
}
</script>

<div class="space-y-4">
	<!-- 工具栏：搜索 + 过滤 + 新建 -->
	<div class="flex flex-wrap items-center gap-3">
		<div class="relative min-w-56 flex-1">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-(--admin-text-faint)"
			>
				<circle cx="11" cy="11" r="7"></circle>
				<path d="m20 20-3.5-3.5"></path>
			</svg>
			<input
				type="search"
				class="admin-input !pl-9"
				placeholder="搜索标题、路径、标签、分类…"
				bind:value={search}
			/>
		</div>
		<label
			class="flex cursor-pointer items-center gap-2 text-sm text-(--admin-text) select-none"
		>
			<input type="checkbox" class="accent-(--admin-accent)" bind:checked={showDrafts} />
			显示草稿
		</label>
		{#if categories.length > 0}
			<select bind:value={category} class="admin-input !w-auto !py-1.5 text-xs">
				<option value="">全部分类</option>
				{#each categories as cat (cat)}
					<option value={cat}>{cat}</option>
				{/each}
			</select>
		{/if}
		<button
			type="button"
			class="admin-btn admin-btn-primary"
			onclick={() => {
				creating = !creating;
				createError = "";
			}}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="h-4 w-4"
			>
				<path d="M11 13H5v-2h6V5h2v6h6v2h-6v6h-2z"></path>
			</svg>
			新建文章
		</button>
	</div>

	<!-- 新建文章表单 -->
	{#if creating}
		<form
			onsubmit={handleCreate}
			class="admin-fade-in space-y-3 rounded-xl border border-(--admin-line) bg-(--admin-panel) p-5"
		>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label class="admin-label" for="new-post-title">标题 *</label>
					<input
						id="new-post-title"
						class="admin-input"
						placeholder="文章标题（中文标题会自动转换为拼音文件名）"
						bind:value={createTitle}
					/>
				</div>
				<div>
					<label class="admin-label" for="new-post-filename">文件名（可选）</label>
					<input
						id="new-post-filename"
						class="admin-input font-mono"
						placeholder="留空则由标题生成，支持子目录如 guide/my-post.md"
						bind:value={createFilename}
					/>
				</div>
			</div>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<label class="flex cursor-pointer items-center gap-2 text-sm text-(--admin-text) select-none">
					<input
						type="checkbox"
						class="accent-(--admin-accent)"
						bind:checked={createDraft}
					/>
					保存为草稿（dev 预览可见，正式构建不发布）
				</label>
				<div class="flex gap-2">
					<button type="button" class="admin-btn admin-btn-ghost" onclick={() => (creating = false)}>
						取消
					</button>
					<button type="submit" class="admin-btn admin-btn-primary" disabled={createLoading}>
						{createLoading ? "创建中…" : "创建并编辑"}
					</button>
				</div>
			</div>
			{#if createError}
				<div class="admin-alert admin-alert-danger">
					{createError}
				</div>
			{/if}
		</form>
	{/if}

	<!-- 文章表格（表头吸顶，随 #admin-main 滚动） -->
	<div class="rounded-xl border border-(--admin-line)">
		<table class="w-full border-separate border-spacing-0 text-sm">
			<thead>
				<tr class="text-left text-xs text-(--admin-text-faint)">
					<th class="sticky top-0 z-10 rounded-tl-xl border-b border-(--admin-line) bg-(--admin-panel) px-4 py-3 font-semibold backdrop-blur">
						<button
							type="button"
							class="inline-flex items-center gap-1 transition-colors hover:text-(--admin-accent-hover) {sortKey === 'title' ? 'text-(--admin-accent-hover)' : ''}"
							onclick={() => toggleSort("title")}
						>
							标题
							<svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3 transition-opacity {sortKey === 'title' ? 'opacity-100' : 'opacity-25'} {sortKey === 'title' && sortAsc ? 'rotate-180' : ''}"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"></path></svg>
						</button>
					</th>
					<th class="sticky top-0 z-10 hidden border-b border-(--admin-line) bg-(--admin-panel) px-4 py-3 font-semibold md:table-cell">分类 / 标签</th>
					<th class="sticky top-0 z-10 hidden border-b border-(--admin-line) bg-(--admin-panel) px-4 py-3 font-semibold sm:table-cell">
						<button
							type="button"
							class="inline-flex items-center gap-1 transition-colors hover:text-(--admin-accent-hover) {sortKey === 'date' ? 'text-(--admin-accent-hover)' : ''}"
							onclick={() => toggleSort("date")}
						>
							发布日期
							<svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3 transition-opacity {sortKey === 'date' ? 'opacity-100' : 'opacity-25'} {sortKey === 'date' && sortAsc ? 'rotate-180' : ''}"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"></path></svg>
						</button>
					</th>
					<th class="sticky top-0 z-10 rounded-tr-xl border-b border-(--admin-line) bg-(--admin-panel) px-4 py-3 text-right font-semibold">操作</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-(--admin-divider)">
				{#each filtered as post (post.path)}
					<tr class="bg-(--admin-panel) transition-colors hover:bg-(--admin-panel-hover)">
						<td class="max-w-0 px-4 py-3">
							<a
								href={`/admin/editor/?file=${encodeURIComponent(post.path)}`}
								class="block truncate font-medium text-(--admin-text-strong) hover:text-(--admin-accent-hover)"
								title={post.title}
							>
								{post.title}
							</a>
							<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
								{#if post.draft}
									<span class="admin-badge-warn rounded px-1.5 py-0.5 text-[10px] font-medium">草稿</span>
								{/if}
								{#if hasDraft(post.path)}
									<span
										class="admin-badge-warn rounded px-1.5 py-0.5 text-[10px] font-medium"
										title="该文件有未发布的修改草稿，请在编辑器中点「发布」"
									>
										未发布草稿
									</span>
								{/if}
								{#if post.pinned}
									<span class="admin-badge-info rounded px-1.5 py-0.5 text-[10px] font-medium">置顶</span>
								{/if}
								{#if post.password}
									<span class="admin-badge-danger rounded px-1.5 py-0.5 text-[10px] font-medium">加密</span>
								{/if}
								<span class="truncate font-mono text-[11px] text-(--admin-text-faint)">{post.path}</span>
							</div>
						</td>
						<td class="hidden max-w-[14rem] px-4 py-3 md:table-cell">
							<div class="truncate text-xs text-(--admin-text)">
								{post.category || "未分类"}
							</div>
							<div class="mt-1 flex flex-wrap gap-1">
								{#each post.tags.slice(0, 4) as tag (tag)}
									<span class="rounded bg-(--admin-soft) px-1.5 py-0.5 text-[10px] text-(--admin-text)">{tag}</span>
								{/each}
								{#if post.tags.length > 4}
									<span class="text-[10px] text-(--admin-text-faint)">+{post.tags.length - 4}</span>
								{/if}
							</div>
						</td>
						<td class="hidden whitespace-nowrap px-4 py-3 text-xs text-(--admin-text-faint) sm:table-cell">
							{formatDate(post.published)}
						</td>
						<td class="whitespace-nowrap px-4 py-3 text-right">
							<a
								href={`/admin/editor/?file=${encodeURIComponent(post.path)}`}
								class="rounded-md px-2 py-1 text-xs text-(--admin-text) transition-colors hover:bg-(--admin-panel-hover) hover:text-(--admin-accent-hover)"
							>编辑</a>
							<a
								href={post.url}
								target="_blank"
								class="rounded-md px-2 py-1 text-xs text-(--admin-text) transition-colors hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
							>预览</a>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="4" class="px-4 py-10 text-center text-sm text-(--admin-text-faint)">
							没有匹配的文章
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
