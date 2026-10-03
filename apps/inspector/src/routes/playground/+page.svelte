<script lang="ts">
	// Paste filters, pick a profile, and see what the engine says (INSPECTOR §2 T0): validateList's
	// violations, fit's result as a diff against the input, and for hardware the bands complete
	// would write. Everything runs locally, on the same engine apps use.
	import { page } from '$app/state';
	import { afterNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		complete,
		fit,
		toWritten,
		validateList,
		type Change,
		type Filter,
		type Profile
	} from '@potatosalad775/eqcaps-core';
	import { catalog } from '$lib/data.svelte';
	import { formatApo, parseFilters } from '$lib/filters-text';
	import { formatField } from '$lib/format';
	import { violationText } from '$lib/violations';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	const SAMPLE = `# AutoEQ ParametricEQ.txt and Equalizer APO text work, and so does JSON.
Preamp: -6.4 dB
Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 2: ON PK Fc 31 Hz Gain -1.2 dB Q 0.58
Filter 3: ON PK Fc 215 Hz Gain -3.1 dB Q 0.91
Filter 4: ON PK Fc 1077 Hz Gain 1.9 dB Q 1.63
Filter 5: ON PK Fc 2817 Hz Gain 3.4 dB Q 2.17
Filter 6: ON PK Fc 4302 Hz Gain -4.7 dB Q 3.85
Filter 7: ON PK Fc 6203 Hz Gain 2.6 dB Q 4.12
Filter 8: ON PK Fc 8148 Hz Gain -3.9 dB Q 5.31
Filter 9: ON PK Fc 13554 Hz Gain -2.2 dB Q 1.12
Filter 10: ON HSC Fc 10000 Hz Gain -1.8 dB Q 0.70
Filter 11: ON PK Fc 19000 Hz Gain 0.8 dB Q 0.70`;

	const DRAFT_KEY = 'eqcaps-inspector:playground';
	const saved = (() => {
		try {
			return localStorage.getItem(DRAFT_KEY);
		} catch {
			return null;
		}
	})();

	let text = $state(saved ?? SAMPLE);
	let profileId = $state(page.url.searchParams.get('profile') ?? 'jds-labs-element-iv');
	let profile = $state.raw<Profile | null | undefined>(undefined);

	$effect(() => {
		try {
			if (text === SAMPLE) localStorage.removeItem(DRAFT_KEY);
			else localStorage.setItem(DRAFT_KEY, text);
		} catch {
			// Remembering the draft is a convenience only.
		}
	});

	// replaceState throws until the router has started; the first navigation marks that.
	let routerReady = $state(false);
	afterNavigate(() => (routerReady = true));

	$effect(() => {
		if (!routerReady) return;
		const url = new URL(page.url);
		url.searchParams.set('profile', profileId);
		// Same page, new query: there is no route to resolve.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		if (url.search !== page.url.search) replaceState(url, {});
	});

	$effect(() => {
		const id = profileId;
		profile = undefined;
		catalog.profile(id).then((p) => {
			if (profileId === id) profile = p;
		});
	});

	const parsed = $derived(parseFilters(text));

	type Result = {
		violations: ReturnType<typeof validateList>;
		written: Filter[];
		fitted: ReturnType<typeof fit>;
		completed: ReturnType<typeof complete> | null;
		error?: undefined;
	};
	const result: Result | { error: string } | null = $derived.by(() => {
		if (!profile) return null;
		const { filters, preamp } = parsed;
		try {
			const fitted = fit(profile, filters, preamp);
			return {
				violations: validateList(profile, filters, preamp),
				written: filters.map((f) => toWritten(profile as Profile, f)),
				fitted,
				completed: profile.kind === 'hardware' ? complete(profile, fitted.slots) : null
			};
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	});

	const hasLaws = $derived((profile?.realization?.laws.length ?? 0) > 0);

	const options = $derived(
		[...(catalog.index?.profiles ?? [])]
			.filter((e) => e.status !== 'deprecated')
			.sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`))
	);

	/** The input filter in each slot, from fit's slotOf. */
	function inputOf(slotOf: (number | null)[]): (number | undefined)[] {
		const inputs: (number | undefined)[] = [];
		slotOf.forEach((s, k) => {
			if (s !== null) inputs[s] = k;
		});
		return inputs;
	}

	function changed(changes: Change[], k: number | undefined, field: Change['field']): boolean {
		return k !== undefined && changes.some((c) => c.filter === k && c.field === field);
	}

	let copied = $state('');
	async function copy(label: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copied = label;
			setTimeout(() => (copied = ''), 1500);
		} catch {
			copied = 'Copy failed';
		}
	}

	const present = (xs: (Filter | null)[]) => xs.filter((x): x is Filter => x !== null);
</script>

<svelte:head><title>Playground · eqcaps</title></svelte:head>

{#snippet cell(field: 'freq' | 'q' | 'gain', f: Filter | null | undefined, hot = false)}
	<td
		class="px-2 py-1 text-right font-mono tabular-nums {hot
			? 'bg-amber-100 font-semibold dark:bg-amber-900/50'
			: ''}"
	>
		{f ? formatField(field, f[field]) : ''}
	</td>
{/snippet}

<div class="space-y-2">
	<h1 class="text-2xl font-semibold">Playground</h1>
	<p class="max-w-3xl text-zinc-600 dark:text-zinc-400">
		Paste filters and pick a profile to see what the engine makes of them: which filters the profile
		rejects (<code>validateList</code>), the closest filters it accepts (<code>fit</code>), and for
		hardware every band that gets written (<code>complete</code>). Nothing leaves your browser.
	</p>
</div>

<div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
	<section class="space-y-3">
		<label class="block text-sm font-medium" for="profile">Profile</label>
		<div class="flex items-center gap-2">
			<select
				id="profile"
				bind:value={profileId}
				class="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
			>
				{#if !options.some((o) => o.id === profileId)}<option value={profileId}>{profileId}</option
					>{/if}
				{#each options as o (o.id)}
					<option value={o.id}
						>{o.brand}
						{o.model}{o.engine ? ` (${o.engine})` : ''}{o.status === 'draft'
							? ''
							: ` · ${o.status}`}</option
					>
				{/each}
			</select>
			<a class="text-sm whitespace-nowrap" href={resolve('/p/[id]', { id: profileId })}>View</a>
		</div>
		{#if profile}
			<p class="flex items-center gap-2 text-xs text-zinc-500">
				<StatusBadge status={profile.meta.status} />
				{profile.bandCount === null ? 'unlimited bands' : `${profile.bandCount} bands`}, preamp {profile
					.preamp.mode}{hasLaws ? ', realization laws' : ''}
			</p>
		{:else if profile === null}
			<p class="text-sm text-red-700 dark:text-red-400">No profile "{profileId}".</p>
		{/if}

		<label class="block pt-2 text-sm font-medium" for="filters">Filters</label>
		<textarea
			id="filters"
			bind:value={text}
			spellcheck="false"
			rows="18"
			class="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
		></textarea>
		<div class="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
			<span
				>{parsed.filters.length} filter{parsed.filters.length === 1 ? '' : 's'}, preamp {formatField(
					'preamp',
					parsed.preamp
				)} dB{parsed.skipped ? `, ${parsed.skipped} switched off` : ''}</span
			>
			{#if text !== SAMPLE}
				<button type="button" class="underline" onclick={() => (text = SAMPLE)}
					>Reset to sample</button
				>
			{/if}
		</div>
		{#if parsed.problems.length}
			<ul class="space-y-0.5 text-xs text-red-700 dark:text-red-400">
				{#each parsed.problems as p, i (i)}
					<li>{p.line > 0 ? `Line ${p.line}: ` : ''}{p.message}</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="min-w-0 space-y-6">
		{#if !result}
			<p class="text-zinc-500">{profile === undefined ? 'Loading the profile…' : ''}</p>
		{:else if result.error !== undefined}
			<p class="text-red-700 dark:text-red-400">The engine failed: {result.error}</p>
		{:else}
			{@const r = result}
			{@const slots = inputOf(r.fitted.slotOf)}
			<div>
				<h2 class="text-lg font-semibold">Validate</h2>
				{#if r.violations.length === 0}
					<p class="mt-1 text-emerald-700 dark:text-emerald-400">
						The profile accepts these filters as they are.
					</p>
				{:else}
					<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
						{r.violations.length} problem{r.violations.length === 1 ? '' : 's'}{hasLaws
							? ' (values are written values, after the realization laws)'
							: ''}:
					</p>
					<ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm">
						{#each r.violations as v, i (i)}<li>{violationText(v, r.written)}</li>{/each}
					</ul>
				{/if}
			</div>

			<div>
				<div class="flex flex-wrap items-baseline gap-x-3">
					<h2 class="text-lg font-semibold">Fit</h2>
					<span
						class="text-sm {r.fitted.feasible
							? 'text-emerald-700 dark:text-emerald-400'
							: 'text-amber-700 dark:text-amber-400'}"
					>
						{r.fitted.feasible ? 'valid for this profile' : 'still breaks a rule'}
					</span>
					<span class="text-sm text-zinc-500">
						preamp {formatField('preamp', parsed.preamp)} → {formatField('preamp', r.fitted.preamp)} dB
					</span>
				</div>
				<div class="mt-2 overflow-x-auto">
					<table class="text-sm">
						<thead class="text-xs text-zinc-500">
							<tr>
								<th class="px-2 text-left font-normal">Slot</th>
								<th class="px-2 text-left font-normal" colspan="4">Wanted</th>
								<th class="px-2 text-left font-normal" colspan="4">
									{hasLaws ? 'Realized (what you hear)' : 'Fitted'}
								</th>
								{#if hasLaws}<th class="px-2 text-left font-normal" colspan="2">Written</th>{/if}
							</tr>
							<tr class="border-b border-zinc-200 dark:border-zinc-800">
								<th></th>
								<th class="px-2 font-normal">#</th><th class="px-2 font-normal">type</th>
								<th class="px-2 text-right font-normal">Hz</th><th
									class="px-2 text-right font-normal">dB · Q</th
								>
								<th class="px-2 font-normal">type</th><th class="px-2 text-right font-normal">Hz</th
								>
								<th class="px-2 text-right font-normal">dB</th><th
									class="px-2 text-right font-normal">Q</th
								>
								{#if hasLaws}<th class="px-2 text-right font-normal">Hz</th><th
										class="px-2 text-right font-normal">Q</th
									>{/if}
							</tr>
						</thead>
						<tbody>
							{#each r.fitted.slots as s, i (i)}
								{@const k = slots[i]}
								{@const w = k !== undefined ? parsed.filters[k] : undefined}
								{@const real = r.fitted.realized[i]}
								<tr
									class="border-b border-zinc-100 dark:border-zinc-900 {s ? '' : 'text-zinc-400'}"
								>
									<td class="px-2 py-1 font-mono">{i + 1}</td>
									<td class="px-2 py-1 font-mono text-zinc-500">{k !== undefined ? k + 1 : ''}</td>
									<td class="px-2 py-1 font-mono">{w?.type ?? ''}</td>
									<td class="px-2 py-1 text-right font-mono tabular-nums"
										>{w ? formatField('freq', w.freq) : ''}</td
									>
									<td class="px-2 py-1 text-right font-mono whitespace-nowrap tabular-nums"
										>{w ? `${formatField('gain', w.gain)} · ${formatField('q', w.q)}` : ''}</td
									>
									{#if s && real}
										<td
											class="px-2 py-1 font-mono {changed(r.fitted.changes, k, 'type')
												? 'bg-amber-100 font-semibold dark:bg-amber-900/50'
												: ''}">{real.type}</td
										>
										{@render cell('freq', real, changed(r.fitted.changes, k, 'freq'))}
										{@render cell('gain', real, changed(r.fitted.changes, k, 'gain'))}
										{@render cell('q', real, changed(r.fitted.changes, k, 'q'))}
										{#if hasLaws}
											{@render cell('freq', s)}
											{@render cell('q', s)}
										{/if}
									{:else}
										<td class="px-2 py-1 text-xs" colspan={hasLaws ? 6 : 4}>empty</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if r.fitted.changes.length}
					<p class="mt-2 text-xs text-zinc-500">
						Highlighted: {r.fitted.changes.length} value{r.fitted.changes.length === 1 ? '' : 's'} moved
						to fit the profile.
					</p>
				{/if}
				{#if r.fitted.unassigned.length}
					<p class="mt-2 text-sm text-amber-700 dark:text-amber-400">
						Left out ({r.fitted.unassigned.length}, the least significant):
						{r.fitted.unassigned
							.map(
								(f) =>
									`${f.type} ${formatField('freq', f.freq)} Hz ${formatField('gain', f.gain)} dB`
							)
							.join('; ')}
					</p>
				{/if}
				{#each r.fitted.changes.filter((c) => c.field === 'gain' && c.slot === null && c.filter !== null) as c, i (i)}
					<p class="mt-1 text-xs text-zinc-500">
						Filter {(c.filter ?? 0) + 1} rounds to 0 dB here, so it is dropped.
					</p>
				{/each}
				<div class="mt-3 flex flex-wrap gap-3 text-sm">
					<button
						type="button"
						class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700"
						onclick={() =>
							copy('Fitted filters copied', formatApo(present(r.fitted.realized), r.fitted.preamp))}
						>Copy fitted filters (APO text)</button
					>
					<button
						type="button"
						class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700"
						onclick={() =>
							copy(
								'Written values copied',
								JSON.stringify({ preamp: r.fitted.preamp, slots: r.fitted.slots }, null, 2)
							)}>Copy written values (JSON)</button
					>
					{#if copied}<span class="self-center text-xs text-zinc-500">{copied}</span>{/if}
				</div>
			</div>

			{#if r.completed}
				<div>
					<h2 class="text-lg font-semibold">Write</h2>
					<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
						A device takes all {r.completed.filters.length} bands; <code>complete</code> fills the empty
						ones with flat filters.
					</p>
					<ol class="mt-2 gap-x-6 font-mono text-xs sm:columns-2">
						{#each r.completed.filters as f, i (i)}
							<li class={r.fitted.slots[i] ? '' : 'text-zinc-400'}>
								{i + 1}. {f.type}
								{formatField('freq', f.freq)} Hz {formatField('gain', f.gain)} dB Q {formatField(
									'q',
									f.q
								)}
								{r.fitted.slots[i] ? '' : '(filler)'}
							</li>
						{/each}
					</ol>
					{#each r.completed.warnings as w, i (i)}
						<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
							Slot {w.slot + 1}: {w.code === 'not-neutral'
								? "the slot can't be made flat, so its filler changes the sound"
								: 'no frequency keeps the bands in ascending order'}
						</p>
					{/each}
				</div>
			{/if}
		{/if}
	</section>
</div>
