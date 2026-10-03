<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		describe,
		isCountingSource,
		unsupported,
		type Profile
	} from '@potatosalad775/eqcaps-core';
	import { catalog } from '$lib/data.svelte';
	import { dataUrl } from '$lib/channel';
	import { profileSourceUrl, sourceHref } from '$lib/repo';
	import SlotChart from '$lib/components/SlotChart.svelte';
	import GroupBadge from '$lib/components/GroupBadge.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let profile = $state.raw<Profile | null | undefined>(undefined);

	$effect(() => {
		const id = data.id;
		profile = undefined;
		catalog.profile(id).then((p) => {
			if (data.id === id) profile = p;
		});
	});

	const description = $derived(profile ? describe(profile) : null);
	const missing = $derived(profile ? unsupported(profile) : null);
	const json = $derived(profile ? JSON.stringify(profile, null, '\t') : '');
</script>

<svelte:head>
	<title>{profile ? `${profile.device.brand} ${profile.device.model}` : data.id} · eqcaps</title>
</svelte:head>

{#if profile === undefined}
	<p class="text-zinc-500">Loading {data.id}…</p>
{:else if profile === null}
	<h1 class="text-xl font-semibold">No profile "{data.id}"</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-400">
		It isn't in the database, or the database could not be loaded.
		<a href={resolve('/')}>Search</a> instead.
	</p>
{:else}
	{@const p = profile}
	<article class="space-y-8">
		<header class="space-y-2">
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h1 class="text-2xl font-semibold">{p.device.brand} {p.device.model}</h1>
				{#if p.engine}<span class="text-zinc-500">{p.engine}</span>{/if}
				<StatusBadge status={p.meta.status} />
				{#if p.device.group}<GroupBadge />{/if}
				<span class="text-xs text-zinc-500 uppercase">{p.kind}</span>
			</div>
			<p class="font-mono text-sm text-zinc-500">{p.id}</p>
			{#if p.device.aliases?.length}
				<p class="text-sm text-zinc-600 dark:text-zinc-400">
					Also known as {p.device.aliases.join(', ')}
				</p>
			{/if}
			{#if p.meta.replacedBy}
				<p class="rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
					Deprecated: replaced by
					<a href={resolve('/p/[id]', { id: p.meta.replacedBy })}>{p.meta.replacedBy}</a>.
				</p>
			{/if}
			{#if p.device.group}
				<p class="rounded bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950">
					Group profile: it stands for several products that can't be told apart by how they
					identify themselves, such as dongles sharing a chipset's firmware. A device with its own
					profile is matched by that instead.
				</p>
			{/if}
			{#if p.meta.status === 'draft'}
				<p
					class="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
				>
					Draft: nobody has checked these values against the device or its vendor's documentation
					yet. Apps should treat them as a best guess.
				</p>
			{/if}
			<div class="flex flex-wrap gap-3 pt-1 text-sm">
				<a href="{resolve('/playground')}?profile={encodeURIComponent(p.id)}"
					>Try in the playground</a
				>
				<a href={resolve('/edit/[[id]]', { id: p.id })}>Edit this profile</a>
				<a href="{resolve('/edit/[[id]]', {})}?copy={encodeURIComponent(p.id)}"
					>New profile from this one</a
				>
				<!-- eslint-disable svelte/no-navigation-without-resolve -- links out of the app -->
				<a href={profileSourceUrl(p)}>Source on GitHub</a>
				<a href="{dataUrl()}profiles/{p.id}.json">Published JSON</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</div>
		</header>

		{#if description}
			<section>
				<h2 class="mb-2 text-lg font-semibold">Summary</h2>
				<dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
					<dt class="text-zinc-500">Bands</dt>
					<dd>
						{description.bands}{description.graphic ? ' (graphic EQ: every frequency fixed)' : ''}
					</dd>
					<dt class="text-zinc-500">Preamp</dt>
					<dd>{description.preamp}</dd>
					<dt class="text-zinc-500">Rules</dt>
					<dd>
						{#each description.rules as rule, i (i)}<div>{rule}</div>{:else}None{/each}
					</dd>
				</dl>
				{#if missing && (missing.rules.length || missing.types.length)}
					<p class="mt-3 rounded bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
						This profile uses parts of the format this app doesn't know:
						{[...missing.rules, ...missing.types].join(', ')}.
					</p>
				{/if}
			</section>

			<section>
				<h2 class="mb-2 text-lg font-semibold">Slots</h2>
				<SlotChart profile={p} />
			</section>

			<section>
				<h2 class="mb-2 text-lg font-semibold">Domains</h2>
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead class="text-zinc-500">
							<tr class="border-b border-zinc-200 dark:border-zinc-800">
								<th class="py-1 pr-4 font-normal">Slots</th>
								<th class="py-1 pr-4 font-normal">Types</th>
								<th class="py-1 pr-4 font-normal">Frequency</th>
								<th class="py-1 pr-4 font-normal">Q</th>
								<th class="py-1 font-normal">Gain</th>
							</tr>
						</thead>
						<tbody>
							{#each description.groups as g, i (i)}
								<tr class="border-b border-zinc-100 align-top dark:border-zinc-900">
									<td class="py-1.5 pr-4 whitespace-nowrap">
										{g.slots.length === 0
											? 'every band'
											: g.slots.length === 1
												? g.slots[0]! + 1
												: `${g.slots[0]! + 1}–${g.slots[g.slots.length - 1]! + 1}`}
										{#if g.label}<span class="text-zinc-500">({g.label})</span>{/if}
									</td>
									<td class="py-1.5 pr-4">{g.types}</td>
									<td class="py-1.5 pr-4">{g.freq}</td>
									<td class="py-1.5 pr-4">{g.q}</td>
									<td class="py-1.5">
										{g.gain}
										{#each g.conditions as c, k (k)}
											<div class="text-amber-700 dark:text-amber-400">{c}</div>
										{/each}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="mt-2 text-xs text-zinc-500">
					Values are written values (SPEC §1): Hz, dB and cookbook Q, as the engine takes them.
					Conditional domains apply when their condition holds; the first matching one wins per
					field.
				</p>
			</section>
		{/if}

		{#if p.match}
			<section>
				<h2 class="mb-2 text-lg font-semibold">Identity</h2>
				<div class="space-y-2 text-sm">
					{#if p.match.usb?.length}
						<div>
							<div class="text-zinc-500">USB ({p.match.usb.length})</div>
							<div class="max-h-48 overflow-y-auto font-mono text-xs">
								{#each p.match.usb as u, i (i)}
									<div>
										{u.vendorId}{u.productId ? `:${u.productId}` : ''}
										{#if u.productName !== undefined}<span class="text-zinc-500"
												>"{u.productName}"</span
											>{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}
					{#if p.match.bluetooth?.length}
						<div>
							<div class="text-zinc-500">Bluetooth</div>
							{#each p.match.bluetooth as b, i (i)}
								<div class="font-mono text-xs">
									{b.name !== undefined ? `"${b.name}"` : `"${b.namePrefix}…"`}
									{#if b.serviceUuid}<span class="text-zinc-500">service {b.serviceUuid}</span>{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if p.match.firmware}
						<div>
							Firmware {p.match.firmware.min ? `from ${p.match.firmware.min}` : ''}
							{p.match.firmware.max ? `before ${p.match.firmware.max}` : ''}
						</div>
					{/if}
				</div>
			</section>
		{/if}

		<section>
			<h2 class="mb-2 text-lg font-semibold">Provenance</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="text-zinc-500">
						<tr class="border-b border-zinc-200 dark:border-zinc-800">
							<th class="py-1 pr-4 font-normal">Kind</th>
							<th class="py-1 pr-4 font-normal">Source</th>
							<th class="py-1 pr-4 font-normal">Date</th>
							<th class="py-1 font-normal">By</th>
						</tr>
					</thead>
					<tbody>
						{#each p.meta.sources as s, i (i)}
							{@const href = sourceHref(s)}
							<tr class="border-b border-zinc-100 align-top dark:border-zinc-900">
								<td class="py-1.5 pr-4 whitespace-nowrap">
									{s.kind}
									{#if isCountingSource(s)}<span
											class="text-xs text-emerald-700 dark:text-emerald-400">verifies</span
										>{/if}
								</td>
								<td class="max-w-md py-1.5 pr-4 break-all">
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external -->
									{#if href}<a {href}>{s.ref}</a>{:else}{s.ref}{/if}
									{#if s.firmware}<div class="text-zinc-500">firmware {s.firmware}</div>{/if}
									{#if s.via}<div class="text-zinc-500">inherited from {s.via}</div>{/if}
								</td>
								<td class="py-1.5 pr-4 whitespace-nowrap">{s.date}</td>
								<td class="py-1.5">{s.by ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if p.meta.contributors?.length}
				<p class="mt-2 text-sm">Contributors: {p.meta.contributors.join(', ')}</p>
			{/if}
			{#if p.meta.notes}
				<p class="mt-2 text-sm whitespace-pre-line text-zinc-600 dark:text-zinc-400">
					{p.meta.notes}
				</p>
			{/if}
		</section>

		<section>
			<details>
				<summary class="cursor-pointer text-lg font-semibold">Raw JSON</summary>
				<pre
					class="mt-2 max-h-[32rem] overflow-auto rounded bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{json}</pre>
			</details>
		</section>
	</article>
{/if}
