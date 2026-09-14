<script lang="ts">
import { onMount } from "svelte";
import CodeEditor from "./CodeEditor.svelte";

interface Props {
	filePath: string;
}
const { filePath }: Props = $props();

type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "stringArray"
	| "numberArray";
type Leaf = {
	/** 点分路径，如 analyticsConfig.umamiAnalytics.websiteId */
	path: string;
	/** 最后一段 key（用于生成中文 label） */
	key: string;
	/** 中文标签：优先取配置源码中该字段正上方的注释，取不到再回退 humanize(key) */
	label?: string;
	type: FieldType;
	/** 当前值 */
	value: string | number | boolean | string[] | number[];
	/** 值在源文件中的字符区间（含端点），保存时精确替换 */
	start: number;
	end: number;
	/** 原始文本（仅作参考） */
	raw: string;
	/**
	 * 载入时的原始值：保存时用它判断字段是否真被改过。
	 * 不能拿「重新序列化后的文本」跟源码原文比 —— 多行数组、`1.0`、单引号字符串
	 * 都会因格式差异被误判成「已改动」，一保存就把没动过的字段整片重排了。
	 */
	orig: string | number | boolean | string[] | number[];
};

type Tok = {
	t: "ident" | "str" | "num" | "bool" | "punct" | "comment";
	v: string;
	s: number;
	e: number;
};

