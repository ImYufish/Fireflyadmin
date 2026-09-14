/**
 * 线上模式（GitHub 后端）：通过 GitHub Contents API 读写博客仓库。
 * 保存 = 提交 commit，推送后由部署平台自动触发重新部署。
 *
 * 所有请求走 lib/auth.ts 的 githubFetch（代理 + TLS 处理同登录链路）。
 * 令牌优先级：会话内 OAuth 令牌（repo 权限）> adminConfig.githubToken（PAT）。
 */

import { adminConfig, resolveGithubRepo } from "../config";
import { githubFetch } from "./auth";

const API_BASE = "https://api.github.com";

export class GhError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** 会话令牌（repo 权限的 OAuth 令牌）或配置的 PAT */
export function getRepoToken(sessionToken?: string): string {
	const token = sessionToken || adminConfig.githubToken;
	if (!token) {
		throw new GhError(
			"线上模式需要 GitHub 仓库写权限：请用 OAuth（repo 权限）重新登录，或在 src/admin/config.ts 配置 githubToken（PAT）",
			403,
		);
	}
	return token;
}

function repoInfo() {
	const repo = resolveGithubRepo();
	if (!repo) {
		throw new GhError(
			"线上模式未配置 GitHub 仓库：请在 src/admin/config.ts 填写 githubRepo（owner/repo/branch）",
			500,
		);
	}
	return repo;
}

function encodeApiPath(apiPath: string): string {
	return apiPath
		.split("/")
		.map((segment) => (segment ? encodeURIComponent(segment) : ""))
		.join("/");
}

type GhJson = Record<string, unknown>;

async function ghRequest(
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
	apiPath: string,
	token: string,
	body?: GhJson,
): Promise<{ status: number; data: GhJson | null; headers: Headers }> {
	const res = await githubFetch(`${API_BASE}${apiPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	let data: GhJson | null = null;
	if (res.status !== 204) {
		data = (await res.json().catch(() => null)) as GhJson | null;
	}
	return { status: res.status, data, headers: res.headers };
}

function ghErrorMessage(status: number, data: GhJson | null): string {
	const message = typeof data?.message === "string" ? data.message : "";
	if (status === 401) return "GitHub 令牌无效或已过期，请重新登录";
	if (status === 403 || status === 429) {
		return "GitHub API 请求受限（无权限或超速），请检查令牌的仓库写权限";
	}
	if (status === 404) return "仓库或文件不存在（检查仓库名 / 分支 / 令牌权限）";
	if (status === 409) return "提交冲突：远端刚有新的提交，请刷新后重试";
	if (status === 422) return message || "GitHub 拒绝了该请求（参数校验失败）";
	return message || `GitHub API 错误（${status}）`;
}

/* ------------------------------ Git 树与缓存 ------------------------------ */

export type GhTreeEntry = { path: string; type: "blob" | "tree"; size: number };

let treeCache: { entries: GhTreeEntry[]; at: number } | null = null;
const CACHE_TTL_MS = 90 * 1000;

export function invalidateGhCache(): void {
	treeCache = null;
	postsCache = null;
}

export async function ghListTree(token: string): Promise<GhTreeEntry[]> {
	if (treeCache && Date.now() - treeCache.at < CACHE_TTL_MS) {
		return treeCache.entries;
	}
	const { owner, repo, branch } = repoInfo();
	const { status, data } = await ghRequest(
		"GET",
		`/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
		token,
	);
	if (status !== 200 || !data || !Array.isArray(data.tree)) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	if (data.truncated === true) {
		console.warn(
			"[firefly-admin] GitHub 仓库文件树过大被截断，后台仅能管理部分文件",
		);
	}
	const entries: GhTreeEntry[] = [];
	for (const item of data.tree as Array<Record<string, unknown>>) {
		if (typeof item.path !== "string") continue;
		if (item.type !== "blob" && item.type !== "tree") continue;
		entries.push({
			path: item.path,
			type: item.type,
			size: typeof item.size === "number" ? item.size : 0,
		});
	}
	treeCache = { entries, at: Date.now() };
	return entries;
}

