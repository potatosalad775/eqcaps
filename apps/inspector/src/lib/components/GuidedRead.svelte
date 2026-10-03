<script lang="ts">
	// Guided read (T3, INSPECTOR §3): the user changes the EQ in the vendor's own app, one step at
	// a time, and this component reads the device back after each step. It only ever calls the
	// bridge's pull (invariant 9, D40); the planning and inference live in $lib/guided.
	import type { Profile } from '@potatosalad775/eqcaps-core';
	import { type PullResult, type WireGrid } from '@potatosalad775/eqcaps-device-bridge';
	import { grantedHidDevice } from '@potatosalad775/eqcaps-device-bridge/browser';
	import { openReadOnly, type ReadOnlyDevice } from '$lib/device';
	import type { EvidenceReport } from '$lib/evidence';
	import type { Handoff } from '$lib/handoff';
	import { changeText } from '$lib/guided/changes';
	import { deriveConstraints } from '$lib/guided/constraints';
	import { guidedEvidence } from '$lib/guided/evidence';
	import { conclude, effective, infer } from '$lib/guided/infer';
	import { instruction, nextStep, plannedSteps, stepLabel, stepState } from '$lib/guided/plan';
	import { readEntry } from '$lib/guided/session';
	import type { Entry, GuidedContext, Step } from '$lib/guided/types';
	import EvidenceReview from './EvidenceReview.svelte';

	let {
		device,
		first,
		report,
		handoff,
		profile,
		groupBase,
		onreconnect
	}: {
		device: ReadOnlyDevice;
		/** The read the guided read starts from, and compares the last read with. */
		first: PullResult;
		/** The evidence of that read, which the guided read's file extends. */
		report: EvidenceReport;
		handoff: Omit<Handoff, 'evidence' | 'firmware' | 'action' | 'extends'>;
		profile: Profile | null;
		groupBase?: string | undefined;
		/** Called with the device after it was reconnected, so the page reads from it too. */
		onreconnect?: (device: ReadOnlyDevice) => void;
	} = $props();

	function wireOf(w: WireGrid): GuidedContext['wire'] {
		return {
			gain: w.gain,
			...(w.q ? { q: w.q } : {}),
			...('min' in w.freq ? { freq: w.freq } : {}),
			...(w.preamp ? { preamp: w.preamp } : {})
		};
	}

	let dev = $state.raw<ReadOnlyDevice | null>(null);
	const active = $derived(dev ?? device);
	const ctx: GuidedContext = $derived({
		first: {
			filters: first.filters,
			...(first.preamp !== undefined ? { preamp: first.preamp } : {})
		},
		readsPreamp: device.capabilities.readsPreamp && first.preamp !== undefined,
		hasQ: device.capabilities.wire.q !== undefined,
		wire: wireOf(device.capabilities.wire)
	});

	let started = $state(false);
	let appName = $state('');
	let appVersion = $state('');
	let platform = $state<'web' | 'phone' | 'desktop'>('web');
	let entries = $state.raw<Entry[]>([]);
	/** A step the user chose to redo; otherwise the planner's next step. */
	let target = $state.raw<Step | null>(null);
	/** A number input's value: a number, or null while it's empty. */
	let typed = $state<number | null>(null);
	let already = $state(false);
	let busy = $state(false);
	let error = $state('');
	let lost = $state(false);

	const planned = $derived(plannedSteps(ctx, entries));
	const step = $derived(target ?? nextStep(ctx, entries));
	const inference = $derived(infer(ctx, entries));
	const bands = $derived(inference.bandCount ?? profile?.bandCount ?? first.filters.length);
	const last = $derived.by(() => {
		const e = entries[entries.length - 1];
		return e?.kind === 'read' ? { entry: e, outcome: conclude(e) } : null;
	});
	/** Types listed so far for the current `each` step. */
	const listed = $derived.by(() => {
		if (step?.ask !== 'each') return [];
		const list = effective(entries).get(step.id) ?? [];
		return [
			...new Set(
				list.flatMap((e) => (e.kind === 'read' ? [e.read.filters[step.band! - 1]?.type] : []))
			)
		].filter((t) => t !== undefined);
	});

	const vendorApp = $derived({
		name: appName.trim() || 'the vendor app',
		...(appVersion.trim() ? { version: appVersion.trim() } : {}),
		platform
	});
	const found = $derived(deriveConstraints(inference, ctx, profile, active.capabilities.types));
	const result = $derived.by(() => {
		if (!started || step) return null;
		const guidedReport = guidedEvidence({
			first: report,
			vendorApp,
			entries,
			inference,
			derived: found
		});
		const appLabel = `${vendorApp.name}${vendorApp.version ? ` ${vendorApp.version}` : ''}`;
		return {
			report: guidedReport,
			handoff: {
				...handoff,
				guided: {
					constraints: found.constraints,
					notes: [...inference.notes, ...found.notes],
					vendorApp: appLabel
				}
			}
		};
	});

	async function read() {
		if (!step) return;
		const s = step;
		let n: number | undefined;
		if (s.ask === 'count' || s.ask === 'value') {
			if (typeof typed !== 'number' || !Number.isFinite(typed)) {
				error = 'Enter a number first.';
				return;
			}
			n = typed;
		}
		busy = true;
		error = '';
		try {
			const pulled = await active.pull({ bands: s.ask === 'count' ? n! : bands });
			const opts = {
				...(n !== undefined ? { typed: n } : {}),
				...(already ? { already: true } : {})
			};
			entries = [...entries, readEntry(ctx, entries, s, pulled, opts)];
			target = null;
			already = false;
			if (s.ask !== 'count') typed = null;
			lost = false;
		} catch (e) {
			error = `The read failed: ${e instanceof Error ? e.message : String(e)}`;
			lost = true;
		} finally {
			busy = false;
		}
	}

	function skip() {
		if (!step) return;
		entries = [...entries, { kind: 'skip', step }];
		target = null;
		typed = null;
	}

	function done() {
		if (!step) return;
		entries = [...entries, { kind: 'done', step }];
		target = null;
	}

	/** After the device was unplugged (moved to a phone and back): find it again, no chooser. */
	async function reconnect() {
		const u = active.identity.usb;
		if (!u || active.transport.kind !== 'hid') return;
		busy = true;
		error = '';
		try {
			const t = await grantedHidDevice({
				vendorId: parseInt(u.vendorId, 16),
				productId: parseInt(u.productId ?? '0', 16),
				productName: u.productName ?? ''
			});
			if (!t) {
				error = 'The device isn’t connected. Plug it back in, then try again.';
				return;
			}
			dev = openReadOnly(t, active.protocol, { profile: { bandCount: bands } });
			onreconnect?.(dev);
			lost = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	const mark = { open: '·', done: '✓', skipped: '–' } as const;
</script>

<div class="space-y-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
	<h3 class="font-medium">Guided read</h3>
	{#if !started}
		<p class="text-sm">
			Learn the limits of your device's vendor app: you change the EQ in the app, one step at a
			time, and this page reads the device back after each step. The page never writes to the
			device. What the app let you set becomes vendor-app evidence for a profile.
		</p>
		<p class="rounded bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
			The steps ask for the app's extreme values, such as its largest gain. <strong
				>Take your headphones off or mute the output first.</strong
			>
		</p>
		<div class="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 text-sm">
			<label for="g-app">Vendor app</label>
			<input
				id="g-app"
				bind:value={appName}
				placeholder="its name, such as Walkplay EQ web app"
				class="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
			/>
			<label for="g-version">Version</label>
			<input
				id="g-version"
				bind:value={appVersion}
				placeholder="if it shows one"
				class="w-40 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
			/>
			<label for="g-platform">Runs on</label>
			<select
				id="g-platform"
				bind:value={platform}
				class="w-40 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
			>
				<option value="web">the web (another tab)</option>
				<option value="phone">a phone</option>
				<option value="desktop">a desktop app</option>
			</select>
		</div>
		{#if platform !== 'web'}
			<p class="text-xs text-zinc-500">
				If the device has to move to the app for each step, plug it back in here before each read;
				the page finds it again without asking.
			</p>
		{/if}
		<button
			type="button"
			class="rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-40"
			disabled={!appName.trim()}
			onclick={() => (started = true)}>Start the guided read</button
		>
	{:else}
		<ol class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
			{#each planned as s (s.id)}
				{@const state = stepState(s, entries)}
				<li>
					<button
						type="button"
						class="{s.id === step?.id
							? 'font-semibold text-teal-700 dark:text-teal-400'
							: state === 'open'
								? 'text-zinc-500'
								: ''} disabled:cursor-default"
						disabled={state === 'open' || busy}
						title={state === 'open' ? '' : 'Redo this step'}
						onclick={() => (target = s)}>{mark[state]} {stepLabel(s)}</button
					>
				</li>
			{/each}
		</ol>

		{#if last}
			<div class="rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
				<p>
					Last read ({stepLabel(last.entry.step)}): {last.entry.changed.length
						? last.entry.changed.map(changeText).join(', ')
						: 'no change since the read before'}.
				</p>
				{#if last.outcome.problem}
					<p class="text-amber-700 dark:text-amber-400">{last.outcome.problem}</p>
				{/if}
			</div>
		{/if}

		{#if step}
			<div class="space-y-2">
				<p class="text-sm font-medium">{stepLabel(step)}</p>
				<p class="text-sm">{instruction(step)}</p>
				{#if step.ask === 'count' || step.ask === 'value'}
					<input
						type="number"
						step="any"
						bind:value={typed}
						aria-label={step.ask === 'count' ? 'Bands' : 'The value you typed'}
						class="w-32 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				{/if}
				{#if step.ask === 'each'}
					<p class="text-xs text-zinc-500">
						Listed: {listed.length ? listed.join(', ') : 'none yet'}. The first read lists the type
						the band has now.
					</p>
				{/if}
				{#if step.ask === 'max' || step.ask === 'min'}
					<label class="flex items-center gap-2 text-xs text-zinc-500">
						<input type="checkbox" bind:checked={already} />
						It already is there, so nothing changes
					</label>
				{/if}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						class="rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-40"
						disabled={busy}
						onclick={read}>Read</button
					>
					{#if step.ask === 'each'}
						<button
							type="button"
							class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
							disabled={busy || listed.length === 0}
							onclick={done}>Done: every type is listed</button
						>
					{/if}
					{#if step.ask !== 'count' && step.ask !== 'restore'}
						<button
							type="button"
							class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
							disabled={busy}
							onclick={skip}>Skip</button
						>
					{/if}
					{#if lost && active.transport.kind === 'hid'}
						<button
							type="button"
							class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
							disabled={busy}
							onclick={reconnect}>Reconnect</button
						>
					{/if}
				</div>
				{#if busy}<p class="text-xs text-zinc-500">Reading…</p>{/if}
				{#if error}<p class="text-sm text-red-700 dark:text-red-400">{error}</p>{/if}
			</div>
		{:else if result}
			<div class="space-y-2 text-sm">
				<p class="font-medium">Found</p>
				<pre
					class="max-h-64 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">{JSON.stringify(
						found.constraints,
						null,
						2
					)}</pre>
				{#if result.handoff.guided.notes.length}
					<ul class="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
						{#each result.handoff.guided.notes as n, i (i)}<li>{n}</li>{/each}
					</ul>
				{/if}
				<p class="text-xs text-zinc-500">{found.notChecked.join(' ')}</p>
			</div>
			{#key result.report}
				<EvidenceReview report={result.report} handoff={result.handoff} {groupBase} />
			{/key}
		{/if}
	{/if}
</div>
