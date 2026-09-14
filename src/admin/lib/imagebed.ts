/**
 * 图片管理数据层：两种存储目标
 *   - "cfbed"：CloudFlare ImgBed（cfbed）图床 API
 *       上传 POST /upload；列表 GET /api/manage/list；删除 POST /api/manage/delete/batch
 *       文档：https://cfbed.sanyue.de/api/
 *   - "local"：上传到本地项目 public/images/（站点以 /images/... 引用）。
 *       本地开发直接读写文件系统；线上 GitHub 模式通过 GitHub Contents API
 *       写入仓库（保存即 commit）。图床地址与 API Token 由 .env 的
 *       ADMIN_IMGBED_URL / ADMIN_IMGBED_TOKEN 提供，本地模式始终可用。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { adminConfig, resolveBackendMode } from "../config";
import { githubFetch } from "./auth";
import {
	getRepoToken,
	ghDeleteFile,
	ghListTree,
	ghWriteFileBinary,
} from "./gh";
import { safeErrorMessage } from "./http";

export class ImgbedError extends Error {}

export type ImgbedImage = {
	/** 存储内路径（删除接口用），如 "posts/2025/a.jpg" 或 "2026/pic.png" */
	name: string;
	/** 引用地址：cfbed 为完整外链，local 为站点相对路径 /images/... 或 ./images/... */
	url: string;
	/**
	 * 后台预览地址：public/cfbed 直接用 url（绝对或外链）；
	 * content 根因为 ./images/... 在后台路由下解析不到正确位置，改为走
	 * /api/admin/image-raw 读磁盘返回，保证 avif 等图片能正常预览。
	 * 插入 markdown 时仍用 url（相对引用），previewUrl 仅用于后台 <img> 显示。
	 */
	previewUrl: string;
	/** local 模式下的根：public=public/images（引用 /images/...），content=src/content/posts/images（引用 ./images/...） */
	root?: "public" | "content";
	mime: string;
	size: number;
	/** ISO 时间 */
	time: string;
};

export type ImageStorage = "local" | "cfbed";

/** 上传命名方式（对齐 cfbed uploadNameType 四种） */
export type ImageNameType = "default" | "index" | "origin" | "short";

export type ImageListResult = {
	images: ImgbedImage[];
	total: number;
	/** 当前目录下（任意深度）的所有子文件夹路径 */
	folders: string[];
};

/* ------------------------------ cfbed 图床 ------------------------------ */

