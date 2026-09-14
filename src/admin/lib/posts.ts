/**
 * 文章工具：列出文章、文件路径 → 博客 URL 映射、新建文章脚手架。
 *
 * URL 映射规则必须与 Astro glob loader 的 entry.id 生成逻辑保持一致
 * （见 astro/dist/content/loaders/glob.js 与 content/utils.js）：
 *  1. frontmatter 里的 slug 字段优先；
 *  2. 否则取相对 posts 目录的路径、去掉扩展名，逐段 github-slugger slug 化，
 *     并去掉结尾的 /index。
 * 文章页路由为 /posts/<slug>/（见 src/pages/posts/[...slug].astro）。
 */

import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { slug as githubSlug } from "github-slugger";
import matter from "gray-matter";
import { resolveBackendMode } from "../config";

export const POSTS_DIR = "src/content/posts";

export type PostMeta = {
	/** 相对项目根、以 / 分隔的文件路径 */
	path: string;
	/** 去掉扩展名的文件路径（目录树展示用） */
	fileSlug: string;
	/** 博客 URL slug */
	slug: string;
	/** 博客文章 URL（不带站点域名） */
	url: string;
	title: string;
	/** ISO 时间字符串；解析失败时为空串 */
	published: string;
	updated?: string;
	tags: string[];
	category: string;
	draft: boolean;
	pinned: boolean;
	password: boolean;
	lang: string;
	size: number;
	mtime: number;
};

/** 由文件相对路径（不含 src/content/posts/ 前缀）推导 URL slug */
export function postSlugFromRelPath(
	relPathInPosts: string,
	frontmatterSlug?: unknown,
): string {
	if (typeof frontmatterSlug === "string" && frontmatterSlug.trim()) {
		return frontmatterSlug.trim().replace(/^\/+|\/+$/g, "");
	}
	const withoutExt = relPathInPosts.replace(/\.(md|mdx|markdown)$/i, "");
	return withoutExt
		.split("/")
		.map((segment) => githubSlug(segment))
		.join("/")
		.replace(/\/index$/, "");
}

export function postUrlFromSlug(slug: string): string {
	return `/posts/${slug}/`;
}

type MatterData = Record<string, unknown>;

function asDateString(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	return "";
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

/** 由 Markdown 源码构建文章元数据（本地 / GitHub 两种后端共用） */
export function buildPostMeta(
	raw: string,
	relInPosts: string,
	size: number,
	mtime: number,
): PostMeta {
	let data: MatterData = {};
	try {
		data = (matter(raw).data ?? {}) as MatterData;
	} catch {
		/* frontmatter 解析失败时按空数据处理 */
	}
	const slug = postSlugFromRelPath(relInPosts, data.slug);
	return {
		path: `${POSTS_DIR}/${relInPosts}`,
		fileSlug: relInPosts.replace(/\.(md|mdx|markdown)$/i, ""),
		slug,
		url: postUrlFromSlug(slug),
		title:
			typeof data.title === "string" && data.title ? data.title : relInPosts,
		published: asDateString(data.published),
		updated: asDateString(data.updated) || undefined,
		tags: asStringArray(data.tags),
		category: typeof data.category === "string" ? data.category : "",
		draft: data.draft === true,
		pinned: data.pinned === true,
		password: typeof data.password === "string" && data.password !== "",
		lang: typeof data.lang === "string" ? data.lang : "",
		size,
		mtime,
	};
}

/** 解析单个本地 markdown 文件的文章元数据；文件不可读时返回 null */
export async function parsePostFile(absPath: string): Promise<PostMeta | null> {
	let raw: string;
	let stat: Stats;
	try {
		raw = await fs.readFile(absPath, "utf-8");
		stat = await fs.stat(absPath);
	} catch {
		return null;
	}
	const relInPosts = path
		.relative(path.resolve(process.cwd(), POSTS_DIR), absPath)
		.split(path.sep)
		.join("/");
	return buildPostMeta(raw, relInPosts, stat.size, Math.round(stat.mtimeMs));
}

/** 列出全部文章（含草稿），按发布时间倒序 */
export async function listPosts(): Promise<PostMeta[]> {
	if (resolveBackendMode() === "github") {
		return listPostsFromGitHub();
	}
	const out: PostMeta[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs);
			} else if (entry.isFile() && /\.(md|mdx|markdown)$/i.test(entry.name)) {
				const meta = await parsePostFile(abs);
				if (meta) out.push(meta);
			}
		}
	}
	await walk(path.resolve(process.cwd(), POSTS_DIR));
	out.sort((a, b) => {
		if (a.draft !== b.draft) return a.draft ? 1 : -1;
		return (b.published || "").localeCompare(a.published || "");
	});
	return out;
}