/** 去掉字符串两端的引号并解转义（尽力而为） */
function parseStr(raw: string): string {
	if (raw.startsWith('"')) {
		try {
			return JSON.parse(raw) as string;
		} catch {
			return raw.slice(1, -1);
		}
	}
	if (raw.startsWith("'")) {
		return raw
			.slice(1, -1)
			.replace(/\\'/g, "'")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	return raw;
}
function serStr(s: string): string {
	return JSON.stringify(s);
}

/** 把 camelCase / kebab 键名变成可读中文 label */
function humanize(key: string): string {
	return key
		.replace(/[-_]/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/^./, (c) => c.toUpperCase())
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 常见字段名的中文标签：配置源码里没写注释时的兜底。
 * 只覆盖高频且语义明确的 key（导航、友链、画廊、字体等对象数组里的 name/url/icon 这种），
 * 查不到再退回 humanize。源码注释优先级高于本表。
 */
const CN_KEY_LABELS: Record<string, string> = {
	name: "名称",
	title: "标题",
	url: "链接",
	link: "链接",
	siteurl: "站点地址",
	imgurl: "图片地址",
	icon: "图标",
	desc: "描述",
	description: "描述",
	weight: "权重",
	order: "排序",
	enabled: "启用",
	enable: "启用",
	disabled: "禁用",
	id: "ID",
	envid: "环境 ID",
	type: "类型",
	value: "值",
	valuedark: "暗色模式值",
	theme: "主题",
	alt: "替代文字",
	pagekey: "页面标识",
	external: "外部链接",
	children: "子项",
	method: "方式",
	mode: "模式",
	static: "静态",
	src: "资源地址",
	opacity: "不透明度",
	blur: "模糊半径",
	cardopacity: "卡片不透明度",
	cssvariable: "CSS 变量",
	provider: "字体来源",
	weights: "字重",
	styles: "样式",
	subsets: "字符集",
	fallbacks: "回退字体",
	variants: "变体",
	width: "宽度",
	height: "高度",
	x: "X 坐标",
	y: "Y 坐标",
	scale: "缩放",
	volume: "音量",
	text: "文本",
	content: "内容",
	closable: "可关闭",
	displaycount: "显示数量",
	all: "全部",
	date: "日期",
	tags: "标签",
	location: "地点",
	password: "密码",
	passwordhint: "密码提示",
	avatar: "头像",
	qrcode: "二维码",
	cover: "封面",
	artist: "艺术家",
	lrc: "歌词",
	playlist: "播放列表",
	amount: "金额",
	samplerate: "采样率",
	maxduration: "最大时长",
};

/** 中文标签：源码注释 > 常用词表 > humanize */
function chineseLabel(key: string, comment?: string): string {
	return comment ?? CN_KEY_LABELS[key.toLowerCase()] ?? humanize(key);
}

/** 注释能否当字段标签用：被注释掉的示例代码、裸链接、分隔线都不合适 */
function isUsableLabel(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (/^https?:\/\//i.test(t)) return false; // 裸链接
	if (/^[\w.$-]+\s*:\s*["'`[\d{]/.test(t)) return false; // key: "value" 形式的示例代码
	if (/^[=\-*#_~]{3,}/.test(t)) return false; // ==== 分隔线
	if (/[;{}]$/.test(t)) return false; // 以 ; { } 结尾的代码片段
	return true;
}

/** 去掉标签末尾的冒号/句号等，读起来更像标题 */
function cleanLabel(text: string): string {
	return text.trim().replace(/[：:。.,，;；]+$/, "");
}

/** 扫描 TS 对象字面量，抽出所有「原始值叶子」（字符串/数字/布尔/原始数组），记录精确区间 */
function parseLeaves(src: string): Leaf[] {
	const toks: Tok[] = [];
	let i = 0;
	const n = src.length;
	const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
	const isIdent = (c: string) => /[A-Za-z0-9_$-]/.test(c);
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			// 行注释保留为 token：字段正上方的注释会被当作该字段的中文标签
			const cs = i;
			while (i < n && src[i] !== "\n") i++;
			toks.push({
				t: "comment",
				v: src.slice(cs + 2, i).trim(),
				s: cs,
				e: i,
			});
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const cs = i;
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
			const body = src.slice(cs + 2, i);
			i += 2;
			toks.push({
				t: "comment",
				v: body
					.replace(/^\s*\*\s?/gm, "")
					.replace(/\s+/g, " ")
					.trim(),
				s: cs,
				e: i,
			});
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const q = c;
			let j = i + 1;
			let str = q;
			while (j < n) {
				if (src[j] === "\\") {
					str += src[j] + (src[j + 1] ?? "");
					j += 2;
					continue;
				}
				str += src[j];
				if (src[j] === q) {
					j++;
					break;
				}
				j++;
			}
			toks.push({ t: "str", v: str, s: i, e: j });
			i = j;
			continue;
		}
		if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < n && /[0-9.eE+-]/.test(src[j])) j++;
			toks.push({ t: "num", v: src.slice(i, j), s: i, e: j });
			i = j;
			continue;
		}
		if (isIdentStart(c)) {
			let j = i + 1;
			while (j < n && isIdent(src[j])) j++;
			const word = src.slice(i, j);
			if (word === "true" || word === "false" || word === "null") {
				toks.push({ t: "bool", v: word, s: i, e: j });
			} else {
				toks.push({ t: "ident", v: word, s: i, e: j });
			}
			i = j;
			continue;
		}
		if ("{}[]:;".includes(c)) {
			toks.push({ t: "punct", v: c, s: i, e: i + 1 });
			i++;
			continue;
		}
		i++; // 其它字符跳过
	}

	const leaves: Leaf[] = [];
	const stack: string[] = [];
	let k = 0;
	const at = (idx: number) => toks[idx];
	/**
	 * 取 key 紧邻上方的注释块作为中文标签：
	 * 向上收集连续的注释行（遇到空行或代码就断开），返回其中第一行「像说明文字」的，
	 * 跳过被注释掉的示例代码、裸链接与分隔线 —— 那些当标签没意义，宁可回退到词表。
	 */
	const labelFor = (keyIdx: number): string | undefined => {
		const keyTok = at(keyIdx);
		if (!keyTok) return undefined;
		const lines: string[] = [];
		let expectLine = src.slice(0, keyTok.s).split("\n").length - 1;
		for (let i = keyIdx - 1; i >= 0 && expectLine >= 1; i--) {
			const t = at(i);
			if (t.t !== "comment") break;
			if (src.slice(0, t.e).split("\n").length !== expectLine) break;
			lines.unshift(t.v);
			expectLine--;
		}
		for (const text of lines) {
			if (isUsableLabel(text)) return cleanLabel(text);
		}
		return undefined;
	};

	// 解析一个值 token，返回 { leaf?, skipTo } ；skipTo 为值结束后的 token 下标
	function parseValue(idx: number): { leaf: Leaf | null; skipTo: number } {
		const tok = at(idx);
		if (!tok) return { leaf: null, skipTo: idx + 1 };
		if (tok.t === "str") {
			return {
				leaf: {
					path: "",
					key: "",
					type: "string",
					value: parseStr(tok.v),
					start: tok.s,
					end: tok.e,
					raw: tok.v,
				},
				skipTo: idx + 1,
			};
		}
		if (tok.t === "num") {
			return {
				leaf: {
					path: "",
					key: "",
					type: "number",
					value: Number(tok.v),
					start: tok.s,
					end: tok.e,
					raw: tok.v,
				},
				skipTo: idx + 1,
			};
		}
		if (tok.t === "bool") {
			// null 不是布尔值：不放进表单，免得显示成「关闭的开关」、一改动就变成 false
			if (tok.v === "null") return { leaf: null, skipTo: idx + 1 };
			return {
				leaf: {
					path: "",
					key: "",
					type: "boolean",
					value: tok.v === "true",
					start: tok.s,
					end: tok.e,
					raw: tok.v,
				},
				skipTo: idx + 1,
			};
		}
		if (tok.t === "punct" && tok.v === "[") {
			// 只把「纯字符串 / 纯数字的一维数组」当作可编辑项：元素是对象
			// （如 links: [{name,url}]）或嵌套数组时一律不解析成表单字段，
			// 否则会被误当成 stringArray 拍平成 ["a","b"]，一保存就把结构毁了。
			let p = idx + 1;
			const elems: Array<{
				kind: "str" | "num";
				v: string;
				s: number;
				e: number;
			}> = [];
			let ok = true;
			let kind: "str" | "num" | null = null;
			let depth = 1;
			while (p < toks.length && depth > 0) {
				const t = at(p);
				if (!t) break;
				if (t.t === "punct" && t.v === "[") {
					depth++;
					ok = false; // 嵌套数组不编辑
				} else if (t.t === "punct" && (t.v === "{" || t.v === "}")) {
					ok = false; // 对象数组不编辑
				} else if (t.t === "punct" && t.v === "]") {
					depth--;
					if (depth === 0) {
						const closeE = t.e;
						p++;
						if (!ok || kind === null || elems.length === 0) {
							return { leaf: null, skipTo: p };
						}
						const arr = elems.map((x) =>
							kind === "str" ? parseStr(x.v) : x.v,
						);
						return {
							leaf: {
								path: "",
								key: "",
								type: kind === "str" ? "stringArray" : "numberArray",
								value:
									kind === "str"
										? (arr as string[])
										: (arr.map(Number) as number[]),
								start: tok.s,
								end: closeE,
								raw: src.slice(tok.s, closeE),
							},
							skipTo: p,
						};
					}
				} else if (t.t === "str" || t.t === "num") {
					if (kind === null) kind = t.t;
					else if (kind !== t.t) ok = false;
					elems.push({ kind: t.t, v: t.v, s: t.s, e: t.e });
				}
				p++;
			}
			return { leaf: null, skipTo: p };
		}
		return { leaf: null, skipTo: idx + 1 };
	}

	while (k < toks.length) {
		const tok = at(k);
		if (!tok) break;
		// key 候选：ident 或 str，后跟 ':'
		if (
			(tok.t === "ident" || tok.t === "str") &&
			at(k + 1)?.t === "punct" &&
			at(k + 1)?.v === ":"
		) {
			const keyName = tok.t === "str" ? parseStr(tok.v) : tok.v;
			const vIdx = k + 2;
			const vtok = at(vIdx);
			if (vtok && vtok.t === "punct" && vtok.v === "{") {
				stack.push(keyName);
				k = vIdx + 1;
				continue;
			}
			const res = parseValue(vIdx);
			if (res.leaf) {
				const path = [...stack, keyName].join(".");
				res.leaf.path = path;
				res.leaf.key = keyName;
				res.leaf.label = labelFor(k);
				// 记下原始值（数组复制一份，避免与 value 共享引用），保存时据此判断是否真改过
				res.leaf.orig = Array.isArray(res.leaf.value)
					? [...res.leaf.value]
					: res.leaf.value;
				leaves.push(res.leaf);
			}
			k = res.skipTo;
			continue;
		}
		if (tok.t === "punct" && tok.v === "}") {
			stack.pop();
			k++;
			continue;
		}
		k++;
	}
	// 收尾：同一路径可能出现多次 —— `links.push({ name, url, … })` 这类对象字面量
	// 没有外层 key，会被逐字段拍平成一堆同名的 name/url/icon。给重复项加编号，
	// 否则 Svelte 的 keyed each 会因为重复 key 直接抛错，而且 values 以 path 为键会互相覆盖。
	const pathTotal = new Map<string, number>();
	for (const l of leaves)
		pathTotal.set(l.path, (pathTotal.get(l.path) ?? 0) + 1);
	const pathSeen = new Map<string, number>();
	for (const l of leaves) {
		if ((pathTotal.get(l.path) ?? 0) <= 1) continue;
		const n = (pathSeen.get(l.path) ?? 0) + 1;
		pathSeen.set(l.path, n);
		l.path = `${l.path} #${n}`;
	}
	return leaves;
}

/** 值是否相等（数组按内容比较） */
function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return a === b;
}

/** 取 offset 所在行的行首缩进（空格 / 制表符） */
function indentAt(src: string, offset: number): string {
	const lineStart = src.lastIndexOf("\n", offset - 1) + 1;
	return /^[ \t]*/.exec(src.slice(lineStart, offset))?.[0] ?? "";
}

/**
 * 把改动后的叶子按精确区间替换回源文件（倒序替换避免位移）。
 * 只重写「值真的变了」的字段 —— 用 orig 比较而不是拿重新序列化的文本跟源码比，
 * 这样没动过的多行数组 / 1.0 / 单引号字符串不会被顺手重排。
 */
function applyLeaves(src: string, leaves: Leaf[]): string {
	const changed = leaves.filter((l) => !sameValue(l.value, l.orig));
	if (changed.length === 0) return src;
	changed.sort((a, b) => b.start - a.start);
	let out = src;
	for (const l of changed) {
		out =
			out.slice(0, l.start) +
			serialized(l, indentAt(src, l.start)) +
			out.slice(l.end);
	}
	return out;
}

/**
 * 序列化回源码。数组额外看原始写法：原本每个元素占一行的，
 * 就按同样风格重排 —— 免得只改了一个壁纸地址、整份配置被压成一行。
 */
function serialized(l: Leaf, indent = ""): string {
	switch (l.type) {
		case "string":
			return serStr(l.value as string);
		case "boolean":
			return l.value ? "true" : "false";
		case "number":
			return String(l.value);
		case "stringArray": {
			const items = (l.value as string[]).map(serStr);
			return l.raw.includes("\n")
				? `[\n${items.map((s) => `${indent}\t${s},`).join("\n")}\n${indent}]`
				: `[${items.join(", ")}]`;
		}
		case "numberArray": {
			const items = (l.value as number[]).map(String);
			return l.raw.includes("\n")
				? `[\n${items.map((s) => `${indent}\t${s},`).join("\n")}\n${indent}]`
				: `[${items.join(", ")}]`;
		}
	}
}

let raw = $state("");
let leaves = $state<Leaf[]>([]);
let values = $state<
	Record<string, string | number | boolean | string[] | number[]>
>({});
let mode = $state<"form" | "code">("form");
let codeText = $state("");
let loading = $state(true);
let loadingError = $state("");
let saving = $state(false);
let saveError = $state("");
let savedAt = $state(0);

function loadInto(src: string) {
	raw = src;
	leaves = parseLeaves(src);
	const init: Record<string, string | number | boolean | string[] | number[]> =
		{};
	for (const l of leaves) init[l.path] = l.value;
	values = init;
	codeText = src;
}

onMount(async () => {
	loading = true;
	loadingError = "";
	try {
		const res = await fetch(
			`/api/admin/files/file/?path=${encodeURIComponent(filePath)}`,
		);
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			content?: string;
		} | null;
		if (!res.ok || !json?.ok || typeof json.content !== "string") {
			loadingError = json?.error ?? "读取配置失败";
			return;
		}
		loadInto(json.content);
	} catch {
		loadingError = "读取配置失败";
	} finally {
		loading = false;
	}
});

async function save() {
	saving = true;
	saveError = "";
	try {
		const next =
			mode === "code"
				? codeText
				: applyLeaves(
						raw,
						leaves.map((l) => ({ ...l, value: values[l.path] ?? l.value })),
					);
		const res = await fetch("/api/admin/files/file/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "save", path: filePath, content: next }),
		});
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
		} | null;
		if (!res.ok || !json?.ok) {
			saveError = json?.error ?? "保存失败";
			return;
		}
		loadInto(next);
		savedAt = Date.now();
	} catch {
		saveError = "保存请求失败";
	} finally {
		saving = false;
	}
}

