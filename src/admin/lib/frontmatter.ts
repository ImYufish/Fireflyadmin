/**
 * 客户端 frontmatter 工具：解析 YAML frontmatter、按字段更新后重新序列化。
 * 仅用于后台编辑器；博客本体始终读取磁盘上的原始文件。
 */

import { dump as yamlDump, load as yamlLoad } from "js-yaml";

export type SplitResult =
	| {
			ok: true;
			data: Record<string, unknown>;
			/** frontmatter 结束之后的正文（含开头换行） */
			body: string;
	  }
	| { ok: false };

/** 把文件拆成原始 frontmatter 块（含 --- 定界，以换行结尾）与正文 */
export function splitRaw(content: string): { fm: string; body: string } {
	const match = /^---[\t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
		content,
	);
	if (!match) return { fm: "", body: content };
	return { fm: match[0], body: content.slice(match[0].length) };
}

export function splitFrontmatter(content: string): SplitResult {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
		content,
	);
	if (!match) return { ok: false };
	try {
		const data = yamlLoad(match[1]);
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return { ok: false };
		}
		return {
			ok: true,
			data: data as Record<string, unknown>,
			body: content.slice(match[0].length),
		};
	} catch {
		return { ok: false };
	}
}

/**
 * 更新 frontmatter 的一个字段并重新序列化整个 YAML 块。
 * 注意：表单修改会重排 YAML（丢失 frontmatter 内的注释），原始编辑器编辑不受影响。
 */
export function applyFrontmatterField(
	content: string,
	field: string,
	value: unknown,
): string {
	const parsed = splitFrontmatter(content);
	if (!parsed.ok) return content;
	const data: Record<string, unknown> = { ...parsed.data };
	const isEmpty = value === "" || value === null || value === undefined;
	if (isEmpty) {
		// published 是必需字段：清空时重置为今天
		if (field === "published") {
			data.published = localDateString(new Date());
		} else {
			delete data[field];
		}
	} else {
		data[field] = value;
	}
	let yaml = yamlDump(data, {
		lineWidth: -1,
		flowLevel: 1,
	}).trimEnd();
	// js-yaml 会把日期字符串加引号（否则会被解析成 Date），这里还原成博客惯用的裸日期格式
	yaml = yaml.replace(
		/^(\s*(?:published|updated):\s*)['"]?(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?['"]?[ \t]*$/gm,
		"$1$2",
	);
	return `---\n${yaml}\n---\n${parsed.body}`;
}

export function localDateString(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** 把 frontmatter 里的日期值转为 input[type=date] 需要的 yyyy-mm-dd */
export function dateFieldValue(value: unknown): string {
	if (value instanceof Date) return localDateString(value);
	if (typeof value === "string") {
		const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
		if (match) return match[1];
	}
	return "";
}

export function tagsFieldValue(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.filter((v) => typeof v === "string").join(", ");
}

export function tagsFromString(value: string): string[] {
	return value
		.split(/[,，]/)
		.map((s) => s.trim())
		.filter(Boolean);
}
