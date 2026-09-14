import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { APIRoute } from "astro";
import matter from "gray-matter";
import { resolveBackendMode } from "../config";
import { requireApiSession } from "../lib/auth";
import {
	errorResponse,
	okResponse,
	readJsonBody,
	safeErrorMessage,
} from "../lib/http";
import {
	isMarkdownFile,
	isTextFile,
	resolveProjectPath,
	sanitizeRelativeSubpath,
} from "../lib/paths";
import { POSTS_DIR, postSlugFromRelPath, postUrlFromSlug } from "../lib/posts";

/** 单文件保存大小上限：4 MB */
const MAX_FILE_SIZE = 4 * 1024 * 1024;

type Mode = "local" | "github";

/** 若为 posts 目录内的 Markdown，返回对应的博客文章 URL（依据 frontmatter slug） */
function postUrlForContent(
	raw: string,
	abs: string,
	rel: string,
): string | null {
	if (!isMarkdownFile(rel)) return null;
	const relInPosts = path
		.relative(path.resolve(process.cwd(), POSTS_DIR), abs)
		.split(path.sep)
		.join("/");
	if (relInPosts.startsWith("..") || path.isAbsolute(relInPosts)) return null;
	let data: Record<string, unknown> = {};
	try {
		data = (matter(raw).data ?? {}) as Record<string, unknown>;
	} catch {
		/* frontmatter 损坏时按默认 slug 规则 */
	}
	return postUrlFromSlug(postSlugFromRelPath(relInPosts, data.slug));
}

/** GET /api/admin/files/file?path=... —— 读取文本文件（meta=1 时只返回元信息） */
export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const resolved = resolveProjectPath(Astro.url.searchParams.get("path"));
	if (!resolved.ok) return errorResponse(resolved.error, 400);
	if (resolved.rel === resolved.root) {
		return errorResponse("请选择具体文件", 400);
	}
	const mode: Mode = resolveBackendMode();

	let stat: { size: number; mtime: number };
	let content: string | null = null;
	if (mode === "github") {
		const { getRepoToken, ghReadFile } = await import("../lib/gh");
		try {
			const gh = await ghReadFile(resolved.rel, getRepoToken(session.token));
			content = gh.content;
			stat = { size: gh.size, mtime: 0 };
		} catch (error) {
			const status =
				typeof (error as { status?: number }).status === "number"
					? (error as { status: number }).status
					: 500;
			if (status === 404) return errorResponse("文件不存在", 404);
			return errorResponse(
				error instanceof Error ? error.message : "读取文件失败",
				status >= 400 && status < 600 ? status : 500,
			);
		}
	} else {
		let fsStat: Stats;
		try {
			fsStat = await fs.stat(resolved.abs);
		} catch {
			return errorResponse("文件不存在", 404);
		}
		if (!fsStat.isFile()) return errorResponse("目标不是文件", 400);
		stat = { size: fsStat.size, mtime: Math.round(fsStat.mtimeMs) };
		// 文本文件始终读取内容：meta 模式也需要它计算 postUrl（只是不返回给客户端）
		if (isTextFile(resolved.abs)) {
			try {
				content = await fs.readFile(resolved.abs, "utf-8");
			} catch {
				return errorResponse("读取文件失败", 500);
			}
		}
	}

	const isText = isTextFile(resolved.abs);
	const meta = {
		path: resolved.rel,
		size: stat.size,
		mtime: stat.mtime,
		isText,
		mode,
		postUrl:
			isText && content !== null
				? postUrlForContent(content, resolved.abs, resolved.rel)
				: null,
	};
	if (Astro.url.searchParams.get("meta") === "1") {
		return okResponse(meta);
	}
	if (!isText) {
		return errorResponse(
			"二进制文件不支持在线编辑，可在文件树中重命名或删除",
			415,
		);
	}
	if (content === null) {
		try {
			content = await fs.readFile(resolved.abs, "utf-8");
		} catch {
			return errorResponse("读取文件失败", 500);
		}
	}
	return okResponse({ ...meta, content });
};

/** POST /api/admin/files/file —— 文件写操作 { action: save|create|rename|delete } */
export const POST: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const body = await readJsonBody(Astro.request);
	if (!body) return errorResponse("请求格式错误", 400);

	try {
		switch (body.action) {
			case "save":
				return await handleSave(body, session.token);
			case "create":
				return await handleCreate(body, session.token);
			case "rename":
				return await handleRename(body, session.token);
			case "delete":
				return await handleDelete(body, session.token);
			default:
				return errorResponse("未知的操作类型", 400);
		}
	} catch (error) {
		const status =
			typeof (error as { status?: number }).status === "number"
				? (error as { status: number }).status
				: 500;
		return errorResponse(
			safeErrorMessage(error),
			status >= 400 && status < 600 ? status : 500,
		);
	}
};

