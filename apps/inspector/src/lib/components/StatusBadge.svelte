<script lang="ts">
	import type { Meta } from '@potatosalad775/eqcaps-core';

	let { status }: { status: Meta['status'] } = $props();

	// SPEC §10. Draft data is unverified, so it reads as a caution, not an error.
	const styles: Record<Meta['status'], string> = {
		draft: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
		'community-verified': 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200',
		'maintainer-verified':
			'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
		deprecated: 'bg-zinc-200 text-zinc-700 line-through dark:bg-zinc-800 dark:text-zinc-400'
	};
</script>

<span
	class="inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap {styles[status]}"
	>{status}</span
>
