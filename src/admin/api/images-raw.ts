/**
 * /api/admin/image-raw —— 直接读取本地图片字节并流式返回（供后台预览用）
 *
 * 本地 public 根图片站点以 /images/... 公开访问，无需此接口；
 * 但文章协同图片根（src/content/posts/images，markdown 中以 ./images/... 引用）
 * 在后台路由 /admin/... 下没有公开 URL，如果用相对地址会解析到错误位置、图片不显示
 * （典型表现：avif 等 content 根图片在图片管理 / 插入图片里加载不出来）。
 * 这里按 root + name 从磁盘读取并带上正确 Content-Type 返回，作为后台预览地址。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { APIRoute } from "astro";
import { requireApiSession } from "../lib/auth";
import { errorResponse } from "../lib/http";

const LOCAL_ROOT = "public/images";
const CONTENT_IMAGES_ROOT = "src/content/posts/images";

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

function safeName(name: string): string | null {
	const norm = path.posix.normalize(name.replace(/\\/g, "/"));
	if (
		!norm ||
		norm.startsWith("..") ||
		norm.startsWith("/") ||
		norm.includes("\0")
	)
		return null;
	return norm;
}

export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const sp = Astro.url.searchParams;
	const root = sp.get("root") === "content" ? "content" : "public";
	const name = safeName(sp.get("name") ?? "");
	if (!name) return errorResponse("非法的图片名", 400);
	const abs = path.join(
		process.cwd(),
		root === "content" ? CONTENT_IMAGES_ROOT : LOCAL_ROOT,
		name,
	);
	try {
		const buf = await fs.readFile(abs);
		return new Response(new Uint8Array(buf), {
			headers: {
				"content-type": mimeFromExt(name),
				"cache-control": "private, max-age=3600",
			},
		});
	} catch {
		return errorResponse("图片不存在", 404);
	}
};
