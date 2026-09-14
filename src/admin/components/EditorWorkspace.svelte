<script lang="ts">
import { untrack } from "svelte";
import {
	clearDrafts,
	deleteDraft,
	readDrafts,
	subscribeDrafts,
	writeDraft,
} from "../lib/drafts";
import { splitRaw } from "../lib/frontmatter";
import CodeEditor from "./CodeEditor.svelte";
import FileTree from "./FileTree.svelte";
import FrontmatterPanel from "./FrontmatterPanel.svelte";

interface Props {
	initialFile: string | null;
}

const { initialFile }: Props = $props();

let currentPath = $state<string | null>(initialFile);
let content = $state("");
/** 上次保存的内容（本地=落盘内容；线上=草稿内容），与 content 比对得出未保存状态 */
let savedContent = $state("");
let isText = $state(true);
let postUrl = $state<string | null>(null);
let loading = $state(false);
let saveError = $state("");
let saving = $state(false);
let lastSavedAt = $state("");
let autoSave = $state(true);
let showFm = $state(true);
let showPreview = $state(true);
let previewMode = $state<"desktop" | "mobile">("desktop");
let toast = $state("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 文件后端模式（来自文件读取接口） */
let backendMode = $state<"local" | "github">("local");
/** 当前文件的 frontmatter 块（含 --- 定界）。编辑器内只显示正文 */
let fmBlock = $state("");
/** 线上模式：全部未发布草稿（content 为正文，fm 为 frontmatter 块） */
let drafts = $state<
	Record<string, { content: string; savedAt: number; fm?: string }>
>({});
let publishing = $state(false);

const draftCount = $derived(Object.keys(drafts).length);
/** 当前文件是否有未发布草稿 */
const currentHasDraft = $derived(
	currentPath !== null && drafts[currentPath] !== undefined,
);

const unsaved = $derived(
	currentPath !== null && isText && content !== savedContent,
);

// 暴露未保存状态给后台无刷新导航（离开前弹确认）
$effect(() => {
	(window as Window & { __adminUnsaved?: boolean }).__adminUnsaved = unsaved;
});

// 订阅草稿变化（本组件写入/发布/其他标签页都会触发）
$effect(() => {
	drafts = readDrafts();
	return subscribeDrafts(() => {
		drafts = readDrafts();
	});
});
const isMarkdown = $derived(
	currentPath !== null && /\.(md|mdx|markdown)$/i.test(currentPath),
);
/** 预览地址：文章用真实文章页；配置文件改动会热更新，预览用首页 */
const previewUrl = $derived.by(() => {
	if (postUrl) return postUrl;
	const path = currentPath;
	if (!path) return null;
	if (path.startsWith("src/config/")) return "/";
	if (path.startsWith("src/content/dynamic/")) return "/dynamic/";
	if (path.startsWith("src/content/projects/")) return "/projects/";
	if (path.startsWith("src/content/spec/")) {
		const name =
			path
				.split("/")
				.pop()
				?.replace(/\.(md|mdx)$/i, "") ?? "";
		return name ? `/${name}/` : null;
	}
	return null;
});

function toastMsg(message: string) {
	toast = message;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toast = ""), 3000);
}

let iframeEl: HTMLIFrameElement | undefined = $state();

function updateUrl(path: string | null) {
	const query = path ? `?file=${encodeURIComponent(path)}` : "";
	history.replaceState(null, "", `/admin/editor/${query}`);
}

async function loadFile(path: string) {
	loading = true;
	saveError = "";
	try {
		const res = await fetch(
			`/api/admin/files/file/?path=${encodeURIComponent(path)}`,
		);
		const data = await res.json().catch(() => null);
		if (res.status === 415) {
			// 二进制文件：允许选中查看信息，但不可编辑
			currentPath = data?.path ?? path;
			isText = false;
			content = "";
			savedContent = "";
			postUrl = null;
			updateUrl(currentPath);
			return;
		}
		if (!res.ok || !data?.ok) {
			toastMsg(data?.error ?? `读取文件失败（${res.status}）`);
			return;
		}
		currentPath = data.path;
		isText = data.isText;
		backendMode = data.mode === "github" ? "github" : "local";
		drafts = readDrafts();
		const full = String(data.content ?? "");
		// 编辑器只显示正文：frontmatter 剥离到「属性」面板
		const parsed = splitRaw(full);
		fmBlock = parsed.fm;
		// 线上模式：有未发布草稿时优先展示草稿内容
		const draft = backendMode === "github" ? drafts[data.path] : undefined;
		if (draft) {
			content = draft.content;
			fmBlock = draft.fm ?? fmBlock;
		} else {
			content = parsed.body;
		}
		savedContent = content;
		postUrl = data.postUrl ?? null;
		updateUrl(data.path);
	} catch {
		toastMsg("网络请求失败");
	} finally {
		loading = false;
	}
}

