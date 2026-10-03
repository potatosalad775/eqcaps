<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import { asset, resolve } from '$app/paths';
	import { dataUrl } from '$lib/channel';
	import { catalog } from '$lib/data.svelte';

	let { children } = $props();

	const links = [
		{
			href: resolve('/'),
			label: 'Browse',
			active: (p: string) => p === '/' || p.startsWith('/p/')
		},
		{
			href: resolve('/playground'),
			label: 'Playground',
			active: (p: string) => p === '/playground'
		},
		{
			href: resolve('/connect'),
			label: 'Connect',
			active: (p: string) => p === '/connect'
		},
		{
			href: resolve('/docs'),
			label: 'Use the data',
			active: (p: string) => p === '/docs'
		}
	];

	$effect(() => {
		catalog.load();
	});
</script>

<div class="flex min-h-screen flex-col">
	<header class="border-b border-zinc-200 dark:border-zinc-800">
		<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
			<a
				href={resolve('/')}
				class="flex items-center gap-2 font-semibold text-inherit no-underline"
			>
				<img src={asset('/favicon.svg')} alt="" class="size-6" />
				eqcaps <span class="font-normal text-zinc-500">inspector</span>
			</a>
			<nav class="flex gap-4 text-sm">
				{#each links as link (link.href)}
					<a
						href={link.href}
						class={link.active(page.route.id ?? '')
							? 'font-medium text-zinc-900 dark:text-zinc-100'
							: 'text-zinc-600 dark:text-zinc-400'}>{link.label}</a
					>
				{/each}
			</nav>
			<a class="ml-auto text-sm" href="https://github.com/potatosalad775/eqcaps">GitHub</a>
		</div>
	</header>

	{#if !catalog.loading && catalog.index === null && catalog.errors.length > 0}
		<div class="border-b border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
			<div class="mx-auto max-w-6xl px-4 py-2 text-sm">
				<p class="font-medium">The database could not be loaded.</p>
				<ul class="mt-1 list-disc pl-5 text-zinc-700 dark:text-zinc-300">
					{#each catalog.errors as error, i (i)}<li>{error}</li>{/each}
				</ul>
			</div>
		</div>
	{/if}

	<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
		{@render children()}
	</main>

	<footer class="border-t border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
		<div class="mx-auto flex max-w-6xl flex-wrap gap-x-4 gap-y-1 px-4 py-3">
			<span
				>Data {catalog.index?.dataVersion ?? '…'} · format {catalog.index?.schemaVersion ??
					'…'}</span
			>
			<!-- eslint-disable svelte/no-navigation-without-resolve -- data files, not routes -->
			<span class="flex gap-3">
				<a href="{dataUrl()}index.json">index.json</a>
				<a href="{dataUrl()}bundle.json">bundle.json</a>
				<a href="{dataUrl()}schema/profile.schema.json">schema</a>
			</span>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<span class="ml-auto">Code MIT · data CC0-1.0</span>
		</div>
	</footer>
</div>
