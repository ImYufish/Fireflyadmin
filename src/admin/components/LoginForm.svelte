<script lang="ts">
interface Props {
	/** 是否已配置 GitHub OAuth App（决定是否显示「使用 GitHub 登录」按钮） */
	oauthEnabled: boolean;
	/** OAuth 回调失败等由服务端带回来的错误信息 */
	urlError?: string | null;
	hasBackground: boolean;
	/** OAuth App 应填写的回调地址（服务端按当前站点计算） */
	callbackUrl: string;
}

const { oauthEnabled, urlError, hasBackground, callbackUrl }: Props = $props();

// props 不会在客户端变化；用「可空 override + $derived」表达
// “默认值来自 prop，用户操作后可覆盖”，避免 $state 只捕获初始值
let tokenFormOverride = $state<boolean | null>(null);
const showTokenForm = $derived(tokenFormOverride ?? !oauthEnabled);

let token = $state("");
let showToken = $state(false);
let loading = $state(false);
let errorOverride = $state<string | null>(null);
const error = $derived(errorOverride ?? urlError ?? "");
let notice = $state("");
let showSetupHint = $state(false);

async function handleLogin(event: SubmitEvent) {
	event.preventDefault();
	if (loading) return;
	const value = token.trim();
	if (!value) {
		errorOverride = "请输入 GitHub 个人访问令牌（PAT）";
		return;
	}
	loading = true;
	errorOverride = "";
	notice = "";
	try {
		const res = await fetch("/api/admin/auth/login/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: value }),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok || !data?.ok) {
			errorOverride = data?.error ?? `登录失败（${res.status}）`;
			return;
		}
		if (data.restricted === false) {
			notice =
				"提示：尚未配置登录白名单，任何持有有效令牌的 GitHub 用户都能登录后台。建议在 .env 中设置 ADMIN_GITHUB_USERS。";
		}
		window.location.href = "/admin/";
	} catch {
		errorOverride = "网络请求失败，请重试";
	} finally {
		loading = false;
	}
}
</script>

<div
	class="admin-login-card admin-fade-in w-full max-w-[28rem] overflow-hidden p-8 text-(--admin-text-strong)"
>
	<div class="mb-7 flex items-center gap-3.5">
		<div
			class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-(--admin-accent) text-(--page-bg) shadow-lg"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="h-6.5 w-6.5"
			>
				<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"></path>
			</svg>
		</div>
		<div>
			<h1 class="text-xl font-bold tracking-wide">Firefly 后台管理</h1>
			<p class="mt-0.5 text-sm text-(--admin-text)">登录以管理文章与网站配置</p>
		</div>
	</div>

	{#if error}
		<div class="admin-alert admin-alert-danger mb-5">{error}</div>
	{/if}
	{#if notice}
		<div class="admin-alert admin-alert-warn-soft mb-5 !text-xs">{notice}</div>
	{/if}

	{#if oauthEnabled}
		<a
			href="/api/admin/auth/authorize/"
			class="admin-btn admin-btn-primary w-full !rounded-xl !py-3 !text-[0.95rem]"
		>
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5">
				<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
			</svg>
			使用 GitHub 登录
		</a>
	{:else}
		<button
			type="button"
			class="admin-btn admin-btn-ghost w-full !rounded-xl !border-dashed !py-3 !text-[0.95rem] text-(--admin-text)"
			onclick={() => (showSetupHint = !showSetupHint)}
		>
			<svg viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5">
				<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
			</svg>
			启用 GitHub 一键登录
		</button>
	{/if}

	{#if showSetupHint}
		<div class="admin-alert admin-alert-info mt-4 !text-xs leading-relaxed">
			<p class="mb-1 font-semibold">启用 GitHub 一键登录（OAuth App）：</p>
			<ol class="list-inside list-decimal space-y-0.5">
				<li>
					打开
					<a
						href="https://github.com/settings/developers"
						target="_blank"
						rel="noopener"
						class="underline underline-offset-2">github.com/settings/developers</a
					>
					→ New OAuth App
				</li>
				<li>
					Authorization callback URL 填
					<code class="font-mono">{callbackUrl}</code>
				</li>
				<li>
					把 Client ID / Client Secret 写入项目根目录
					<code class="font-mono">.env</code>（或环境变量
					<code class="font-mono">ADMIN_GITHUB_CLIENT_ID</code> /
					<code class="font-mono">ADMIN_GITHUB_CLIENT_SECRET</code>）后重启
				</li>
			</ol>
		</div>
	{/if}

	{#if oauthEnabled || showSetupHint}
		<div class="my-6 flex items-center gap-3 text-xs text-(--admin-text-faint)">
			<div class="h-px flex-1 bg-(--admin-line)"></div>
			或使用令牌登录
			<div class="h-px flex-1 bg-(--admin-line)"></div>
		</div>
	{/if}

	<button
		type="button"
		class="mb-4 flex w-full items-center justify-between text-sm text-(--admin-text) transition-colors hover:text-(--admin-text-strong)"
		onclick={() => (tokenFormOverride = !showTokenForm)}
	>
		<span class="flex items-center gap-1.5 {!showTokenForm ? 'font-medium' : ''}">
			令牌登录（GitHub PAT）
		</span>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="currentColor"
			class="h-4 w-4 transition-transform {showTokenForm ? 'rotate-180' : ''}"
		>
			<path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"></path>
		</svg>
	</button>

	{#if showTokenForm}
		<form onsubmit={handleLogin} class="space-y-4">
			<div>
				<label for="admin-token" class="admin-label">
					GitHub 个人访问令牌
				</label>
				<div class="relative">
					<input
						id="admin-token"
						type={showToken ? "text" : "password"}
						class="admin-input pr-16 font-mono"
						placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
						autocomplete="off"
						spellcheck="false"
						bind:value={token}
					/>
					<button
						type="button"
						class="absolute inset-y-0 right-0 flex items-center px-3 text-xs text-(--admin-text-faint) hover:text-(--admin-text-strong)"
						onclick={() => (showToken = !showToken)}
					>
						{showToken ? "隐藏" : "显示"}
					</button>
				</div>
			</div>
			<button
				type="submit"
				class="admin-btn admin-btn-ghost w-full !rounded-xl"
				disabled={loading}
			>
				{#if loading}
					<svg
						class="h-4 w-4 animate-spin"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<circle
							class="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							stroke-width="4"
						></circle>
						<path
							class="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z"
						></path>
					</svg>
					正在验证令牌…
				{:else}
					登录
				{/if}
			</button>
		</form>
	{/if}

	<div
		class="mt-6 space-y-2 border-t border-(--admin-divider) pt-4 text-xs leading-relaxed text-(--admin-text-faint)"
	>
		<p>
			令牌仅用于通过 GitHub API 验证身份，不会被保存；OAuth
			登录则全程在 GitHub 官方页面完成，后台只拿到你的公开用户名。
		</p>
		<p>
			站长可在
			<code class="rounded bg-(--admin-soft) px-1 py-0.5 font-mono">.env</code>
			中用 ADMIN_GITHUB_USERS 设置白名单限制登录者。
		</p>
		{#if !hasBackground}
			<p>
				提示：在 src/admin/config.ts 中配置 loginBackgroundApi 可开启随机动漫背景。
			</p>
		{/if}
	</div>
</div>