/** GitHub 后端：从仓库拉取 posts 源文件并解析元数据 */
async function listPostsFromGitHub(): Promise<PostMeta[]> {
	const { getRepoToken, ghReadPostsSources } = await import("./gh");
	const items = await ghReadPostsSources(getRepoToken());
	return items.map((item) =>
		buildPostMeta(item.raw, item.relInPosts, item.size, 0),
	);
}

/* ------------------------- 新建文章 ------------------------- */

/**
 * 文件名/标题 → URL slug：中文字符转拼音（与 scripts/new-post.js 保持一致），
 * 其他字符保持原样后清理为 URL 安全字符。
 */
export async function slugifyFilename(input: string): Promise<string> {
	const fileExtensionRegex = /\.(md|mdx)$/i;
	let fileName = input.trim();
	if (!fileName) return "";
	if (!fileExtensionRegex.test(fileName)) {
		fileName += ".md";
	}
	let slug = fileName.replace(fileExtensionRegex, "");
	if (slug.endsWith("/index")) {
		slug = slug.slice(0, -"/index".length);
	}
	const segments = slug.split("/");
	const converted = await Promise.all(
		segments.map((segment) => slugifySegment(segment)),
	);
	return converted.filter(Boolean).join("/");
}

async function slugifySegment(segment: string): Promise<string> {
	if (!/[一-鿿]/.test(segment)) {
		return segment
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	}
	try {
		const { pinyin } = await import("pinyin-pro");
		const chars = [...segment];
		const parts: string[] = [];
		let buf = "";
		for (const ch of chars) {
			if (/[一-鿿]/.test(ch)) {
				if (buf) {
					parts.push(buf);
					buf = "";
				}
				parts.push(pinyin(ch, { toneType: "none", type: "array" })[0] ?? "");
			} else {
				buf += ch;
			}
		}
		if (buf) parts.push(buf);
		return parts
			.join("-")
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	} catch {
		/* pinyin-pro 不可用时退化为丢弃非 ASCII 字符 */
		return segment
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	}
}

function todayString(): string {
	const today = new Date();
	const month = String(today.getMonth() + 1).padStart(2, "0");
	const day = String(today.getDate()).padStart(2, "0");
	return `${today.getFullYear()}-${month}-${day}`;
}

/** 生成新文章的 frontmatter（与 scripts/new-post.js 模板一致） */
export function newPostContent(
	title: string,
	slug: string,
	draft: boolean,
): string {
	return `---
title: ${title}
published: ${todayString()}
description: ''
image: ''
tags: []
category: ''
draft: ${draft}
lang: ''
slug: ${slug}
---
`;
}

/** 通过当前后端（本地文件 / GitHub 仓库）创建新文章文件 */
export async function writeNewPost(
	relInPosts: string,
	content: string,
): Promise<{ committed?: boolean }> {
	if (resolveBackendMode() === "github") {
		const { getRepoToken, ghReadFile, ghWriteFile } = await import("./gh");
		const token = getRepoToken();
		try {
			await ghReadFile(`${POSTS_DIR}/${relInPosts}`, token);
			throw Object.assign(new Error(`文件已存在：${POSTS_DIR}/${relInPosts}`), {
				status: 409,
			});
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status && status !== 404) throw error;
			if (status === 409) throw error;
		}
		return ghWriteFile(
			`${POSTS_DIR}/${relInPosts}`,
			content,
			token,
			"create post",
		);
	}
	const abs = path.resolve(process.cwd(), POSTS_DIR, relInPosts);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content, "utf-8");
	return {};
}