async function refreshMeta() {
	if (!currentPath) return;
	try {
		const res = await fetch(
			`/api/admin/files/file/?path=${encodeURIComponent(currentPath)}&meta=1`,
		);
		const data = await res.json().catch(() => null);
		if (res.ok && data?.ok) {
			postUrl = data.postUrl ?? null;
		}
	} catch {
		/* 元信息刷新失败不影响保存 */
	}
}

async function save() {
	if (saving || !currentPath || !isText) return;
	if (content === savedContent) return;
	saving = true;
	saveError = "";
	try {
		// 线上模式：保存 = 暂存本地草稿，攒多次修改由「发布」一次性提交
		if (backendMode === "github") {
			writeDraft(currentPath, content, fmBlock);
			savedContent = content;
			lastSavedAt = new Date().toLocaleTimeString("zh-CN", {
				hour12: false,
			});
			toastMsg("已保存草稿（尚未发布），点「发布」一次性提交全部修改");
			return;
		}
		const res = await fetch("/api/admin/files/file/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "save",
				path: currentPath,
				content: fmBlock + content,
			}),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok || !data?.ok) {
			saveError = data?.error ?? `保存失败（${res.status}）`;
			return;
		}
		savedContent = content;
		lastSavedAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
		refreshPreview();
		await refreshMeta();
	} catch {
		saveError = "网络请求失败";
	} finally {
		saving = false;
	}
}

/** 把全部草稿一次性提交为单个 commit */
async function publishDrafts() {
	if (publishing || draftCount === 0) return;
	if (
		!window.confirm(`把 ${draftCount} 个文件的修改一次性提交到 ${"GitHub"}？`)
	) {
		return;
	}
	publishing = true;
	saveError = "";
	try {
		const changes = Object.entries(drafts).map(([p, d]) => ({
			path: p,
			content: (d.fm ?? "") + d.content,
		}));
		const res = await fetch("/api/admin/publish/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				changes,
				message: `chore(admin): publish ${changes.length} file change${changes.length > 1 ? "s" : ""}`,
			}),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok || !data?.ok) {
			toastMsg(data?.error ?? `发布失败（${res.status}）`);
			return;
		}
		clearDrafts();
		drafts = {};
		toastMsg(
			`已发布 ${data.count} 个文件（commit ${String(data.sha).slice(0, 7)}），部署完成后预览更新`,
		);
		refreshPreview();
		await refreshMeta();
	} catch {
		toastMsg("网络请求失败");
	} finally {
		publishing = false;
	}
}

/** 丢弃当前文件的未发布草稿，恢复为仓库内容 */
async function discardDraft() {
	if (!currentPath || !drafts[currentPath]) return;
	if (!window.confirm("丢弃当前文件的未发布草稿，恢复为仓库内容？")) return;
	deleteDraft(currentPath);
	drafts = readDrafts();
	await loadFile(currentPath);
}

function refreshPreview() {
	// 同源 iframe 直接重载；dev 服务器的内容 HMR 通常也会让它自动刷新
	iframeEl?.contentWindow?.location.reload();
}

function handleDocChange(next: string) {
	content = next;
}

function handleFmChange(next: string) {
	// frontmatter 表单修改：更新 fm 块并标记未保存（正文不受影响）
	fmBlock = next;
}

function handleTreeSelect(path: string) {
	if (path !== currentPath) void loadFile(path);
}

