/**
 * 文件操作路径安全：所有后台文件读写只允许发生在允许的根目录内，
 * 并规范化路径以阻止目录穿越（../、绝对路径、NUL 字节等）。
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** 允许后台管理的目录（相对项目根） */
export const ALLOWED_ROOTS = ["src/content", "src/config"] as const;

/** 允许在线编辑的文本文件扩展名 */
const TEXT_EXTENSIONS = new Set([
	".md",
	".mdx",
	".markdown",
	".ts",
	".mts",
	".js",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".html",
	".htm",
	".css",
	".styl",
	".stylus",
	".yaml",
	".yml",
	".txt",
	".astro",
	".svelte",
	".svg",
	".xml",
	".csv",
	".gitignore",
]);

const BINARY_NAME_HINTS = [".DS_Store", "Thumbs.db", "desktop.ini"];

export type ResolvedPath =
	| { ok: true; abs: string; rel: string; root: string }
	| { ok: false; error: string };

/**
 * 把用户传入的项目相对路径解析为绝对路径，并校验位于允许的根目录内。
 * 返回的 rel 是相对项目根、以 / 分隔的完整路径（如 src/content/posts/a.md）。
 */
export function resolveProjectPath(input: unknown): ResolvedPath {
	if (typeof input !== "string" || input.trim() === "") {
		return { ok: false, error: "缺少路径参数" };
	}
	const cleaned = input.trim().replace(/\\/g, "/");
	if (cleaned.includes("\0")) {
		return { ok: false, error: "非法路径" };
	}
	const abs = path.resolve(process.cwd(), cleaned);
	for (const root of ALLOWED_ROOTS) {
		const absRoot = path.resolve(process.cwd(), root);
		const relFromRoot = path.relative(absRoot, abs);
		if (path.isAbsolute(relFromRoot) || relFromRoot.startsWith("..")) continue;
		const relNormalized = relFromRoot
			.split(path.sep)
			.join("/")
			.replace(/^\/+|\/+$/g, "");
		return {
			ok: true,
			abs,
			rel: relNormalized ? `${root}/${relNormalized}` : root,
			root,
		};
	}
	return {
		ok: false,
		error: "只允许访问 src/content 与 src/config 目录",
	};
}

export function isTextFile(filePath: string): boolean {
	const name = path.basename(filePath).toLowerCase();
	if (BINARY_NAME_HINTS.includes(name)) return false;
	if (name === ".gitignore" || name === ".gitattributes") return true;
	return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isMarkdownFile(filePath: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(filePath);
}

export type TreeNode = {
	name: string;
	/** 相对项目根、以 / 分隔的路径 */
	path: string;
	type: "dir" | "file";
	size?: number;
	mtime?: number;
	children?: TreeNode[];
};

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** 递归构建目录树（跳过隐藏文件） */
export async function buildTree(
	absDir: string,
	projectRel: string,
): Promise<TreeNode[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(absDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const nodes: TreeNode[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || IGNORED_NAMES.has(entry.name)) continue;
		const childAbs = path.join(absDir, entry.name);
		const childRel = projectRel ? `${projectRel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			nodes.push({
				name: entry.name,
				path: childRel,
				type: "dir",
				children: await buildTree(childAbs, childRel),
			});
		} else if (entry.isFile()) {
			let size = 0;
			let mtime = 0;
			try {
				const st = await fs.stat(childAbs);
				size = st.size;
				mtime = Math.round(st.mtimeMs);
			} catch {
				/* 忽略单个文件 stat 失败 */
			}
			nodes.push({
				name: entry.name,
				path: childRel,
				type: "file",
				size,
				mtime,
			});
		}
	}
	nodes.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name, "zh-Hans-CN");
	});
	return nodes;
}

/**
 * 校验新建/重命名的文件名或相对子路径：
 * 拒绝目录穿越、隐藏文件、Windows 非法字符。
 * 允许包含子目录（a/b/c.md），返回规范化后的相对子路径。
 */
export function sanitizeRelativeSubpath(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const cleaned = input.trim().replace(/\\/g, "/");
	if (!cleaned || cleaned.includes("\0")) return null;
	const segments = cleaned.split("/").filter((s) => s !== "");
	if (segments.length === 0) return null;
	for (const segment of segments) {
		if (segment === "." || segment === "..") return null;
		if (segment.startsWith(".")) return null;
		// Windows 保留字符与结尾的空格/点
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 需要拒绝控制字符进入文件名
		if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return null;
		if (/[\s.]$/.test(segment)) return null;
		if (
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(
				path.basename(segment, path.extname(segment)),
			)
		) {
			return null;
		}
	}
	return segments.join("/");
}
