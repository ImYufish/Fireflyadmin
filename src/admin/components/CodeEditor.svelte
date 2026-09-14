<script lang="ts">
import { indentWithTab, redo, undo } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import {
	codeFolding,
	foldEffect,
	foldService,
	foldState,
} from "@codemirror/language";
import {
	Compartment,
	EditorSelection,
	EditorState,
	type Extension,
} from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import { untrack } from "svelte";

interface Props {
	/** 当前文件内容（外部受控值） */
	value: string;
	/** 当前文件路径，用于决定语法高亮语言 */
	path: string | null;
	/** 禁用编辑（如二进制文件 / 未选择文件） */
	disabled?: boolean;
	onDocChange?: (value: string) => void;
}

const { value, path, disabled = false, onDocChange }: Props = $props();

let container: HTMLDivElement | undefined = $state();
let view = $state<EditorView | null>(null);
let languageCompartment = new Compartment();
let editableCompartment = new Compartment();
/** 明暗主题跟随后台/博客的 dark 类 */
let themeCompartment = new Compartment();
/** 最近一次由内部编辑上报的值，用于区分外部值变化与内部输入 */
let lastEmitted: string | null = null;

const isMarkdown = $derived(
	path !== null && /\.(md|mdx|markdown)$/i.test(path),
);

function isDarkTheme(): boolean {
	return typeof document !== "undefined"
		? document.documentElement.classList.contains("dark")
		: true;
}

function themeExtension(): Extension[] {
	return isDarkTheme() ? [oneDark] : [];
}

/* --------------------- Markdown 编辑命令 --------------------- */

/** 包裹选区：选中文本时前后加标记；空选区插入占位符并选中它 */
function wrap(before: string, after: string, placeholder: string) {
	if (!view) return;
	const state = view.state;
	const changes: Array<{ from: number; to: number; insert: string }> = [];
	const ranges: Array<{ anchor: number; head: number }> = [];
	let offset = 0;
	for (const range of state.selection.ranges) {
		const selected = state.sliceDoc(range.from, range.to);
		const inner = selected || placeholder;
		const from = range.from + offset;
		const insert = before + inner + after;
		changes.push({ from: range.from, to: range.to, insert });
		ranges.push({
			anchor: from + before.length,
			head: from + before.length + inner.length,
		});
		offset += insert.length - (range.to - range.from);
	}
	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		scrollIntoView: true,
	});
	view.focus();
}

/** 行首前缀 toggle：涉及行全部已有前缀则移除，否则添加 */
function toggleLinePrefix(prefix: string) {
	if (!view) return;
	const state = view.state;
	const lineNumbers = new Set<number>();
	for (const range of state.selection.ranges) {
		const first = state.doc.lineAt(range.from).number;
		const last = state.doc.lineAt(range.to).number;
		for (let n = first; n <= last; n++) lineNumbers.add(n);
	}
	const lines = [...lineNumbers]
		.sort((x, y) => x - y)
		.map((n) => state.doc.line(n));
	const allHavePrefix = lines.every((line) => {
		const indent = line.text.match(/^\s*/)?.[0] ?? "";
		return line.text.slice(indent.length).startsWith(prefix.trim());
	});
	const changes: Array<{ from: number; to?: number; insert?: string }> = [];
	for (const line of lines) {
		const indent = line.text.match(/^\s*/)?.[0] ?? "";
		if (allHavePrefix) {
			changes.push({
				from: line.from + indent.length,
				to: line.from + indent.length + prefix.length,
				insert: "",
			});
		} else {
			changes.push({ from: line.from + indent.length, insert: prefix });
		}
	}
	view.dispatch({ changes, scrollIntoView: true });
	view.focus();
}

/**
 * 标题级别切换：先剥掉行首已有的 `#`~`######` 前缀再套用目标级别。
 * 直接用 toggleLinePrefix 会有两个毛病：对 H1 行套 H2 得到「## # 标题」，
 * 对 H2 行套 H1 又会按前缀长度误删字符；而且「已是 H1 再点 H1」只删前两个字符。
 * 这里按目标级别整体替换；若所有行本就是该级别，则视为取消，降为正文。
 */
function setHeading(level: 1 | 2 | 3) {
	if (!view) return;
	const state = view.state;
	const lineNumbers = new Set<number>();
	for (const range of state.selection.ranges) {
		const first = state.doc.lineAt(range.from).number;
		const last = state.doc.lineAt(range.to).number;
		for (let n = first; n <= last; n++) lineNumbers.add(n);
	}
	const lines = [...lineNumbers]
		.sort((x, y) => x - y)
		.map((n) => state.doc.line(n));
	const existing = /^#{1,6}\s+/;
	const allAtLevel = lines.every((line) => {
		const indent = line.text.match(/^\s*/)?.[0] ?? "";
		const m = existing.exec(line.text.slice(indent.length));
		return m ? m[0].trimEnd().length === level : false;
	});
	const changes: Array<{ from: number; to: number; insert: string }> = [];
	for (const line of lines) {
		const indent = line.text.match(/^\s*/)?.[0] ?? "";
		const start = line.from + indent.length;
		const m = existing.exec(line.text.slice(indent.length));
		changes.push({
			from: start,
			to: start + (m ? m[0].length : 0),
			insert: allAtLevel ? "" : "#".repeat(level) + " ",
		});
	}
	view.dispatch({ changes, scrollIntoView: true });
	view.focus();
}

/** 在光标处插入文本块；cursorOffsetFromEnd 控制插入后光标相对块尾的位置 */
function insertBlock(text: string, cursorOffsetFromEnd = 0) {
	if (!view) return;
	const pos = view.state.selection.main.to;
	const needsLeadingNl = view.state.doc.lineAt(pos).text.trim() !== "";
	const insert = `${needsLeadingNl ? "\n\n" : ""}${text}`;
	view.dispatch({
		changes: { from: pos, insert },
		selection: { anchor: pos + insert.length - cursorOffsetFromEnd },
		scrollIntoView: true,
	});
	view.focus();
}