/* ------------------------------ 文件读写 ------------------------------ */

export async function ghReadFile(
	projectPath: string,
	token: string,
): Promise<{ content: string; sha: string; size: number }> {
	const { owner, repo, branch } = repoInfo();
	const apiPath = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath(projectPath)}?ref=${encodeURIComponent(branch)}`;
	const { status, data } = await ghRequest("GET", apiPath, token);
	if (status !== 200 || !data) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	const contentB64 = typeof data.content === "string" ? data.content : "";
	const sha = typeof data.sha === "string" ? data.sha : "";
	const size = typeof data.size === "number" ? data.size : 0;
	if (data.encoding !== "base64" || !contentB64) {
		throw new GhError("该文件内容无法通过 GitHub API 读取", 415);
	}
	return {
		content: Buffer.from(contentB64, "base64").toString("utf-8"),
		sha,
		size,
	};
}

export async function ghWriteFile(
	projectPath: string,
	content: string,
	token: string,
	commitPrefix = "update",
): Promise<{ committed: true }> {
	const { owner, repo, branch } = repoInfo();
	const apiPath = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath(projectPath)}`;
	// 已存在则需带 sha（更新）；不存在则新建
	let sha: string | undefined;
	try {
		const existing = await ghReadFile(projectPath, token);
		sha = existing.sha;
	} catch (error) {
		if (!(error instanceof GhError) || error.status !== 404) throw error;
	}
	const { status, data } = await ghRequest("PUT", apiPath, token, {
		message: `chore(admin): ${commitPrefix} ${projectPath}`,
		content: Buffer.from(content, "utf-8").toString("base64"),
		branch,
		...(sha ? { sha } : {}),
	});
	if (status !== 200 && status !== 201) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	invalidateGhCache();
	return { committed: true };
}

/** 写入二进制文件（图片上传等）：Buffer 直接 base64，避免 utf-8 转码损坏 */
export async function ghWriteFileBinary(
	projectPath: string,
	buffer: Buffer,
	token: string,
	commitPrefix = "upload",
): Promise<{ committed: true }> {
	const { owner, repo, branch } = repoInfo();
	const apiPath = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath(projectPath)}`;
	let sha: string | undefined;
	try {
		sha = (await ghReadFile(projectPath, token)).sha;
	} catch (error) {
		if (!(error instanceof GhError) || error.status !== 404) throw error;
	}
	const { status, data } = await ghRequest("PUT", apiPath, token, {
		message: `chore(admin): ${commitPrefix} ${projectPath}`,
		content: buffer.toString("base64"),
		branch,
		...(sha ? { sha } : {}),
	});
	if (status !== 200 && status !== 201) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	invalidateGhCache();
	return { committed: true };
}

export async function ghDeleteFile(
	projectPath: string,
	token: string,
): Promise<void> {
	const { owner, repo, branch } = repoInfo();
	const apiPath = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath(projectPath)}`;
	let sha: string;
	try {
		sha = (await ghReadFile(projectPath, token)).sha;
	} catch (error) {
		if (error instanceof GhError && error.status === 404) return;
		throw error;
	}
	const { status, data } = await ghRequest("DELETE", apiPath, token, {
		message: `chore(admin): delete ${projectPath}`,
		sha,
		branch,
	});
	if (status !== 200 && status !== 204) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	invalidateGhCache();
}

