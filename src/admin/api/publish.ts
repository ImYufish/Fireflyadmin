import type { APIRoute } from "astro";
import { resolveBackendMode, resolveGithubRepo } from "../config";
import { requireApiSession } from "../lib/auth";
import { errorResponse, okResponse, readJsonBody } from "../lib/http";
import { resolveProjectPath } from "../lib/paths";

/** 单次发布文件数上限 */
const MAX_CHANGES = 100;

/**
 * POST /api/admin/publish/ —— 把草稿暂存的多文件修改**一次性**提交为单个
 * commit（Git Data API）。仅线上（github 后端）模式可用。
 *
 * body: { changes: [{ path, content?, delete? }], message? }
 */
export const POST: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	if (resolveBackendMode() !== "github") {
		return errorResponse("仅在 GitHub（线上）模式下需要发布草稿", 400);
	}
	if (!resolveGithubRepo()) {
		return errorResponse(
			"未配置 GitHub 仓库（src/admin/config.ts 的 githubRepo）",
			500,
		);
	}
	const body = await readJsonBody(Astro.request);
	const rawChanges = Array.isArray(body?.changes) ? body.changes : [];
	if (rawChanges.length === 0) {
		return errorResponse("没有要发布的修改", 400);
	}
	if (rawChanges.length > MAX_CHANGES) {
		return errorResponse(`单次发布最多 ${MAX_CHANGES} 个文件`, 400);
	}

	const changes: Array<{
		path: string;
		content?: string;
		delete?: boolean;
	}> = [];
	for (const raw of rawChanges) {
		const item = raw as Record<string, unknown>;
		const resolved = resolveProjectPath(item.path);
		if (!resolved.ok) return errorResponse(`路径无效：${resolved.error}`, 400);
		if (resolved.rel === resolved.root) {
			return errorResponse("不能修改根目录", 400);
		}
		if (item.delete === true) {
			changes.push({ path: resolved.rel, delete: true });
			continue;
		}
		if (typeof item.content !== "string") {
			return errorResponse(`缺少文件内容：${resolved.rel}`, 400);
		}
		if (Buffer.byteLength(item.content, "utf-8") > 4 * 1024 * 1024) {
			return errorResponse(`文件过大（上限 4 MB）：${resolved.rel}`, 413);
		}
		changes.push({ path: resolved.rel, content: item.content });
	}

	const message =
		typeof body?.message === "string" && body.message.trim()
			? body.message.trim().slice(0, 200)
			: `chore(admin): publish ${changes.length} file change${changes.length > 1 ? "s" : ""}`;

	const { getRepoToken, ghCommitBatch } = await import("../lib/gh");
	const result = await ghCommitBatch(
		getRepoToken(session.token),
		changes,
		message,
	);
	return okResponse({
		sha: result.sha,
		url: result.url,
		count: result.count,
	});
};