function command(id: string): boolean {
	if (!view) return true;
	switch (id) {
		case "undo":
			undo(view);
			break;
		case "redo":
			redo(view);
			break;
		case "bold":
			wrap("**", "**", "粗体文本");
			break;
		case "italic":
			wrap("*", "*", "斜体文本");
			break;
		case "strikethrough":
			wrap("~~", "~~", "删除文本");
			break;
		case "inlineCode":
			wrap("`", "`", "code");
			break;
		case "codeBlock":
			insertBlock("```ts\n\n```\n", 5);
			break;
		case "h1":
			setHeading(1);
			break;
		case "h2":
			setHeading(2);
			break;
		case "h3":
			setHeading(3);
			break;
		case "ul":
			toggleLinePrefix("- ");
			break;
		case "ol":
			toggleLinePrefix("1. ");
			break;
		case "task":
			toggleLinePrefix("- [ ] ");
			break;
		case "quote":
			toggleLinePrefix("> ");
			break;
		case "table":
			openInsertModal(
				"插入表格",
				[
					{ key: "rows", label: "数据行数", placeholder: "2" },
					{ key: "cols", label: "列数", placeholder: "3" },
				],
				(v) => {
					const rows = Math.min(
						Math.max(Number.parseInt(v.rows || "2", 10) || 2, 1),
						20,
					);
					const cols = Math.min(
						Math.max(Number.parseInt(v.cols || "3", 10) || 3, 1),
						8,
					);
					const head =
						"| " +
						Array.from({ length: cols }, (_, i) => `表头${i + 1}`).join(" | ") +
						" |";
					const sep =
						"| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
					const bodyRows = Array.from(
						{ length: rows },
						() =>
							"| " +
							Array.from({ length: cols }, () => "内容").join(" | ") +
							" |",
					);
					insertBlock([head, sep, ...bodyRows].join("\n") + "\n");
				},
			);
			break;
		case "hr":
			insertBlock("---\n");
			break;
		case "link":
			openInsertModal(
				"插入链接",
				[
					{
						key: "text",
						label: "链接文字",
						defaultFrom: textFromSelection,
						placeholder: "链接文字（留空则用 URL）",
					},
					{
						key: "url",
						label: "URL",
						defaultFrom: urlFromText,
						fillFromClipboard: true,
						placeholder: "https://",
					},
				],
				(v) =>
					insertAtSelection(
						`[${v.text || v.url || "链接文字"}](${v.url || "https://"})`,
					),
			);
			break;
		case "image":
			openInsertModal(
				"插入图片",
				[
					{
						key: "alt",
						label: "图片描述",
						defaultFrom: textFromSelection,
						placeholder: "图片描述",
					},
					{
						key: "url",
						label: "图片地址",
						defaultFrom: urlFromText,
						fillFromClipboard: true,
						placeholder: "./images/图片.png 或 https://",
					},
				],
				(v) => insertAtSelection(`![${v.alt || "图片"}](${v.url || ""})\n`),
				{ imagePicker: true },
			);
			break;
		case "callout":
			insertBlock("> [!NOTE] 标题\n> 提示内容\n");
			break;
		case "container":
			insertBlock(":::tip 标题\n\n内容\n\n:::\n");
			break;
		case "spoiler":
			wrap(":spoiler[", "]", "被隐藏的内容");
			break;
		case "wiki":
			openInsertModal(
				"插入内部链接",
				[
					{
						key: "slug",
						label: "文章 slug",
						placeholder: "firefly 或 guide/index",
					},
					{
						key: "alias",
						label: "显示文字（可选）",
						defaultFrom: (s) => s.trim() || undefined,
						placeholder: "留空使用 slug",
					},
				],
				(v) =>
					insertAtSelection(
						`[[${v.slug || ""}${v.alias ? "|" + v.alias : ""}]]`,
					),
			);
			break;
		case "katex":
			wrap("$", "$", "E=mc^2");
			break;
		case "katexBlock":
			openInsertModal(
				"插入块级公式",
				[
					{
						key: "tex",
						label: "LaTeX 公式",
						textarea: true,
						placeholder: "\\frac{a}{b}",
					},
				],
				(v) => insertBlock(`$$\n${v.tex || ""}\n$$\n`),
			);
			break;
		case "mermaid":
			openInsertModal(
				"插入 Mermaid 图表",
				[
					{
						key: "code",
						label: "Mermaid 代码",
						textarea: true,
						placeholder: "graph TD\n  A[开始] --> B{条件}",
					},
				],
				(v) => insertBlock("```mermaid\n" + (v.code || "") + "\n```\n"),
			);
			break;
		case "plantuml":
			insertBlock("```plantuml\n@startuml\nA -> B\n@enduml\n```\n");
			break;
		case "codeGroup":
			insertBlock("::: code-group labels=[app.js]\n\n```js\n\n```\n:::\n", 9);
			break;
		case "githubCard":
			openInsertModal(
				"插入 GitHub 仓库卡片",
				[
					{
						key: "repo",
						label: "仓库",
						placeholder: "owner/repo，或直接粘贴仓库链接",
						defaultFrom: githubRepoFromText,
						fillFromClipboard: true,
						hint: (value) => {
							const r = githubRepoFromText(value);
							if (!value.trim())
								return {
									text: "支持 owner/repo，或直接粘贴 github.com 仓库链接",
									ok: false,
								};
							if (r) return { text: `✓ ${r}`, ok: true };
							return { text: "格式应为 owner/repo", ok: false };
						},
					},
				],
				(v) => {
					// 提交时再归一化一次：用户可能直接把整条链接粘进输入框
					const repo = githubRepoFromText(v.repo) ?? v.repo;
					insertAtSelection(`::github{repo="${repo || "owner/repo"}"}\n`);
				},
			);
			break;
		case "grid":
			insertBlock(
				"[grid]\n![图一](./images/1.png)\n![图二](./images/2.png)\n[/grid]\n",
			);
			break;
		case "foldYaml":
			toggleFrontmatterFold();
			break;
		case "video":
			openInsertModal(
				"插入视频",
				[
					{
						key: "url",
						label: "视频链接",
						placeholder: "粘贴 B站 / YouTube 链接，或裸 BV 号",
						defaultFrom: (s) => (videoEmbedFromText(s) ? s.trim() : undefined),
						fillFromClipboard: true,
						hint: (value) => {
							if (!value.trim())
								return {
									text: "自动识别 B站（BV号 / av号 / 分P）与 YouTube（watch / youtu.be / shorts）",
									ok: false,
								};
							const code = videoEmbedFromText(value);
							if (!code) return { text: "未能识别，请检查链接", ok: false };
							return {
								text: code.includes("bilibili")
									? "✓ 已识别：哔哩哔哩"
									: code.includes("youtube")
										? "✓ 已识别：YouTube"
										: "✓ 通用 iframe 嵌入",
								ok: true,
							};
						},
					},
				],
				(v) => {
					const code = videoEmbedFromText(v.url) ?? "";
					insertBlock(code ? `${code}\n` : "");
				},
			);
			break;
		case "iframe":
			openInsertModal(
				"插入内嵌框架",
				[
					{
						key: "url",
						label: "页面地址",
						placeholder: "https://",
						defaultFrom: urlFromText,
						fillFromClipboard: true,
					},
				],
				(v) => {
					const url = urlFromText(v.url) ?? v.url;
					insertBlock(
						`<iframe src="${url || "https://"}" width="100%" height="400"></iframe>\n`,
					);
				},
			);
			break;
		case "wikicard":
			insertBlock("[[文章slug]]\n");
			break;
		case "codeln":
			insertBlock("```js showLineNumbers\n\n```\n", 4);
			break;
		case "codemark":
			insertBlock('```js {2} mark="重点"\n\n```\n', 4);
			break;
		case "codeframe":
			insertBlock('```js frame="editor" title="文件名"\n\n```\n', 4);
			break;
		case "codecollapse":
			insertBlock("```js collapse={1-4}\n\n```\n", 4);
			break;
		case "codeansi":
			insertBlock("```ansi\n\u001b[32m绿色文本\u001b[0m\n```\n");
			break;
		case "admonitionObsidian":
			insertBlock("!!! note 标题\n    内容\n");
			break;
	}
	return true;
}

/* --------------------- 参数弹窗（插入类命令） --------------------- */