function setValue(
	path: string,
	v: string | number | boolean | string[] | number[],
) {
	values = { ...values, [path]: v };
}

/** 把数组类的逗号文本转成数组 */
function arrayFromText(text: string, numeric: boolean): string[] | number[] {
	const parts = text
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return numeric ? parts.map(Number) : parts;
}
function textFromArray(v: string[] | number[]): string {
	return v.join(", ");
}
</script>

<div>
	<header class="mb-5 flex flex-wrap items-end justify-between gap-3">
		<div class="min-w-0">
			<button
				type="button"
				class="mb-1 font-mono text-xs text-(--admin-text-faint) hover:text-(--admin-accent-hover)"
				onclick={() => history.back()}
			>← 返回配置列表</button>
			<h1 class="truncate font-mono text-xl font-bold text-(--admin-text-strong)">{filePath.split("/").pop()}</h1>
			<p class="mt-1 text-xs text-(--admin-text-faint)">
				表单视图直接改参数（布尔为开关、字符串为输入框、数组用逗号分隔）；切到「代码」可手动编辑完整 TS。
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex rounded-lg border border-(--admin-line) bg-(--admin-panel) p-0.5 text-xs">
				<button
					type="button"
					onclick={() => (mode = "form")}
					class="rounded-md px-3 py-1.5 font-medium transition-colors {mode === 'form' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
				>表单</button>
				<button
					type="button"
					onclick={() => (mode = "code")}
					class="rounded-md px-3 py-1.5 font-medium transition-colors {mode === 'code' ? 'bg-(--admin-accent-soft) text-(--admin-accent-hover)' : 'text-(--admin-text) hover:bg-(--admin-panel-hover)'}"
				>代码</button>
			</div>
			<button
				type="button"
				class="admin-btn admin-btn-primary {saving ? 'pointer-events-none opacity-60' : ''}"
				onclick={save}
			>
				{saving ? "保存中…" : "保存"}
			</button>
		</div>
	</header>

	{#if loading}
		<div class="admin-panel animate-pulse p-10 text-center text-sm text-(--admin-text-faint)">加载中…</div>
	{:else if loadingError}
		<div class="admin-alert admin-alert-danger">{loadingError}</div>
	{:else if mode === "form"}
		{#if leaves.length === 0}
			<div class="admin-panel p-8 text-center text-sm text-(--admin-text-faint)">
				没解析出可编辑的原始值字段（可能是纯嵌套结构），请用「代码」视图手动编辑。
			</div>
		{:else}
			<div class="admin-panel divide-y divide-(--admin-divider)">
				{#each leaves as leaf (leaf.path)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<span class="block text-sm font-medium text-(--admin-text-strong)">{chineseLabel(leaf.key, leaf.label)}</span>
							<span class="font-mono text-[11px] text-(--admin-text-faint)">{leaf.path}</span>
						</div>
						<div class="shrink-0">
							{#if leaf.type === "boolean"}
								<button
									type="button"
									role="switch"
									aria-label={chineseLabel(leaf.key, leaf.label)}
									aria-checked={Boolean(values[leaf.path])}
									onclick={() => setValue(leaf.path, !(values[leaf.path] as boolean))}
									class="relative h-6 w-11 rounded-full transition-colors {values[leaf.path] ? 'bg-(--admin-accent)' : 'bg-(--admin-soft)'}"
								>
									<span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform {values[leaf.path] ? 'translate-x-5' : ''}"></span>
								</button>
							{:else if leaf.type === "number"}
								<input
									type="number"
									aria-label={chineseLabel(leaf.key, leaf.label)}
									class="admin-input !w-40 !py-1.5 text-right text-sm"
									value={Number(values[leaf.path] ?? 0)}
									oninput={(e) => setValue(leaf.path, Number((e.currentTarget as HTMLInputElement).value))}
								/>
							{:else if leaf.type === "stringArray" || leaf.type === "numberArray"}
								<input
									type="text"
									aria-label={chineseLabel(leaf.key, leaf.label)}
									class="admin-input !w-72 !py-1.5 text-sm"
									value={textFromArray((values[leaf.path] as string[] | number[]) ?? [])}
									placeholder="用逗号分隔"
									oninput={(e) => setValue(leaf.path, arrayFromText((e.currentTarget as HTMLInputElement).value, leaf.type === "numberArray"))}
								/>
							{:else}
								<input
									type="text"
									aria-label={chineseLabel(leaf.key, leaf.label)}
									class="admin-input !w-80 !py-1.5 text-sm"
									value={String(values[leaf.path] ?? "")}
									oninput={(e) => setValue(leaf.path, (e.currentTarget as HTMLInputElement).value)}
								/>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
		{#if savedAt}
			<p class="mt-3 text-xs text-(--admin-accent)">已保存（{new Date(savedAt).toLocaleTimeString("zh-CN")}），开发服务器会自动热更新</p>
		{/if}
	{:else}
		<div class="admin-codemirror h-[70vh] overflow-hidden rounded-xl border border-(--admin-line)">
			<CodeEditor value={codeText} path={filePath} onDocChange={(v: string) => (codeText = v)} />
		</div>
	{/if}

	{#if saveError}
		<div class="admin-alert admin-alert-danger mt-3">{saveError}</div>
	{/if}
</div>
