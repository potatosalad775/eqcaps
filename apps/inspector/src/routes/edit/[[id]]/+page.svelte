<script lang="ts">
	// T4 author and submit (INSPECTOR §2): edit an authoring file as a form and as JSON, check it
	// the way CI does while typing, see the result and the diff, and turn it into a pull request
	// or an issue on GitHub. Nothing is sent anywhere by the app: submitting is a link.
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		describe,
		FILTER_TYPES,
		type AuthoringProfile,
		type AuthoringSource,
		type Domain,
		type FilterType
	} from '@potatosalad775/eqcaps-core';
	import type { DataFile } from '@potatosalad775/eqcaps-build';
	import { authoringPath, baseIds, httpReader, loadChain } from '$lib/authoring';
	import { sourcesUrl } from '$lib/channel';
	import { identityText, readFindings } from '$lib/connect';
	import { catalog } from '$lib/data.svelte';
	import {
		blankProfile,
		checkEdited,
		diffHunks,
		formatAuthoring,
		lineDiff,
		profileIssueUrl,
		pullRequestUrl,
		withSchemaRef
	} from '$lib/editor';
	import { edited, listOf, setOptional } from '$lib/editor-form';
	import { today } from '$lib/evidence';
	import { citeEvidence, loadHandoff, profileForDevice, type Handoff } from '$lib/handoff';
	import { REPO_URL } from '$lib/repo';
	import { schemaValidator } from '$lib/schemas';
	import { violationText } from '$lib/violations';
	import DomainInput from '$lib/components/DomainInput.svelte';
	import SlotChart from '$lib/components/SlotChart.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const read = httpReader(sourcesUrl());
	const SOURCE_KINDS: AuthoringSource['kind'][] = [
		'vendor-docs',
		'vendor-app',
		'measurement',
		'community',
		'handler-code'
	];
	const STATUSES = ['draft', 'community-verified', 'maintainer-verified', 'deprecated'] as const;

	/** The text the editor started from, and where it lives; null for a new file. */
	let original = $state<string | null>(null);
	let originalPath = $state<string | null>(null);
	let initial = $state('');
	let text = $state('');
	let loading = $state(true);
	let loadError = $state('');
	let handoff = $state.raw<Handoff | null>(null);
	let chain = $state.raw<DataFile[]>([]);
	let draft = $state<{ text: string; saved: string } | null>(null);
	let notice = $state('');
	let textarea = $state<HTMLTextAreaElement | null>(null);

	const draftKey = $derived(`eqcaps-inspector:edit:${data.id ?? 'new'}`);

	function parse(t: string): AuthoringProfile | null {
		try {
			const d = JSON.parse(t) as unknown;
			return d && typeof d === 'object' && !Array.isArray(d) ? (d as AuthoringProfile) : null;
		} catch {
			return null;
		}
	}

	async function start(id: string | null, query: URLSearchParams) {
		loading = true;
		loadError = '';
		original = null;
		originalPath = null;
		draft = null;
		await catalog.load();
		const entries = catalog.index?.profiles ?? [];
		handoff = query.has('device') ? loadHandoff() : null;
		try {
			let start: AuthoringProfile;
			if (id) {
				const entry = entries.find((e) => e.id === id);
				const path = entry
					? authoringPath({ id, device: { brand: entry.brand } })
					: `data/bases/${id}.json`;
				const t = await read(path);
				if (t === null) throw new Error(`there is no authoring file for "${id}" (${path})`);
				original = t;
				originalPath = path;
				start = parse(t) ?? blankProfile();
				if (!handoff) {
					text = initial = t;
					restoreDraft();
					return;
				}
				start = citeEvidence(start, handoff);
			} else if (query.get('copy')) {
				const copyId = query.get('copy') as string;
				const entry = entries.find((e) => e.id === copyId);
				const t = entry
					? await read(authoringPath({ id: copyId, device: { brand: entry.brand } }))
					: null;
				const from = t ? parse(t) : null;
				if (!from) throw new Error(`there is no authoring file for "${copyId}"`);
				start = { ...from, id: '', meta: { status: 'draft', sources: [] } };
				delete start.match;
				if (start.kind === 'hardware') start.match = { usb: [] };
			} else if (handoff) {
				start = profileForDevice(handoff);
			} else {
				start = blankProfile({
					...(query.get('extends') ? { extends: query.get('extends') as string } : {}),
					kind: query.get('kind') === 'software' ? 'software' : 'hardware'
				});
			}
			text = initial = await formatAuthoring(withSchemaRef(start, authoringPath(start)));
			restoreDraft();
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function restoreDraft() {
		loading = false;
		try {
			const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as {
				text: string;
				saved: string;
			} | null;
			if (saved && saved.text !== text) draft = saved;
		} catch {
			// Drafts are a convenience only.
		}
	}

	$effect(() => {
		const id = data.id;
		const query = new URLSearchParams(page.url.search);
		untrack(() => start(id, query));
	});

	// Keep an unsent draft in this browser, so a reload or a closed tab doesn't lose work.
	$effect(() => {
		const t = text;
		const key = draftKey;
		if (loading) return;
		const timer = setTimeout(() => {
			try {
				if (t === initial) localStorage.removeItem(key);
				else
					localStorage.setItem(key, JSON.stringify({ text: t, saved: new Date().toISOString() }));
			} catch {
				// Drafts are a convenience only.
			}
		}, 500);
		return () => clearTimeout(timer);
	});

	const parsed = $derived(parse(text));
	const path = $derived(parsed ? authoringPath(parsed) : (originalPath ?? ''));
	const moved = $derived(originalPath !== null && path !== originalPath);
	const extendsId = $derived(typeof parsed?.extends === 'string' ? parsed.extends : undefined);

	$effect(() => {
		const id = extendsId;
		const d = untrack(() => parsed);
		if (!id || !d) {
			chain = [];
			return;
		}
		loadChain(d, catalog.index?.profiles ?? [], read)
			.then((c) => {
				if (extendsId === id) chain = c;
			})
			.catch(() => (chain = []));
	});

	// Checked a moment after typing stops.
	let checkedText = $state('');
	$effect(() => {
		const t = text;
		const timer = setTimeout(() => (checkedText = t), 250);
		return () => clearTimeout(timer);
	});

	// The handoff's evidence file, wherever the file cites it: a new device's evidence moves to
	// evidence/<id>/ once the profile has an id.
	const evidenceName = $derived(
		handoff ? handoff.evidence.path.slice(handoff.evidence.path.lastIndexOf('/') + 1) : ''
	);
	const evidenceRef = $derived.by(() => {
		if (!handoff) return '';
		const cited = (parsed?.meta?.sources ?? []).find(
			(s) => s.ref.startsWith('evidence/') && s.ref.endsWith(`/${evidenceName}`)
		);
		return cited?.ref ?? handoff.evidence.path;
	});

	const evidence = $derived.by(() => {
		// A plain Set: built once per derivation and never mutated after.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const refs = new Set<string>();
		const from = original ? parse(original) : null;
		for (const s of from?.meta?.sources ?? []) {
			if (s.ref.startsWith('evidence/')) refs.add(s.ref);
		}
		if (evidenceRef) refs.add(evidenceRef);
		return refs;
	});

	const result = $derived.by(() => {
		if (loading || !checkedText || !path) return null;
		return checkEdited({
			path,
			text: checkedText,
			chain,
			others: catalog.bundle?.profiles ?? [],
			evidence,
			knownIds: new Set((catalog.index?.profiles ?? []).map((e) => e.id)),
			schema: schemaValidator()
		});
	});
	const errors = $derived(result?.issues.filter((i) => i.severity === 'error') ?? []);
	const summary = $derived(result?.profile ? describe(result.profile) : null);
	const findings = $derived(
		handoff && result?.profile
			? readFindings(result.profile, handoff.readBack, { needsBandCount: handoff.needsBandCount })
			: null
	);
	const diff = $derived(diffHunks(lineDiff(original ?? '', text)));
	const changed = $derived(text !== (original ?? ''));
	const bases = $derived(baseIds(catalog.bundle?.profiles ?? []));

	/** Applies a form edit: the JSON is rewritten and reformatted, keeping the file's location. */
	async function apply(edit: (d: AuthoringProfile) => void) {
		if (!parsed) return;
		const next = edited(parsed, edit);
		text = await formatAuthoring(withSchemaRef(next, authoringPath(next)));
	}

	async function reformat() {
		if (parsed) text = await formatAuthoring(withSchemaRef(parsed, authoringPath(parsed)));
	}

	function goToLine(line: number | undefined) {
		if (!textarea || line === undefined) return;
		const lines = text.split('\n');
		const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
		textarea.focus();
		textarea.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
		const lineHeight = textarea.scrollHeight / Math.max(lines.length, 1);
		textarea.scrollTop = Math.max(0, (line - 5) * lineHeight);
	}

	async function copy(t: string, what: string) {
		try {
			await navigator.clipboard.writeText(t);
			notice = `${what} copied to the clipboard.`;
		} catch {
			notice = `Copying failed: select the ${what.toLowerCase()} and copy it by hand.`;
		}
	}

	function download(name: string, t: string) {
		const url = URL.createObjectURL(new Blob([t], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function openPullRequest() {
		const exists = originalPath !== null && !moved;
		const s = pullRequestUrl(path, text, exists);
		if (s.paste) {
			await copy(text, 'The file');
			notice += exists
				? ' On GitHub, replace the file’s text with it, then propose the change.'
				: ' The file is too long for a link: paste it on GitHub, then propose the file.';
		}
		window.open(s.url, '_blank', 'noopener');
	}

	async function openIssue() {
		const name = parsed ? `${parsed.device?.brand ?? ''} ${parsed.device?.model ?? ''}`.trim() : '';
		const sources = (parsed?.meta?.sources ?? []).map((s) => `- ${s.kind}: ${s.ref}`).join('\n');
		const s = profileIssueUrl({
			device: name || parsed?.id || 'unknown',
			identity: handoff ? identityText(handoff.identity) : '',
			text,
			evidence: `${sources}${handoff ? `\n\nEvidence file attached: ${evidenceRef}` : ''}`
		});
		if (s.paste) await copy(text, 'The file');
		window.open(s.url, '_blank', 'noopener');
	}

	const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
	const input =
		'rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';
	const inherited = $derived(extendsId !== undefined);
	const band = $derived(parsed?.band);
	const today_ = today();
</script>

<svelte:head><title>{data.id ? `Edit ${data.id}` : 'New profile'} · eqcaps</title></svelte:head>

<div class="max-w-3xl space-y-2">
	<h1 class="text-2xl font-semibold">{data.id ? `Edit ${data.id}` : 'New profile'}</h1>
	<p class="text-zinc-600 dark:text-zinc-400">
		Edit the file as a form or as JSON. It is checked as you type, with the same rules CI runs, and
		becomes a pull request on GitHub when you are done. The format is defined in
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- GitHub, not a route -->
		<a href="{REPO_URL}/blob/main/docs/SPEC.md">SPEC.md</a>.
	</p>
	{#if !data.id}
		<p class="text-sm">
			Start from
			<a href={resolve('/edit/[[id]]', {})}>a blank profile</a>,
			<a href="{resolve('/edit/[[id]]', {})}?kind=software">a blank software EQ</a>, a base below,
			or any profile's “New profile from this one”.
		</p>
	{/if}
</div>

{#if loading}
	<p class="mt-6 text-zinc-500">Loading…</p>
{:else if loadError}
	<p class="mt-6 text-red-700 dark:text-red-400">Could not start the editor: {loadError}.</p>
{:else}
	{#if draft}
		<div
			class="mt-4 flex flex-wrap items-center gap-3 rounded bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950"
		>
			<span
				>You have an unsent draft of this file from {new Date(draft.saved).toLocaleString()}.</span
			>
			<button
				type="button"
				class="underline"
				onclick={() => {
					text = draft!.text;
					draft = null;
				}}>Restore it</button
			>
			<button
				type="button"
				class="underline"
				onclick={() => {
					draft = null;
					try {
						localStorage.removeItem(draftKey);
					} catch {
						// Nothing stored.
					}
				}}>Discard it</button
			>
		</div>
	{/if}

	{#if handoff}
		<div class="mt-4 rounded bg-teal-50 px-3 py-2 text-sm dark:bg-teal-950">
			{#if handoff.action === 'new' && handoff.extends}
				A profile of its own for your device, extending <span class="font-mono"
					>{handoff.extends}</span
				>: fill in its brand, model and id;
				{handoff.guided
					? 'the constraints the guided read found are written out, overriding what it inherits.'
					: 'everything else is inherited.'}
			{/if}
			{#if handoff.guided}
				Started from your guided read in {handoff.guided.vendorApp}: its band count, types, domains
				and preamp are in the file, and the evidence file
				<span class="font-mono">{evidenceRef}</span> is cited in
				<span class="font-mono">meta.sources</span> as vendor-app evidence, which counts toward a
				verified status once a maintainer has reviewed it. What it didn't check is in
				<span class="font-mono">meta.notes</span>.
			{:else}
				Started from your device's read-back: the evidence file
				<span class="font-mono">{evidenceRef}</span> is cited in
				<span class="font-mono">meta.sources</span>. Change the values the read-back shows are
				wrong, and the check on the right updates as you type.
			{/if}
		</div>
	{/if}

	<div class="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
		<section class="min-w-0 space-y-6">
			{#if parsed}
				<details open class="space-y-3">
					<summary class="cursor-pointer text-lg font-semibold">Form</summary>
					<p class="text-xs text-zinc-500">
						Common fields. Per-slot overrides, conditional domains and rules are edited in the JSON
						below. A field is written to the file when you leave it.
					</p>

					<div class="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2 text-sm">
						<label for="f-id">Id</label>
						<input
							id="f-id"
							class="{input} font-mono"
							value={parsed.id}
							placeholder="brand-model"
							onchange={(e) =>
								apply((d) => {
									const id = e.currentTarget.value.trim();
									d.id = id;
									// A new device's evidence file lives under the profile's id.
									for (const src of d.meta?.sources ?? []) {
										if (handoff?.action === 'new' && src.ref === evidenceRef) {
											src.ref = `evidence/${id || 'new-device'}/${evidenceName}`;
										}
									}
								})}
						/>
						<label for="f-brand">Brand</label>
						<input
							id="f-brand"
							class={input}
							value={parsed.device?.brand ?? ''}
							onchange={(e) =>
								apply((d) => (d.device = { ...d.device!, brand: e.currentTarget.value }))}
						/>
						<label for="f-model">Model</label>
						<input
							id="f-model"
							class={input}
							value={parsed.device?.model ?? ''}
							onchange={(e) =>
								apply((d) => (d.device = { ...d.device!, model: e.currentTarget.value }))}
						/>
						{#if parsed.kind === 'hardware'}
							<label for="f-group">Group</label>
							<label class="flex items-center gap-2 text-xs text-zinc-500">
								<input
									id="f-group"
									type="checkbox"
									checked={parsed.device?.group === true}
									onchange={(e) =>
										apply((d) => {
											const device = { ...d.device! };
											setOptional(device, 'group', e.currentTarget.checked || undefined);
											d.device = device;
										})}
								/>
								Stands for several products its match can't tell apart (SPEC §3)
							</label>
						{/if}
						<label for="f-aliases">Aliases</label>
						<input
							id="f-aliases"
							class={input}
							value={parsed.device?.aliases?.join(', ') ?? ''}
							placeholder="comma-separated, optional"
							onchange={(e) =>
								apply((d) => {
									const device = { ...d.device! };
									setOptional(device, 'aliases', listOf(e.currentTarget.value));
									d.device = device;
								})}
						/>
						<label for="f-engine">Engine</label>
						<input
							id="f-engine"
							class={input}
							value={parsed.engine ?? ''}
							placeholder="optional label, e.g. PEQ"
							onchange={(e) => apply((d) => setOptional(d, 'engine', e.currentTarget.value.trim()))}
						/>
						<label for="f-extends">Extends</label>
						<select
							id="f-extends"
							class={input}
							value={parsed.extends ?? ''}
							onchange={(e) => apply((d) => setOptional(d, 'extends', e.currentTarget.value))}
						>
							<option value="">nothing (a complete profile)</option>
							{#if parsed.extends && !bases.includes(parsed.extends)}
								<option value={parsed.extends}>{parsed.extends}</option>
							{/if}
							{#each bases as id (id)}<option value={id}>{id}</option>{/each}
						</select>
						<label for="f-bands">Bands</label>
						<input
							id="f-bands"
							class="{input} w-24"
							type="number"
							min="1"
							value={parsed.bandCount ?? ''}
							placeholder={inherited ? 'inherited' : parsed.kind === 'software' ? 'unbounded' : ''}
							onchange={(e) =>
								apply((d) => {
									const v = e.currentTarget.value;
									if (v === '') {
										if (inherited) delete d.bandCount;
										else d.bandCount = null;
									} else d.bandCount = Math.round(Number(v));
								})}
						/>
					</div>

					<div class="space-y-2">
						<h3 class="font-medium">
							Every band <span class="text-xs font-normal text-zinc-500"
								>(the slot template; {inherited ? 'empty fields are inherited' : 'SPEC §5'})</span
							>
						</h3>
						<div class="flex flex-wrap gap-3 text-sm">
							{#each FILTER_TYPES as t (t)}
								<label class="flex items-center gap-1">
									<input
										type="checkbox"
										checked={band?.types?.includes(t) ?? false}
										onchange={(e) =>
											apply((d) => {
												const types = new Set<FilterType>(d.band?.types ?? []);
												if (e.currentTarget.checked) types.add(t);
												else types.delete(t);
												const order = FILTER_TYPES.filter((x) => types.has(x));
												d.band = { ...d.band };
												setOptional(d.band, 'types', order);
											})}
									/>
									<span class="font-mono">{t}</span>
								</label>
							{/each}
						</div>
						{#each [['freq', 'Freq', 'Hz'], ['q', 'Q', ''], ['gain', 'Gain', 'dB']] as const as [field, label, unit] (field)}
							<DomainInput
								{label}
								{unit}
								domain={band?.[field]}
								onchange={(dom: Domain) => apply((d) => (d.band = { ...d.band, [field]: dom }))}
							/>
						{/each}
					</div>

					<div class="flex flex-wrap items-center gap-3 text-sm">
						<label for="f-preamp" class="font-medium">Preamp</label>
						<select
							id="f-preamp"
							class={input}
							value={parsed.preamp?.mode ?? ''}
							onchange={(e) =>
								apply((d) => {
									const mode = e.currentTarget.value;
									if (mode === '') delete d.preamp;
									else if (mode === 'manual')
										d.preamp = { mode, gain: { min: -12, max: 0, step: 0.1 } };
									else d.preamp = { mode: mode as 'auto' | 'none' | 'unknown' };
								})}
						>
							{#if inherited}<option value="">inherited</option>{/if}
							<option value="manual">manual</option>
							<option value="auto">auto</option>
							<option value="none">none</option>
							<option value="unknown">unknown</option>
						</select>
					</div>
					{#if parsed.preamp?.mode === 'manual'}
						<DomainInput
							label="Preamp"
							unit="dB"
							domain={parsed.preamp.gain}
							onchange={(dom: Domain) => apply((d) => (d.preamp = { mode: 'manual', gain: dom }))}
						/>
					{/if}

					<div class="space-y-2">
						<h3 class="font-medium">
							Provenance <span class="text-xs font-normal text-zinc-500">(SPEC §10)</span>
						</h3>
						<label class="flex items-center gap-3 text-sm">
							Status
							<select
								class={input}
								value={parsed.meta?.status ?? 'draft'}
								onchange={(e) =>
									apply((d) => {
										d.meta = {
											...d.meta,
											status: e.currentTarget.value as (typeof STATUSES)[number]
										};
										if (d.meta.status !== 'deprecated') delete d.meta.replacedBy;
									})}
							>
								{#each STATUSES as s (s)}<option value={s}>{s}</option>{/each}
							</select>
						</label>
						<p class="text-xs text-zinc-500">
							Verified statuses need a source that counts: vendor docs, a vendor app or a
							measurement. handler-code and community sources don't count.
						</p>
						{#each parsed.meta?.sources ?? [] as s, i (i)}
							<div
								class="space-y-1 rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800"
							>
								<div class="flex flex-wrap gap-2">
									<select
										class={input}
										value={s.kind}
										aria-label="Source {i + 1} kind"
										onchange={(e) =>
											apply((d) => {
												d.meta.sources[i]!.kind = e.currentTarget.value as AuthoringSource['kind'];
											})}
									>
										{#each SOURCE_KINDS as k (k)}<option value={k}>{k}</option>{/each}
									</select>
									<input
										class="{input} w-32"
										value={s.date}
										aria-label="Source {i + 1} date"
										placeholder="YYYY-MM-DD"
										onchange={(e) =>
											apply((d) => (d.meta.sources[i]!.date = e.currentTarget.value.trim()))}
									/>
									<input
										class="{input} w-28"
										value={s.firmware ?? ''}
										aria-label="Source {i + 1} firmware"
										placeholder="firmware"
										onchange={(e) =>
											apply((d) =>
												setOptional(d.meta.sources[i]!, 'firmware', e.currentTarget.value.trim())
											)}
									/>
									<input
										class="{input} w-32"
										value={s.by ?? ''}
										aria-label="Source {i + 1} GitHub handle"
										placeholder="GitHub handle"
										onchange={(e) =>
											apply((d) =>
												setOptional(d.meta.sources[i]!, 'by', e.currentTarget.value.trim())
											)}
									/>
									<button
										type="button"
										class="ml-auto text-xs underline"
										onclick={() => apply((d) => d.meta.sources.splice(i, 1))}>Remove</button
									>
								</div>
								<input
									class="{input} w-full"
									value={s.ref}
									aria-label="Source {i + 1} reference"
									placeholder="URL, citation, or evidence/<id>/<file>.json"
									onchange={(e) =>
										apply((d) => (d.meta.sources[i]!.ref = e.currentTarget.value.trim()))}
								/>
							</div>
						{/each}
						<button
							type="button"
							class="text-sm underline"
							onclick={() =>
								apply((d) => {
									d.meta = d.meta ?? { status: 'draft', sources: [] };
									d.meta.sources = [
										...(d.meta.sources ?? []),
										{ kind: 'vendor-docs', ref: '', date: today_ }
									];
								})}>Add a source</button
						>
						<label class="block text-sm" for="f-contributors">Contributors</label>
						<input
							id="f-contributors"
							class="{input} w-full"
							value={parsed.meta?.contributors?.join(', ') ?? ''}
							placeholder="GitHub handles, comma-separated"
							onchange={(e) =>
								apply((d) => setOptional(d.meta, 'contributors', listOf(e.currentTarget.value)))}
						/>
						<label class="block text-sm" for="f-notes">Notes</label>
						<textarea
							id="f-notes"
							class="{input} w-full"
							rows="3"
							value={parsed.meta?.notes ?? ''}
							onchange={(e) =>
								apply((d) => setOptional(d.meta, 'notes', e.currentTarget.value.trim()))}
						></textarea>
					</div>
				</details>
			{/if}

			<div>
				<div class="flex flex-wrap items-baseline gap-3">
					<h2 class="text-lg font-semibold">JSON</h2>
					<span class="font-mono text-xs text-zinc-500">{path}</span>
					<button
						type="button"
						class="ml-auto text-sm underline"
						disabled={!parsed}
						onclick={reformat}>Format</button
					>
				</div>
				<textarea
					bind:this={textarea}
					bind:value={text}
					spellcheck="false"
					rows="28"
					wrap="off"
					aria-label="Profile JSON"
					class="mt-2 w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs leading-5 dark:border-zinc-700 dark:bg-zinc-900"
				></textarea>
			</div>
		</section>

		<section class="min-w-0 space-y-6">
			<div>
				<h2 class="text-lg font-semibold">Check</h2>
				{#if !result}
					<p class="mt-1 text-sm text-zinc-500">Checking…</p>
				{:else}
					{#if result.issues.length === 0 && result.chainIssues.length === 0}
						<p class="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
							{result.profile
								? 'The file passes every check CI runs on it.'
								: 'The file passes. It is a base, so it is checked through the profiles that extend it.'}
						</p>
					{/if}
					{#if result.issues.length > 0}
						<ul class="mt-1 space-y-1 text-sm">
							{#each result.issues as issue, i (i)}
								<li>
									<button
										type="button"
										class="text-left"
										onclick={() => goToLine(issue.line)}
										title="Show the line"
									>
										<span class="font-mono text-xs text-zinc-500">{issue.line ?? ''}</span>
										<span
											class={issue.severity === 'error'
												? 'text-red-700 dark:text-red-400'
												: 'text-amber-700 dark:text-amber-400'}>{issue.code}</span
										>
										{issue.path ? `${issue.path}: ` : ''}{issue.message}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					{#if result.chainIssues.length > 0}
						<p class="mt-2 text-sm">Problems in the files this one extends:</p>
						<ul class="mt-1 list-disc pl-5 text-sm">
							{#each result.chainIssues as issue, i (i)}
								<li>{issue.file}: {issue.code} {issue.path} {issue.message}</li>
							{/each}
						</ul>
					{/if}
					{#if moved}
						<p class="mt-2 text-sm text-amber-700 dark:text-amber-400">
							The file would move from {originalPath} to {path}. Ids are permanent: to rename a
							profile, deprecate it with <span class="font-mono">replacedBy</span> and add a new one.
						</p>
					{/if}
				{/if}
			</div>

			{#if findings && handoff}
				<div>
					<h2 class="text-lg font-semibold">Against your device's read-back</h2>
					{#if !findings.bandCount && findings.violations.length === 0}
						<p class="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
							Everything the device held fits this version of the profile.
						</p>
					{:else}
						<ul class="mt-1 list-disc pl-5 text-sm">
							{#if findings.bandCount}
								<li>
									The device returned {findings.bandCount.read} bands; the profile has
									{findings.bandCount.profile}.
								</li>
							{/if}
							{#each findings.violations as v, i (i)}<li>
									{violationText(v, handoff.readBack.filters)}
								</li>{/each}
						</ul>
					{/if}
					<p class="mt-1 text-xs text-zinc-500">
						A read-back shows values the device holds, not its limits: it supports widening a domain
						to include them, not where the new bounds are.
					</p>
				</div>
			{/if}

			{#if summary && result?.profile}
				<div>
					<h2 class="text-lg font-semibold">Result</h2>
					<p class="mt-1 text-sm">
						{summary.bands} · {summary.preamp}{summary.graphic ? ' · graphic EQ' : ''}
					</p>
					<div class="mt-2"><SlotChart profile={result.profile} /></div>
				</div>
			{/if}

			<div>
				<h2 class="text-lg font-semibold">Changes</h2>
				{#if !changed}
					<p class="mt-1 text-sm text-zinc-500">No changes yet.</p>
				{:else}
					<pre
						class="mt-1 max-h-96 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs leading-5 dark:bg-zinc-900">{#each diff as d, i (i)}{#if d === null}<span
									class="text-zinc-400"
									>⋯
</span>{:else}<span
									class={d.op === '+'
										? 'bg-emerald-100 dark:bg-emerald-950'
										: d.op === '-'
											? 'bg-red-100 dark:bg-red-950'
											: ''}
									>{d.op} {d.text}
</span>{/if}{/each}</pre>
				{/if}
			</div>

			<div class="space-y-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
				<h2 class="text-lg font-semibold">Submit</h2>
				<p class="text-sm">
					Submitting opens GitHub, where you propose the file as a pull request (GitHub makes a fork
					for you if you need one). What you submit becomes public-domain data under
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- GitHub, not a route -->
					<a href="{REPO_URL}/blob/main/LICENSE-DATA">CC0-1.0</a>. Don't include vendor code.
				</p>
				{#if handoff}
					<ol class="list-decimal space-y-1 pl-5 text-sm">
						<li>
							<button
								type="button"
								class="underline"
								onclick={() => download(evidenceName, handoff!.evidence.text)}
								>Download the evidence file</button
							>
							(<span class="font-mono">{evidenceName}</span>).
						</li>
						<li>Open the pull request below.</li>
						<li>
							Attach the evidence file to the pull request's description. A maintainer adds it at
							<span class="font-mono">data/{evidenceRef}</span>; until then CI reports it missing.
							With git, add both files to one commit instead.
						</li>
					</ol>
				{/if}
				{#if errors.length > 0}
					<p class="text-sm text-amber-700 dark:text-amber-400">
						Fix the {errors.length === 1 ? 'problem' : `${errors.length} problems`} above first: CI would
						reject the file as it is.
					</p>
				{/if}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						class="rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-40"
						disabled={!changed || errors.length > 0 || !result || moved}
						onclick={openPullRequest}>Open a pull request</button
					>
					<button
						type="button"
						class="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
						onclick={() => copy(text, 'The file')}>Copy the file</button
					>
					<button
						type="button"
						class="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
						disabled={!path}
						onclick={() => download(fileName(path), text)}>Download the file</button
					>
					<button
						type="button"
						class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
						disabled={!changed}
						onclick={openIssue}>Open an issue instead</button
					>
				</div>
				{#if notice}<p class="text-sm">{notice}</p>{/if}
				<p class="text-xs text-zinc-500">
					No GitHub account handy? “Open an issue instead” needs one too, but no fork. The issue
					carries the file, and a maintainer turns it into a pull request.
				</p>
			</div>

			{#if !data.id && bases.length > 0}
				<details>
					<summary class="cursor-pointer text-sm font-medium">Start from a base</summary>
					<p class="mt-1 text-xs text-zinc-500">
						Devices sharing a chip share a base through <span class="font-mono">extends</span> (SPEC §11).
						Your file then only says what differs.
					</p>
					<ul class="mt-1 columns-1 text-sm sm:columns-2">
						{#each bases as id (id)}
							<li>
								<a class="font-mono text-xs" href="{resolve('/edit/[[id]]', {})}?extends={id}"
									>{id}</a
								>
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		</section>
	</div>
{/if}