type ModalField = {
	key: string;
	label: string;
	placeholder?: string;
	textarea?: boolean;
	/**
	 * 从「当前选中文本」派生该字段的初始值，返回 undefined 表示留空。
	 * 用回调而不是布尔开关，是因为链接类命令需要判断选中内容是不是链接：
	 * 是则填 URL 框，否则填文字框，开关表达不了这种分流。
	 */
	defaultFrom?: (selected: string) => string | undefined;
	/** 没有选中文本时，若剪贴板里是链接则用其预填该字段 */
	fillFromClipboard?: boolean;
	/**
	 * 输入框内容变化时的实时识别提示（如「✓ 已识别：哔哩哔哩」）。
	 * 返回 ok=true 表示已能识别；用于把整条链接填进去却没提取出关键部分时
	 * 给用户一眼可见的确认——这正是此前「填完整链接还显示完整链接」的痛点。
	 */
	hint?: (value: string) => { text: string; ok: boolean };
};

/**
 * 判断一段文本是否可以直接当链接用。
 * 需要区分 `example.com/a.png` 与 `my-post.md` ——后者是文件名不是域名，
 * 否则选中文件名按 Ctrl+K 会把它误当成网址。
 */
function looksLikeUrl(text: string): boolean {
	const t = text.trim();
	if (!t || /\s/.test(t)) return false; // 链接不含空白
	// 明确的协议头或站内路径
	if (/^(https?:\/\/|mailto:|tel:|ftp:\/\/|#|\.{0,2}\/)/i.test(t)) return true;
	// 裸域名：example.com、sub.example.com/path
	const matched = /^([\w-]+(?:\.[\w-]+)+)(?::\d+)?(\/\S*)?$/.exec(t);
	if (!matched) return false;
	const tld = matched[1].split(".").pop() ?? "";
	if (tld.length < 2 || /\d/.test(tld)) return false;
	// 常见文档 / 图片扩展名视为文件名，不是域名
	return !/\.(md|mdx|markdown|txt|jsonc?|ya?ml|jsx?|tsx?|svelte|astro|png|jpe?g|gif|webp|avif|svg|css|styl|html?|pdf|zip)$/i.test(
		t,
	);
}

/** 内容是链接就作为 URL，否则留空 */
function urlFromText(text: string): string | undefined {
	const t = text.trim();
	return looksLikeUrl(t) ? t : undefined;
}

/** 内容不是链接时作为链接文字（避免把网址重复填进文字框） */
function textFromSelection(text: string): string | undefined {
	const t = text.trim();
	return t && !looksLikeUrl(t) ? t : undefined;
}

/**
 * 从 GitHub 仓库链接里取出 `owner/repo`。
 * 直接粘贴 `https://github.com/CuteLeaf/Firefly`（还常带 /tree/main、.git）
 * 时应该只留下 owner/repo，否则整条链接会被塞进 ::github{repo="..."} 里。
 */
function githubRepoFromText(text: string): string | undefined {
	const t = text.trim().replace(/\.git$/i, "");
	if (!t) return undefined;
	const matched =
		/(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)/i.exec(t);
	if (matched) return `${matched[1]}/${matched[2]}`;
	// 本来就填的是 owner/repo
	if (/^[\w.-]+\/[\w.-]+$/.test(t)) return t;
	return undefined;
}

/**
 * 从视频链接里识别平台与关键 ID，生成 <iframe> 嵌入代码。
 * 移植自 Firefly-Markdown：支持 B 站（BV 号 / av 号 / 分 P）、
 * YouTube（watch / youtu.be / shorts），以及其它 https 链接的通用 iframe 回退。
 * 返回 null 表示无法识别（提示「请检查链接」）。
 */
function videoEmbedFromText(
	input: string,
	w = "100%",
	h = 468,
	autoplay = false,
): string | null {
	const s = input.trim();
	if (!s) return null;
	const biliM = /(?:bilibili\.com\/video\/)?(BV[\w]{10})/i.exec(s);
	const biliAvM = /(?:bilibili\.com\/video\/)?av(\d+)/i.exec(s);
	const pageM = /[?&]p=(\d+)/.exec(s);
	const ytM =
		/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i.exec(
			s,
		);
	const bv = biliM ? biliM[1] : null;
	const av = biliAvM ? biliAvM[1] : null;
	const page = pageM ? Number(pageM[1]) : 1;
	const yt = ytM ? ytM[1] : null;
	if (bv || av) {
		const q =
			(bv ? "bvid=" + bv : "aid=" + av) +
			`&p=${page}&autoplay=${autoplay ? 1 : 0}&high_quality=1&danmaku=0`;
		return `<iframe width="${w}" height="${h}" src="//player.bilibili.com/player.html?${q}" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`;
	}
	if (yt)
		return `<iframe width="${w}" height="${h}" src="https://www.youtube.com/embed/${yt}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
	if (/^https?:\/\//i.test(s))
		return `<iframe width="${w}" height="${h}" src="${s}" frameborder="0" allowfullscreen></iframe>`;
	return null;
}

/** 弹窗打开后聚焦首个输入框，方便直接输入与按 Esc 关闭 */
function autofocusFirst(
	node: HTMLInputElement | HTMLTextAreaElement,
	enabled: boolean,
) {
	if (!enabled) return;
	requestAnimationFrame(() => {
		node.focus();
		if (node instanceof HTMLInputElement) node.select();
	});
}

/* ---------- 行级编辑快捷键（移植自 Firefly-Markdown） ---------- */

/** 向上 / 下移动选中行或光标所在行 */
function moveLine(view: EditorView, dir: -1 | 1): boolean {
	const { state } = view;
	const sel = state.selection.main;
	const top = state.doc.lineAt(sel.from);
	const bot = state.doc.lineAt(sel.to);
	if (dir < 0) {
		if (top.number === 1) return true;
		const prev = state.doc.line(top.number - 1);
		const block = prev.text + "\n" + state.sliceDoc(top.from, bot.to);
		const delta = prev.text.length + 1;
		view.dispatch({
			changes: { from: prev.from, to: bot.to, insert: block },
			selection: EditorSelection.range(sel.from - delta, sel.to - delta),
			scrollIntoView: true,
		});
	} else {
		if (bot.number === state.doc.lines) return true;
		const next = state.doc.line(bot.number + 1);
		const block = state.sliceDoc(top.from, bot.to) + "\n" + next.text;
		const delta = next.text.length + 1;
		view.dispatch({
			changes: { from: top.from, to: next.to, insert: block },
			selection: EditorSelection.range(sel.from + delta, sel.to + delta),
			scrollIntoView: true,
		});
	}
	return true;
}

/** 复制光标所在行（或选中行）到其下方 */
function duplicateLine(view: EditorView): boolean {
	const { state } = view;
	const sel = state.selection.main;
	const top = state.doc.lineAt(sel.from);
	const bot = state.doc.lineAt(sel.to);
	const text = state.sliceDoc(top.from, bot.to);
	view.dispatch({
		changes: { from: bot.to, insert: "\n" + text },
		selection: EditorSelection.range(
			sel.from + text.length + 1,
			sel.to + text.length + 1,
		),
		scrollIntoView: true,
	});
	return true;
}

/** 删除光标所在行（或选中行） */
function deleteLine(view: EditorView): boolean {
	const { state } = view;
	const sel = state.selection.main;
	const top = state.doc.lineAt(sel.from);
	const bot = state.doc.lineAt(sel.to);
	const end = bot.to + (bot.number === state.doc.lines ? 0 : 1);
	view.dispatch({
		changes: { from: top.from, to: end, insert: "" },
		selection: EditorSelection.cursor(Math.min(top.from, state.doc.length)),
		scrollIntoView: true,
	});
	return true;
}

let insertModal = $state<{
	title: string;
	fields: ModalField[];
	values: Record<string, string>;
	build: (values: Record<string, string>, selectedText: string) => void;
	imagePicker?: boolean;
} | null>(null);

/* 插入图片：可选图片库（文章图片 ./images / 站点图片 /images / cfbed 图床） */
type BedImage = { name: string; url: string; previewUrl: string };
type BedSource = "content" | "public" | "cfbed";
/** 默认文章图片（./images/...），最贴合写文章时引用协同图片的场景 */
let bedSource = $state<BedSource>("content");
let bedImages = $state<BedImage[]>([]);
let bedLoading = $state(false);
let bedUploading = $state(false);
let bedError = $state("");
/** 插入图片弹窗里的图床/本地库文件夹导航 */
let bedFolder = $state("");
let bedFolders = $state<string[]>([]);
const bedBreadcrumb = $derived(bedFolder ? bedFolder.split("/") : []);
const bedSubfolders = $derived(
	[
		...new Set(
			bedFolders
				.map((f) => f.split("/")[0])
				.filter((s): s is string => Boolean(s)),
		),
	].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
);

/** 打开参数弹窗：build 决定如何把生成文本插入编辑器 */
function openInsertModal(
	title: string,
	fields: ModalField[],
	build: (values: Record<string, string>, selectedText: string) => void,
	opts: { imagePicker?: boolean } = {},
) {
	if (!view) return;
	const selectedText = view.state.sliceDoc(
		view.state.selection.main.from,
		view.state.selection.main.to,
	);
	const values: Record<string, string> = {};
	for (const f of fields) {
		values[f.key] = f.defaultFrom?.(selectedText) ?? "";
	}
	insertModal = { title, fields, values, build, ...opts };
	if (opts.imagePicker) void loadBedImages();
	// 没选中内容时，剪贴板里的链接自动补进 URL 字段（省一次手动粘贴）
	if (!selectedText && fields.some((f) => f.fillFromClipboard)) {
		void fillUrlFromClipboard(fields);
	}
}

/** 读取剪贴板，是链接就填进标记了 fillFromClipboard 的字段 */
async function fillUrlFromClipboard(fields: ModalField[]) {
	let text = "";
	try {
		text = (await navigator.clipboard.readText())?.trim() ?? "";
	} catch {
		return; // 未授权或非安全上下文，静默跳过
	}
	if (!text || !looksLikeUrl(text)) return;
	for (const f of fields) {
		if (!f.fillFromClipboard || !insertModal) continue;
		const value = f.defaultFrom?.(text);
		if (value) insertModal.values[f.key] = value;
	}
}

function bedOpenFolder(path: string) {
	bedFolder = path;
	void loadBedImages();
}

function bedJumpTo(index: number) {
	bedFolder = index < 0 ? "" : bedBreadcrumb.slice(0, index + 1).join("/");
	void loadBedImages();
}

async function loadBedImages() {
	bedLoading = true;
	bedError = "";
	try {
		const params = new URLSearchParams({ count: "24" });
		if (bedSource === "cfbed") {
			params.set("storage", "cfbed");
		} else {
			params.set("storage", "local");
			params.set("root", bedSource); // content | public
		}
		if (bedFolder) params.set("folder", bedFolder);
		const res = await fetch(`/api/admin/images/?${params.toString()}`);
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			configured?: boolean;
			error?: string;
			images?: Array<{ name: string; url: string; previewUrl?: string }>;
			folders?: string[];
		} | null;
		if (res.ok && json?.ok) {
			bedImages = (json.images ?? []).slice(0, 24).map((i) => ({
				name: i.name,
				url: i.url,
				previewUrl: i.previewUrl ?? i.url,
			}));
			bedFolders = json.folders ?? [];
		} else {
			bedError = json?.error ?? "图片加载失败";
		}
	} catch {
		bedError = "图片加载失败";
	} finally {
		bedLoading = false;
	}
}

async function uploadBedImage(file: File) {
	bedUploading = true;
	bedError = "";
	try {
		const form = new FormData();
		form.append("storage", bedSource === "cfbed" ? "cfbed" : "local");
		if (bedSource !== "cfbed") form.append("root", bedSource);
		if (bedFolder) form.append("folder", bedFolder);
		form.append("file", file);
		const res = await fetch("/api/admin/images/", {
			method: "POST",
			body: form,
		});
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			images?: Array<{ name: string; url: string; previewUrl?: string }>;
		} | null;
		if (!res.ok || !json?.ok) {
			bedError = json?.error ?? "上传失败";
			return;
		}
		const img = (json.images ?? [])[0];
		if (img && insertModal) {
			insertModal.values.url = img.url;
			insertModal.values.alt =
				insertModal.values.alt ||
				file.name.replace(/\.[a-z0-9]+$/i, "") ||
				"图片";
		}
		void loadBedImages();
	} catch {
		bedError = "上传请求失败";
	} finally {
		bedUploading = false;
	}
}

function pickBedImage(img: BedImage) {
	if (!insertModal) return;
	insertModal.values.url = img.url;
	insertModal.values.alt =
		insertModal.values.alt ||
		img.name
			.split("/")
			.pop()
			?.replace(/\.[a-z0-9]+$/i, "") ||
		"图片";
}

/** 用弹窗结果替换选区 / 插入到光标处 */
function insertAtSelection(text: string) {
	if (!view) return;
	const { from, to } = view.state.selection.main;
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
		scrollIntoView: true,
	});
	view.focus();
}

function submitInsertModal() {
	if (!insertModal) return;
	const values = { ...insertModal.values };
	const build = insertModal.build;
	insertModal = null;
	build(values, selectedTextOf());
}

function selectedTextOf(): string {
	if (!view) return "";
	return view.state.sliceDoc(
		view.state.selection.main.from,
		view.state.selection.main.to,
	);
}

/* --------------------- 斜杠命令（/ 唤出） --------------------- */

type SlashItem = { id: string; name: string; desc: string };

const SLASH_ITEMS: SlashItem[] = [
	{ id: "h1", name: "一级标题", desc: "# 标题" },
	{ id: "h2", name: "二级标题", desc: "## 标题" },
	{ id: "h3", name: "三级标题", desc: "### 标题" },
	{ id: "bold", name: "粗体", desc: "**文本**" },
	{ id: "italic", name: "斜体", desc: "*文本*" },
	{ id: "strikethrough", name: "删除线", desc: "~~文本~~" },
	{ id: "ul", name: "无序列表", desc: "- 项目" },
	{ id: "ol", name: "有序列表", desc: "1. 项目" },
	{ id: "task", name: "任务列表", desc: "- [ ] 待办" },
	{ id: "quote", name: "引用", desc: "> 引用" },
	{ id: "callout", name: "提示块 Callout", desc: "> [!TIP] 支持 NOTE/TIP/…" },
	{ id: "container", name: "容器指令", desc: ":::tip 标题" },
	{ id: "spoiler", name: "剧透遮罩", desc: ":spoiler[…]" },
	{ id: "codeBlock", name: "代码块", desc: "``` 语言" },
	{ id: "codeln", name: "代码块（行号）", desc: "showLineNumbers" },
	{ id: "codemark", name: "代码块（行标记）", desc: '{2} mark="重点"' },
	{ id: "codeframe", name: "代码块（窗口框）", desc: 'frame="editor"' },
	{ id: "codecollapse", name: "代码块（折叠）", desc: "collapse={1-4}" },
	{ id: "codeansi", name: "终端输出（ANSI）", desc: "```ansi" },
	{ id: "codeGroup", name: "Tab 代码组", desc: "::: code-group" },
	{ id: "link", name: "链接", desc: "[文字](url)" },
	{ id: "image", name: "图片", desc: "![alt](url)" },
	{ id: "grid", name: "图片画廊", desc: "[grid]…[/grid]" },
	{ id: "table", name: "表格", desc: "生成表格" },
	{ id: "hr", name: "分割线", desc: "---" },
	{ id: "wiki", name: "内部链接", desc: "[[slug|别名]]" },
	{ id: "wikicard", name: "文章卡片", desc: "[[slug]] 独占一段" },
	{ id: "katex", name: "行内公式", desc: "$…$ KaTeX" },
	{ id: "katexBlock", name: "块级公式", desc: "$$…$$ KaTeX" },
	{ id: "mermaid", name: "Mermaid 图表", desc: "```mermaid" },
	{ id: "plantuml", name: "PlantUML", desc: "```plantuml" },
	{ id: "githubCard", name: "GitHub 卡片", desc: '::github{repo="o/r"}' },
	{ id: "video", name: "视频嵌入", desc: "B站播放器" },
	{ id: "iframe", name: "Iframe", desc: "自定义嵌入" },
	{ id: "admonitionObsidian", name: "提示块（Obsidian）", desc: "!!! note" },
];

let slash = $state<{
	open: boolean;
	idx: number;
	start: number;
	/** 菜单是正文里输入 "/" 唤出的（true），还是工具栏按钮唤出的（false） */
	hasSlash: boolean;
	query: string;
	left: number;
	top: number;
	items: SlashItem[];
}>({
	open: false,
	idx: 0,
	start: -1,
	hasSlash: false,
	query: "",
	left: 0,
	top: 0,
	items: [],
});

let stats = $state({
	words: 0,
	chars: 0,
	lines: 0,
	minutes: 0,
	line: 1,
	col: 1,
	/** 当前选区字符数，0 表示无选区 */
	sel: 0,
});

function computeStats() {
	if (!view) return;
	const doc = view.state.doc;
	const text = doc.toString();
	// 中文字符按字计，连续西文按词计（与博客 reading-time 口径接近）
	const cjk = (text.match(/[一-鿿]/g) ?? []).length;
	const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
	const words = cjk + latin;
	const sel = view.state.selection.main;
	stats = {
		words,
		chars: text.replace(/\s/g, "").length,
		lines: doc.lines,
		minutes: Math.max(1, Math.ceil(words / 400)),
		line: doc.lineAt(sel.head).number,
		col: sel.head - doc.lineAt(sel.head).from + 1,
		sel: Math.abs(sel.to - sel.from),
	};
}

function slashFiltered(query: string): SlashItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return SLASH_ITEMS;
	return SLASH_ITEMS.filter(
		(x) => x.name.toLowerCase().includes(q) || x.desc.toLowerCase().includes(q),
	);
}

function openSlashAt(pos: number, hasSlash = true) {
	if (!view) return;
	const coords = view.coordsAtPos(pos);
	if (!coords) return;
	const items = slashFiltered("");
	slash = {
		open: true,
		idx: 0,
		start: pos,
		hasSlash,
		query: "",
		left: Math.min(Math.max(coords.left, 8), window.innerWidth - 252),
		top: Math.min(coords.bottom + 6, window.innerHeight - 300),
		items,
	};
}

function closeSlash() {
	slash = { ...slash, open: false };
}

/** 菜单打开时点击菜单以外的地方即关闭（点编辑器重定位光标等场景） */
function onWindowMousedown(event: MouseEvent) {
	if (!slash.open) return;
	const target = event.target as HTMLElement | null;
	if (target?.closest(".admin-slash-menu")) return;
	closeSlash();
}

/** 斜杠菜单 DOM 引用：方向键移动高亮项时把它滚进可视区 */
let slashMenuEl = $state<HTMLDivElement | undefined>();
$effect(() => {
	if (!slash.open) return;
	const active = slash.idx;
	slashMenuEl
		?.querySelector<HTMLElement>(`.admin-slash-item[data-idx="${active}"]`)
		?.scrollIntoView({ block: "nearest" });
});

function updateSlashFilter() {
	if (!view || !slash.open) return;
	const head = view.state.selection.main.head;
	// 输入 "/" 唤出时查询词从 "/" 之后算起；工具栏唤出时前面没有 "/"，从起点算起
	const from = slash.start + (slash.hasSlash ? 1 : 0);
	if (head < from) {
		closeSlash();
		return;
	}
	const query = view.state.doc.sliceString(from, head);
	// 输入空格或换行即关闭
	if (/\s/.test(query)) {
		closeSlash();
		return;
	}
	const items = slashFiltered(query);
	if (items.length === 0) {
		closeSlash();
		return;
	}
	slash = {
		...slash,
		query,
		items,
		idx: Math.min(slash.idx, items.length - 1),
	};
}

function slashMove(delta: number) {
	const total = slash.items.length;
	slash = { ...slash, idx: (slash.idx + delta + total) % total };
}

/** 执行选中的斜杠命令：先删掉 "/查询词" 再应用命令 */
function runSlashItem(item: SlashItem) {
	if (!view) return;
	const head = view.state.selection.main.head;
	if (head > slash.start) {
		view.dispatch({
			changes: { from: slash.start, to: head, insert: "" },
			selection: { anchor: slash.start },
		});
	}
	closeSlash();
	command(item.id);
}

/** 斜杠菜单激活时的按键拦截（优先级最高） */
const slashKeymap = [
	{
		any: (_view: EditorView, event: KeyboardEvent) => {
			if (!slash.open) return false;
			if (
				["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
			) {
				event.preventDefault();
				if (event.key === "Escape") closeSlash();
				else if (event.key === "ArrowDown") slashMove(1);
				else if (event.key === "ArrowUp") slashMove(-1);
				else runSlashItem(slash.items[slash.idx]);
				return true;
			}
			return false;
		},
	},
];

/** 供父组件（工具栏）调用的命令入口 */
export function runCommand(id: string) {
	command(id);
}

/** 快捷键（仅 Markdown 文件生效） */
const markdownKeymap: Array<{ key: string; run: () => boolean }> = [
	{ key: "Mod-b", run: () => command("bold") },
	{ key: "Mod-i", run: () => command("italic") },
	{ key: "Mod-Shift-x", run: () => command("strikethrough") },
	{ key: "Mod-e", run: () => command("inlineCode") },
	{ key: "Mod-k", run: () => command("link") },
	{ key: "Mod-Shift-m", run: () => command("katex") },
	{ key: "Mod-Alt-c", run: () => command("codeBlock") },
	{ key: "Mod-Shift-q", run: () => command("quote") },
	{ key: "Mod-Shift-8", run: () => command("ul") },
	{ key: "Mod-Shift-7", run: () => command("ol") },
	{ key: "Mod-Shift-9", run: () => command("task") },
	{ key: "Mod-Alt-1", run: () => command("h1") },
	{ key: "Mod-Alt-2", run: () => command("h2") },
	{ key: "Mod-Alt-3", run: () => command("h3") },
];

/* --------------------- YAML frontmatter 折叠 --------------------- */

/** 让 frontmatter（首尾 `---` 包裹的 YAML 块）可以整体折叠 */
const frontmatterFold = foldService.of((state, from) => {
	const firstLine = state.doc.line(1);
	if (firstLine.text.trim() !== "---") return null;
	if (from < firstLine.from || from > firstLine.to) return null;
	for (let n = 2; n <= Math.min(state.doc.lines, 80); n++) {
		const line = state.doc.line(n);
		if (line.text.trim() === "---") {
			return { from: firstLine.from, to: line.to };
		}
	}
	return null;
});

function frontmatterRange(): { from: number; to: number } | null {
	if (!view) return null;
	const doc = view.state.doc;
	if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return null;
	for (let n = 2; n <= Math.min(doc.lines, 80); n++) {
		const line = doc.line(n);
		if (line.text.trim() === "---") {
			return { from: doc.line(1).from, to: line.to };
		}
	}
	return null;
}

function frontmatterIsFolded(range: { from: number; to: number }): boolean {
	if (!view) return false;
	let folded = false;
	view.state
		.field(foldState, false)
		?.between(range.from, range.from + 1, () => {
			folded = true;
		});
	return folded;
}

function toggleFrontmatterFold() {
	if (!view) return;
	const range = frontmatterRange();
	if (!range) return;
	if (frontmatterIsFolded(range)) {
		view.dispatch({
			effects: foldEffect.of({
				from: range.from,
				to: range.to,
				unrestricted: true,
			}),
		});
	} else {
		view.dispatch({
			effects: foldEffect.of({ from: range.from, to: range.to }),
		});
	}
	view.focus();
}

function languageExtensionsFor(filePath: string | null): Extension[] {
	if (!filePath) return [];
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	switch (ext) {
		case "md":
		case "mdx":
		case "markdown":
			return [
				markdown({ language: markdownLanguage }),
				frontmatterFold,
				keymap.of(markdownKeymap),
				keymap.of(slashKeymap),
			];
		case "yaml":
		case "yml":
			return yaml();
		case "ts":
		case "mts":
			return javascript({ typescript: true });
		case "js":
		case "mjs":
		case "cjs":
			return javascript();
		case "json":
		case "jsonc":
			return json();
		case "html":
		case "htm":
		case "astro":
		case "svelte":
			return html();
		case "css":
			return css();
		default:
			return [];
	}
}

$effect(() => {
	// 创建 EditorView：组件生命周期内仅一次。
	// 注意必须 untrack——effect 体内读取 value/path/disabled 等响应式 prop
	// 会让 Svelte 在每次输入时销毁并重建视图（滚动归零、光标丢失）；
	// 外部内容变化由下方的 value 同步 effect 处理，路径/只读/主题走 Compartment。
	if (!container) return;
	return untrack(() => {
		view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					EditorView.lineWrapping,
					codeFolding(),
					keymap.of([
						{ key: "Alt-ArrowUp", run: (v) => moveLine(v, -1) },
						{ key: "Alt-ArrowDown", run: (v) => moveLine(v, 1) },
						{ key: "Mod-d", run: duplicateLine, preventDefault: true },
						{ key: "Mod-Shift-k", run: deleteLine, preventDefault: true },
						indentWithTab,
					]),
					languageCompartment.of(languageExtensionsFor(path)),
					editableCompartment.of([
						EditorState.readOnly.of(disabled),
						EditorView.editable.of(!disabled),
					]),
					themeCompartment.of(themeExtension()),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							const doc = update.state.doc.toString();
							lastEmitted = doc;
							onDocChange?.(doc);
							// 斜杠命令：新输入的 "/" 前是行首或空白时唤出菜单
							if (slash.open) {
								updateSlashFilter();
							} else {
								for (const tr of update.transactions) {
									tr.changes.iterChanges(
										(_fromA, _toA, fromB, _toB, inserted) => {
											const insertedText = inserted.toString();
											if (!insertedText.endsWith("/")) return;
											// fromB 是「/」在文档中的起始位置（插入点），slash.start 必须指向它，
											// 否则 updateSlashFilter 用 sliceString(slash.start+1, head) 取查询词会错位，
											// 且「head <= slash.start」会在同一次更新里立刻把刚打开的菜单关掉。
											const slashPos = fromB;
											const line = update.state.doc.lineAt(slashPos);
											const before = line.text.slice(0, slashPos - line.from);
											if (before === "" || /\s$/.test(before)) {
												openSlashAt(slashPos);
											}
										},
									);
								}
							}
						}
						if (update.selectionSet && slash.open) updateSlashFilter();
						computeStats();
					}),
				],
			}),
		});
		// 初始化时先算一次：首次挂载不会触发 updateListener，否则状态栏字数一直是 0
		computeStats();
		return () => {
			view?.destroy();
			view = null;
			lastEmitted = null;
		};
	});
});

