<script lang="ts">
	// T3 probe (INSPECTOR §3): the one place in the inspector that writes to a device. It checks
	// the preconditions, plans the probe and shows its write budget, asks twice for the hearing
	// gate, runs the probe engine with a stop button, keeps the backup on screen, and ends with the
	// restore's outcome, the derived constraints and the evidence file.
	import { onMount } from 'svelte';
	import { describe, type Profile } from '@potatosalad775/eqcaps-core';
	import {
		analyzeCodec,
		type BridgeDevice,
		type DeviceIdentity
	} from '@potatosalad775/eqcaps-device-bridge';
	import { APP_COMMIT } from '$lib/channel';
	import { filterText } from '$lib/connect';
	import { today } from '$lib/evidence';
	import { constraintDiff } from '$lib/probe/compare';
	import { deriveConstraints } from '$lib/probe/derive';
	import { runProbe } from '$lib/probe/engine';
	import { probeEvidence } from '$lib/probe/evidence';
	import {
		bandsToTry,
		estimateWrites,
		experimentsFor,
		preconditions,
		targetSlot
	} from '$lib/probe/plan';
	import type {
		Backup,
		ExperimentId,
		ProbeMode,
		ProbeProgress,
		ProbeResult
	} from '$lib/probe/types';
	import EvidenceReview from './EvidenceReview.svelte';

	let {
		device,
		identity,
		transport,
		profile,
		profileId,
		groupBase
	}: {
		device: BridgeDevice;
		identity: DeviceIdentity;
		transport: 'hid' | 'serial' | 'ble';
		/** The profile the device was matched to, if any: its bounds are tried first. */
		profile: Profile | null;
		profileId: string;
		groupBase?: string | undefined;
	} = $props();

	const caps = $derived(device.capabilities);
	const analysis = $derived(analyzeCodec(device.protocol));
	const checks = $derived(preconditions(caps, analysis));
	const blocked = $derived(checks.some((c) => !c.ok));

	let mode = $state<ProbeMode>('quick');
	let current = $state<number | null>(null);
	onMount(() => {
		// A read, not a write: which preset plays now, so a spare one can be probed.
		if (caps.readsCurrentSlot) {
			device
				.currentSlot()
				.then((s) => (current = s))
				.catch(() => {});
		}
	});
	const target = $derived(targetSlot(caps, current));
	const bands = $derived(profile?.bandCount ?? bandsToTry(analysis, profile ?? undefined));
	const planned = $derived(estimateWrites(experimentsFor(mode, caps, analysis), bands, analysis));

	let muted = $state(false);
	let confirming = $state(false);
	let running = $state(false);
	let stopper: AbortController | null = null;
	let progress = $state.raw<ProbeProgress | null>(null);
	let backup = $state.raw<Backup | null>(null);
	let result = $state.raw<ProbeResult | null>(null);
	let error = $state('');

	async function start() {
		confirming = false;
		running = true;
		error = '';
		result = null;
		backup = null;
		stopper = new AbortController();
		try {
			result = await runProbe(device, {
				mode,
				analysis,
				...(profile ? { profile } : {}),
				...(target.slot !== undefined ? { slot: target.slot } : {}),
				signal: stopper.signal,
				onProgress: (p) => (progress = p),
				onBackup: (b) => (backup = b)
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
			stopper = null;
		}
	}

	function download(name: string, text: string) {
		const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	const derivation = $derived(
		result ? deriveConstraints(result, { analysis, ...(profile ? { profile } : {}) }) : null
	);
	const differences = $derived(
		derivation && profile ? constraintDiff(profile, derivation.constraints as Profile) : null
	);
	const summary = $derived.by(() => {
		if (!derivation) return null;
		try {
			return describe({
				...(profile ?? {}),
				id: profileId || 'probed',
				...derivation.constraints
			} as Profile);
		} catch {
			return null;
		}
	});

	const evidence = $derived.by(() => {
		if (!result || !result.backup) return null;
		const date = today();
		const report = probeEvidence({
			transport,
			identity,
			handler: device.protocol.handler,
			experimental: device.protocol.experimental === true,
			...(profileId ? { profile: profileId } : {}),
			result,
			derivation,
			commit: APP_COMMIT,
			userAgent: navigator.userAgent,
			date
		});
		const handoff = {
			...(profileId && profile ? { profileId } : {}),
			date,
			identity,
			readBack: {
				filters: result.backup.filters,
				...(result.backup.preamp !== undefined ? { preamp: result.backup.preamp } : {})
			},
			needsBandCount: caps.needsBandCount,
			...(derivation
				? {
						probe: {
							mode: result.mode,
							constraints: derivation.constraints,
							notes: derivation.notes
						}
					}
				: {}),
			protocol: {
				handler: device.protocol.handler,
				...(device.protocol.options ? { options: device.protocol.options } : {}),
				commit: APP_COMMIT
			}
		};
		return { report, handoff };
	});

	const STEPS: Record<ExperimentId, string> = {
		backup: 'Reading your EQ (the backup)',
		'band-count': 'Counting bands',
		settle: 'Settling every band on known values',
		'gain-step': 'Gain step',
		'gain-range': 'Gain range',
		'q-step': 'Q step',
		'q-range': 'Q range',
		'freq-step': 'Frequency step',
		'freq-range': 'Frequency windows',
		types: 'Filter types',
		conditions: 'Conditional windows',
		order: 'Band order',
		preamp: 'Preamp',
		restore: 'Restoring your EQ'
	};

	const backupText = (b: Backup) =>
		b.filters.map((f, i) => `${i + 1}. ${f ? filterText(f) : 'off'}`).join('\n') +
		(b.preamp !== undefined ? `\npreamp ${b.preamp} dB` : '');
</script>

<section class="space-y-3 rounded border border-amber-300 p-3 dark:border-amber-800">
	<h3 class="font-medium">Probe the device</h3>
	<p class="text-xs text-zinc-600 dark:text-zinc-400">
		Learns what the device accepts by writing test values and reading them back, then puts your EQ
		back and checks that it did. This is the only part of the inspector that writes to a device. It
		sends EQ settings only, never firmware or other commands.
	</p>

	<ul class="space-y-0.5 text-sm">
		{#each checks as c (c.id)}
			<li class={c.ok ? '' : 'text-red-700 dark:text-red-400'}>{c.ok ? '✓' : '✗'} {c.text}</li>
		{/each}
	</ul>

	{#if !blocked && !result && !running}
		<fieldset class="space-y-1 text-sm">
			<label class="flex items-center gap-2">
				<input type="radio" bind:group={mode} value="quick" />
				Quick: band count, gain range and step
			</label>
			<label class="flex items-center gap-2">
				<input type="radio" bind:group={mode} value="full" />
				Full: also Q, frequency (per band), types, conditional windows, band order, preamp
			</label>
		</fieldset>
		<p class="text-sm">
			About <strong>{planned}</strong> writes, at least 100 ms apart. A device that refuses a whole
			write for one bad band is probed band by band, which takes up to {bands} times as many.
			{target.text} Keep this tab in front while it runs: browsers slow down tabs in the background.
		</p>
		<div class="rounded bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
			<strong>Protect your hearing.</strong> The probe writes gains up to +30 dB. Take your
			headphones off or mute the output before you start, and leave it so until the probe ends.
			<label class="mt-2 flex items-center gap-2">
				<input type="checkbox" bind:checked={muted} />
				My headphones are off, or the output is muted.
			</label>
		</div>
		{#if confirming}
			<div class="flex flex-wrap items-center gap-2 text-sm">
				Last check: nothing is playing through this device?
				<button type="button" class="rounded bg-amber-700 px-3 py-2 text-white" onclick={start}
					>Yes, start writing</button
				>
				<button type="button" class="underline" onclick={() => (confirming = false)}>Cancel</button>
			</div>
		{:else}
			<button
				type="button"
				class="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-40"
				disabled={!muted}
				onclick={() => (confirming = true)}>Probe</button
			>
		{/if}
	{/if}

	{#if running}
		<div class="space-y-1 text-sm">
			<div class="h-2 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
				<div
					class="h-full bg-amber-600"
					style="width: {progress?.planned
						? Math.min(100, (100 * progress.writes) / progress.planned)
						: 0}%"
				></div>
			</div>
			<p>
				{STEPS[progress?.experiment ?? 'backup']}{progress?.writes
					? ` · write ${progress.writes} of about ${progress.planned}`
					: ''}
			</p>
			<button
				type="button"
				class="rounded border border-red-400 px-3 py-1 text-red-700 dark:text-red-400"
				onclick={() => stopper?.abort()}>Stop and restore</button
			>
		</div>
	{/if}

	{#if backup}
		<details open={!!result && !result.restore.verified}>
			<summary class="cursor-pointer text-sm font-medium">Your EQ before the probe (backup)</summary
			>
			<pre class="mt-1 font-mono text-xs whitespace-pre-wrap">{backupText(backup)}</pre>
			<button
				type="button"
				class="text-xs underline"
				onclick={() =>
					download(`eq-backup-${today()}.json`, `${JSON.stringify(backup, null, '\t')}\n`)}
				>Download the backup</button
			>
		</details>
	{/if}

	{#if error}<p class="text-sm text-red-700 dark:text-red-400">{error}</p>{/if}

	{#if result}
		{#if result.restore.verified}
			<p class="text-sm text-emerald-700 dark:text-emerald-400">
				Your EQ is back as it was: the device read back the backup after {result.writes} writes.
			</p>
		{:else}
			<div class="rounded bg-red-50 px-3 py-2 text-sm dark:bg-red-950">
				<strong>Your EQ may not be as it was.</strong>
				{#if result.restore.error}Restoring failed: {result.restore.error}.{/if}
				{#each result.restore.mismatches as m, i (i)}<div>{m}</div>{/each}
				Set it back from the backup above with the vendor's app or another EQ app, or reconnect the device
				and probe again.
			</div>
		{/if}
		<button
			type="button"
			class="text-sm underline"
			onclick={() => {
				result = null;
				backup = null;
				muted = false;
			}}>Probe again</button
		>
		{#if result.aborted}
			<p class="text-sm text-amber-700 dark:text-amber-400">The probe stopped: {result.aborted}.</p>
		{/if}

		{#if derivation}
			<div class="space-y-2 text-sm">
				<h4 class="font-medium">What the device accepts</h4>
				{#if summary}
					<ul class="list-disc pl-5">
						<li>{summary.bands}</li>
						{#each summary.groups as g, i (i)}<li>
								{g.slots.length === 1 ? 'Band' : 'Bands'}
								{g.slots.map((s) => s + 1).join(', ')}: {g.types} · {g.freq} · Q {g.q} · {g.gain}
								{#each g.conditions as c, j (j)}<div class="text-xs">{c}</div>{/each}
							</li>{/each}
						{#each summary.rules as r, i (i)}<li>{r}</li>{/each}
						<li>{summary.preamp}</li>
					</ul>
				{/if}
				{#if differences}
					{#if differences.length === 0}
						<p class="text-emerald-700 dark:text-emerald-400">
							This is what {profileId} says.
						</p>
					{:else}
						<p>Different from {profileId}:</p>
						<ul class="list-disc pl-5">
							{#each differences as d, i (i)}<li>{d}</li>{/each}
						</ul>
					{/if}
				{/if}
				{#if derivation.notes.length}
					<p class="text-xs text-zinc-500">Notes:</p>
					<ul class="list-disc pl-5 text-xs text-zinc-500">
						{#each derivation.notes as n, i (i)}<li>{n}</li>{/each}
					</ul>
				{/if}
			</div>
		{/if}
		{#if result.anomalies.length}
			<details class="text-xs">
				<summary class="cursor-pointer"
					>Noticed during the probe ({result.anomalies.length})</summary
				>
				<ul class="list-disc pl-5">
					{#each result.anomalies as a, i (i)}<li>{a}</li>{/each}
				</ul>
			</details>
		{/if}

		{#if evidence}
			{#key evidence.report}
				<EvidenceReview report={evidence.report} handoff={evidence.handoff} {groupBase} />
			{/key}
		{/if}
	{/if}
</section>