function handleTreeMutate(
	event:
		| { type: "created"; path: string }
		| { type: "renamed"; from: string; to: string }
		| { type: "deleted"; path: string },
) {
	if (event.type === "created") {
		void loadFile(event.path);
		return;
	}
	const path = currentPath;
	if (!path) return;
	if (event.type === "renamed") {
		if (path === event.from || path.startsWith(`${event.from}/`)) {
			const next = `${event.to}${path.slice(event.from.length)}`;
			currentPath = next;
			updateUrl(next);
			void refreshMeta();
		}
		return;
	}
	if (event.type === "deleted") {
		if (path === event.path || path.startsWith(`${event.path}/`)) {
			currentPath = null;
			content = "";
			savedContent = "";
			postUrl = null;
			isText = true;
			updateUrl(null);
		}
	}
}

function handleKeydown(event: KeyboardEvent) {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
		event.preventDefault();
		void save();
	}
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
	if (unsaved) event.preventDefault();
}

// 自动保存：内容变化 2 秒后触发
$effect(() => {
	if (!autoSave || !isText || !currentPath) return;
	if (content === savedContent) return;
	const timer = setTimeout(() => void save(), 2000);
	return () => clearTimeout(timer);
});

// 初始加载 URL 参数指定的文件（仅使用初始值，不建立响应式依赖）
$effect(() => {
	const file = untrack(() => initialFile);
	if (file) void loadFile(file);
});
</script>

<svelte:window onkeydown={handleKeydown} onbeforeunload={handleBeforeUnload} />