// 外部 value 变化时同步到编辑器（跳过内部输入触发的变化）
$effect(() => {
	const external = value;
	if (!view) return;
	if (external === lastEmitted) return;
	const current = view.state.doc.toString();
	if (external === current) return;
	view.dispatch({
		changes: { from: 0, to: current.length, insert: external },
	});
	// Markdown 文件在内容首次就绪后自动折叠 frontmatter（每个路径仅一次）
	if (
		path &&
		/\.(md|mdx|markdown)$/i.test(path) &&
		autoFoldedForPath !== path
	) {
		autoFoldedForPath = path;
		const range = frontmatterRange();
		if (range) {
			view.dispatch({
				effects: foldEffect.of({ from: range.from, to: range.to }),
			});
		}
	}
});

let autoFoldedForPath: string | null = null;

// 路径变化时切换语法高亮语言
$effect(() => {
	const filePath = path;
	if (!view) return;
	view.dispatch({
		effects: languageCompartment.reconfigure(languageExtensionsFor(filePath)),
	});
});

// disabled 状态切换
$effect(() => {
	const isDisabled = disabled;
	if (!view) return;
	view.dispatch({
		effects: editableCompartment.reconfigure([
			EditorState.readOnly.of(isDisabled),
			EditorView.editable.of(!isDisabled),
		]),
	});
});

