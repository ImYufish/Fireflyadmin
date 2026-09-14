/**
 * /api/admin/images/ —— 图片管理（本地项目 public/images 与 cfbed 图床）
 *   GET    ?storage=local|cfbed&start=&count=&search=   列出图片
 *   POST   multipart 上传（字段 file，可多张，单次最多 10 张；字段 storage）
 *   DELETE { storage, fileIds: string[] }               批量删除
 */

import type { APIRoute } from "astro";
import { type ResolvedSession, requireApiSession } from "../lib/auth";
import { errorResponse, okResponse, readJsonBody } from "../lib/http";
import {
	type ImageStorage,
	ImgbedError,
	imageDelete,
	imageList,
	imageUpload,
	resolveImageBed,
} from "../lib/imagebed";

function storageParam(value: string | null | undefined): ImageStorage {
	return value === "cfbed" ? "cfbed" : "local";
}

const NAME_TYPES = ["default", "index", "origin", "short"] as const;

function uploadNameType(value: string): (typeof NAME_TYPES)[number] {
	return (NAME_TYPES as readonly string[]).includes(value)
		? (value as (typeof NAME_TYPES)[number])
		: "origin";
}

function sessionTokenOf(session: ResolvedSession): string | undefined {
	return session.token;
}

export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const sp = Astro.url.searchParams;
	const storage = storageParam(sp.get("storage"));
	if (storage === "cfbed" && !resolveImageBed()) {
		return okResponse({
			configured: true,
			cfbedConfigured: false,
			images: [],
			total: 0,
		});
	}
	try {
		const { images, total, folders } = await imageList(
			storage,
			{
				start: Number(sp.get("start") ?? 0) || 0,
				count: Number(sp.get("count") ?? 40) || 40,
				search: sp.get("search") ?? "",
				folder: sp.get("folder") ?? "",
				root:
					sp.get("root") === "content"
						? "content"
						: sp.get("root") === "public"
							? "public"
							: undefined,
			},
			sessionTokenOf(session),
		);
		return okResponse({
			configured: true,
			cfbedConfigured: !!resolveImageBed(),
			storage,
			images,
			total,
			folders,
		});
	} catch (err) {
		const message = err instanceof ImgbedError ? err.message : "加载图片失败";
		return errorResponse(message, 502);
	}
};

export const POST: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	try {
		const form = await Astro.request.formData();
		const storage = storageParam(String(form.get("storage") ?? "local"));
		const nameType = uploadNameType(String(form.get("nameType") ?? "origin"));
		const folder = String(form.get("folder") ?? "");
		const root =
			String(form.get("root") ?? "public") === "content" ? "content" : "public";
		const files = form
			.getAll("file")
			.filter((f): f is File => f instanceof File && f.size > 0)
			.slice(0, 10);
		if (files.length === 0)
			return errorResponse("没有收到文件（表单字段名需为 file）");
		const images = [];
		for (const f of files) {
			const buffer = await f.arrayBuffer();
			images.push(
				await imageUpload(
					storage,
					{
						buffer,
						filename: f.name || "image",
						contentType: f.type || "application/octet-stream",
					},
					sessionTokenOf(session),
					{ nameType, folder, root },
				),
			);
		}
		return okResponse({ images, storage });
	} catch (err) {
		const message = err instanceof ImgbedError ? err.message : "上传图片失败";
		return errorResponse(message, 502);
	}
};

export const DELETE: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const body = await readJsonBody(Astro.request);
	const fileIds = body?.fileIds;
	const validFileId = (id: unknown): boolean =>
		typeof id === "string"
			? id.length > 0
			: typeof id === "object" &&
				id !== null &&
				typeof (id as { name?: unknown }).name === "string" &&
				(id as { name: string }).name.length > 0;
	if (
		!Array.isArray(fileIds) ||
		fileIds.length === 0 ||
		!fileIds.every(validFileId)
	) {
		return errorResponse(
			"缺少 fileIds（字符串数组，或 {name, root} 对象数组）",
		);
	}
	const storage = storageParam(
		typeof body?.storage === "string" ? body.storage : "local",
	);
	try {
		const result = await imageDelete(
			storage,
			fileIds.slice(0, 500) as string[],
			sessionTokenOf(session),
		);
		return okResponse(result);
	} catch (err) {
		const message = err instanceof ImgbedError ? err.message : "删除图片失败";
		return errorResponse(message, 502);
	}
};
