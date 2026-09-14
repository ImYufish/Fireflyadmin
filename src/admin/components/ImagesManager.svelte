<script lang="ts">
import { onMount } from "svelte";

type Img = {
	name: string;
	url: string;
	previewUrl: string;
	root?: "public" | "content";
	mime: string;
	size: number;
	time: string;
};

type StorageMode = "local" | "cfbed";
type NameType = "default" | "index" | "origin" | "short";

const STORAGE_KEY = "firefly-admin-image-storage";
const NAMING_KEY = "firefly-admin-image-naming";

const NAMING_OPTIONS: Array<{ value: NameType; label: string; desc: string }> =
	[
		{ value: "origin", label: "原文件名", desc: "保持上传时的文件名" },
		{ value: "default", label: "前缀_原名", desc: "时间戳前缀_原文件名" },
		{ value: "index", label: "仅前缀", desc: "只保留时间戳前缀" },
		{ value: "short", label: "短链接", desc: "随机短文件名" },
	];

let storage = $state<StorageMode>("local");
let cfbedConfigured = $state(false);
let images = $state<Img[]>([]);
let total = $state(0);
/** 当前目录下（任意深度）的全部子目录，用于派生面包屑与子文件夹卡片 */
let folders = $state<string[]>([]);
let folder = $state("");
let nameType = $state<NameType>("origin");
/** 本地模式下的图片根：content=src/content/posts/images（引用 ./images/...），public=public/images（引用 /images/...） */
let localRoot = $state<"public" | "content">("content");
let loading = $state(true);
let loadingMore = $state(false);
let loadError = $state("");
let notice = $state("");
let search = $state("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let uploading = $state(false);
let uploadError = $state("");
let copied = $state("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;
/** 待确认删除的图片（弹窗确认，替代原来挤在卡片里的小确认框） */
let pendingDelete = $state<Img | null>(null);
let dragDepth = $state(0);
let lightbox = $state<Img | null>(null);
/** 上传弹窗：点上传按钮展开，内含上传目标 / 命名方式 / 选文件 */
let uploadModal = $state(false);
/** 上传目标：图床 / 文章图片（./images）/ 站点图片（/images） */
type UploadTarget = "cfbed" | "content" | "public";
let uploadTarget = $state<UploadTarget>("content");
let uploadNaming = $state<NameType>("origin");
/** 弹窗内是否正在上传 */
let modalUploading = $state(false);
let modalUploadError = $state("");

const PAGE_SIZE = 40;

onMount(() => {
	const savedStorage = localStorage.getItem(STORAGE_KEY);
	if (savedStorage === "local" || savedStorage === "cfbed")
		storage = savedStorage;
	const savedNaming = localStorage.getItem(NAMING_KEY);
	if (
		savedNaming === "default" ||
		savedNaming === "index" ||
		savedNaming === "origin" ||
		savedNaming === "short"
	) {
		nameType = savedNaming;
	}
	void load();
});

/* ------------------------------ 目录导航 ------------------------------ */

const breadcrumb = $derived(folder ? folder.split("/") : []);

/** 当前目录的直属子文件夹（folders 为当前目录下的目录路径，取第一段） */
const subfolders = $derived(
	[
		...new Set(
			folders
				.map((f) => f.split("/")[0])
				.filter((seg): seg is string => Boolean(seg)),
		),
	].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
);

const folderLabel = $derived(
	storage === "cfbed"
		? `图床${folder ? ` / ${breadcrumb.join(" / ")}` : ""}`
		: `${localRoot === "content" ? "src/content/posts/images" : "public/images"}${folder ? ` / ${breadcrumb.join(" / ")}` : ""}`,
);

function openFolder(path: string) {
	folder = path;
	pendingDelete = null;
	notice = "";
	void load();
}

function jumpTo(index: number) {
	// index = -1 回根目录；否则回到 breadcrumb[0..index]
	folder = index < 0 ? "" : breadcrumb.slice(0, index + 1).join("/");
	pendingDelete = null;
	void load();
}

function pickStorage(mode: StorageMode) {
	if (storage === mode) return;
	if (mode === "cfbed" && !cfbedConfigured) {
		notice =
			"尚未配置 cfbed 图床：在 .env 填写 ADMIN_IMGBED_URL 与 ADMIN_IMGBED_TOKEN 后重启";
		return;
	}
	storage = mode;
	folder = "";
	notice = "";
	pendingDelete = null;
	localStorage.setItem(STORAGE_KEY, mode);
	void load();
}

function pickLocalRoot(root: "public" | "content") {
	if (localRoot === root) return;
	localRoot = root;
	folder = "";
	notice = "";
	pendingDelete = null;
	void load();
}

function pickNaming(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value as NameType;
	nameType = value;
	localStorage.setItem(NAMING_KEY, value);
}

/* ------------------------------ 数据加载 ------------------------------ */

async function load() {
	loading = true;
	loadError = "";
	try {
		const res = await fetch(
			`/api/admin/images/?storage=${storage}&folder=${encodeURIComponent(folder)}&start=0&count=${PAGE_SIZE}&search=${encodeURIComponent(search)}${storage === "local" ? `&root=${localRoot}` : ""}`,
		);
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.ok) {
			loadError = json?.error ?? `加载失败（${res.status}）`;
			return;
		}
		cfbedConfigured = json.cfbedConfigured === true;
		if (storage === "cfbed" && !cfbedConfigured) {
			storage = "local";
			return load();
		}
		images = json.images ?? [];
		total = json.total ?? images.length;
		folders = json.folders ?? [];
	} catch {
		loadError = "网络请求失败";
	} finally {
		loading = false;
	}
}

function onSearchInput() {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => void load(), 400);
}

