<script lang="ts">
	// T1 identify and T2 read (INSPECTOR §2): connect a device, show what it says about itself,
	// match it against the database, and read its EQ back to check the profile. This page never
	// writes to the device: it calls the bridge's pull, never push or setEnabled.
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		toRealized,
		type Filter,
		type IndexEntry,
		type Profile
	} from '@potatosalad775/eqcaps-core';
	import type { DeviceMatch } from '@potatosalad775/eqcaps-client';
	import {
		guessProtocol,
		identityOf,
		openDevice,
		protocolFor,
		type BridgeDevice,
		type DeviceIdentity,
		type HidCollectionInfo,
		type Protocol,
		type PullResult,
		type Transport
	} from '@potatosalad775/eqcaps-device-bridge';
	import {
		deviceApis,
		requestBleDevice,
		requestHidDevice,
		requestSerialPort,
		type BleChoice,
		type SerialPortChoice
	} from '@potatosalad775/eqcaps-device-bridge/browser';
	import {
		descriptorText,
		filterText,
		identityText,
		newDeviceIssueUrl,
		readFindings,
		wireRows,
		wrongConstraintIssueUrl
	} from '$lib/connect';
	import { catalog } from '$lib/data.svelte';
	import { APP_COMMIT } from '$lib/channel';
	import { readEvidence, today } from '$lib/evidence';
	import EvidenceReview from '$lib/components/EvidenceReview.svelte';
	import { formatApo } from '$lib/filters-text';
	import { formatField } from '$lib/format';
	import { violationText } from '$lib/violations';
	import StatusBadge from '$lib/components/StatusBadge.svelte';

	const apis = (() => {
		try {
			return deviceApis();
		} catch {
			return { hid: false, serial: false, bluetooth: false };
		}
	})();
	const secure = typeof window !== 'undefined' && window.isSecureContext;

	/** A chosen device. HID is open at once; serial and BLE open once the protocol is known. */
	type Chosen =
		| {
				kind: 'hid';
				identity: DeviceIdentity;
				transport: Transport;
				collections: readonly HidCollectionInfo[];
		  }
		| { kind: 'serial'; identity: DeviceIdentity; choice: SerialPortChoice }
		| { kind: 'ble'; identity: DeviceIdentity; choice: BleChoice };

	let chosen = $state.raw<Chosen | null>(null);
	let matches = $state.raw<DeviceMatch<IndexEntry>[]>([]);
	let ambiguous = $state(false);
	let profileId = $state('');
	let profile = $state.raw<Profile | null>(null);
	let device = $state.raw<BridgeDevice | null>(null);
	let pulled = $state.raw<PullResult | null>(null);
	let bandsWanted = $state(10);
	let busy = $state('');
	let error = $state('');
	let reportText = $state('');

	const hardware = $derived(
		(catalog.index?.profiles ?? [])
			.filter((e) => e.kind === 'hardware' && e.status !== 'deprecated')
			.sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`))
	);

	/** The protocol: the profile's, else a vendor guess for HID (marked experimental, D33). */
	const protocol: Protocol | undefined = $derived.by(() => {
		if (profileId) {
			const p = protocolFor(profileId);
			if (p) return p;
		}
		if (chosen?.kind === 'hid' && chosen.identity.usb) {
			return guessProtocol(parseInt(chosen.identity.usb.vendorId, 16));
		}
		return undefined;
	});

	/**
	 * A HID protocol's capabilities are known without any I/O: say up front when it can't read,
	 * rather than failing on "Read the EQ". (Serial and BLE ports are opened first.)
	 */
	const writeOnly = $derived.by(() => {
		if (chosen?.kind !== 'hid' || !protocol) return false;
		try {
			return !openDevice(chosen.transport, protocol).capabilities.canRead;
		} catch {
			return false;
		}
	});

	$effect(() => {
		const id = profileId;
		profile = null;
		if (!id) return;
		catalog.profile(id).then((p) => {
			if (profileId === id) profile = p;
		});
	});

	function fail(e: unknown) {
		error = e instanceof Error ? e.message : String(e);
	}

	async function choose(kind: 'hid' | 'hid-any' | 'serial' | 'ble') {
		error = '';
		await disconnect();
		await catalog.load();
		const entries = catalog.index?.profiles ?? [];
		busy = 'Waiting for the browser’s device chooser…';
		try {
			if (kind === 'hid' || kind === 'hid-any') {
				const transport = await requestHidDevice({ entries, anyDevice: kind === 'hid-any' });
				if (!transport || transport.kind !== 'hid') return;
				chosen = {
					kind: 'hid',
					identity: identityOf(transport),
					transport,
					collections: transport.collections
				};
			} else if (kind === 'serial') {
				const choice = await requestSerialPort({ entries });
				if (choice) chosen = { kind: 'serial', identity: choice.identity, choice };
			} else {
				const choice = await requestBleDevice({ entries });
				if (choice) chosen = { kind: 'ble', identity: choice.identity, choice };
			}
			if (chosen) await identify(chosen.identity);
		} catch (e) {
			fail(e);
		} finally {
			busy = '';
		}
	}

	async function identify(identity: DeviceIdentity) {
		const result = await catalog.client.matchDevice(identity);
		matches = result.matches;
		ambiguous = result.ambiguous;
		profileId = result.best?.id ?? '';
		reportText = identityText(identity);
	}

	async function read() {
		if (!chosen || !protocol) return;
		error = '';
		pulled = null;
		busy = 'Reading the EQ…';
		try {
			if (!device) {
				const transport =
					chosen.kind === 'hid'
						? chosen.transport
						: chosen.kind === 'serial'
							? await chosen.choice.open(protocol)
							: await chosen.choice.open(protocol);
				const bandCount = profile?.bandCount ?? bandsWanted;
				device = openDevice(transport, protocol, { profile: { bandCount } });
			}
			pulled = await device.pull(profile ? {} : { bands: bandsWanted });
		} catch (e) {
			fail(e);
		} finally {
			busy = '';
		}
	}

	async function disconnect() {
		const open = device?.transport ?? (chosen?.kind === 'hid' ? chosen.transport : null);
		device = null;
		chosen = null;
		pulled = null;
		matches = [];
		profileId = '';
		try {
			await open?.close();
		} catch {
			// Already gone.
		}
	}

	// A different profile may mean a different protocol: reopen on the next read.
	$effect(() => {
		void protocol;
		if (device && device.protocol !== protocol) {
			const transport = device.transport;
			device = null;
			pulled = null;
			if (chosen?.kind !== 'hid') transport.close().catch(() => {});
		}
	});

	const findings = $derived(
		profile && pulled && device ? readFindings(profile, pulled, device.capabilities) : null
	);
	const hasLaws = $derived((profile?.realization?.laws.length ?? 0) > 0);
	const present = (xs: (Filter | null)[]) => xs.filter((x): x is Filter => x !== null);

	function findingsText(): string {
		if (!findings || !profile || !pulled) return '';
		const lines: string[] = [];
		if (findings.bandCount) {
			lines.push(
				`The device returned ${findings.bandCount.read} bands; the profile has ${findings.bandCount.profile}.`
			);
		}
		for (const v of findings.violations) lines.push(violationText(v, pulled.filters));
		return lines.join('\n');
	}

	const evidence = $derived.by(() => {
		if (!pulled || !chosen || !protocol) return null;
		const date = today();
		const lines = findingsText();
		const report = readEvidence({
			transport: chosen.kind,
			identity: chosen.identity,
			handler: protocol.handler,
			experimental: protocol.experimental === true,
			...(profileId && profile ? { profile: profileId } : {}),
			pull: pulled,
			findings: lines ? lines.split('\n') : [],
			commit: APP_COMMIT,
			userAgent: navigator.userAgent,
			date
		});
		const handoff = {
			...(profileId && profile ? { profileId } : {}),
			date,
			identity: chosen.identity,
			readBack: {
				filters: pulled.filters,
				...(pulled.preamp !== undefined ? { preamp: pulled.preamp } : {})
			},
			needsBandCount: device?.capabilities.needsBandCount ?? true
		};
		return { report, handoff };
	});

	function readBackText(): string {
		if (!pulled) return '';
		return pulled.filters.map((f, i) => `${i + 1}. ${f ? filterText(f) : 'off'}`).join('\n');
	}

	async function openInPlayground() {
		if (!pulled || !profileId) return;
		const realized = present(pulled.filters).map((f) => (profile ? toRealized(profile, f) : f));
		try {
			localStorage.setItem('eqcaps-inspector:playground', formatApo(realized, pulled.preamp ?? 0));
		} catch {
			// The playground then shows its sample.
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved, plus a query
		await goto(`${resolve('/playground')}?profile=${encodeURIComponent(profileId)}`);
	}
</script>

<svelte:head><title>Connect a device · eqcaps</title></svelte:head>

<div class="max-w-3xl space-y-2">
	<h1 class="text-2xl font-semibold">Connect a device</h1>
	<p class="text-zinc-600 dark:text-zinc-400">
		See what your device says about itself, which profile matches it, and whether its current EQ
		fits that profile. This page only reads: it never changes your device's settings.
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
									bind:group={profileId}
									id="match-{m.id}"
								/>
								<label for="match-{m.id}">{m.entry.brand} {m.entry.model}</label>
								<StatusBadge status={m.entry.status} />
								{#if m.entry.group}<span
										class="text-xs text-sky-700 dark:text-sky-400"
										title="Stands for several products that can't be told apart">group</span
									>{/if}
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
					bind:value={profileId}
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
							bind:value={bandsWanted}
							class="w-20 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				{/if}
				{#if writeOnly || (device && !device.capabilities.canRead)}
					<p class="rounded bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
						This protocol can only write to the device: it has no way to read the EQ back. This page
						only reads, so it can identify the device but not check its EQ. Apps that drive the
						device bridge can still write to it.
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

			{#if pulled}
				<div>
					<h3 class="font-medium">
						Current EQ{pulled.slot !== undefined ? `, preset ${pulled.slot}` : ''}{pulled.preamp !==
						undefined
							? `, preamp ${formatField('preamp', pulled.preamp)} dB`
							: ''}
					</h3>
					<table class="mt-1 text-sm">
						<thead class="text-xs text-zinc-500">
							<tr>
								<th class="px-2 text-left font-normal">Band</th>
								<th class="px-2 text-left font-normal">Type</th>
								<th class="px-2 text-right font-normal">Hz</th>
								<th class="px-2 text-right font-normal">dB</th>
								<th class="px-2 text-right font-normal">Q</th>
								{#if hasLaws}<th class="px-2 text-left font-normal">You hear</th>{/if}
							</tr>
						</thead>
						<tbody class="font-mono tabular-nums">
							{#each pulled.filters as f, i (i)}
								<tr class="border-b border-zinc-100 dark:border-zinc-900">
									<td class="px-2 py-0.5">{i + 1}</td>
									{#if f}
										<td class="px-2">{f.type}</td>
										<td class="px-2 text-right">{formatField('freq', f.freq)}</td>
										<td class="px-2 text-right">{formatField('gain', f.gain)}</td>
										<td class="px-2 text-right">{formatField('q', f.q)}</td>
										{#if hasLaws && profile}
											{@const r = toRealized(profile, f)}
											<td class="px-2 text-xs text-zinc-500"
												>{formatField('freq', r.freq)} Hz Q {formatField('q', r.q)}</td
											>
										{/if}
									{:else}
										<td class="px-2 text-zinc-400" colspan="4">off</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
					<p class="mt-1 text-xs text-zinc-500">
						Written values, as the device stores them{hasLaws
							? '; "You hear" applies the profile\'s realization laws'
							: ''}.
					</p>
				</div>

				{#if findings}
					<div>
						<h3 class="font-medium">Check against {profile?.id}</h3>
						{#if !findings.bandCount && findings.violations.length === 0}
							<p class="mt-1 text-sm text-emerald-700 dark:text-emerald-400">
								Everything the device holds fits the profile.
							</p>
						{:else}
							<p class="mt-1 text-sm">
								The device holds values the profile says it can't. Either the profile is too strict,
								or the device was set by an app that ignores it:
							</p>
							<ul class="mt-1 list-disc pl-5 text-sm">
								{#if findings.bandCount}
									<li>
										The device returned {findings.bandCount.read} bands; the profile has {findings
											.bandCount.profile}.
									</li>
								{/if}
								{#each findings.violations as v, i (i)}<li>
										{violationText(v, pulled.filters)}
									</li>{/each}
							</ul>
							<!-- eslint-disable svelte/no-navigation-without-resolve -- GitHub, not a route -->
							<a
								class="mt-2 inline-block text-sm"
								target="_blank"
								rel="noopener"
								href={wrongConstraintIssueUrl({
									profile: profile?.id ?? '',
									wrong: findingsText(),
									evidence: `Read back from the device with the eqcaps inspector:\n${readBackText()}`
								})}>Report it as a wrong constraint</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
					</div>
				{/if}

				{#if profileId}
					<button type="button" class="text-sm underline" onclick={openInPlayground}
						>Open this EQ in the playground</button
					>
				{/if}

				{#if evidence}
					{#key evidence.report}
						<EvidenceReview report={evidence.report} handoff={evidence.handoff} />
					{/key}
				{/if}
			{/if}
		</section>
	</div>
{/if}