async function handleSave(
	body: Record<string, unknown>,
	repoToken?: string,
): Promise<Response> {
	const resolved = resolveProjectPath(body.path);
	if (!resolved.ok) return errorResponse(resolved.error, 400);
	if (resolved.rel === resolved.root) {
		return errorResponse("请选择具体文件", 400);
	}
	if (typeof body.content !== "string") {
		return errorResponse("缺少文件内容", 400);
	}
	if (Buffer.byteLength(body.content, "utf-8") > MAX_FILE_SIZE) {
		return errorResponse("文件过大（上限 4 MB）", 413);
	}
	if (!isTextFile(resolved.abs)) {
		return errorResponse("二进制文件不支持在线编辑", 415);
	}
	if (resolveBackendMode() === "github") {
		const { getRepoToken, ghWriteFile } = await import("../lib/gh");
		const result = await ghWriteFile(
			resolved.rel,
			body.content,
			getRepoToken(repoToken),
			"update",
		);
		return okResponse({ path: resolved.rel, mtime: Date.now(), ...result });
	}
	let stat: Stats;
	try {
		stat = await fs.stat(resolved.abs);
	} catch {
		return errorResponse("文件不存在，请使用「新建文件」操作", 404);
	}
	if (!stat.isFile()) return errorResponse("目标不是文件", 400);
	await fs.writeFile(resolved.abs, body.content, "utf-8");
	const newStat = await fs.stat(resolved.abs);
	return okResponse({ path: resolved.rel, mtime: Math.round(newStat.mtimeMs) });
}

async function handleCreate(
	body: Record<string, unknown>,
	repoToken?: string,
): Promise<Response> {
	const resolved = resolveProjectPath(body.path);
	if (!resolved.ok) return errorResponse(resolved.error, 400);
	if (resolved.rel === resolved.root) {
		return errorResponse("请提供具体路径", 400);
	}
	const isDir = body.type === "dir";
	const subpath = sanitizeRelativeSubpath(resolved.rel);
	if (!subpath) {
		return errorResponse(
			"路径包含非法字符（不允许隐藏文件、.. 或特殊字符）",
			400,
		);
	}
	const abs = path.resolve(process.cwd(), subpath);

	if (resolveBackendMode() === "github") {
		const { getRepoToken, ghWriteFile } = await import("../lib/gh");
		if (isDir) {
			return errorResponse(
				"GitHub 仓库不支持空目录：请直接在需要的位置创建文件（会自动创建所在目录）",
				400,
			);
		}
		const content = typeof body.content === "string" ? body.content : "";
		const result = await ghWriteFile(
			subpath,
			content,
			getRepoToken(repoToken),
			"create",
		);
		return okResponse({ path: subpath, ...result });
	}

	try {
		const existing = await fs.stat(abs);
		return errorResponse(
			existing.isDirectory() && isDir ? "目录已存在" : "文件已存在",
			409,
		);
	} catch {
		/* 不存在，继续创建 */
	}
	if (isDir) {
		await fs.mkdir(abs, { recursive: true });
	} else {
		await fs.mkdir(path.dirname(abs), { recursive: true });
		const content = typeof body.content === "string" ? body.content : "";
		await fs.writeFile(abs, content, "utf-8");
	}
	return okResponse({ path: subpath });
}

async function handleRename(
	body: Record<string, unknown>,
	repoToken?: string,
): Promise<Response> {
	const from = resolveProjectPath(body.from);
	const to = resolveProjectPath(body.to);
	if (!from.ok) return errorResponse(from.error, 400);
	if (!to.ok) return errorResponse(to.error, 400);
	if (from.rel === from.root || to.rel === to.root) {
		return errorResponse("不能重命名根目录", 400);
	}
	const toSubpath = sanitizeRelativeSubpath(to.rel);
	if (!toSubpath) {
		return errorResponse("新路径包含非法字符", 400);
	}
	if (resolveBackendMode() === "github") {
		const { getRepoToken, ghRenameFile } = await import("../lib/gh");
		await ghRenameFile(from.rel, toSubpath, getRepoToken(repoToken));
		return okResponse({ path: toSubpath });
	}
	const fromAbs = from.abs;
	const toAbs = path.resolve(process.cwd(), toSubpath);
	if (fromAbs === toAbs) return okResponse({ path: toSubpath });
	try {
		await fs.access(fromAbs);
	} catch {
		return errorResponse("原路径不存在", 404);
	}
	try {
		await fs.access(toAbs);
		return errorResponse("目标路径已存在", 409);
	} catch {
		/* 目标不存在，可以重命名 */
	}
	await fs.mkdir(path.dirname(toAbs), { recursive: true });
	await fs.rename(fromAbs, toAbs);
	return okResponse({ path: toSubpath });
}

async function handleDelete(
	body: Record<string, unknown>,
	repoToken?: string,
): Promise<Response> {
	const resolved = resolveProjectPath(body.path);
	if (!resolved.ok) return errorResponse(resolved.error, 400);
	if (resolved.rel === resolved.root) {
		return errorResponse("不能删除根目录", 400);
	}

	if (resolveBackendMode() === "github") {
		const { getRepoToken, ghDeleteDir, ghDeleteFile } = await import(
			"../lib/gh"
		);
		const token = getRepoToken(repoToken);
		const looksLikeDir = !path.extname(resolved.rel);
		if (looksLikeDir) {
			await ghDeleteDir(resolved.rel, token);
		} else {
			await ghDeleteFile(resolved.rel, token);
		}
		return okResponse({ path: resolved.rel });
	}

	let stat: Stats;
	try {
		stat = await fs.stat(resolved.abs);
	} catch {
		return errorResponse("路径不存在", 404);
	}
	if (stat.isDirectory() && body.recursive !== true) {
		// 非递归模式：仅允许删除空目录
		try {
			await fs.rmdir(resolved.abs);
		} catch {
			return errorResponse("目录非空，请确认后选择递归删除", 409);
		}
		return okResponse({ path: resolved.rel });
	}
	await fs.rm(resolved.abs, {
		recursive: stat.isDirectory(),
		force: false,
	});
	return okResponse({ path: resolved.rel });
}
