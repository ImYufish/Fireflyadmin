<script lang="ts">
import { readDrafts, subscribeDrafts } from "../lib/drafts";

type TreeNode = {
	name: string;
	path: string;
	type: "dir" | "file";
	size?: number;
	mtime?: number;
	children?: TreeNode[];
};

type MutateEvent =
	| { type: "created"; path: string }
	| { type: "renamed"; from: string; to: string }
	| { type: "deleted"; path: string };

interface Props {
	selectedPath: string | null;
	onSelect?: (path: string) => void;
	onMutate?: (event: MutateEvent) => void;
}

const { selectedPath, onSelect, onMutate }: Props = $props();

let roots = $state<TreeNode[]>([]);
let loading = $state(true);
let error = $state("");
let expanded = $state(new Set<string>());
let busy = $state(false);
/** 有未发布草稿的文件（线上模式） */
let draftPaths = $state(new Set<string>());

$effect(() => {
	const sync = () => {
		draftPaths = new Set(Object.keys(readDrafts()));
	};
	sync();
	return subscribeDrafts(sync);
});

/** 文件类型徽标：扩展名 → 缩写 + 主题色 */
function fileBadge(name: string): { label: string; cls: string } {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md" || ext === "mdx")
		return { label: "MD", cls: "text-(--admin-info)" };
	if (ext === "ts" || ext === "mts")
		return { label: "TS", cls: "text-(--admin-accent-hover)" };
	if (ext === "json" || ext === "jsonc")
		return { label: "{ }", cls: "text-(--admin-warn)" };
	if (ext === "html" || ext === "htm")
		return { label: "<>", cls: "text-(--admin-danger)" };
	if (ext === "css") return { label: "#", cls: "text-(--admin-success)" };
	if (ext === "yml" || ext === "yaml")
		return { label: "Y", cls: "text-(--admin-success)" };
	return { label: "T", cls: "text-(--admin-text-faint)" };
}

function hasDraft(path: string): boolean {
	return draftPaths.has(path);
}

type Modal =
	| {
			mode: "create-file" | "create-dir" | "rename";
			dirPath: string;
			initialName: string;
	  }
	| {
			mode: "delete";
			targetPath: string;
			targetName: string;
			isDir: boolean;
			nonEmpty: boolean;
	  }
	| null;

let modal = $state<Modal>(null);
let modalInput = $state("");
let modalError = $state("");

const modalTitle = $derived(
	modal === null
		? ""
		: modal.mode === "delete"
			? "确认删除"
			: modal.mode === "create-file"
				? "新建文件"
				: modal.mode === "create-dir"
					? "新建文件夹"
					: "重命名",
);

/** 弹窗打开后聚焦输入框（Esc 关闭绑在 window 上，不依赖这里） */
function autofocusInput(node: HTMLInputElement) {
	requestAnimationFrame(() => {
		node.focus();
		node.select();
	});
}

function onWindowKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && modal) {
		event.preventDefault();
		closeModal();
	}
}

// 默认展开根目录与其一级子目录
async function fetchTree(keepExpanded = true) {
	loading = true;
	error = "";
	try {
		const res = await fetch("/api/admin/files/tree/");
		const data = await res.json();
		if (!res.ok || !data?.ok) {
			error = data?.error ?? "加载文件树失败";
			return;
		}
		roots = data.roots as TreeNode[];
		if (!keepExpanded) {
			expanded = new Set();
		}
		for (const root of roots) {
			expanded.add(root.path);
		}
	} catch {
		error = "网络请求失败";
	} finally {
		loading = false;
	}
}

$effect(() => {
	void fetchTree(false);
});

function toggle(path: string) {
	const next = new Set(expanded);
	if (next.has(path)) next.delete(path);
	else next.add(path);
	expanded = next;
}

function isExpanded(path: string): boolean {
	return expanded.has(path);
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index > 0 ? path.slice(0, index) : path;
}

function openCreate(dirPath: string, mode: "create-file" | "create-dir") {
	modal = { mode, dirPath, initialName: "" };
	modalInput = "";
	modalError = "";
}

function openRename(node: TreeNode) {
	modal = {
		mode: "rename",
		dirPath: parentPath(node.path),
		initialName: node.name,
	};
	modalInput = node.name;
	modalError = "";
}

function openDelete(node: TreeNode) {
	modal = {
		mode: "delete",
		targetPath: node.path,
		targetName: node.name,
		isDir: node.type === "dir",
		nonEmpty: Boolean(node.children && node.children.length > 0),
	};
	modalError = "";
}

function closeModal() {
	modal = null;
	modalError = "";
}