/** 重命名 / 移动文件（base64 原样搬移，二进制安全） */
export async function ghRenameFile(
	fromPath: string,
	toPath: string,
	token: string,
): Promise<void> {
	const { owner, repo, branch } = repoInfo();
	const base = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/`;
	const { status, data } = await ghRequest(
		"GET",
		`${base}${encodeApiPath(fromPath)}?ref=${encodeURIComponent(branch)}`,
		token,
	);
	if (status !== 200 || !data) {
		throw new GhError(ghErrorMessage(status, data), status);
	}
	const contentB64 = typeof data.content === "string" ? data.content : "";
	const sha = typeof data.sha === "string" ? data.sha : "";
	if (!contentB64 || !sha) {
		throw new GhError("无法读取原文件内容，重命名失败", 500);
	}
	const put = await ghRequest("PUT", `${base}${encodeApiPath(toPath)}`, token, {
		message: `chore(admin): rename ${fromPath} -> ${toPath}`,
		content: contentB64,
		branch,
	});
	if (put.status !== 200 && put.status !== 201) {
		throw new GhError(ghErrorMessage(put.status, put.data), put.status);
	}
	const del = await ghRequest(
		"DELETE",
		`${base}${encodeApiPath(fromPath)}`,
		token,
		{
			message: `chore(admin): rename ${fromPath} -> ${toPath}`,
			sha,
			branch,
		},
	);
	if (del.status !== 200 && del.status !== 204) {
		throw new GhError(ghErrorMessage(del.status, del.data), del.status);
	}
	invalidateGhCache();
}

/** 递归删除目录下全部文件（GitHub 无空目录，逐文件删除） */
export async function ghDeleteDir(
	dirPath: string,
	token: string,
): Promise<void> {
	const entries = await ghListTree(token);
	const files = entries.filter(
		(entry) =>
			entry.type === "blob" &&
			(entry.path === dirPath || entry.path.startsWith(`${dirPath}/`)),
	);
	if (files.length === 0) return;
	for (const file of files) {
		await ghDeleteFile(file.path, token);
	}
}

/* ------------------------------ 批量提交 ------------------------------ */

export type GhCommitChange = {
	path: string;
	/** 删除该文件（tree 中置空） */
	delete?: boolean;
	/** 新的文件内容（UTF-8；与 delete 互斥） */
	content?: string;
};

/**
 * 把多个文件修改提交为**单个** commit（Git Data API：blobs → tree → commit → ref）。
 * 以发布时刻的远端分支头为父提交（单人写作工具的 last-write-wins 语义）。
 */
export async function ghCommitBatch(
	token: string,
	changes: GhCommitChange[],
	message: string,
): Promise<{ sha: string; url: string; count: number }> {
	const { owner, repo, branch } = repoInfo();
	const base = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/git`;

	const ref = await ghRequest(
		"GET",
		`${base}/ref/heads/${encodeURIComponent(branch)}`,
		token,
	);
	const headSha = (ref.data?.object as Record<string, unknown> | undefined)
		?.sha;
	if (typeof headSha !== "string") {
		throw new GhError(ghErrorMessage(ref.status, ref.data), ref.status);
	}

	const commit = await ghRequest("GET", `${base}/commits/${headSha}`, token);
	const baseTree = (commit.data?.tree as Record<string, unknown> | undefined)
		?.sha;
	if (typeof baseTree !== "string") {
		throw new GhError(
			ghErrorMessage(commit.status, commit.data),
			commit.status,
		);
	}

	const treeItems: Array<Record<string, unknown>> = [];
	for (const change of changes) {
		if (change.delete) {
			treeItems.push({
				path: change.path,
				mode: "100644",
				type: "blob",
				sha: null,
			});
			continue;
		}
		const blob = await ghRequest("POST", `${base}/blobs`, token, {
			content: Buffer.from(change.content ?? "", "utf-8").toString("base64"),
			encoding: "base64",
		});
		const blobSha = blob.data?.sha;
		if (blob.status !== 201 || typeof blobSha !== "string") {
			throw new GhError(ghErrorMessage(blob.status, blob.data), blob.status);
		}
		treeItems.push({
			path: change.path,
			mode: "100644",
			type: "blob",
			sha: blobSha,
		});
	}

	const tree = await ghRequest("POST", `${base}/trees`, token, {
		base_tree: baseTree,
		tree: treeItems,
	});
	const treeSha = tree.data?.sha;
	if (tree.status !== 201 || typeof treeSha !== "string") {
		throw new GhError(ghErrorMessage(tree.status, tree.data), tree.status);
	}

	const newCommit = await ghRequest("POST", `${base}/commits`, token, {
		message,
		tree: treeSha,
		parents: [headSha],
	});
	const newSha = newCommit.data?.sha;
	const commitUrl = newCommit.data?.html_url;
	if (newCommit.status !== 201 || typeof newSha !== "string") {
		throw new GhError(
			ghErrorMessage(newCommit.status, newCommit.data),
			newCommit.status,
		);
	}

	const updated = await ghRequest(
		"PATCH",
		`${base}/refs/heads/${encodeURIComponent(branch)}`,
		token,
		{ sha: newSha, force: false },
	);
	if (updated.status !== 200) {
		throw new GhError(
			ghErrorMessage(updated.status, updated.data),
			updated.status,
		);
	}

	invalidateGhCache();
	return {
		sha: newSha,
		url: typeof commitUrl === "string" ? commitUrl : "",
		count: changes.length,
	};
}

