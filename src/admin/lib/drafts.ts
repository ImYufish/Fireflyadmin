/**
 * 线上模式的本地草稿暂存（浏览器 localStorage）。
 *
 * GitHub 模式下「保存」先把修改累积为本地草稿，攒多次修改后通过
 * 「发布」一次性提交为单个 commit，避免每保存一个文件就产生一个 commit。
 * 草稿保存在浏览器本地，按文件路径为键；换设备/清浏览器数据会丢失，
 * 发布前请及时发布或手动备份。
 */

const KEY = "firefly_admin_gh_drafts_v1";

export type GhDraft = { content: string; savedAt: number; fm?: string };
export type GhDraftMap = Record<string, GhDraft>;

const EVENT = "firefly-admin-drafts-changed";

export function readDrafts(): GhDraftMap {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as GhDraftMap;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeAll(drafts: GhDraftMap): void {
	localStorage.setItem(KEY, JSON.stringify(drafts));
	window.dispatchEvent(new CustomEvent(EVENT));
}

/** 保存单个文件的草稿（content=正文，fm=frontmatter 块） */
export function writeDraft(path: string, content: string, fm = ""): void {
	const drafts = readDrafts();
	drafts[path] = { content, savedAt: Date.now(), fm: fm || undefined };
	writeAll(drafts);
}

/** 删除单个文件的草稿 */
export function deleteDraft(path: string): void {
	const drafts = readDrafts();
	delete drafts[path];
	writeAll(drafts);
}

/** 清空全部草稿 */
export function clearDrafts(): void {
	writeAll({});
}

export function subscribeDrafts(callback: () => void): () => void {
	const handler = () => callback();
	window.addEventListener(EVENT, handler);
	window.addEventListener("storage", handler);
	return () => {
		window.removeEventListener(EVENT, handler);
		window.removeEventListener("storage", handler);
	};
}
