import fs from "node:fs/promises";
import path from "node:path";
import type { APIRoute } from "astro";
import { resolveBackendMode } from "../config";
import { requireApiSession } from "../lib/auth";
import { errorResponse, okResponse, readJsonBody } from "../lib/http";
import { sanitizeRelativeSubpath } from "../lib/paths";
import {
	listPosts,
	newPostContent,
	POSTS_DIR,
	slugifyFilename,
	writeNewPost,
} from "../lib/posts";

/** GET /api/admin/posts —— 全部文章列表（含草稿） */
export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const posts = await listPosts();
	return okResponse({ posts });
};

/** POST /api/admin/posts —— 新建文章 { filename?, title?, draft? } */
export const POST: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const body = await readJsonBody(Astro.request);
	if (!body) return errorResponse("请求格式错误", 400);

	const title =
		typeof body.title === "string" && body.title.trim()
			? body.title.trim()
			: "无标题";
	const draft = body.draft !== false;
	let filename = typeof body.filename === "string" ? body.filename.trim() : "";
	if (!filename) {
		// 未指定文件名时由标题生成拼音 slug（slugifyFilename 返回不带扩展名的路径）
		const baseSlug = await slugifyFilename(title);
		if (!baseSlug)
			return errorResponse("无法从标题生成文件名，请手动填写", 400);
		filename = `${baseSlug}.md`;
	}
	const subpath = sanitizeRelativeSubpath(filename);
	if (!subpath) {
		return errorResponse("文件名包含非法字符", 400);
	}
	if (!/\.(md|mdx)$/i.test(subpath)) {
		return errorResponse("文件名必须以 .md 或 .mdx 结尾", 400);
	}
	const slug = await slugifyFilename(subpath);
	if (!slug) return errorResponse("无法生成有效的文章 slug", 400);
	const relInPosts = subpath.split(path.sep).join("/");
	// 本地模式检查重名；GitHub 模式由 API 侧禁止覆盖（带 sha 更新时才会覆盖）
	if (resolveBackendMode() === "local") {
		const abs = path.resolve(process.cwd(), POSTS_DIR, subpath);
		try {
			await fs.access(abs);
			return errorResponse(`文件已存在：${POSTS_DIR}/${relInPosts}`, 409);
		} catch {
			/* 不存在，继续创建 */
		}
	}
	const content = newPostContent(title, slug, draft);
	const result = await writeNewPost(relInPosts, content);
	return okResponse({
		path: `${POSTS_DIR}/${relInPosts}`,
		url: `/posts/${slug}/`,
		...result,
	});
};
