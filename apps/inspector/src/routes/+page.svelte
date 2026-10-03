<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { IndexEntry, Meta, Profile } from '@potatosalad775/eqcaps-core';
	import { catalog } from '$lib/data.svelte';
	import { FEATURES, searchEntries, type Feature } from '$lib/search';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	const params = page.url.searchParams;
	let query = $state(params.get('q') ?? '');
	let status = $state((params.get('status') ?? '') as Meta['status'] | '');
	let kind = $state((params.get('kind') ?? '') as Profile['kind'] | '');
	let features = $state(
		(params.get('features') ?? '').split(',').filter((f): f is Feature => f in FEATURES)
	);
	let showDeprecated = $state(params.has('deprecated'));

	const results = $derived(
		searchEntries(catalog.index?.profiles ?? [], catalog.features, {
			query,
			status,
			kind,
			features,
			showDeprecated
		})
	);

	// replaceState throws until the router has started; the first navigation marks that.
	let routerReady = $state(false);
	afterNavigate(() => (routerReady = true));

	// Keep the search in the URL, so a search can be shared and survives a reload.
	$effect(() => {
		if (!routerReady) return;
		const url = new URL(page.url);
		const set = (k: string, v: string) =>
			v ? url.searchParams.set(k, v) : url.searchParams.delete(k);
		set('q', query.trim());
		set('status', status);
		set('kind', kind);
		set('features', features.join(','));
		set('deprecated', showDeprecated ? '1' : '');
		// Same page, new query: there is no route to resolve.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		if (url.search !== page.url.search) replaceState(url, {});
	});

	function toggle(f: Feature) {
		features = features.includes(f) ? features.filter((x) => x !== f) : [...features, f];
	}

	function identity(e: IndexEntry): string {
		const usb = (e.match?.usb ?? []).map(
			(u) =>
				`${u.vendorId}${u.productId ? `:${u.productId}` : ''}${u.productName ? ` "${u.productName}"` : ''}`
		);
		const bt = (e.match?.bluetooth ?? []).map((b) => `BT ${b.name ?? `${b.namePrefix}…`}`);
		const all = [...usb, ...bt];
		return all.length > 3
			? `${all.slice(0, 2).join(', ')} +${all.length - 2} more`
			: all.join(', ');
	}
</script>

<svelte:head><title>eqcaps inspector</title></svelte:head>

<section class="space-y-4">
	<div>
		<h1 class="text-2xl font-semibold">What does your EQ accept?</h1>
		<p class="mt-1 text-zinc-600 dark:text-zinc-400">
			Search the database by brand, model, alias or USB id (<code>0x2972</code>,
			<code>2972:0047</code>).
		</p>
		<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
			Not listed, or wrong? <a href={resolve('/connect')}>Connect your device</a> to check it, or
			<a href={resolve('/edit/[[id]]', {})}>write a profile</a> for it.
		</p>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<input
			type="search"
			bind:value={query}
			placeholder="Search devices and apps"
			aria-label="Search"
			class="min-w-64 flex-1 rounded border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
		/>
		<select
			bind:value={status}
			aria-label="Status"
			class="rounded border border-zinc-300 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
		>
			<option value="">Any status</option>
			<option value="maintainer-verified">maintainer-verified</option>
			<option value="community-verified">community-verified</option>
			<option value="draft">draft</option>
			<option value="deprecated">deprecated</option>
		</select>
		<select
			bind:value={kind}
			aria-label="Kind"
			class="rounded border border-zinc-300 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
		>
			<option value="">Hardware and software</option>
			<option value="hardware">Hardware</option>
			<option value="software">Software</option>
		</select>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-sm">
		{#each Object.entries(FEATURES) as [key, label] (key)}
			<button
				type="button"
				onclick={() => toggle(key as Feature)}
				aria-pressed={features.includes(key as Feature)}
				class="rounded-full border px-2.5 py-0.5 {features.includes(key as Feature)
					? 'border-teal-600 bg-teal-600 text-white'
					: 'border-zinc-300 text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300'}"
				>{label}</button
			>
		{/each}
		<label class="ml-auto flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
			<input type="checkbox" bind:checked={showDeprecated} /> Show deprecated
		</label>
	</div>

	{#if catalog.index === null}
		<p class="text-zinc-500">{catalog.loading ? 'Loading the database…' : 'No data.'}</p>
	{:else}
		<p class="text-sm text-zinc-500">
			{results.length} of {catalog.index.profiles.length} profiles
		</p>
		<ul
			class="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"
		>
			{#each results as e (e.id)}
				<li>
					<a
						href={resolve('/p/[id]', { id: e.id })}
						class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-inherit no-underline hover:bg-zinc-50 dark:hover:bg-zinc-900"
					>
						<span class="font-medium">{e.brand} {e.model}</span>
						{#if e.engine}<span class="text-sm text-zinc-500">{e.engine}</span>{/if}
						<StatusBadge status={e.status} />
						{#if e.kind === 'software'}
							<span class="text-xs text-zinc-500 uppercase">software</span>
						{/if}
						<span class="ml-auto font-mono text-xs text-zinc-500">{e.id}</span>
						{#if identity(e)}
							<span class="w-full font-mono text-xs text-zinc-500">{identity(e)}</span>
						{/if}
					</a>
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-zinc-500">No profile matches.</li>
			{/each}
		</ul>
	{/if}
</section>
