<script lang="ts">
import {
	applyFrontmatterField,
	dateFieldValue,
	splitFrontmatter,
	tagsFieldValue,
	tagsFromString,
} from "../lib/frontmatter";

interface Props {
	/** 编辑器当前完整内容（唯一数据源） */
	content: string;
	disabled?: boolean;
	/** 字段修改后输出新的完整内容 */
	onChange?: (nextContent: string) => void;
}

const { content, disabled = false, onChange }: Props = $props();

const parsed = $derived(splitFrontmatter(content));
const fm = $derived((parsed.ok ? parsed.data : {}) as Record<string, unknown>);

const title = $derived(typeof fm.title === "string" ? fm.title : "");
const description = $derived(
	typeof fm.description === "string" ? fm.description : "",
);
const category = $derived(typeof fm.category === "string" ? fm.category : "");
const lang = $derived(typeof fm.lang === "string" ? fm.lang : "");
const image = $derived(typeof fm.image === "string" ? fm.image : "");
const slug = $derived(typeof fm.slug === "string" ? fm.slug : "");
const password = $derived(typeof fm.password === "string" ? fm.password : "");
const passwordHint = $derived(
	typeof fm.passwordHint === "string" ? fm.passwordHint : "",
);
const published = $derived(dateFieldValue(fm.published));
const updated = $derived(dateFieldValue(fm.updated));
const tags = $derived(tagsFieldValue(fm.tags));
const draft = $derived(fm.draft === true);
const pinned = $derived(fm.pinned === true);
const comment = $derived(fm.comment !== false);

function update(field: string, value: unknown) {
	onChange?.(applyFrontmatterField(content, field, value));
}

function handleDate(field: "published" | "updated", value: string) {
	if (field === "updated" && value === "") {
		update("updated", "");
		return;
	}
	update(field, value === "" ? undefined : value);
}
</script>

<div class="admin-fade-in space-y-4 border-b border-(--admin-line) p-4">
	{#if !parsed.ok}
		<div class="admin-alert admin-alert-warn-soft !text-xs">
			未能解析 frontmatter（缺少 `---` 包裹或 YAML 格式错误），表单不可用。可直接在下方编辑器中修改原文。
		</div>
	{:else}
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			<div class="sm:col-span-2 xl:col-span-3">
				<label class="admin-label" for="fm-title">标题 title *</label>
				<input
					id="fm-title"
					class="admin-input"
					disabled={disabled}
					value={title}
					oninput={(e) => update("title", e.currentTarget.value)}
				/>
			</div>
			<div class="sm:col-span-2 xl:col-span-3">
				<label class="admin-label" for="fm-description">摘要 description</label>
				<input
					id="fm-description"
					class="admin-input"
					disabled={disabled}
					value={description}
					placeholder="用于 SEO、首页卡片与 RSS 的摘要"
					oninput={(e) => update("description", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-published">发布日期 published *</label>
				<input
					id="fm-published"
					type="date"
					class="admin-input"
					disabled={disabled}
					value={published}
					oninput={(e) => handleDate("published", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-updated">更新日期 updated</label>
				<input
					id="fm-updated"
					type="date"
					class="admin-input"
					disabled={disabled}
					value={updated}
					oninput={(e) => handleDate("updated", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-category">分类 category</label>
				<input
					id="fm-category"
					class="admin-input"
					disabled={disabled}
					value={category}
					oninput={(e) => update("category", e.currentTarget.value)}
				/>
			</div>
			<div class="sm:col-span-2">
				<label class="admin-label" for="fm-tags">标签 tags（逗号分隔）</label>
				<input
					id="fm-tags"
					class="admin-input"
					disabled={disabled}
					value={tags}
					placeholder="教程, Astro"
					oninput={(e) => update("tags", tagsFromString(e.currentTarget.value))}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-lang">语言 lang</label>
				<input
					id="fm-lang"
					class="admin-input font-mono"
					disabled={disabled}
					value={lang}
					placeholder="zh_CN / en …"
					oninput={(e) => update("lang", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-image">封面 image</label>
				<input
					id="fm-image"
					class="admin-input font-mono"
					disabled={disabled}
					value={image}
					placeholder="/images/cover.png 或 URL"
					oninput={(e) => update("image", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-slug">URL slug</label>
				<input
					id="fm-slug"
					class="admin-input font-mono"
					disabled={disabled}
					value={slug}
					placeholder="留空则按文件路径生成"
					oninput={(e) => update("slug", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-password">访问密码 password</label>
				<input
					id="fm-password"
					class="admin-input"
					disabled={disabled}
					value={password}
					placeholder="留空表示不加密"
					oninput={(e) => update("password", e.currentTarget.value)}
				/>
			</div>
			<div>
				<label class="admin-label" for="fm-password-hint">密码提示 passwordHint</label>
				<input
					id="fm-password-hint"
					class="admin-input"
					disabled={disabled}
					value={passwordHint}
					oninput={(e) => update("passwordHint", e.currentTarget.value)}
				/>
			</div>
			<div class="flex flex-wrap items-center gap-5 sm:col-span-2 xl:col-span-3">
				<label class="flex cursor-pointer items-center gap-2 text-sm text-(--admin-text) select-none">
					<input
						type="checkbox"
						class="h-4 w-4 accent-(--admin-accent)"
						checked={draft}
						disabled={disabled}
						onchange={(e) => update("draft", e.currentTarget.checked)}
					/>
					草稿 draft
				</label>
				<label class="flex cursor-pointer items-center gap-2 text-sm text-(--admin-text) select-none">
					<input
						type="checkbox"
						class="h-4 w-4 accent-(--admin-accent)"
						checked={pinned}
						disabled={disabled}
						onchange={(e) => update("pinned", e.currentTarget.checked)}
					/>
					置顶 pinned
				</label>
				<label class="flex cursor-pointer items-center gap-2 text-sm text-(--admin-text) select-none">
					<input
						type="checkbox"
						class="h-4 w-4 accent-(--admin-accent)"
						checked={comment}
						disabled={disabled}
						onchange={(e) => update("comment", e.currentTarget.checked)}
					/>
					开启评论 comment
				</label>
			</div>
		</div>
		<p class="text-[11px] leading-relaxed text-(--admin-text-faint)">
			提示：通过表单修改会重新序列化 YAML 块（其中的注释会丢失）；直接在编辑器里改原文则完全保留。
		</p>
	{/if}
</div>