async function submitModal() {
	if (!modal || busy) return;
	busy = true;
	modalError = "";
	try {
		let res: Response;
		if (modal.mode === "create-file" || modal.mode === "create-dir") {
			const name = modalInput.trim();
			if (!name) {
				modalError = "请输入名称";
				return;
			}
			const target = `${modal.dirPath}/${name}`;
			res = await fetch("/api/admin/files/file/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "create",
					path: target,
					type: modal.mode === "create-dir" ? "dir" : "file",
				}),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok || !data?.ok) {
				modalError = data?.error ?? `创建失败（${res.status}）`;
				return;
			}
			await fetchTree();
			if (modal.mode === "create-file") {
				onSelect?.(data.path);
				onMutate?.({ type: "created", path: data.path });
			}
		} else if (modal.mode === "rename") {
			const name = modalInput.trim();
			if (!name || name === modal.initialName) {
				closeModal();
				return;
			}
			const from = `${modal.dirPath}/${modal.initialName}`;
			const to = `${modal.dirPath}/${name}`;
			res = await fetch("/api/admin/files/file/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "rename", from, to }),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok || !data?.ok) {
				modalError = data?.error ?? `重命名失败（${res.status}）`;
				return;
			}
			await fetchTree();
			onMutate?.({ type: "renamed", from, to: data.path });
		} else if (modal.mode === "delete") {
			res = await fetch("/api/admin/files/file/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "delete",
					path: modal.targetPath,
					recursive: true,
				}),
			});
			const data = await res.json().catch(() => null);
			if (!res.ok || !data?.ok) {
				modalError = data?.error ?? `删除失败（${res.status}）`;
				return;
			}
			await fetchTree();
			onMutate?.({ type: "deleted", path: modal.targetPath });
		}
		closeModal();
	} catch {
		modalError = "网络请求失败";
	} finally {
		busy = false;
	}
}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center justify-between px-3 pt-3 pb-2">
		<span class="text-xs font-semibold tracking-wide text-(--admin-text-faint)">文件树</span>
		<div class="flex items-center gap-1">
			<button
				type="button"
				class="rounded-md p-1 text-(--admin-text-faint) transition-colors hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
				title="刷新文件树"
				onclick={() => fetchTree(true)}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4">
					<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7"></path>
				</svg>
			</button>
		</div>
	</div>

	{#if loading && roots.length === 0}
		<div class="px-4 py-8 text-center text-xs text-(--admin-text-faint)">加载中…</div>
	{:else if error}
		<div class="px-4 py-4 text-xs text-red-400">{error}</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-y-auto pb-4">
			{#each roots as root (root.path)}
				{@render dirNode(root, 0)}
			{/each}
		</div>
	{/if}

	<!-- 操作弹窗 -->
	{#if modal}
		<div
			class="admin-modal-backdrop"
			onclick={(e) => {
				if (e.target === e.currentTarget) closeModal();
			}}
			role="presentation"
		>
			<div
				class="admin-modal-panel"
				role="dialog"
				aria-modal="true"
				aria-label={modalTitle}
			>
				<div class="admin-modal-head">
					<h3 class="admin-modal-title">{modalTitle}</h3>
					<button
						type="button"
						class="admin-modal-close"
						title="关闭 (Esc)"
						aria-label="关闭"
						onclick={closeModal}
					>
						<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4">
							<path
								d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"
							></path>
						</svg>
					</button>
				</div>

				{#if modal.mode === "delete"}
					<div class="admin-modal-body">
						<p>
							确定要删除
							<code>{modal.targetPath}</code>
							吗？
							{#if modal.isDir && modal.nonEmpty}
								<span class="text-(--admin-warn)">
									该目录非空，其中的所有内容将被一并删除。
								</span>
							{/if}
							此操作无法撤销。
						</p>
						{#if modalError}
							<div class="admin-alert admin-alert-danger mt-3 !text-xs">
								{modalError}
							</div>
						{/if}
					</div>
					<div class="admin-modal-footer">
						<button
							type="button"
							class="admin-btn admin-btn-ghost"
							onclick={closeModal}
						>
							取消
						</button>
						<button
							type="button"
							class="admin-btn admin-btn-danger"
							disabled={busy}
							onclick={submitModal}
						>
							{busy ? "删除中…" : "删除"}
						</button>
					</div>
				{:else}
					<div class="admin-modal-body">
						{#if modal.mode === "rename"}
							<p class="mb-3">
								位于 <code>{modal.dirPath}/</code>
							</p>
						{:else}
							<p class="mb-3">
								将创建在 <code>{modal.dirPath}/</code>
								下，支持子目录（如 <code>images/pic.png</code>）
							</p>
						{/if}
						<input
							type="text"
							class="admin-input font-mono"
							placeholder={modal.mode === "create-dir"
								? "文件夹名称"
								: "文件名（如 my-post.md）"}
							bind:value={modalInput}
							use:autofocusInput
							onkeydown={(e) => {
								if (e.key === "Enter") submitModal();
							}}
						/>
						{#if modalError}
							<div class="admin-alert admin-alert-danger mt-3 !text-xs">
								{modalError}
							</div>
						{/if}
					</div>
					<div class="admin-modal-footer">
						<button
							type="button"
							class="admin-btn admin-btn-ghost"
							onclick={closeModal}
						>
							取消
						</button>
						<button
							type="button"
							class="admin-btn admin-btn-primary"
							disabled={busy}
							onclick={submitModal}
						>
							{busy ? "处理中…" : "确定"}
						</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#snippet dirNode(node: TreeNode, depth: number)}
	<div>
		<div
			class="group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-(--admin-panel-hover)"
			style={`padding-left: ${depth * 14 + 6}px`}
		>
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
				onclick={() => toggle(node.path)}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="currentColor"
					class="h-3.5 w-3.5 shrink-0 text-(--admin-text-faint) transition-transform {isExpanded(node.path) ? 'rotate-90' : ''}"
				>
					<path d="M10 17 15 12 10 7z"></path>
				</svg>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4 shrink-0 text-(--admin-accent-hover)/80">
					<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"></path>
				</svg>
				<span class="truncate text-sm text-(--admin-text)">{node.name}</span>
			</button>
			<div class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
				<button
					type="button"
					class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
					title="新建文件"
					onclick={() => openCreate(node.path, "create-file")}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M13 11V5h-2v6H5v2h6v6h2v-6h6v-2z"></path></svg>
				</button>
				<button
					type="button"
					class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
					title="新建文件夹"
					onclick={() => openCreate(node.path, "create-dir")}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2m-9 9h2v-2h2v-2h-2V9h-2v2H7v2h2z"></path></svg>
				</button>
				<button
					type="button"
					class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
					title="重命名"
					onclick={() => openRename(node)}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.6 1.6 3.7 3.7zM3 17.2V21h3.8L17.9 9.9l-3.8-3.8z"></path></svg>
				</button>
				<button
					type="button"
					class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-admin-danger"
					title="删除"
					onclick={() => openDelete(node)}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M9 3v1H4v2h16V4h-5V3zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6z"></path></svg>
				</button>
			</div>
		</div>
		{#if isExpanded(node.path) && node.children}
			{#each node.children as child (child.path)}
				{#if child.type === "dir"}
					{@render dirNode(child, depth + 1)}
				{:else}
					{@render fileNode(child, depth + 1)}
				{/if}
			{/each}
			{#if node.children.length === 0}
				<div class="py-1 text-xs text-(--admin-text-faint)" style={`padding-left: ${(depth + 1) * 14 + 26}px`}>
					（空）
				</div>
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet fileNode(node: TreeNode, depth: number)}
	<div
		class="group flex items-center rounded-md pr-1 transition-colors hover:bg-(--admin-panel-hover) {selectedPath === node.path ? 'bg-(--admin-accent)/15' : ''}"
		style={`padding-left: ${depth * 14 + 6}px`}
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left {selectedPath === node.path ? 'text-(--admin-accent-hover)' : ''}"
			onclick={() => onSelect?.(node.path)}
			title={node.path}
		>
			<span class="ml-2.5 w-5 shrink-0 text-center text-[9px] font-extrabold tracking-tight {fileBadge(node.name).cls}">
					{fileBadge(node.name).label}
				</span>
			<span class="truncate text-sm {selectedPath === node.path ? 'text-(--admin-text-strong)' : 'text-(--admin-text)'}">
				{node.name}
			</span>
			{#if hasDraft(node.path)}
				<span
					class="ml-auto mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-(--admin-warn)"
					title="有未发布的草稿修改"
				></span>
			{/if}
		</button>
		<div class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
			<button
				type="button"
				class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong)"
				title="重命名"
				onclick={() => openRename(node)}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.6 1.6 3.7 3.7zM3 17.2V21h3.8L17.9 9.9l-3.8-3.8z"></path></svg>
			</button>
			<button
				type="button"
				class="rounded p-1 text-(--admin-text-faint) hover:bg-(--admin-panel-hover) hover:text-admin-danger"
				title="删除"
				onclick={() => openDelete(node)}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><path d="M9 3v1H4v2h16V4h-5V3zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6z"></path></svg>
			</button>
		</div>
	</div>
{/snippet}
