import path from "node:path";
import type { APIRoute } from "astro";
import { resolveBackendMode, resolveGithubRepo } from "../config";
import { requireApiSession } from "../lib/auth";
import { errorResponse, okResponse } from "../lib/http";
import { ALLOWED_ROOTS, buildTree, type TreeNode } from "../lib/paths";

/**
 * GET /api/admin/files/tree/ —— 文件树
 * 可选参数 root=src/content|src/config（默认返回全部允许的根目录）
 * 线上模式（github 后端）从仓库 git 树构建。
 */
export const GET: APIRoute = async (Astro) => {
	const session = await requireApiSession(Astro);
	if (session instanceof Response) return session;
	const rootParam = Astro.url.searchParams.get("root");
	const roots = rootParam
		? ALLOWED_ROOTS.filter((r) => r === rootParam.replace(/\/+$/, ""))
		: [...ALLOWED_ROOTS];
	if (roots.length === 0) {
		return errorResponse("未知的根目录", 400);
	}

	try {
		const trees = [];
		if (resolveBackendMode() === "github") {
			const repo = resolveGithubRepo();
			const { getRepoToken, ghListTree } = await import("../lib/gh");
			const entries = await ghListTree(getRepoToken(session.token));
			for (const root of roots) {
				trees.push({
					name: root,
					path: root,
					type: "dir" as const,
					children: buildGhSubtree(entries, root),
				});
			}
			void repo;
		} else {
			for (const root of roots) {
				const abs = path.resolve(process.cwd(), root);
				const children = await buildTree(abs, root);
				trees.push({
					name: root,
					path: root,
					type: "dir" as const,
					children,
				});
			}
		}
		return okResponse({ roots: trees });
	} catch (error) {
		const status =
			typeof (error as { status?: number }).status === "number"
				? (error as { status: number }).status
				: 500;
		return errorResponse(
			error instanceof Error ? error.message : "加载文件树失败",
			status >= 400 && status < 600 ? status : 500,
		);
	}
};

/** 由 GitHub git 树条目构建允许根目录下的子树（跳过隐藏文件） */
function buildGhSubtree(
	entries: Array<{ path: string; type: "blob" | "tree"; size: number }>,
	root: string,
): TreeNode[] {
	type DirNode = TreeNode & { children: TreeNode[] };
	const rootDir: DirNode = {
		name: root,
		path: root,
		type: "dir",
		children: [],
	};
	const dirMap = new Map<string, DirNode>([[root, rootDir]]);

	const ensureDir = (dirPath: string): DirNode => {
		const existing = dirMap.get(dirPath);
		if (existing) return existing;
		const index = dirPath.lastIndexOf("/");
		const parentPath = index > 0 ? dirPath.slice(0, index) : root;
		const node: DirNode = {
			name: dirPath.slice(index + 1),
			path: dirPath,
			type: "dir",
			children: [],
		};
		ensureDir(parentPath).children.push(node);
		dirMap.set(dirPath, node);
		return node;
	};

	for (const entry of entries) {
		if (!entry.path.startsWith(`${root}/`)) continue;
		const segments = entry.path.split("/");
		if (segments.some((s) => s.startsWith("."))) continue;
		if (entry.type === "tree") {
			ensureDir(entry.path);
			continue;
		}
		const index = entry.path.lastIndexOf("/");
		const parentPath = index > 0 ? entry.path.slice(0, index) : root;
		const fileName = entry.path.slice(index + 1);
		ensureDir(parentPath).children.push({
			name: fileName,
			path: entry.path,
			type: "file",
			size: entry.size,
			mtime: 0,
		});
	}

	const sortTree = (node: TreeNode) => {
		if (!node.children) return;
		node.children.sort((a: TreeNode, b: TreeNode) => {
			if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name, "zh-Hans-CN");
		});
		for (const child of node.children) sortTree(child);
	};
	sortTree(rootDir);
	return rootDir.children;
}