<div class="flex h-full min-h-0">
	<!-- 左：文件树 -->
	<aside class="w-64 shrink-0 border-r border-(--admin-line) bg-(--admin-panel)">
		<FileTree
			selectedPath={currentPath}
			onSelect={handleTreeSelect}
			onMutate={handleTreeMutate}
		/>
	</aside>

		<!-- 中：编辑器 -->
		<section class="flex min-w-0 flex-1 flex-col">
			<div class="flex flex-wrap items-center gap-2 border-b border-(--admin-line) px-4 py-2.5">
				<span class="min-w-0 flex-1 truncate font-mono text-xs text-(--admin-text)" title={currentPath ?? undefined}>
					{currentPath ?? "未选择文件"}
				</span>
				<span class="text-xs {unsaved || currentHasDraft ? 'text-admin-warn' : 'text-(--admin-text-faint)'}">
					{#if saving}
						保存中…
					{:else if saveError}
						保存失败
					{:else if unsaved}
						未保存
					{:else if currentHasDraft}
						草稿（未发布）
					{:else if lastSavedAt}
						已保存 {lastSavedAt}
					{/if}
				</span>
				<button
					type="button"
					class="admin-btn admin-btn-ghost !px-2.5 !py-1 !text-xs {showFm ? '!border-(--admin-accent)/50 !text-(--admin-accent-hover)' : ''}"
					onclick={() => (showFm = !showFm)}
					title="显示/隐藏 frontmatter 表单"
				>
					属性
				</button>
				<label class="flex cursor-pointer items-center gap-1.5 text-xs text-(--admin-text) select-none">
					<input type="checkbox" class="accent-(--admin-accent)" bind:checked={autoSave} />
					自动保存
				</label>
				<button
					type="button"
					class="admin-btn admin-btn-ghost !px-2.5 !py-1 !text-xs {showPreview ? '!border-(--admin-accent)/50 !text-(--admin-accent-hover)' : ''}"
					onclick={() => (showPreview = !showPreview)}
					title="显示/隐藏预览"
				>
					预览
				</button>
				{#if backendMode === "github"}
					<button
						type="button"
						class="admin-btn admin-btn-ghost !px-2.5 !py-1 !text-xs"
						disabled={!currentHasDraft}
						onclick={() => void discardDraft()}
						title="丢弃当前文件的未发布草稿"
					>
						丢弃草稿
					</button>
				{/if}
				<button
					type="button"
					class="admin-btn admin-btn-primary !px-3.5 !py-1 !text-xs"
					disabled={!unsaved || saving || !isText}
					onclick={() => void save()}
					title="保存（Ctrl+S）"
				>
					{backendMode === "github" ? "存草稿" : "保存"}
				</button>
				{#if backendMode === "github"}
					<button
						type="button"
						class="admin-btn admin-btn-primary !px-3.5 !py-1 !text-xs"
						disabled={draftCount === 0 || publishing || unsaved}
						onclick={() => void publishDrafts()}
						title="把全部草稿一次性提交为单个 commit"
					>
						发布{draftCount > 0 ? `（${draftCount}）` : ""}
					</button>
				{/if}
			</div>

		{#if saveError}
			<div class="admin-alert admin-alert-danger rounded-none border-x-0 border-t-0 !text-xs">
				{saveError}
			</div>
		{/if}

		{#if currentPath && isText && isMarkdown && showFm}
			<FrontmatterPanel content={fmBlock} disabled={loading} onChange={handleFmChange} />
		{/if}

		<div class="relative flex min-h-0 flex-1 flex-col">
			{#if !currentPath}
				<div class="flex flex-1 flex-col items-center justify-center gap-2 text-(--admin-text-faint)">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-10 w-10 text-(--admin-text-faint)">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z"></path>
					</svg>
					<p class="text-sm">从左侧文件树选择一个文件开始编辑</p>
				</div>
			{:else if !isText}
				<div class="flex flex-1 flex-col items-center justify-center gap-2 text-(--admin-text-faint)">
					<p class="text-sm">二进制文件不支持在线编辑</p>
					<p class="text-xs">可在左侧文件树中重命名或删除该文件</p>
				</div>
			{:else if loading}
				<div class="flex flex-1 items-center justify-center text-sm text-(--admin-text-faint)">
					加载中…
				</div>
			{:else}
				<CodeEditor value={content} path={currentPath} onDocChange={handleDocChange} />
			{/if}
		</div>
	</section>

	<!-- 右：真实页面预览 -->
	{#if showPreview}
		<aside
			class="flex min-w-0 flex-col border-l border-(--admin-line) bg-(--admin-panel) {previewMode === 'mobile' ? 'w-[440px] shrink-0 flex-none' : 'flex-1'}"
		>
			<div class="flex items-center gap-2 border-b border-(--admin-line) px-3 py-2">
				<span class="text-xs font-semibold text-(--admin-text)">实时预览</span>
				{#if previewUrl}
					<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-(--admin-text-faint)">{previewUrl}</span>
					<div class="flex shrink-0 items-center gap-1">
						<button
							type="button"
							class="admin-btn admin-btn-ghost !px-2 !py-1 !text-[11px]"
							onclick={() => (previewMode = previewMode === "desktop" ? "mobile" : "desktop")}
						>
							{previewMode === "desktop" ? "手机" : "桌面"}
						</button>
						<button
							type="button"
							class="admin-btn admin-btn-ghost !px-2 !py-1 !text-[11px]"
							onclick={refreshPreview}
							title="刷新预览"
						>
							刷新
						</button>
						<a
							href={previewUrl}
							target="_blank"
							class="admin-btn admin-btn-ghost !px-2 !py-1 !text-[11px]"
							title="在新标签页打开"
						>
							新窗口
						</a>
					</div>
				{:else}
					<span class="flex-1 text-[11px] text-(--admin-text-faint)">此文件没有对应的预览页面</span>
				{/if}
			</div>
			<div class="min-h-0 flex-1 {previewMode === 'mobile' ? 'flex justify-center overflow-auto bg-(--admin-panel) p-3' : ''}">
				{#if previewUrl}
					<iframe
						bind:this={iframeEl}
						src={previewUrl}
						title="博客预览"
						class="h-full w-full border-0 bg-white {previewMode === 'mobile' ? 'max-w-[400px] rounded-xl border border-(--admin-line)' : ''}"
					></iframe>
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-(--admin-text-faint)">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-10 w-10 text-(--admin-text-faint)">
							<path d="M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 14H3V8h18zm-16-5h9v2H5z"></path>
						</svg>
						<p class="text-sm">
							{currentPath
								? "保存后此处将显示博客真实渲染页面"
								: "选择 src/content/posts 下的文章进行预览"}
						</p>
						<p class="text-xs text-(--admin-text-faint)">
							预览与博客前台完全一致（含 KaTeX、Mermaid、代码块等全部渲染特性）
						</p>
					</div>
				{/if}
			</div>
		</aside>
	{/if}
</div>

{#if toast}
	<div class="admin-fade-in fixed right-6 bottom-6 z-50 rounded-lg border border-(--admin-line) bg-(--admin-panel) px-4 py-3 text-sm text-(--admin-text-strong) shadow-2xl">
		{toast}
	</div>
{/if}