async function loadMore() {
	loadingMore = true;
	try {
		const res = await fetch(
			`/api/admin/images/?storage=${storage}&folder=${encodeURIComponent(folder)}&start=${images.length}&count=${PAGE_SIZE}&search=${encodeURIComponent(search)}${storage === "local" ? `&root=${localRoot}` : ""}`,
		);
		const json = await res.json().catch(() => null);
		if (res.ok && json?.ok) {
			images = [...images, ...(json.images ?? [])];
			total = json.total ?? total;
		}
	} catch {
		/* 加载更多失败保留现状 */
	} finally {
		loadingMore = false;
	}
}

/* ------------------------------ 上传 / 删除 ------------------------------ */

async function uploadFiles(
	files: File[],
	opts: {
		storage?: StorageMode;
		root?: "public" | "content";
		nameType?: NameType;
	} = {},
) {
	if (files.length === 0) return;
	const st = opts.storage ?? storage;
	const root = opts.root ?? localRoot;
	const naming = opts.nameType ?? nameType;
	uploading = true;
	uploadError = "";
	try {
		const form = new FormData();
		form.append("storage", st);
		form.append("folder", folder);
		form.append("nameType", naming);
		if (st === "local") form.append("root", root);
		for (const f of files.slice(0, 10)) form.append("file", f);
		const res = await fetch("/api/admin/images/", {
			method: "POST",
			body: form,
		});
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.ok) {
			uploadError = json?.error ?? `上传失败（${res.status}）`;
			return;
		}
		const added: Img[] = json.images ?? [];
		images = [...added, ...images];
		total += added.length;
	} catch {
		uploadError = "上传请求失败";
	} finally {
		uploading = false;
		if (fileInput) fileInput.value = "";
	}
}

/** 上传弹窗：打开时把目标/命名同步成当前浏览的库，减少来回切 */
function openUploadModal() {
	uploadTarget = storage === "cfbed" ? "cfbed" : localRoot;
	uploadNaming = nameType;
	modalUploading = false;
	modalUploadError = "";
	uploadModal = true;
}