// 明暗主题跟随后台（后台切换与博客设置面板切换都会改 <html> 的 dark 类）
$effect(() => {
	if (!view) return;
	const observer = new MutationObserver(() => {
		view?.dispatch({
			effects: themeCompartment.reconfigure(themeExtension()),
		});
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class"],
	});
	return () => observer.disconnect();
});

const toolbarGroups: Array<{
	items: Array<{ id: string; label: string; title: string }>;
}> = [
	{
		items: [
			{ id: "undo", label: "↶", title: "撤销" },
			{ id: "redo", label: "↷", title: "重做" },
		],
	},
	{
		items: [
			{ id: "h1", label: "H1", title: "一级标题（Ctrl+Alt+1）" },
			{ id: "h2", label: "H2", title: "二级标题（Ctrl+Alt+2）" },
			{ id: "h3", label: "H3", title: "三级标题（Ctrl+Alt+3）" },
		],
	},
	{
		items: [
			{ id: "bold", label: "B", title: "粗体（Ctrl+B）" },
			{ id: "italic", label: "I", title: "斜体（Ctrl+I）" },
			{
				id: "strikethrough",
				label: "S",
				title: "删除线（Ctrl+Shift+X）",
			},
			{ id: "inlineCode", label: "</>", title: "行内代码（Ctrl+E）" },
			{ id: "codeBlock", label: "代码块", title: "代码块（Ctrl+Alt+C）" },
		],
	},
	{
		items: [
			{ id: "link", label: "链接", title: "链接（Ctrl+K）" },
			{ id: "image", label: "图片", title: "图片" },
			{ id: "ul", label: "• 列表", title: "无序列表（Ctrl+Shift+8）" },
			{ id: "ol", label: "1. 列表", title: "有序列表（Ctrl+Shift+7）" },
			{
				id: "task",
				label: "☑ 任务",
				title: "任务列表（Ctrl+Shift+9）",
			},
			{ id: "quote", label: "引用", title: "引用（Ctrl+Shift+Q）" },
		],
	},
	{
		items: [
			{ id: "table", label: "表格", title: "插入表格" },
			{ id: "hr", label: "—", title: "分割线" },
			{
				id: "callout",
				label: "提示块",
				title:
					"Callout（> [!NOTE]，支持 NOTE/TIP/IMPORTANT/WARNING/CAUTION 等）",
			},
			{
				id: "container",
				label: "容器",
				title: "容器指令（:::tip / :::note / :::warning / :::danger）",
			},
			{ id: "spoiler", label: "剧透", title: "剧透（:spoiler[]）" },
		],
	},
	{
		items: [
			{
				id: "wiki",
				label: "维基",
				title: "内部链接 [[slug|显示文字]]",
			},
			{ id: "katex", label: "公式", title: "行内公式（Ctrl+Shift+M）" },
			{ id: "katexBlock", label: "公式块", title: "块级公式 $$" },
			{ id: "mermaid", label: "图表", title: "Mermaid 图表" },
			{ id: "plantuml", label: "UML", title: "PlantUML" },
			{ id: "codeGroup", label: "代码组", title: "Tab 代码组" },
			{
				id: "githubCard",
				label: "仓库卡",
				title: "GitHub 仓库卡片（::github{repo=...}）",
			},
			{ id: "grid", label: "图集", title: "图片网格 [grid]" },
		],
	},
];
</script>

