/**
 * 把项目根目录 `.env` 里的变量读进 `process.env`。
 *
 * 为什么需要它：Astro/Vite 只把 `.env` 注入 `import.meta.env`，**不会**写入
 * `process.env`。后台配置（src/admin/config.ts）全部走 `process.env` 读取，
 * 本地开发若只写 `.env` 就会读不到，表现为「GitHub 登录按钮不出现、
 * 图床 / Umami 未配置」。本项目在 astro.config.mjs 顶部调用本模块解决。
 *
 * 约定：
 *  - 已存在的环境变量优先（平台注入的加密变量不被本地 .env 覆盖）；
 *  - 支持 `#` 注释、`export ` 前缀、单双引号包裹、行尾注释；
 *  - 读取失败（文件不存在 / 无权限）时静默跳过。
 */

import fs from "node:fs";
import path from "node:path";

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** 去掉包裹的引号与行尾注释 */
function cleanValue(raw) {
	let value = raw;
	// 先剥离未被引号包裹的行尾注释
	if (!/^["']/.test(value)) {
		const hash = value.indexOf(" #");
		if (hash !== -1) value = value.slice(0, hash);
		value = value.trim();
	}
	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.length >= 2) {
		const closing = value.indexOf(quote, 1);
		if (closing !== -1) {
			// 双引号内支持 \n \t 转义；单引号原样保留
			value =
				quote === '"'
					? value
							.slice(1, closing)
							.replace(/\\n/g, "\n")
							.replace(/\\t/g, "\t")
							.replace(/\\(["\\])/g, "$1")
					: value.slice(1, closing);
			return value;
		}
	}
	// 未闭合引号时去掉前导引号，避免把引号带进值里
	return value.replace(/^["']/, "").trim();
}

/** 加载 .env（默认 `<cwd>/.env`），返回本次新写入的键数量 */
export function loadEnvIntoProcess(envPath) {
	const file = envPath ?? path.join(process.cwd(), ".env");
	let content;
	try {
		content = fs.readFileSync(file, "utf-8");
	} catch {
		return 0;
	}
	let loaded = 0;
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = LINE_RE.exec(trimmed);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (key in process.env) continue;
		process.env[key] = cleanValue(rawValue);
		loaded += 1;
	}
	return loaded;
}