/** 弹窗内上传：按弹窗里选的目标 / 命名上传，不直接改动当前浏览的库 */
async function uploadFromModal(files: File[]) {
	if (files.length === 0) return;
	modalUploading = true;
	modalUploadError = "";
	const st: StorageMode = uploadTarget === "cfbed" ? "cfbed" : "local";
	const root: "public" | "content" =
		uploadTarget === "content" ? "content" : "public";
	try {
		const form = new FormData();
		form.append("storage", st);
		form.append("folder", folder);
		form.append("nameType", uploadNaming);
		if (st === "local") form.append("root", root);
		for (const f of files.slice(0, 10)) form.append("file", f);
		const res = await fetch("/api/admin/images/", {
			method: "POST",
			body: form,
		});
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.ok) {
			modalUploadError = json?.error ?? `上传失败（${res.status}）`;
			return;
		}
		const added: Img[] = json.images ?? [];
		// 若上传目标与当前浏览的库一致，直接把新图插到最前；否则提示已传到别的库
		if (
			(storage === "cfbed") === (st === "cfbed") &&
			(st === "local" ? localRoot === root : true)
		) {
			images = [...added, ...images];
			total += added.length;
		} else {
			notice = `已上传 ${added.length} 张到「${uploadTarget === "cfbed" ? "图床" : uploadTarget === "content" ? "文章图片 ./images" : "站点图片 /images"}」，切到该库即可看到`;
		}
		uploadModal = false;
	} catch {
		modalUploadError = "上传请求失败";
	} finally {
		modalUploading = false;
	}
}

/** 整页拖拽上传（dragenter/dragleave 计数避免子元素抖动） */
function onDragEnter(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	dragDepth++;
}

function onDragOver(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
}

function onDragLeave() {
	dragDepth = Math.max(0, dragDepth - 1);
}

function onDrop(event: DragEvent) {
	dragDepth = 0;
	const files = [...(event.dataTransfer?.files ?? [])].filter((f) =>
		f.type.startsWith("image/"),
	);
	if (files.length > 0) {
		event.preventDefault();
		void uploadFiles(files);
	}
}

/** 任意位置 Ctrl+V 粘贴图片直接上传 */
function onPaste(event: ClipboardEvent) {
	const files = [...(event.clipboardData?.files ?? [])].filter((f) =>
		f.type.startsWith("image/"),
	);
	if (files.length === 0) return;
	event.preventDefault();
	void uploadFiles(files);
}

function onKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape") return;
	// 先关最上层：删除确认 > 上传弹窗 > 灯箱
	if (pendingDelete) pendingDelete = null;
	else if (uploadModal) uploadModal = false;
	else if (lightbox) lightbox = null;
}

async function copyUrl(img: Img) {
	try {
		await navigator.clipboard.writeText(img.url);
	} catch {
		/* 剪贴板不可用时忽略 */
	}
	copied = img.name;
	clearTimeout(copyTimer);
	copyTimer = setTimeout(() => (copied = ""), 1600);
}

/** 执行删除（由确认弹窗触发，图片取自 pendingDelete） */
async function removeImage() {
	const img = pendingDelete;
	if (!img) return;
	try {
		const res = await fetch("/api/admin/images/", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				storage,
				fileIds: [{ name: img.name, root: img.root ?? "public" }],
			}),
		});
		const json = await res.json().catch(() => null);
		if (!res.ok || !json?.ok) {
			uploadError = json?.error ?? "删除失败";
			return;
		}
		images = images.filter((i) => i.name !== img.name);
		total = Math.max(0, total - 1);
		pendingDelete = null;
	} catch {
		uploadError = "删除请求失败";
	}
}

function fmtSize(n: number): string {
	if (!n) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
	if (!iso) return "";
	return iso.slice(0, 10);
}

/** 文件卡片展示名：去掉目录部分只显示文件名 */
function baseName(name: string): string {
	return name.split("/").pop() ?? name;
}
</script>

<svelte:window onpaste={onPaste} onkeydown={onKeydown} />