<svelte:window onmousedown={onWindowMousedown} />

{#if isMarkdown && !disabled}
		<div
			class="flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-(--admin-line) bg-(--admin-panel) px-2 py-1.5"
		>
			{#each toolbarGroups as group, gi (gi)}
				<div
					class="flex items-center gap-0.5 {gi === toolbarGroups.length - 1 ? '' : 'mr-0.5 border-r border-(--admin-divider) pr-1.5'}"
				>
					{#each group.items as item (item.id)}
						<button
							type="button"
							class="rounded-md px-2 py-1 text-xs leading-none text-(--admin-text) transition-colors hover:bg-(--admin-panel-hover) hover:text-(--admin-text-strong) active:bg-(--admin-accent-soft)"
							title={item.title}
							onclick={() => runCommand(item.id)}
						>
							{item.label}
						</button>
					{/each}
				</div>
			{/each}
		</div>
{/if}

<div class="admin-codemirror min-h-0 flex-1" bind:this={container}></div>

{#if slash.open}
	<!-- 斜杠命令菜单：固定定位跟随光标 -->
	<div
		bind:this={slashMenuEl}
		class="admin-slash-menu"
		style={`left: ${slash.left}px; top: ${slash.top}px`}
		role="listbox"
	>
		{#each slash.items as item, i (item.id + i)}
			<button
				type="button"
				data-idx={i}
				class="admin-slash-item {i === slash.idx ? 'sel' : ''}"
				role="option"
				aria-selected={i === slash.idx}
				onmousedown={(e) => {
					e.preventDefault();
					runSlashItem(item);
				}}
				onmouseenter={() => (slash = { ...slash, idx: i })}
			>
				<span class="slash-name">{item.name}</span>
				<span class="slash-desc">{item.desc}</span>
			</button>
		{/each}
		{#if slash.items.length === 0}
			<div class="px-3 py-2 text-xs text-(--admin-text-faint)">没有匹配的命令</div>
		{/if}
		<div class="admin-slash-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
	</div>
{/if}

{#if view && !disabled}
	<!-- 状态栏 -->
	<div
		class="flex items-center gap-3 border-t border-(--admin-divider) px-3 py-1 text-[11px] text-(--admin-text-faint)"
	>
		<span><b class="text-(--admin-text)">{stats.words}</b> 字</span>
		<span><b class="text-(--admin-text)">{stats.chars}</b> 字符</span>
		<span><b class="text-(--admin-text)">{stats.lines}</b> 行</span>
		{#if stats.sel > 0}
			<span class="text-(--admin-accent-hover)">选中 <b>{stats.sel}</b> 字符</span>
		{/if}
		{#if isMarkdown}
			<span>约 <b class="text-(--admin-text)">{stats.minutes}</b> 分钟阅读</span>
		{/if}
		<span class="ml-auto font-mono">行 {stats.line}：列 {stats.col}</span>
		{#if isMarkdown}
			<span class="hidden sm:inline">输入 <b class="text-(--admin-text)">/</b> 唤出命令菜单</span>
		{/if}
	</div>
{/if}


<style>
	.admin-slash-menu {
		position: fixed;
		z-index: 80;
		width: 236px;
		max-height: 252px;
		overflow-y: auto;
		background: var(--card-bg);
		border: 1px solid var(--admin-line);
		border-radius: 10px;
		box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.35);
		padding: 5px;
	}
	.admin-slash-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 5px 8px;
		border-radius: 6px;
		text-align: left;
		transition: background 0.1s ease;
	}
	.admin-slash-item .slash-name {
		font-size: 12px;
		font-weight: 600;
		color: var(--admin-text-strong);
	}
	.admin-slash-item .slash-desc {
		font-size: 11px;
		color: var(--admin-text-faint);
		font-family: ui-monospace, monospace;
	}
	.admin-slash-item.sel,
	.admin-slash-item:hover {
		background: var(--admin-accent-soft);
	}
	.admin-slash-item.sel .slash-name,
	.admin-slash-item:hover .slash-name {
		color: var(--admin-accent-hover);
	}
	.admin-slash-hint {
		padding: 6px 9px 3px;
		border-top: 1px solid var(--admin-divider);
		margin-top: 4px;
		font-size: 10.5px;
		color: var(--admin-text-faint);
		text-align: center;
	}
</style>


{#if insertModal}
	<!-- 插入参数弹窗 -->
	<div
		class="admin-modal-backdrop"
		onclick={(e) => {
			if (e.target === e.currentTarget) insertModal = null;
		}}
		role="presentation"
	>
		<div
			class="admin-modal-panel"
			role="dialog"
			aria-modal="true"
			aria-label={insertModal.title}
		>
			<div class="admin-modal-head">
				<h3 class="admin-modal-title">{insertModal.title}</h3>
				<button
					type="button"
					class="admin-modal-close"
					title="关闭 (Esc)"
					aria-label="关闭"
					onclick={() => (insertModal = null)}
				>
					<svg viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4">
						<path
							d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"
						></path>
					</svg>
				</button>
			</div>
			<div class="admin-modal-body">
			<div class="space-y-3">
				{#each insertModal.fields as field, i (field.key)}
					<div>
						<label class="admin-label" for={`modal-${field.key}`}>
							{field.label}
						</label>
						{#if field.textarea}
							<textarea
								id={`modal-${field.key}`}
								class="admin-input min-h-24 font-mono"
								placeholder={field.placeholder}
								bind:value={insertModal.values[field.key]}
								use:autofocusFirst={i === 0}
								onkeydown={(e) => {
									if (e.key === "Escape") insertModal = null;
								}}
							></textarea>
						{:else}
							<input
								id={`modal-${field.key}`}
								type="text"
								class="admin-input"
								placeholder={field.placeholder}
								bind:value={insertModal.values[field.key]}
								use:autofocusFirst={i === 0}
								onkeydown={(e) => {
									if (e.key === "Enter") submitInsertModal();
									if (e.key === "Escape") insertModal = null;
								}}
							/>
						{/if}
						{#if field.hint}
							{@const h = field.hint(insertModal.values[field.key] ?? "")}
							<p
								class="mt-1.5 text-[11px] {h.ok
									? 'text-(--admin-accent)'
									: h.text
										? 'text-(--admin-warn)'
										: 'text-(--admin-text-faint)'}"
							>
								{h.text}
							</p>
						{/if}
					</div>
				{/each}
				{#if insertModal.imagePicker}
					<!-- 插入图片：选图片库 + 上传 + 最近图片 -->
					<div class="border-t border-(--admin-divider) pt-3">
						<div class="flex flex-wrap items-center gap-2">
							<span class="admin-label mr-1">图片库</span>
							<div class="flex rounded-lg border border-(--admin-line) bg-(--admin-panel) p-0.5 text-xs">
								<button
									type="button"
									onclick={() => { if (bedSource !== "content") { bedSource = "content"; bedFolder = ""; void loadBedImages(); } }}
									class="rounded-md px-2.5 py-1 font-medium transition-colors {bedSource === 'content' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
								>文章图片 ./images</button>
								<button
									type="button"
									onclick={() => { if (bedSource !== "public") { bedSource = "public"; bedFolder = ""; void loadBedImages(); } }}
									class="rounded-md px-2.5 py-1 font-medium transition-colors {bedSource === 'public' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
								>站点图片 /images</button>
								<button
									type="button"
									onclick={() => { if (bedSource !== "cfbed") { bedSource = "cfbed"; bedFolder = ""; void loadBedImages(); } }}
									class="rounded-md px-2.5 py-1 font-medium transition-colors {bedSource === 'cfbed' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
								>图床</button>
							</div>
							<label
								class="admin-btn admin-btn-ghost cursor-pointer !px-2.5 !py-1 text-xs {bedUploading ? 'pointer-events-none opacity-60' : ''} ml-auto"
							>
								{bedUploading ? "上传中…" : "上传到此库"}
								<input
									type="file"
									accept="image/*"
									class="hidden"
									onchange={(e) => {
										const input = e.currentTarget as HTMLInputElement;
										const file = input.files?.[0];
										if (file) void uploadBedImage(file);
										input.value = "";
									}}
								/>
						</label>
					</div>
					{#if bedBreadcrumb.length > 0}
						<div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
							<span class="text-(--admin-text-faint)">位置</span>
							<button type="button" onclick={() => bedJumpTo(-1)} class="rounded-md px-1.5 py-0.5 font-medium transition-colors {bedFolder === '' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}">根目录</button>
							{#each bedBreadcrumb as seg, i (i)}
								<span class="text-(--admin-text-faint)">/</span>
								<button type="button" onclick={() => bedJumpTo(i)} class="rounded-md px-1.5 py-0.5 font-medium transition-colors {i === bedBreadcrumb.length - 1 ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}">{seg}</button>
							{/each}
						</div>
					{/if}
					{#if bedSubfolders.length > 0}
						<div class="mt-2 flex flex-wrap gap-2">
							{#each bedSubfolders as sub (sub)}
								<button type="button" onclick={() => bedOpenFolder(bedFolder ? `${bedFolder}/${sub}` : sub)} class="flex items-center gap-2 rounded-lg border border-(--admin-line) bg-(--admin-panel) px-3 py-1.5 text-xs transition-colors hover:border-(--admin-accent)/50">
									<svg viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5 text-(--admin-accent-hover)"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"></path></svg>
									<span class="font-medium text-(--admin-text-strong)">{sub}</span>
								</button>
							{/each}
						</div>
					{/if}
					{#if bedError}
							<p class="mt-1.5 text-[11px] text-(--admin-text-faint)">{bedError}</p>
						{/if}
						{#if bedLoading}
							<div class="mt-2 grid grid-cols-4 gap-2">
								{#each Array(8) as _, i (i)}
									<div class="aspect-square animate-pulse rounded-lg bg-(--admin-soft)"></div>
								{/each}
							</div>
						{:else if bedImages.length > 0}
							<div class="mt-2 grid max-h-44 grid-cols-4 gap-2 overflow-y-auto">
								{#each bedImages as img (img.name)}
									<button
										type="button"
										onclick={() => pickBedImage(img)}
										class="aspect-square overflow-hidden rounded-lg border border-(--admin-line) transition-colors hover:border-(--admin-accent)"
										title={img.name}
									>
										<img src={img.previewUrl} alt={img.name} loading="lazy" class="h-full w-full object-cover" />
									</button>
								{/each}
							</div>
							<p class="mt-1.5 text-[11px] text-(--admin-text-faint)">
								点击图片填入地址；管理全部图片请到「图片管理」页
							</p>
						{:else if !bedLoading}
							<p class="mt-1.5 text-[11px] text-(--admin-text-faint)">
								该图片库暂无图片，可直接上传，或从上方切换其它图片库
							</p>
						{/if}
					</div>
				{/if}
			</div>
				</div>
			<div class="admin-modal-footer">
				<button
					type="button"
					class="admin-btn admin-btn-ghost"
					onclick={() => (insertModal = null)}
				>
					取消
				</button>
				<button
					type="button"
					class="admin-btn admin-btn-primary"
					onclick={submitInsertModal}
				>
					插入
				</button>
			</div>
		</div>
	</div>
{/if}
