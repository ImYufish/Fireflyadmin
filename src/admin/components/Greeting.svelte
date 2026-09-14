<script lang="ts">
interface Props {
	name: string;
}
const { name }: Props = $props();

/** 按当前时间返回问候语；每分钟刷新一次，避免页面长时间挂着不变 */
function greetingOf(d: Date): string {
	const h = d.getHours();
	if (h < 5) return "夜深了";
	if (h < 11) return "早上好";
	if (h < 14) return "中午好";
	if (h < 18) return "下午好";
	return "晚上好";
}

let now = $state(new Date());
let greeting = $derived(greetingOf(now));

$effect(() => {
	const timer = setInterval(() => {
		now = new Date();
	}, 60_000);
	return () => clearInterval(timer);
});
</script>

<h2 class="text-2xl font-bold text-(--admin-text-strong)">
	{greeting}，{name}<span
		class="ml-1 inline-block origin-bottom-right animate-[wave_1.5s_ease-in-out_infinite]"
		>👋</span
	>
</h2>