{#if lightbox}
	<!-- 灯箱大图预览 -->
	<div
		class="admin-lightbox"
		role="dialog"
		aria-label="图片预览"
		onclick={(e) => {
			if (e.target === e.currentTarget) lightbox = null;
		}}
	>
		<img src={lightbox.previewUrl} alt={lightbox.name} />
		<div class="admin-lightbox-meta">
			<span class="name" title={lightbox.name}>{lightbox.name}</span>
			{#if fmtSize(lightbox.size)}
				<span class="opacity-70">{fmtSize(lightbox.size)}</span>
			{/if}
			<button type="button" onclick={() => void copyUrl(lightbox)}>
				{copied === lightbox.name ? "已复制" : "复制地址"}
			</button>
			<a href={lightbox.url} target="_blank" rel="noreferrer">新窗口打开</a>
			<button type="button" onclick={() => (lightbox = null)}>关闭 (Esc)</button>
		</div>
	</div>
{/if}

<!-- 删除确认弹窗 -->
{#if pendingDelete}
	<div
		class="admin-modal-backdrop"
		onclick={(e) => {
			if (e.target === e.currentTarget) pendingDelete = null;
		}}
		role="presentation"
	>
		<div
			class="admin-modal-panel"
			role="dialog"
			aria-modal="true"
			aria-label="确认删除图片"
		>
			<div class="admin-modal-head">
				<h3 class="admin-modal-title">确认删除这张图片？</h3>
				<button
					type="button"
					class="admin-modal-close"
					title="关闭 (Esc)"
					aria-label="关闭"
					onclick={() => (pendingDelete = null)}
				>
					<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4">
						<path
							d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"
						></path>
					</svg>
				</button>
			</div>
			<div class="admin-modal-body">
				<div class="flex items-start gap-3">
					<img
						src={pendingDelete.previewUrl}
						alt=""
						class="h-16 w-16 shrink-0 rounded-lg border border-(--admin-line) object-cover"
					/>
					<div class="min-w-0">
						<p class="break-all font-mono text-xs text-(--admin-text-strong)">
							{pendingDelete.name}
						</p>
						<p class="mt-1 text-[11px] text-(--admin-text-faint)">
							{fmtSize(pendingDelete.size)}{pendingDelete.time
								? ` · ${fmtTime(pendingDelete.time)}`
								: ""}
						</p>
					</div>
				</div>
				<p class="mt-3 text-(--admin-warn)">删除后无法恢复，引用了该图片的页面会失效。</p>
			</div>
			<div class="admin-modal-footer">
				<button
					type="button"
					class="admin-btn admin-btn-ghost"
					onclick={() => (pendingDelete = null)}
				>
					取消
				</button>
				<button
					type="button"
					class="admin-btn admin-btn-danger"
					onclick={() => void removeImage()}
				>
					删除
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- 上传弹窗：选目标库 / 命名方式 / 选文件 -->
{#if uploadModal}
	<div
		class="admin-modal-backdrop"
		onclick={(e) => {
			if (e.target === e.currentTarget) uploadModal = false;
		}}
		role="presentation"
	>
		<div
			class="admin-modal-panel"
			role="dialog"
			aria-modal="true"
			aria-label="上传图片"
		>
			<div class="admin-modal-head">
				<h3 class="admin-modal-title">上传图片</h3>
				<button
					type="button"
					class="admin-modal-close"
					title="关闭 (Esc)"
					aria-label="关闭"
					onclick={() => (uploadModal = false)}
				>
					<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"></path></svg>
				</button>
			</div>
			<div class="admin-modal-body space-y-4">
				<!-- 上传目标 -->
				<div>
					<span class="admin-label">上传到</span>
					<div class="mt-1.5 flex flex-wrap gap-2">
						<button
							type="button"
							onclick={() => (uploadTarget = "content")}
							class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors {uploadTarget === 'content' ? 'border-(--admin-accent) bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'border-(--admin-line) text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
						>
							文章图片 ./images
							<span class="mt-0.5 block text-[10px] font-normal text-(--admin-text-faint)">src/content/posts/images</span>
						</button>
						<button
							type="button"
							onclick={() => (uploadTarget = "public")}
							class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors {uploadTarget === 'public' ? 'border-(--admin-accent) bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'border-(--admin-line) text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
						>
							站点图片 /images
							<span class="mt-0.5 block text-[10px] font-normal text-(--admin-text-faint)">public/images</span>
						</button>
						<button
							type="button"
							onclick={() => (uploadTarget = "cfbed")}
							class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors {uploadTarget === 'cfbed' ? 'border-(--admin-accent) bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'border-(--admin-line) text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
						>
							图床
							<span class="mt-0.5 block text-[10px] font-normal text-(--admin-text-faint)">CloudFlare ImgBed</span>
						</button>
					</div>
				</div>
				{#if uploadTarget === "cfbed"}
				<!-- 命名方式（仅图床上传支持；本地文章图片/站点图片沿用原文件名） -->
				<div>
					<span class="admin-label">命名方式</span>
					<div class="mt-1.5 grid grid-cols-2 gap-2">
						{#each NAMING_OPTIONS as opt (opt.value)}
							<button
								type="button"
								onclick={() => (uploadNaming = opt.value)}
								class="rounded-lg border px-3 py-2 text-left text-xs transition-colors {uploadNaming === opt.value ? 'border-(--admin-accent) bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'border-(--admin-line) text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
							>
								<span class="block font-medium">{opt.label}</span>
								<span class="mt-0.5 block text-[10px] font-normal text-(--admin-text-faint)">{opt.desc}</span>
							</button>
						{/each}
					</div>
				</div>
				{/if}
				<!-- 选文件 -->
				<div>
					<span class="admin-label">选择文件</span>
					<label
						class="mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-(--admin-line) bg-(--admin-panel) px-4 py-7 text-center transition-colors hover:border-(--admin-accent)/60 {modalUploading ? 'pointer-events-none opacity-60' : ''}"
					>
						<svg viewBox="0 0 24 24" fill="currentColor" class="h-8 w-8 text-(--admin-accent-hover)"><path d="M9 16v-6H5l7-7 7 7h-4v6zm-4 2h14v2H5z"></path></svg>
						<span class="text-xs text-(--admin-text)">{modalUploading ? "上传中…" : "点击选择图片（可多选，最多 10 张）"}</span>
						<input
							type="file"
							accept="image/*"
							multiple
							class="hidden"
							onchange={(e) => {
								const input = e.currentTarget as HTMLInputElement;
								const files = [...(input.files ?? [])];
								if (files.length) void uploadFromModal(files);
								input.value = "";
							}}
						/>
					</label>
					{#if modalUploadError}
						<p class="mt-1.5 text-[11px] text-(--admin-warn)">{modalUploadError}</p>
					{/if}
				</div>
			</div>
			<div class="admin-modal-footer">
				<button
					type="button"
					class="admin-btn admin-btn-ghost"
					onclick={() => (uploadModal = false)}
				>
					关闭
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- 整页拖拽上传遮罩 -->
{#if dragDepth > 0}
	<div class="pointer-events-none fixed inset-0 z-[80] p-6">
		<div class="flex h-full w-full flex-col items-center justify-center gap-3 rounded-3xl border-4 border-dashed border-(--admin-accent) bg-(--admin-bg)/85 backdrop-blur-sm">
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-12 w-12 text-(--admin-accent)"><path d="M9 16v-6H5l7-7 7 7h-4v6zm-4 2h14v2H5z"></path></svg>
			<p class="text-base font-semibold text-(--admin-text-strong)">松开上传到 {folderLabel}</p>
			<p class="text-xs text-(--admin-text-faint)">最多 10 张 · 命名方式：{NAMING_OPTIONS.find((n) => n.value === nameType)?.label}</p>
		</div>
	</div>
{/if}

<div
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<!-- 第一行：当前位置 + 存储目标 -->
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-xl border border-(--admin-line) bg-(--admin-panel) px-3.5 py-2 text-xs">
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4 shrink-0 text-(--admin-accent-hover)"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"></path></svg>
			<span class="shrink-0 text-(--admin-text-faint)">位置</span>
			<button
				type="button"
				onclick={() => jumpTo(-1)}
				class="rounded-md px-1.5 py-0.5 font-medium transition-colors {folder === '' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
			>
				{storage === "local" ? "images" : "根目录"}
			</button>
			{#each breadcrumb as seg, i (i)}
				<span class="text-(--admin-text-faint)">/</span>
				<button
					type="button"
					onclick={() => jumpTo(i)}
					class="rounded-md px-1.5 py-0.5 font-medium transition-colors {i === breadcrumb.length - 1 ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
				>
					{seg}
				</button>
			{/each}
			{#if dragDepth === 0}
				<span class="ml-auto hidden text-[11px] text-(--admin-text-faint) lg:inline">
					拖拽图片到页面任意位置 / Ctrl+V 粘贴，即可上传到当前位置
				</span>
			{/if}
		</div>

		<!-- 存储目标切换 -->
		<div class="flex shrink-0 rounded-xl border border-(--admin-line) bg-(--admin-panel) p-1">
			<button
				type="button"
				onclick={() => pickStorage("local")}
				class="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors {storage === 'local' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
			>
				本地项目
			</button>
			<button
				type="button"
				onclick={() => pickStorage("cfbed")}
				class="rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors {storage === 'cfbed' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'} {!cfbedConfigured ? 'opacity-50' : ''}"
				title={!cfbedConfigured ? "未配置 cfbed 图床" : "CloudFlare ImgBed"}
			>
				图床 {#if !cfbedConfigured}<span class="ml-0.5 text-[10px] opacity-70">未配置</span>{/if}
			</button>
		</div>

		{#if storage === "local"}
			<!-- 本地图片根：文章协同图片（./images/...）或站点静态图片（/images/...） -->
			<div class="flex shrink-0 rounded-xl border border-(--admin-line) bg-(--admin-panel) p-1">
				<button
					type="button"
					onclick={() => pickLocalRoot("content")}
					class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors {localRoot === 'content' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
					title="src/content/posts/images，markdown 中以 ./images/... 引用"
				>
					文章图片 ./images
				</button>
				<button
					type="button"
					onclick={() => pickLocalRoot("public")}
					class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors {localRoot === 'public' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
					title="public/images，站点中以 /images/... 引用"
				>
					站点图片 /images
				</button>
			</div>
		{/if}
	</div>

	<!-- 第二行：上传 / 搜索 -->
	<div class="mb-4 flex flex-wrap items-center gap-3">
		<!-- 上传按钮：点开弹窗，内含上传目标 / 命名方式 / 选文件 -->
		<button
			type="button"
			class="admin-btn admin-btn-primary"
			title="选择图片库与命名方式后上传"
			onclick={openUploadModal}
		>
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M9 16v-6H5l7-7 7 7h-4v6zm-4 2h14v2H5z"></path></svg>
			上传图片
		</button>

		<span class="flex-1"></span>
		<div class="relative">
			<svg viewBox="0 0 24 24" fill="currentColor" class="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-(--admin-text-faint)"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14"></path></svg>
			<input
				type="search"
				placeholder="搜索文件名…"
				bind:value={search}
				oninput={onSearchInput}
				class="admin-input w-44 !py-1.5 !pl-8 text-xs"
			/>
		</div>
		<span class="rounded-lg bg-(--admin-soft) px-2.5 py-1 text-xs font-medium text-(--admin-text)">
			共 {total} 张
		</span>
	</div>

	{#if notice}
		<div class="admin-alert admin-alert-warn-soft mb-4 !text-xs">{notice}</div>
	{/if}

	{#if loading}
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
			{#each Array(10) as _, i (i)}
				<div class="aspect-square animate-pulse rounded-2xl bg-(--admin-soft)"></div>
			{/each}
		</div>
	{:else if loadError}
		<div class="admin-alert admin-alert-danger">{loadError}</div>
	{:else if images.length === 0 && subfolders.length === 0}
		<div class="admin-panel flex flex-col items-center justify-center gap-2 p-12 text-center text-(--admin-text-faint)">
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-9 w-9 opacity-40"><path d="M21 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-5 3.5A1.5 1.5 0 1 1 14.5 10 1.5 1.5 0 0 1 16 8.5M5 16l4.5-6 3 4 2-2.5L19 16z" opacity="0.4"></path></svg>
			<p class="text-sm">
				{search ? "没有匹配的图片" : "当前目录还没有图片"}
			</p>
			<p class="text-xs">拖拽 / 粘贴 / 点击「上传图片」，文件会传到上面显示的位置</p>
		</div>
	{:else}
		<!-- 子文件夹 -->
		{#if subfolders.length > 0}
			<div class="mb-4 flex flex-wrap gap-2.5">
				{#each subfolders as sub (sub)}
					<button
						type="button"
						onclick={() => openFolder(folder ? `${folder}/${sub}` : sub)}
						class="group flex items-center gap-2 rounded-xl border border-(--admin-line) bg-(--admin-panel) px-3.5 py-2 text-xs transition-all hover:-translate-y-0.5 hover:border-(--admin-accent)/50 hover:shadow-md"
					>
						<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4 text-(--admin-accent-hover)"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"></path></svg>
						<span class="font-medium text-(--admin-text-strong)">{sub}</span>
						<svg viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5 text-(--admin-text-faint) transition-transform group-hover:translate-x-0.5"><path d="M10 17 15 12 10 7z"></path></svg>
					</button>
				{/each}
			</div>
		{/if}

		<!-- 图片网格 -->
		{#if images.length > 0}
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
				{#each images as img (img.name)}
					<figure class="group relative overflow-hidden rounded-2xl border border-(--admin-line) bg-(--admin-bg)">
						<button
							type="button"
							class="block aspect-square w-full cursor-zoom-in overflow-hidden"
							onclick={() => (lightbox = img)}
							title="点击放大预览"
						>
							<img
								src={img.previewUrl}
								alt={img.name}
								loading="lazy"
								class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
							/>
						</button>
						<!-- 悬浮操作 -->
						<div class="absolute inset-x-0 top-0 flex justify-end gap-1.5 bg-gradient-to-b from-black/45 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
							<button
								type="button"
								onclick={() => void copyUrl(img)}
								class="rounded-lg bg-black/45 p-1.5 text-white backdrop-blur transition-colors hover:bg-black/65"
								title="复制引用地址"
							>
								{#if copied === img.name}
									<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"></path></svg>
								{:else}
									<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z"></path></svg>
								{/if}
							</button>
							<button
								type="button"
								onclick={() => (pendingDelete = img)}
								class="rounded-lg bg-black/45 p-1.5 text-white backdrop-blur transition-colors hover:bg-red-500"
								title="删除"
							>
								<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6z"></path></svg>
							</button>
						</div>
						<figcaption class="min-w-0 px-3 py-2">
							<p class="truncate text-[11px] text-(--admin-text)" title={img.name}>{baseName(img.name)}</p>
							<p class="mt-0.5 text-[10px] text-(--admin-text-faint)">
								{fmtSize(img.size)}{img.time ? ` · ${fmtTime(img.time)}` : ""}
							</p>
						</figcaption>
					</figure>
				{/each}
			</div>
			{#if images.length < total}
				<div class="mt-5 text-center">
					<button
						type="button"
						disabled={loadingMore}
						onclick={() => void loadMore()}
						class="admin-btn-ghost text-sm {loadingMore ? 'opacity-60' : ''}"
					>
						{loadingMore ? "加载中…" : "加载更多"}
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</div>
