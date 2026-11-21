<script lang="ts">
	// T1 identify, T2 read and T3 guided read (INSPECTOR §2): connect a device, show what it says
	// about itself, match it against the database, and read its EQ back to check the profile. The
	// state and its rules are the read session's (lib/read-session.ts); this page shows it, and
	// asks the browser for a device. The inspector never writes to one: the session and GuidedRead
	// open it for reading only (D40).
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Filter } from '@potatosalad775/eqcaps-core';
	import { identityOf, openReader } from '@potatosalad775/eqcaps-device-bridge';
	import {
		deviceApis,
		requestBleDevice,
		requestHidDevice,
		requestSerialPort
	} from '@potatosalad775/eqcaps-device-bridge/browser';
	import {
		channelsText,
		descriptorText,
		filterText,
		findingLines,
		identityText,
		newDeviceIssueUrl,
		wireRows,
		wrongConstraintIssueUrl
	} from '#lib/connect.ts';
	import { catalog } from '#lib/data.svelte.ts';
	import { APP_COMMIT } from '#lib/channel.ts';
	import { today } from '#lib/evidence.ts';
	import { memberBase } from '#lib/handoff.ts';
	import { readFilters, readHandoff, ReadSession, type Chosen } from '#lib/read-session.ts';
	import EvidenceReview from '#lib/components/EvidenceReview.svelte';
	import GuidedRead from '#lib/components/GuidedRead.svelte';
	import { formatApo } from '#lib/filters-text.ts';
	import { formatField } from '#lib/format.ts';
	import GroupBadge from '#lib/components/GroupBadge.svelte';
	import StatusBadge from '#lib/components/StatusBadge.svelte';

	const apis = (() => {
		try {
			return deviceApis();
		} catch {
			return { hid: false, serial: false, bluetooth: false };
		}
	})();
	const secure = typeof window !== 'undefined' && window.isSecureContext;

	const session = new ReadSession({
		entries: () => catalog.index?.profiles ?? [],
		match: (identity) => catalog.client.matchDevice(identity),
		loadProfile: (id) => catalog.profile(id),
		open: openReader,
		onChange: (next) => (s = next)
	});
	let s = $state.raw(session.state);
	const { chosen, matches, ambiguous, profileId, profile, driver, eqId, listedEq, eqShown } =
		$derived(s);
	const { bandsWanted, writeOnly, device, pulled, channels } = $derived(s);
	const protocol = $derived(driver?.protocol);

	let busy = $state('');
	let error = $state('');
	let reportText = $state('');

	const hardware = $derived(
		(catalog.index?.profiles ?? [])
			.filter((e) => e.kind === 'hardware' && e.status !== 'deprecated')
			.sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`))
	);

	/** Set when the device was checked against a group profile: what a profile for it extends. */
	const groupBase = $derived(profile?.device.group ? memberBase(profile) : undefined);

	/** Runs one of the session's steps, showing what it is doing and what went wrong. */
	async function run(doing: string, step: () => Promise<void>) {
		error = '';
		busy = doing;
		try {
			await step();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = '';
		}
	}

	/** The device the user picks in the browser's chooser; null if they cancel. */
	async function request(kind: 'hid' | 'hid-any' | 'serial' | 'ble'): Promise<Chosen | null> {
		const entries = catalog.index?.profiles ?? [];
		if (kind === 'hid' || kind === 'hid-any') {
			const transport = await requestHidDevice({ entries, anyDevice: kind === 'hid-any' });
			if (!transport || transport.kind !== 'hid') return null;
			return {
				kind: 'hid',
				identity: identityOf(transport),
				transport,
				collections: transport.collections
			};
		}
		const choice =
			kind === 'serial'
				? await requestSerialPort({ entries })
				: await requestBleDevice({ entries });
		return choice && { kind, identity: choice.identity, choice };
	}

	const choose = (kind: 'hid' | 'hid-any' | 'serial' | 'ble') =>
		run('Waiting for the browser’s device chooser…', async () => {
			await session.disconnect();
			await catalog.load();
			const picked = await request(kind);
			if (!picked) return;
			await session.connect(picked);
			reportText = identityText(picked.identity);
		});

	const read = () => run('Reading the EQ…', () => session.read());
	const disconnect = () => session.disconnect();

	const evidence = $derived(
		s.pulled
			? readHandoff(s, { date: today(), commit: APP_COMMIT, userAgent: navigator.userAgent })
			: null
	);

	function readBackText(filters: readonly (Filter | null)[]): string {
		return filters.map((f, i) => `${i + 1}. ${f ? filterText(f) : 'off'}`).join('\n');
	}

	async function openInPlayground() {
		if (!pulled || !profileId) return;
		try {
			localStorage.setItem(
				'eqcaps-inspector:playground',
				formatApo(readFilters(pulled), pulled.preamp ?? 0)
			);
		} catch {
			// The playground then shows its sample.
		}
		await goto(`${resolve('/playground')}?profile=${encodeURIComponent(profileId)}`);
	}
</script>

<svelte:head><title>Connect a device · eqcaps</title></svelte:head>

<div class="max-w-3xl space-y-2">
	<h1 class="text-2xl font-semibold">Connect a device</h1>
	<p class="text-zinc-600 dark:text-zinc-400">
		See what your device says about itself, which profile matches it, and whether its current EQ
		fits that profile. The inspector only reads: it never changes your device's settings.
	</p>
</div>

{#if !secure || !(apis.hid || apis.serial || apis.bluetooth)}
	<p class="mt-6 max-w-3xl rounded bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
		{#if !secure}
			Device access needs a secure (HTTPS) page.
		{:else}
			This browser has no WebHID, Web Serial or Web Bluetooth. They are available in Chrome, Edge
			and other Chromium browsers on desktop.
		{/if}
		Browsing profiles and the playground work everywhere.
	</p>
{/if}

<div class="mt-6 flex flex-wrap gap-2">
	<button
		type="button"
		class="rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-40"
		disabled={!apis.hid || !!busy}
		onclick={() => choose('hid')}>USB device (HID)</button
	>
	<button
		type="button"
		class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
		disabled={!apis.serial || !!busy}
		onclick={() => choose('serial')}>Serial (USB or Bluetooth)</button
	>
	<button
		type="button"
		class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
		disabled={!apis.bluetooth || !!busy}
		onclick={() => choose('ble')}>Bluetooth LE</button
	>
	<button
		type="button"
		class="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
		disabled={!apis.hid || !!busy}
		title="Lists every HID device, for identifying one the database doesn't know"
		onclick={() => choose('hid-any')}>Any HID device</button
	>
	{#if chosen}
		<button type="button" class="ml-auto text-sm underline" onclick={disconnect}>Disconnect</button>
	{/if}
</div>

{#if busy}<p class="mt-3 text-sm text-zinc-500">{busy}</p>{/if}
{#if error}<p class="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>{/if}

{#if chosen}
	<div class="mt-8 grid gap-8 lg:grid-cols-2">
		<section class="min-w-0 space-y-4">
			<div>
				<h2 class="text-lg font-semibold">Identity</h2>
				<pre class="mt-1 font-mono text-sm whitespace-pre-wrap">{identityText(chosen.identity) ||
						'The browser shows nothing that identifies this device.'}</pre>
				<p class="mt-1 text-xs text-zinc-500">
					What the browser exposes over {chosen.kind === 'hid'
						? 'WebHID'
						: chosen.kind === 'serial'
							? 'Web Serial'
							: 'Web Bluetooth'}. Serial numbers and Bluetooth addresses are never read.
				</p>
			</div>

			{#if chosen.kind === 'hid'}
				<details>
					<summary class="cursor-pointer font-medium">HID descriptor</summary>
					<pre
						class="mt-2 max-h-80 overflow-auto rounded bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{descriptorText(
							chosen.collections
						)}</pre>
				</details>
			{/if}

			<div>
				<h2 class="text-lg font-semibold">Profile</h2>
				{#if matches.length > 0}
					<ul class="mt-1 space-y-1 text-sm">
						{#each matches as m (m.id)}
							<li class="flex items-center gap-2">
								<input
									type="radio"
									name="match"
									value={m.id}
									checked={profileId === m.id}
									onchange={() => session.pickProfile(m.id)}
									id="match-{m.id}"
								/>
								<label for="match-{m.id}">{m.entry.brand} {m.entry.model}</label>
								<StatusBadge status={m.entry.status} />
								{#if m.entry.group}<GroupBadge />{/if}
								<span class="text-xs text-zinc-500">specificity {m.specificity}</span>
								<a class="text-xs" href={resolve('/p/[id]', { id: m.id })}>view</a>
							</li>
						{/each}
					</ul>
					{#if matches.find((m) => m.id === profileId)?.entry.group}
						<p class="mt-1 text-xs text-sky-700 dark:text-sky-400">
							This is a group profile: it covers your device's chipset or firmware, not your exact
							model, which isn't in the database yet.
						</p>
					{/if}
					{#if ambiguous}
						<p class="mt-1 text-xs text-amber-700 dark:text-amber-400">
							Several profiles match equally well. Pick the one that is your device.
						</p>
					{/if}
				{:else}
					<p class="mt-1 text-sm">No profile in the database matches this device.</p>
				{/if}
				<label class="mt-2 block text-xs text-zinc-500" for="other">Or choose a profile</label>
				<select
					id="other"
					bind:value={() => profileId, (id) => session.pickProfile(id)}
					class="mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				>
					<option value="">None</option>
					{#each hardware as e (e.id)}
						<option value={e.id}>{e.brand} {e.model}{e.engine ? ` (${e.engine})` : ''}</option>
					{/each}
				</select>
			</div>

			{#if matches.length === 0}
				<div class="rounded border border-zinc-200 p-3 dark:border-zinc-800">
					<h3 class="font-medium">Report this device</h3>
					<p class="mt-1 text-xs text-zinc-500">
						Opens a prefilled GitHub issue with the text below. Check it first: remove anything
						personal, such as a name you gave the device. Nothing is sent until you submit the issue
						on GitHub, and what you submit becomes public-domain data (CC0-1.0).
					</p>
					<textarea
						bind:value={reportText}
						rows="6"
						class="mt-2 w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
					></textarea>
					<!-- eslint-disable svelte/no-navigation-without-resolve -- GitHub, not a route -->
					<a
						class="text-sm"
						target="_blank"
						rel="noopener"
						href={newDeviceIssueUrl({
							device: chosen.identity.usb?.productName ?? chosen.identity.bluetooth?.name ?? '',
							identity: reportText
						})}>Open the issue on GitHub</a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</div>
			{/if}
		</section>

		<section class="min-w-0 space-y-4">
			<div>
				<h2 class="text-lg font-semibold">Protocol</h2>
				{#if protocol}
					<p class="mt-1 text-sm">
						<span class="font-mono">{protocol.handler}</span>
						{#if driver?.source === 'match'}
							<span class="text-zinc-500"
								>· from {driver.profileId}, which this device also matches</span
							>
						{/if}
						{#if protocol.experimental}
							<span class="text-amber-700 dark:text-amber-400"
								>· experimental: a guess from the USB vendor, unconfirmed for this device</span
							>
						{/if}
					</p>
				{:else}
					<p class="mt-1 text-sm">
						{profileId
							? 'The device bridge has no protocol for this profile.'
							: 'Choose a profile to find its protocol.'}
					</p>
				{/if}
			</div>

			{#if protocol}
				{#if !profile}
					<label class="flex items-center gap-2 text-sm">
						Bands to read
						<input
							type="number"
							min="1"
							max="64"
							bind:value={() => bandsWanted, (n) => session.setBands(n)}
							class="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				{/if}
				{#if protocol.eqs?.length}
					<label class="flex items-center gap-2 text-sm">
						EQ
						<select
							bind:value={() => eqId, (id) => session.pickEq(id)}
							class="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="">{profile?.engine ?? 'The profile’s own'}</option>
							{#each protocol.eqs as eq (eq.id)}
								<option value={eq.id}>{eq.name}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if writeOnly || (device && !device.capabilities.canRead)}
					<p class="rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
						This protocol can only write to the device: it has no way to read the EQ back. So this
						page can identify the device, but not check its EQ. Apps that drive the device bridge
						can still write to it.
					</p>
				{:else}
					<button
						type="button"
						class="rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-40"
						disabled={!!busy}
						onclick={read}>Read the EQ</button
					>
				{/if}
			{/if}

			{#if device}
				{@const c = device.capabilities}
				<p class="text-xs text-zinc-500">
					Reads {c.canRead ? 'yes' : 'no'} · writes {c.canWrite ? 'yes' : 'no'} · preamp
					{c.readsPreamp ? 'read' : 'not read'} · preset slots {c.slots.length || 'none'}
					{c.disconnectOnSave ? '· reconnects after saving' : ''}
				</p>
				{#if profile}
					<table class="w-full text-left text-xs">
						<thead class="text-zinc-500">
							<tr
								><th class="font-normal"></th><th class="font-normal">Profile</th><th
									class="font-normal">Wire</th
								></tr
							>
						</thead>
						<tbody>
							{#each wireRows(profile, c.wire) as row (row.field)}
								<tr class="align-top"
									><td class="pr-2">{row.field}</td><td class="pr-2">{row.profile}</td><td
										>{row.wire}</td
									></tr
								>
							{/each}
						</tbody>
					</table>
					<p class="text-xs text-zinc-500">
						What the protocol's frames can carry explains rounding in the read-back.
					</p>
				{/if}
			{/if}

			{#if pulled && channels}
				{@const apart = channels.length > 1}
				<div>
					<h3 class="font-medium">
						Current EQ{pulled.slot !== undefined ? `, preset ${pulled.slot}` : ''}{!apart &&
						pulled.preamp !== undefined
							? `, preamp ${formatField('preamp', pulled.preamp)} dB`
							: ''}
					</h3>
					{#if eqShown}
						<p class="mt-1 text-sm">{channelsText(eqShown, apart)}</p>
					{/if}
				</div>

				{#each channels as ch (ch.channel ?? '')}
					<div>
						{#if ch.channel}
							<h4 class="font-medium">
								{ch.channel} channel{ch.preamp !== undefined
									? `, preamp ${formatField('preamp', ch.preamp)} dB`
									: ''}
							</h4>
						{/if}
						<table class="mt-1 text-sm">
							<thead class="text-xs text-zinc-500">
								<tr>
									<th class="px-2 text-left font-normal">Band</th>
									<th class="px-2 text-left font-normal">Type</th>
									<th class="px-2 text-right font-normal">Hz</th>
									<th class="px-2 text-right font-normal">dB</th>
									<th class="px-2 text-right font-normal">Q</th>
								</tr>
							</thead>
							<tbody class="font-mono tabular-nums">
								{#each ch.filters as f, i (i)}
									<tr class="border-b border-zinc-100 dark:border-zinc-900">
										<td class="px-2 py-0.5">{i + 1}</td>
										{#if f}
											<td class="px-2">{f.type}</td>
											<td class="px-2 text-right">{formatField('freq', f.freq)}</td>
											<td class="px-2 text-right">{formatField('gain', f.gain)}</td>
											<td class="px-2 text-right">{formatField('q', f.q)}</td>
										{:else}
											<td class="px-2 text-zinc-400" colspan="4">off</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
						<p class="mt-1 text-xs text-zinc-500">Values as the device stores them.</p>
					</div>

					{#if ch.findings}
						{@const lines = findingLines(ch.findings, ch.filters)}
						{@const which = ch.channel ? `the ${ch.channel.toLowerCase()} channel` : ''}
						<div>
							<h3 class="font-medium">
								Check {which ? `${which} ` : ''}against {profile?.id}{listedEq
									? ` (${listedEq.name})`
									: ''}
							</h3>
							{#if lines.length === 0}
								<p class="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
									Everything {which || 'the device'} holds fits the profile.
								</p>
							{:else}
								<p class="mt-1 text-sm">
									The device holds values the profile says it can't. Either the profile is too
									strict, or the device was set by an app that ignores it:
								</p>
								<ul class="mt-1 list-disc pl-5 text-sm">
									{#each lines as line, i (i)}<li>{line}</li>{/each}
								</ul>
								<!-- eslint-disable svelte/no-navigation-without-resolve -- GitHub, not a route -->
								<a
									class="mt-2 inline-block text-sm"
									target="_blank"
									rel="noopener"
									href={wrongConstraintIssueUrl({
										profile: profile?.id ?? '',
										wrong: lines.join('\n'),
										evidence: `Read back from ${which || 'the device'} with the eqcaps inspector:\n${readBackText(ch.filters)}`
									})}>Report it as a wrong constraint</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						</div>
					{/if}
				{/each}

				{#if profileId}
					<button type="button" class="text-sm underline" onclick={openInPlayground}
						>Open this EQ in the playground</button
					>
				{/if}

				{#if listedEq}
					<p class="text-xs text-zinc-500">
						Evidence and guided reads are for the EQ the profile describes; choose it above to make
						one.
					</p>
				{/if}
				{#if evidence && !listedEq}
					{#key evidence.report}
						<EvidenceReview report={evidence.report} handoff={evidence.handoff} {groupBase} />
					{/key}
				{/if}

				{#if evidence && device && !listedEq}
					{#key pulled}
						<GuidedRead
							{device}
							first={pulled}
							report={evidence.report}
							handoff={evidence.handoff}
							{profile}
							{groupBase}
							onreconnect={(d) => session.adopt(d)}
						/>
					{/key}
				{/if}
			{/if}
		</section>
	</div>
{/if}