/* ------------------------------ 文章列表 ------------------------------ */

let postsCache: {
	at: number;
	items: Array<{ relInPosts: string; raw: string; size: number }>;
} | null = null;

/** 拉取 posts 目录下全部 Markdown 源文件（带缓存，供文章列表解析 frontmatter） */
export async function ghReadPostsSources(
	token: string,
): Promise<Array<{ relInPosts: string; raw: string; size: number }>> {
	if (postsCache && Date.now() - postsCache.at < CACHE_TTL_MS) {
		return postsCache.items;
	}
	const { owner, repo, branch } = repoInfo();
	const apiPath = `/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath("src/content/posts")}?ref=${encodeURIComponent(branch)}`;
	// 目录式 contents API：单次返回目录（含子目录第一层）内文件列表与内容
	const { status, data } = await ghRequest("GET", apiPath, token);
	if (status !== 200 || !Array.isArray(data)) {
		throw new GhError(ghErrorMessage(status, data as GhJson | null), status);
	}
	const items: Array<{ relInPosts: string; raw: string; size: number }> = [];
	const dirs: string[] = [];
	for (const entry of data as Array<Record<string, unknown>>) {
		const name = typeof entry.name === "string" ? entry.name : "";
		const type = entry.type;
		if (type === "dir") {
			dirs.push(name);
			continue;
		}
		if (type !== "file" || !/\.(md|mdx|markdown)$/i.test(name)) continue;
		const contentB64 = typeof entry.content === "string" ? entry.content : "";
		if (!contentB64) continue;
		items.push({
			relInPosts: name,
			raw: Buffer.from(contentB64, "base64").toString("utf-8"),
			size: typeof entry.size === "number" ? entry.size : 0,
		});
	}
	// 递归子目录（guide/ 等）
	for (const dir of dirs) {
		const sub = await ghRequest(
			"GET",
			`/repos/${encodeApiPath(owner)}/${encodeApiPath(repo)}/contents/${encodeApiPath(`src/content/posts/${dir}`)}?ref=${encodeURIComponent(branch)}`,
			token,
		);
		if (sub.status !== 200 || !Array.isArray(sub.data)) continue;
		for (const entry of sub.data as Array<Record<string, unknown>>) {
			const name = typeof entry.name === "string" ? entry.name : "";
			if (entry.type !== "file" || !/\.(md|mdx|markdown)$/i.test(name))
				continue;
			const contentB64 = typeof entry.content === "string" ? entry.content : "";
			if (!contentB64) continue;
			items.push({
				relInPosts: `${dir}/${name}`,
				raw: Buffer.from(contentB64, "base64").toString("utf-8"),
				size: typeof entry.size === "number" ? entry.size : 0,
			});
		}
	}
	postsCache = { at: Date.now(), items };
	return items;
}
