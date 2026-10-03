<script lang="ts">
	// One row per slot on a log-frequency axis: the slot's frequency window, its grid when it is
	// coarse enough to see, listed values as dots, and each variant's window as an alternative
	// (INSPECTOR §2 T0). Hover a row for its full domains.
	import { describeDomain, type Domain, type Profile } from '@potatosalad775/eqcaps-core';
	import { formatHz, formatTick } from '$lib/format';
	import { freqAxis, gridPoints, slotRows, span, whenLabel, type SlotRow } from '$lib/slots';

	let { profile }: { profile: Profile } = $props();

	const rows = $derived(slotRows(profile));
	const axis = $derived(freqAxis(rows));
	const compact = $derived(rows.length > 24);

	const pct = (f: number) => `${(axis.x(f) * 100).toFixed(3)}%`;
	const width = (d: Domain) => {
		const [a, b] = span(d);
		return `max(${((axis.x(b) - axis.x(a)) * 100).toFixed(3)}%, 2px)`;
	};

	function title(r: SlotRow): string {
		const lines = [
			r.index === null ? 'Every band' : `Slot ${r.index + 1}${r.label ? ` (${r.label})` : ''}`,
			`types: ${r.types.join(', ')}`,
			`freq: ${describeDomain(r.freq, 'freq')}`,
			`q: ${describeDomain(r.q, 'q')}`,
			`gain: ${describeDomain(r.gain, 'gain')}`
		];
		for (const v of r.variants) {
			const then = (['freq', 'q', 'gain'] as const)
				.flatMap((f) => (v[f] ? [`${f} ${describeDomain(v[f], f)}`] : []))
				.join(', ');
			lines.push(`when ${whenLabel(v.when)}: ${then}`);
		}
		return lines.join('\n');
	}

	const points = (d: Domain): number[] =>
		'value' in d ? [d.value] : 'values' in d ? d.values : [];
</script>

{#snippet window(d: Domain, variant: boolean)}
	{@const dots = points(d)}
	{#if dots.length > 0}
		{#each dots as f, i (i)}
			<span
				class="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full {variant
					? 'bg-amber-500'
					: 'bg-teal-600 dark:bg-teal-400'}"
				style:left={pct(f)}
			></span>
		{/each}
	{:else}
		{@const [lo] = span(d)}
		<span
			class="absolute inset-y-1 rounded-sm {variant
				? 'border border-dashed border-amber-500 bg-amber-400/20'
				: 'bg-teal-600/70 dark:bg-teal-400/60'}"
			style:left={pct(lo)}
			style:width={width(d)}
		></span>
		{#each gridPoints(d) ?? [] as f, i (i)}
			<span class="absolute inset-y-1 w-px bg-white/80 dark:bg-zinc-950/80" style:left={pct(f)}
			></span>
		{/each}
	{/if}
{/snippet}

<div class="text-xs">
	<div class="grid grid-cols-[minmax(5rem,9rem)_1fr] gap-x-2">
		<div></div>
		<div class="relative h-5 text-zinc-500">
			{#each axis.ticks as t (t)}
				<span class="absolute -translate-x-1/2" style:left={pct(t)}>{formatTick(t)}</span>
			{/each}
		</div>
	</div>

	{#each rows as r, i (i)}
		<div class="group grid grid-cols-[minmax(5rem,9rem)_1fr] gap-x-2" title={title(r)}>
			<div
				class="flex items-center gap-1 truncate pr-1 text-zinc-600 dark:text-zinc-400 {compact
					? 'h-3.5 text-[10px]'
					: 'h-6'}"
			>
				<span class="font-mono">{r.index === null ? 'all' : r.index + 1}</span>
				<span class="truncate">{r.label ?? r.types.join(' ')}</span>
			</div>
			<div>
				<div
					class="relative bg-zinc-100 group-hover:bg-zinc-200 dark:bg-zinc-900 dark:group-hover:bg-zinc-800 {compact
						? 'h-3.5'
						: 'h-6'}"
				>
					{#each axis.ticks as t (t)}
						<span
							class="absolute inset-y-0 w-px bg-zinc-300/60 dark:bg-zinc-700/60"
							style:left={pct(t)}
						></span>
					{/each}
					{@render window(r.freq, false)}
				</div>
				{#each r.variants as v, k (k)}
					{#if v.freq}
						<div class="relative h-5 bg-zinc-50 dark:bg-zinc-900/50">
							{@render window(v.freq, true)}
							<span
								class="absolute top-1/2 -translate-y-1/2 pl-1 whitespace-nowrap text-amber-700 dark:text-amber-400"
								style:left={pct(span(v.freq)[1])}>when {whenLabel(v.when)}</span
							>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	{/each}

	<p class="mt-2 text-zinc-500">
		Axis {formatHz(axis.min)} – {formatHz(axis.max)}, logarithmic. Solid: the slot's frequency
		window; white lines: its grid; dots: listed or fixed values; dashed: a conditional window. Hover
		a row for its domains.
	</p>
</div>
