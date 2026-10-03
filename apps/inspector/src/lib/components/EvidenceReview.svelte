<script lang="ts">
	// The evidence export with its PII review (INSPECTOR §6): every string in the file is shown and
	// can be changed or removed before the file leaves the page. Then: download it, or take it to
	// the editor to fix the profile, add the device under its group, or start a new profile.
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		applyEdits,
		evidencePath,
		evidenceText,
		stringFields,
		type EvidenceReport
	} from '$lib/evidence';
	import { saveHandoff, type Handoff } from '$lib/handoff';

	let {
		report,
		handoff,
		groupBase
	}: {
		report: EvidenceReport;
		/** Everything the editor needs except the evidence file and what to do with it. */
		handoff: Omit<Handoff, 'evidence' | 'firmware' | 'action' | 'extends'>;
		/**
		 * Set when the device was checked against a group profile (SPEC §3): what a profile for
		 * this device extends. The device then gets "Add my device" before "fix the group".
		 */
		groupBase?: string | undefined;
	} = $props();

	const edits = new SvelteMap<string, string>();
	let firmware = $state('');

	const reviewed = $derived.by(() => {
		const r = applyEdits(report, edits);
		const fw = firmware.trim();
		return fw ? { ...r, device: { ...r.device, firmware: fw } } : r;
	});
	const fields = $derived(
		stringFields(report).sort((a, b) => Number(b.personal) - Number(a.personal))
	);
	const text = $derived(evidenceText(reviewed));

	function set(pointer: string, value: string) {
		edits.set(pointer, value);
	}

	/** A fix's evidence lives with its profile; a new profile's moves there once it has an id. */
	async function file(action: Handoff['action']) {
		const dir = action === 'fix' && handoff.profileId ? handoff.profileId : 'new-device';
		return { path: await evidencePath(dir, handoff.date, text), text };
	}

	async function download() {
		const { path } = await file(handoff.profileId && !groupBase ? 'fix' : 'new');
		const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = path.slice(path.lastIndexOf('/') + 1);
		a.click();
		URL.revokeObjectURL(url);
	}

	async function go(action: Handoff['action']) {
		const fw = firmware.trim();
		saveHandoff({
			...handoff,
			action,
			...(action === 'new' && groupBase ? { extends: groupBase } : {}),
			evidence: await file(action),
			...(fw ? { firmware: fw } : {})
		});
		const target =
			action === 'fix' && handoff.profileId
				? resolve('/edit/[[id]]', { id: handoff.profileId })
				: resolve('/edit/[[id]]', {});
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved, plus a query
		await goto(`${target}?device=1`);
	}
</script>

<div class="space-y-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
	<h3 class="font-medium">Evidence</h3>
	<p class="text-xs text-zinc-500">
		A file recording what was read, to submit with a profile change. Check every text in it first.
		Names you gave the device and anything else personal should go: clear a field to remove it.
		Serial numbers and Bluetooth addresses are never read. Nothing leaves this page until you submit
		it on GitHub, and what you submit becomes public-domain data (CC0-1.0).
	</p>
	<label class="flex items-center gap-2 text-sm">
		Firmware version
		<input
			bind:value={firmware}
			placeholder="if you know it"
			class="w-32 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
		/>
	</label>
	<div class="max-h-64 space-y-1 overflow-y-auto">
		{#each fields as f (f.pointer)}
			<label class="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-2 text-xs">
				<span
					class="truncate font-mono {f.personal
						? 'text-amber-700 dark:text-amber-400'
						: 'text-zinc-500'}">{f.pointer}</span
				>
				<input
					value={edits.get(f.pointer) ?? f.value}
					oninput={(e) => set(f.pointer, e.currentTarget.value)}
					class="rounded border border-zinc-300 bg-white px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
				/>
			</label>
		{/each}
	</div>
	<details>
		<summary class="cursor-pointer text-xs">The file as it will be saved</summary>
		<pre
			class="mt-1 max-h-64 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">{text}</pre>
	</details>
	<div class="flex flex-wrap gap-2">
		{#if groupBase}
			<button
				type="button"
				class="rounded bg-teal-700 px-3 py-2 text-sm text-white"
				title="A profile of its own for this model, extending {groupBase}"
				onclick={() => go('new')}>Add my device</button
			>
			<button
				type="button"
				class="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
				onclick={() => go('fix')}>Propose a change to the group</button
			>
		{:else if handoff.profileId}
			<button
				type="button"
				class="rounded bg-teal-700 px-3 py-2 text-sm text-white"
				onclick={() => go('fix')}>Propose a change to {handoff.profileId}</button
			>
		{:else}
			<button
				type="button"
				class="rounded bg-teal-700 px-3 py-2 text-sm text-white"
				onclick={() => go('new')}>Start a profile for this device</button
			>
		{/if}
		<button
			type="button"
			class="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
			onclick={download}>Download the evidence file</button
		>
	</div>
</div>
