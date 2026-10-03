<script lang="ts">
	// Consumer guide (INSPECTOR §7): where the data is, and how an app uses it. The packages'
	// READMEs and the SPEC have the details; this page is the map.
	import { resolve } from '$app/paths';
	import { dataUrl } from '$lib/channel';
	import { REPO_URL } from '$lib/repo';

	const pkg = (name: string) => `https://www.npmjs.com/package/@potatosalad775/${name}`;
	const readme = (name: string) => `${REPO_URL}/tree/main/packages/${name}#readme`;

	const clientCode = `import { createClient, webStorageStore } from '@potatosalad775/eqcaps-client';
import { complete, fit, toRealized, validateList } from '@potatosalad775/eqcaps-core';

const client = createClient({ store: webStorageStore(localStorage) });

// What WebHID (or a native USB plugin) reports for the connected device.
const { best } = await client.matchDevice({
  usb: { vendorId: '0x2972', productId: '0x0093', productName: 'FIIO KA17' }
});
const profile = best && (await client.loadProfile(best.id));
if (profile) {
  validateList(profile, wanted, preamp);                // while editing: flag, don't rewrite
  const result = fit(profile, wanted, preamp);          // before writing: what to send
  const bands = complete(profile, result.slots).filters; // every slot, neutral fillers included
  // After reading the device back: what the listener hears.
  const heard = readBack.map((f) => toRealized(profile, f));
}`;

	const bridgeCode = `import { identityOf, openDevice, protocolFor } from '@potatosalad775/eqcaps-device-bridge';
import { requestHidDevice } from '@potatosalad775/eqcaps-device-bridge/browser';

const index = await client.loadIndex();
const transport = await requestHidDevice({ entries: index?.profiles ?? [] });
const { best } = await client.matchDevice(identityOf(transport));
const device = openDevice(transport, protocolFor(best.id), { profile });
const state = await device.pull();                // written values, band order
await device.push({ filters: bands });            // exactly what you give it: fit + complete first`;
</script>

<svelte:head><title>Use the data · eqcaps</title></svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- npm, GitHub and data files, not routes -->
<article class="max-w-3xl space-y-8">
	<header class="space-y-2">
		<h1 class="text-2xl font-semibold">Use the data</h1>
		<p class="text-zinc-600 dark:text-zinc-400">
			eqcaps says what an EQ engine accepts: how many bands, which filter types in which slot, the
			frequency, Q and gain each slot takes, and the rules between them. Apps use it to show the
			right controls and to write only what a device can hold. The data is public domain (CC0-1.0);
			the packages are MIT.
		</p>
	</header>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">The files</h2>
		<p class="text-sm">
			Static JSON with CORS, on GitHub Pages, under <span class="font-mono">/v1/</span> for format
			v1 (<a href="{REPO_URL}/blob/main/docs/SPEC.md#14-published-artifacts">SPEC §14</a>):
		</p>
		<table class="text-left text-sm">
			<tbody>
				<tr
					><td class="pr-4 font-mono"><a href="{dataUrl()}index.json">index.json</a></td><td
						>every profile's id, names, status and device identity, for search and matching</td
					></tr
				>
				<tr
					><td class="pr-4 font-mono"><a href="{dataUrl()}bundle.json">bundle.json</a></td><td
						>every current profile in one file, to embed for offline use</td
					></tr
				>
				<tr><td class="pr-4 font-mono">profiles/&lt;id&gt;.json</td><td>one profile</td></tr>
				<tr
					><td class="pr-4 font-mono"
						><a href="{dataUrl()}schema/profile.schema.json">schema/profile.schema.json</a></td
					><td>the JSON Schema</td></tr
				>
			</tbody>
		</table>
		<p class="text-sm">
			Each release on GitHub also carries <span class="font-mono">bundle.json</span>. An app must
			work without the data: it improves the app and never blocks it.
		</p>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">The packages</h2>
		<ul class="list-disc space-y-1 pl-5 text-sm">
			<li>
				<a href={pkg('eqcaps-core')}>@potatosalad775/eqcaps-core</a>: types, validation and the
				engine (<span class="font-mono">validate</span>, <span class="font-mono">fit</span>,
				<span class="font-mono">complete</span>, <span class="font-mono">toRealized</span>…). No
				dependencies, synchronous. <a href={readme('core')}>README</a>
			</li>
			<li>
				<a href={pkg('eqcaps-client')}>@potatosalad775/eqcaps-client</a>: fetching, caching and
				device matching. Never throws into the app. <a href={readme('client')}>README</a>
			</li>
			<li>
				@potatosalad775/eqcaps-device-bridge: reads and writes the EQ of the database's devices over
				WebHID, Web Serial and Web Bluetooth, or a native transport of your own.
				<a href={readme('device-bridge')}>README</a>
			</li>
		</ul>
		<pre
			class="overflow-x-auto rounded bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{clientCode}</pre>
		<p class="text-sm">
			Hold the filters the user <em>wants</em>. Write through <span class="font-mono">fit</span>
			then
			<span class="font-mono">complete</span>; show a device's read-back through
			<span class="font-mono">toRealized</span>, since some engines play something other than the
			values they store (<a href="{REPO_URL}/blob/main/docs/SPEC.md#8-realization">SPEC §8</a>).
		</p>
		<pre
			class="overflow-x-auto rounded bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{bridgeCode}</pre>
	</section>

	<section class="space-y-2">
		<h2 class="text-lg font-semibold">Try it here</h2>
		<p class="text-sm">
			The <a href={resolve('/playground')}>playground</a> runs the engine on your own filters
			against any profile. <a href={resolve('/connect')}>Connect</a> reads a device's EQ through the
			bridge and checks it against its profile. Found something wrong? The
			<a href={resolve('/edit/[[id]]', {})}>editor</a> turns a fix into a pull request.
		</p>
	</section>
</article>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