export function resolveImageBed(): { url: string; token: string } | null {
	const { url, token } = adminConfig.imageBed;
	if (!url || !token) return null;
	return { url: url.replace(/\/+$/, ""), token };
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

/** 图床的 TimeStamp 是毫秒时间戳字符串 */
function timestampToIso(v: unknown): string {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return "";
	return new Date(n).toISOString();
}

type ImgbedRawFile = { name?: string; metadata?: Record<string, unknown> };

/** 向图床请求一页原始列表（recursive=true，可能包含任意层级的子目录文件） */
async function fetchImgbedPage(
	bed: { url: string; token: string },
	opts: { start: number; count: number; folder: string; search?: string },
): Promise<{ files: ImgbedRawFile[]; directories: string[] }> {
	const params = new URLSearchParams({
		start: String(opts.start),
		count: String(opts.count),
		recursive: "true",
		fileType: "image",
	});
	if (opts.folder) params.set("dir", opts.folder);
	if (opts.search) params.set("search", opts.search);
	let res: Response;
	try {
		res = await githubFetch(`${bed.url}/api/manage/list?${params}`, {
			headers: authHeaders(bed.token),
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		throw new ImgbedError("无法连接图床服务");
	}
	if (res.status === 401 || res.status === 403)
		throw new ImgbedError("图床 Token 无效或缺少 list 权限");
	if (!res.ok) throw new ImgbedError(`图床列表接口错误（${res.status}）`);
	const json = (await res.json().catch(() => null)) as {
		files?: ImgbedRawFile[];
		directories?: string[];
	} | null;
	return {
		files: Array.isArray(json?.files) ? (json.files as ImgbedRawFile[]) : [],
		directories: Array.isArray(json?.directories) ? json.directories : [],
	};
}

/**
 * 列出图床「当前目录」的图片。
 *
 * 图床 list 接口固定 recursive=true，一次返回所有层级的文件，且分页偏移基于
 * 这个**未过滤**的结果集。因此必须先把结果集取全，在本地过滤出直属文件后再
 * 分页——否则：① 根目录会把子目录里的图片一并显示出来；② 前端按已过滤条数
 * 递增 start，会与图床偏移错位导致翻页漏图/重复。
 */
async function imgbedList(opts: {
	start?: number;
	count?: number;
	search?: string;
	folder?: string;
}): Promise<ImageListResult> {
	const bed = resolveImageBed();
	if (!bed)
		throw new ImgbedError(
			"未配置图床（.env 的 ADMIN_IMGBED_URL / ADMIN_IMGBED_TOKEN）",
		);
	const start = Math.max(0, Math.floor(opts.start ?? 0));
	const count = Math.min(Math.max(1, Math.floor(opts.count ?? 40)), 200);
	const folder = normalizeFolder(opts.folder);

	// 单次请求上限 200；总量上限仅作极端情况下的保护
	const CHUNK = 200;
	const MAX_FILES = 5000;
	const raw: ImgbedRawFile[] = [];
	const directories: string[] = [];
	for (let offset = 0; offset < MAX_FILES; offset += CHUNK) {
		const page = await fetchImgbedPage(bed, {
			start: offset,
			count: CHUNK,
			folder,
			search: opts.search,
		});
		raw.push(...page.files);
		directories.push(...page.directories);
		if (page.files.length < CHUNK) break; // 已取完
	}

	// 子目录集合：响应的 directories + 文件路径前缀，统一折算为相对当前目录
	const folderSet = new Set<string>();
	for (const dir of directories) {
		if (typeof dir !== "string" || !dir) continue;
		const rel = stripFolderPrefix(dir, folder);
		if (rel) folderSet.add(rel);
	}

	// 不同版本在 dir 参数下可能返回根相对或目录相对路径，由 stripFolderPrefix
	// 自适应识别；只保留当前目录的直属文件，子目录内容通过文件夹卡片进入
	const images: ImgbedImage[] = [];
	for (const f of raw) {
		if (typeof f.name !== "string" || !f.name) continue;
		const rel = stripFolderPrefix(f.name, folder);
		const slash = rel.lastIndexOf("/");
		if (slash >= 0) {
			folderSet.add(rel.slice(0, slash));
			continue;
		}
		const meta = f.metadata ?? {};
		images.push({
			name: f.name,
			url: `${bed.url}/file/${f.name}`,
			previewUrl: `${bed.url}/file/${f.name}`,
			mime: String(meta["File-Mime"] ?? ""),
			size: Number(meta["File-Size"] ?? 0) || 0,
			time: timestampToIso(meta.TimeStamp),
		});
	}

	return {
		images: images.slice(start, start + count),
		total: images.length,
		folders: [...folderSet].filter(Boolean).sort(),
	};
}

/** 把目录路径折算为相对当前 folder 的路径（不同版本响应可能带/不带目录前缀） */
function stripFolderPrefix(dir: string, folder: string): string {
	const norm = dir.replace(/\\/g, "/").replace(/^\/|\/$/g, "");
	if (!folder) return norm;
	return norm.startsWith(`${folder}/`) ? norm.slice(folder.length + 1) : norm;
}

/**
 * 手工构造 multipart/form-data（Blob）：避免 undici fetch 与全局
 * FormData 的类品牌不兼容问题。
 */
function multipartBody(
	buffer: ArrayBuffer,
	filename: string,
	contentType: string,
	boundary: string,
): Blob {
	const enc = new TextEncoder();
	const safeName = filename.replace(/[\r\n"]/g, "") || "image";
	const head =
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
		`Content-Type: ${contentType}\r\n\r\n`;
	const tail = `\r\n--${boundary}--\r\n`;
	return new Blob(
		[enc.encode(head), new Uint8Array(buffer), enc.encode(tail)],
		{
			type: `multipart/form-data; boundary=${boundary}`,
		},
	);
}

async function imgbedUpload(
	file: { buffer: ArrayBuffer; filename: string; contentType: string },
	opts: { nameType?: ImageNameType; folder?: string } = {},
): Promise<ImgbedImage> {
	const bed = resolveImageBed();
	if (!bed)
		throw new ImgbedError(
			"未配置图床（.env 的 ADMIN_IMGBED_URL / ADMIN_IMGBED_TOKEN）",
		);
	const boundary = `----FireflyAdmin${Date.now()}${Math.random().toString(36).slice(2)}`;
	const query = new URLSearchParams();
	if (opts.nameType) query.set("uploadNameType", opts.nameType);
	const folder = normalizeFolder(opts.folder);
	if (folder) query.set("uploadFolder", folder);
	let res: Response;
	try {
		res = await githubFetch(
			`${bed.url}/upload${query.size ? `?${query}` : ""}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${bed.token}`,
					"content-type": `multipart/form-data; boundary=${boundary}`,
				},
				body: multipartBody(
					file.buffer,
					file.filename,
					file.contentType,
					boundary,
				),
				signal: AbortSignal.timeout(60000),
			},
		);
	} catch {
		throw new ImgbedError("无法连接图床服务");
	}
	if (res.status === 401 || res.status === 403)
		throw new ImgbedError("图床 Token 无效或缺少 upload 权限");
	if (!res.ok) {
		let detail = "";
		try {
			const text = await res.text();
			detail = text.slice(0, 200);
		} catch {}
		throw new ImgbedError(
			`图床上传失败（${res.status}）${detail ? `：${detail}` : ""}`,
		);
	}
	const json = (await res.json().catch(() => null)) as
		| Array<{ src?: string }>
		| { src?: string }
		| null;
	const src = Array.isArray(json) ? json[0]?.src : json?.src;
	if (!src) throw new ImgbedError("图床未返回文件地址");
	return {
		name: src.replace(/^\/file\//, ""),
		url: `${bed.url}${src.startsWith("/") ? "" : "/"}${src}`,
		previewUrl: `${bed.url}${src.startsWith("/") ? "" : "/"}${src}`,
		mime: file.contentType,
		size: file.buffer.byteLength,
		time: new Date().toISOString(),
	};
}

async function imgbedDelete(fileIds: string[]): Promise<{
	deleted: string[];
	failed: Array<{ fileId: string; error: string }>;
}> {
	const bed = resolveImageBed();
	if (!bed)
		throw new ImgbedError(
			"未配置图床（.env 的 ADMIN_IMGBED_URL / ADMIN_IMGBED_TOKEN）",
		);
	let res: Response;
	try {
		res = await githubFetch(`${bed.url}/api/manage/delete/batch`, {
			method: "POST",
			headers: {
				...authHeaders(bed.token),
				"content-type": "application/json",
			},
			body: JSON.stringify({ fileIds }),
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		throw new ImgbedError("无法连接图床服务");
	}
	if (res.status === 401 || res.status === 403)
		throw new ImgbedError("图床 Token 无效或缺少 delete 权限");
	if (!res.ok) throw new ImgbedError(`图床删除接口错误（${res.status}）`);
	const json = (await res.json().catch(() => ({}))) as {
		deleted?: string[];
		failed?: Array<{ fileId?: string; error?: string }>;
	};
	return {
		deleted: json.deleted ?? [],
		failed: (json.failed ?? []).map((f) => ({
			fileId: f.fileId ?? "",
			error: f.error ?? "删除失败",
		})),
	};
}

/* ------------------------- 本地项目 public/images ------------------------- */

const LOCAL_ROOT = "public/images";
/** 文章协同图片根目录：markdown 中以 ./images/... 相对引用（Astro 内容集合资源） */
const CONTENT_IMAGES_ROOT = "src/content/posts/images";
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/i;

function localRootAbs(): string {
	return path.join(process.cwd(), LOCAL_ROOT);
}

function contentImagesAbs(): string {
	return path.join(process.cwd(), CONTENT_IMAGES_ROOT);
}

/** 规范化本地相对路径，防目录穿越；非法返回 null */
function safeLocalName(rel: string): string | null {
	const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
	if (
		!norm ||
		norm.startsWith("..") ||
		norm.startsWith("/") ||
		norm.includes("\0")
	)
		return null;
	return norm;
}

function mimeFromExt(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		avif: "image/avif",
		svg: "image/svg+xml",
		bmp: "image/bmp",
		ico: "image/x-icon",
		tif: "image/tiff",
		tiff: "image/tiff",
	};
	return map[ext] ?? "application/octet-stream";
}

async function walkLocal(dir: string, base = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const rel = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...(await walkLocal(path.join(dir, entry.name), rel)));
		} else if (entry.isFile() && IMAGE_EXT_RE.test(entry.name)) {
			out.push(rel);
		}
	}
	return out;
}

function normalizeFolder(folder?: string): string {
	return (folder ?? "").replace(/\\/g, "/").replace(/^\/|\/$/g, "");
}

/** 时间戳前缀（本地 default / index 命名用） */
function tsPrefix(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 短链接名（本地 short 命名用） */
function shortId(): string {
	return (
		Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4)
	);
}

/**
 * 上传到本地时的安全文件名：按命名方式生成，非 ASCII 转 pinyin、
 * 去危险字符、重名自动加后缀。
 */
async function safeUploadName(
	filename: string,
	nameType: ImageNameType = "origin",
): Promise<string> {
	const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png").toLowerCase();
	let base = filename
		.slice(0, filename.length - ext.length)
		.replace(/[\r\n"\\/:*?<>|]+/g, " ")
		.trim();
	if (/[^\x20-\x7e]/.test(base)) {
		try {
			const { pinyin } = await import("pinyin-pro");
			base = base
				.replace(/[^\x20-\x7e]+/g, (seg) => {
					const cjk = seg.replace(/[^\u4e00-\u9fff]+/g, " ").trim();
					if (!cjk) return "-";
					// 每段中文整体转拼音（type:array 逐字返回），全部拼接
					return cjk
						.split(/\s+/)
						.map(
							(word) =>
								pinyin(word, { toneType: "none", type: "array" }).join("-") ??
								word,
						)
						.join("-");
				})
				.trim();
		} catch {
			base = base.replace(/[^\x20-\x7e]/g, "");
		}
	}
	base = base
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	// 命名方式（对齐 cfbed 四种）：default=前缀_原名，index=仅前缀，origin=仅原名，short=短链接
	if (nameType === "default") {
		base = base ? `${tsPrefix()}_${base}` : tsPrefix();
	} else if (nameType === "index") {
		base = tsPrefix();
	} else if (nameType === "short") {
		base = shortId();
	} else if (!base) {
		base = `image-${Date.now()}`;
	}
	const root = localRootAbs();
	let name = `${base}${ext}`;
	for (let i = 2; i < 100; i++) {
		try {
			await fs.access(path.join(root, name));
			name = `${base}-${i}${ext}`;
		} catch {
			return name;
		}
	}
	return `${base}-${Date.now()}${ext}`;
}

async function localList(
	opts: {
		start?: number;
		count?: number;
		search?: string;
		folder?: string;
		root?: "public" | "content";
	},
	sessionToken?: string,
): Promise<ImageListResult> {
	const start = Math.max(0, Math.floor(opts.start ?? 0));
	const count = Math.min(Math.max(1, Math.floor(opts.count ?? 40)), 200);
	const search = (opts.search ?? "").toLowerCase();
	const folder = normalizeFolder(opts.folder);
	const prefix = folder ? `${folder}/` : "";
	const images: ImgbedImage[] = [];
	const folderSet = new Set<string>();

	if (resolveBackendMode() === "github") {
		// 线上模式：列出仓库里 public/images 下的图片
		const token = getRepoToken(sessionToken);
		const ghPrefix = `${LOCAL_ROOT}/`;
		const entries = await ghListTree(token);
		for (const e of entries) {
			if (e.type !== "blob" || !e.path.startsWith(ghPrefix)) continue;
			if (!IMAGE_EXT_RE.test(e.path)) continue;
			const name = e.path.slice(ghPrefix.length);
			if (folder && !name.startsWith(prefix)) continue;
			const rel = folder ? name.slice(prefix.length) : name;
			const slash = rel.lastIndexOf("/");
			if (slash >= 0) folderSet.add(rel.slice(0, slash));
			if (rel.includes("/")) continue;
			if (search && !name.toLowerCase().includes(search)) continue;
			images.push({
				name,
				url: `/images/${name}`,
				previewUrl: `/images/${name}`,
				mime: mimeFromExt(name),
				size: e.size ?? 0,
				time: "",
			});
		}
		images.sort((a, b) => a.name.localeCompare(b.name));
	} else {
		// 同时扫描 public/images（引用 /images/...）与 src/content/posts/images（引用 ./images/...）
		const allRoots = [
			{ abs: localRootAbs(), urlBase: "/images/", root: "public" as const },
			{
				abs: contentImagesAbs(),
				urlBase: "./images/",
				root: "content" as const,
			},
		];
		const roots =
			opts.root === "content"
				? allRoots.filter((r) => r.root === "content")
				: opts.root === "public"
					? allRoots.filter((r) => r.root === "public")
					: allRoots;
		for (const r of roots) {
			await fs.mkdir(r.abs, { recursive: true });
			const rels = await walkLocal(r.abs);
			for (const name of rels) {
				if (folder && !name.startsWith(prefix)) continue;
				const rel = folder ? name.slice(prefix.length) : name;
				const slash = rel.lastIndexOf("/");
				if (slash >= 0) folderSet.add(rel.slice(0, slash));
				if (rel.includes("/")) continue;
				if (search && !name.toLowerCase().includes(search)) continue;
				const abs = path.join(r.abs, name);
				const stat = await fs.stat(abs);
				images.push({
					name,
					root: r.root,
					url: `${r.urlBase}${name}`,
					// content 根的 ./images/... 在后台路由下解析不到，改用 raw 接口读磁盘预览
					previewUrl:
						r.root === "content"
							? `/api/admin/image-raw/?root=content&name=${encodeURIComponent(name)}`
							: `/images/${name}`,
					mime: mimeFromExt(name),
					size: stat.size,
					time: stat.mtime.toISOString(),
				});
			}
		}
		images.sort((a, b) => b.time.localeCompare(a.time));
	}
	return {
		images: images.slice(start, start + count),
		total: images.length,
		folders: [...folderSet].sort(),
	};
}

async function localUpload(
	file: { buffer: ArrayBuffer; filename: string; contentType: string },
	sessionToken?: string,
	opts: {
		nameType?: ImageNameType;
		folder?: string;
		root?: "public" | "content";
	} = {},
): Promise<ImgbedImage> {
	// 线上 GitHub 模式只写 public/images；本地模式按 root 选目标
	const github = resolveBackendMode() === "github";
	const root = github
		? "public"
		: opts.root === "content"
			? "content"
			: "public";
	const folder = normalizeFolder(opts.folder);
	const base = await safeUploadName(file.filename, opts.nameType);
	const name = folder ? `${folder}/${base}` : base;
	const urlBase = root === "content" ? "./images/" : "/images/";
	const buffer = Buffer.from(file.buffer);
	if (github) {
		await ghWriteFileBinary(
			`${LOCAL_ROOT}/${name}`,
			buffer,
			getRepoToken(sessionToken),
			"upload image",
		);
	} else {
		const abs = path.join(
			root === "content" ? contentImagesAbs() : localRootAbs(),
			name,
		);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, buffer);
	}
	return {
		name,
		root,
		url: `${urlBase}${name}`,
		previewUrl:
			root === "content"
				? `/api/admin/image-raw/?root=content&name=${encodeURIComponent(name)}`
				: `/images/${name}`,
		mime: file.contentType || mimeFromExt(name),
		size: buffer.byteLength,
		time: new Date().toISOString(),
	};
}

async function localDelete(
	fileIds: Array<string | { name: string; root?: "public" | "content" }>,
	sessionToken?: string,
): Promise<{
	deleted: string[];
	failed: Array<{ fileId: string; error: string }>;
}> {
	const deleted: string[] = [];
	const failed: Array<{ fileId: string; error: string }> = [];
	const github = resolveBackendMode() === "github";
	for (const raw of fileIds.slice(0, 500)) {
		const parsed =
			typeof raw === "string"
				? { name: raw, root: "public" as const }
				: {
						name: raw.name,
						root: (raw.root ?? "public") as "public" | "content",
					};
		const name = safeLocalName(parsed.name);
		if (!name) {
			failed.push({ fileId: parsed.name, error: "非法路径" });
			continue;
		}
		try {
			if (github) {
				await ghDeleteFile(`${LOCAL_ROOT}/${name}`, getRepoToken(sessionToken));
			} else {
				const abs =
					parsed.root === "content"
						? path.join(contentImagesAbs(), name)
						: path.join(localRootAbs(), name);
				await fs.unlink(abs);
			}
			deleted.push(name);
		} catch (error) {
			const status = (error as { status?: number }).status;
			// 底层 fs 错误的 message 会带服务器绝对路径，归一化后再返回
			const msg =
				status === 404
					? "文件不存在"
					: error instanceof Error
						? safeErrorMessage(error, "删除失败")
						: "删除失败";
			failed.push({ fileId: parsed.name, error: msg });
		}
	}
	return { deleted, failed };
}

/* ------------------------------ 统一入口 ------------------------------ */

function dispatch<T>(
	storage: ImageStorage,
	cfbed: () => Promise<T>,
	local: () => Promise<T>,
): Promise<T> {
	return storage === "cfbed" ? cfbed() : local();
}

/** 批量删除结果：成功的 id 列表 + 失败项及原因 */
export type ImageDeleteResult = {
	deleted: string[];
	failed: Array<{ fileId: string; error: string }>;
};

export function imageList(
	storage: ImageStorage,
	opts: {
		start?: number;
		count?: number;
		search?: string;
		folder?: string;
		root?: "public" | "content";
	},
	sessionToken?: string,
): Promise<ImageListResult> {
	return dispatch(
		storage,
		() => imgbedList(opts),
		() => localList(opts, sessionToken),
	);
}

export function imageUpload(
	storage: ImageStorage,
	file: { buffer: ArrayBuffer; filename: string; contentType: string },
	sessionToken?: string,
	opts: {
		nameType?: ImageNameType;
		folder?: string;
		root?: "public" | "content";
	} = {},
): Promise<ImgbedImage> {
	return dispatch(
		storage,
		() => imgbedUpload(file, opts),
		() => localUpload(file, sessionToken, opts),
	);
}

export function imageDelete(
	storage: ImageStorage,
	fileIds: Array<string | { name: string; root?: "public" | "content" }>,
	sessionToken?: string,
): Promise<ImageDeleteResult> {
	return dispatch(
		storage,
		() =>
			imgbedDelete(fileIds.map((f) => (typeof f === "string" ? f : f.name))),
		() => localDelete(fileIds, sessionToken),
	);
}
