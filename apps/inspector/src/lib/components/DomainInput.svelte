<script lang="ts">
	// One domain (SPEC §4) as form inputs: a range, a stepped range, listed values or one fixed
	// value. Calls onchange with the new domain once the inputs describe one.
	import type { Domain } from '@potatosalad775/eqcaps-core';
	import { domainToForm, formToDomain, type DomainForm } from '$lib/editor-form';

	let {
		label,
		domain,
		unit,
		onchange
	}: {
		label: string;
		domain: Domain | undefined;
		unit: string;
		onchange: (d: Domain) => void;
	} = $props();

	let form = $state<DomainForm>(domainToForm(undefined));
	let problem = $state('');

	// The JSON is the source of truth: take its value whenever it changes.
	$effect(() => {
		form = domainToForm(domain);
		problem = '';
	});

	function commit() {
		const d = formToDomain(form);
		if (typeof d === 'string') {
			problem = d;
			return;
		}
		problem = '';
		onchange(d);
	}

	const input =
		'w-24 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';
</script>

<fieldset class="flex flex-wrap items-center gap-2 text-sm">
	<legend class="sr-only">{label}</legend>
	<span class="w-12 font-medium">{label}</span>
	<select
		bind:value={form.kind}
		onchange={commit}
		class="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
		aria-label="{label} domain form"
	>
		<option value="stepped">range with step</option>
		<option value="range">continuous range</option>
		<option value="values">listed values</option>
		<option value="locked">fixed value</option>
	</select>
	{#if form.kind === 'range' || form.kind === 'stepped'}
		<input
			class={input}
			bind:value={form.min}
			onchange={commit}
			aria-label="{label} min"
			placeholder="min"
		/>
		<span>to</span>
		<input
			class={input}
			bind:value={form.max}
			onchange={commit}
			aria-label="{label} max"
			placeholder="max"
		/>
		{#if form.kind === 'stepped'}
			<span>step</span>
			<input
				class={input}
				bind:value={form.step}
				onchange={commit}
				aria-label="{label} step"
				placeholder="step"
			/>
		{/if}
	{:else if form.kind === 'values'}
		<input
			class="{input} w-full max-w-md"
			bind:value={form.values}
			onchange={commit}
			aria-label="{label} values"
			placeholder="31, 62, 125, …"
		/>
	{:else}
		<input class={input} bind:value={form.value} onchange={commit} aria-label="{label} value" />
	{/if}
	<span class="text-zinc-500">{unit}</span>
	{#if problem}<span class="text-xs text-amber-700 dark:text-amber-400">{problem}</span>{/if}
</fieldset>
