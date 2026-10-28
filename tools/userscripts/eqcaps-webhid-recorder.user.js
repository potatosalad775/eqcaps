// ==UserScript==
// @name         eqcaps WebHID recorder
// @namespace    https://github.com/potatosalad775/eqcaps
// @version      1
// @description  Records a vendor web app's WebHID traffic, and what the app made of it, for eqcaps' protocol tests. It sends nothing to the device itself.
// @match        https://cc.fosiaudio.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

// Wraps the page's WebHID calls (HIDDevice.prototype) and logs every report sent and answered.
// An adapter for the vendor app adds snapshots of what the app decoded from those answers, and a
// button that asks the app to run its own reads. The export is a recording for
// packages/device-bridge/test/recordings/ (format in tools/userscripts/README.md). The script
// never writes to a device: everything sent is sent by the vendor app.

(() => {
	'use strict';

	const RECORDER_VERSION = 1;
	const start = performance.now();
	const devices = [];
	const events = [];
	const snapshots = [];
	const deviceIndex = new WeakMap();

	const ms = () => Math.round((performance.now() - start) * 10) / 10;
	const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	const bytes = (data) =>
		data instanceof ArrayBuffer
			? new Uint8Array(data)
			: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

	function collections(list) {
		return Array.from(list ?? [], (c) => ({
			usagePage: c.usagePage,
			usage: c.usage,
			inputReports: Array.from(c.inputReports ?? [], (r) => r.reportId),
			outputReports: Array.from(c.outputReports ?? [], (r) => r.reportId),
			featureReports: Array.from(c.featureReports ?? [], (r) => r.reportId),
			children: collections(c.children)
		}));
	}

	function indexOf(device) {
		if (!deviceIndex.has(device)) {
			deviceIndex.set(device, devices.length);
			devices.push({
				vendorId: device.vendorId,
				productId: device.productId,
				productName: device.productName,
				collections: collections(device.collections)
			});
		}
		return deviceIndex.get(device);
	}

	function log(device, op, reportId, data, error) {
		const event = { t: ms(), device: indexOf(device), op, reportId };
		if (data !== undefined) event.data = hex(bytes(data));
		if (error !== undefined) event.error = String(error?.message ?? error);
		events.push(event);
		panel.update();
	}

	// --- WebHID --------------------------------------------------------------------------------

	const proto = window.HIDDevice?.prototype;
	if (!proto) return;
	const wrap = (name, body) => {
		const original = proto[name];
		proto[name] = function (...args) {
			return body.call(this, original, ...args);
		};
	};
	const sending = (op) =>
		async function (original, reportId, data) {
			try {
				const result = await original.call(this, reportId, data);
				log(this, op, reportId, data);
				return result;
			} catch (e) {
				log(this, op, reportId, data, e);
				throw e;
			}
		};
	wrap('sendReport', sending('output'));
	wrap('sendFeatureReport', sending('feature-out'));
	wrap('receiveFeatureReport', async function (original, reportId) {
		try {
			const view = await original.call(this, reportId);
			log(this, 'feature-in', reportId, view);
			return view;
		} catch (e) {
			log(this, 'feature-in', reportId, undefined, e);
			throw e;
		}
	});
	wrap('open', async function (original) {
		const result = await original.call(this);
		if (!this.__eqcapsRecording) {
			this.__eqcapsRecording = true;
			this.addEventListener('inputreport', (e) => log(this, 'input', e.reportId, e.data));
		}
		return result;
	});

	// --- Vendor app adapters ---------------------------------------------------------------------

	/** Fosi Audio's web control center: Vue with Pinia stores, one per product. */
	const fosi = {
		id: 'fosi-cc',
		matches: () => location.hostname === 'cc.fosiaudio.com',
		stores: {
			'Fosi Audio DS3': ['ds3Store', 'ds3DeviceInfo'],
			'Fosi Audio C1': ['c1Store', 'c1DeviceInfo'],
			'Fosi Audio C3': ['c3Store', 'c3DeviceInfo'],
			'Fosi Audio ZH1': ['zh1Store', 'zh1DeviceInfo'],
			'Fosi Audio ZH3': ['zh3Store', 'zh3DeviceInfo']
		},
		// The app's own read actions, in an order that works: the firmware sets the band count.
		reads: [
			['getFirmwareVersion'],
			['getEqModeCount'],
			['getAllEqModes'],
			['getAllEqBandParams'],
			['getEqEnable'],
			['getVolume'],
			['getGainMode'],
			['getFilterMode'],
			['getGameMode'],
			['getUpsample'],
			['getCurrentUacMode'],
			['getUacModeInfo'],
			['getLedSwitch', 0],
			['getSampleFormat']
		],
		pinia() {
			return document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		},
		store() {
			const stores = this.pinia()?._s;
			const name = stores?.get('hidDevices')?.selectedDevice?.productName;
			const [id, stateKey] = this.stores[name] ?? [];
			const store = id && stores.get(id);
			if (!store) throw new Error(`no store for "${name ?? 'no device'}": open its page first`);
			return { id, stateKey, store };
		},
		async readAll() {
			const { store } = this.store();
			const tasks = this.reads
				.filter(([name]) => typeof store[name] === 'function')
				.map(
					([name, ...args]) =>
						() =>
							store[name](...args)
				);
			if (typeof store.runSequence === 'function') await store.runSequence(tasks, 20, 0);
			else for (const task of tasks) await task();
		},
		snapshot() {
			const { id, stateKey, store } = this.store();
			return { store: id, state: JSON.parse(JSON.stringify(store[stateKey])) };
		}
	};

	const adapter = [fosi].find((a) => a.matches());

	function takeSnapshot(label) {
		if (!adapter) throw new Error('no adapter for this page');
		snapshots.push({ t: ms(), label, adapter: adapter.id, ...adapter.snapshot() });
		panel.update();
	}

	function exportRecording() {
		const recording = {
			recording: 'eqcaps-webhid',
			version: 1,
			recordedAt: new Date().toISOString(),
			tool: { name: 'eqcaps WebHID recorder', version: RECORDER_VERSION },
			page: { origin: location.origin, path: location.pathname + location.hash },
			userAgent: navigator.userAgent,
			notes: panel.notes(),
			devices,
			snapshots,
			events
		};
		const name = (devices[0]?.productName ?? 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-');
		const date = recording.recordedAt.slice(0, 10);
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(recording, null, '\t') + '\n'], { type: 'application/json' })
		);
		const a = Object.assign(document.createElement('a'), {
			href: url,
			download: `${date}-${name}.json`
		});
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	// --- Panel ----------------------------------------------------------------------------------

	const panel = (() => {
		let root;
		let status;
		let counts;
		let notes;
		const say = (text) => status && (status.textContent = text);
		const run = async (what, action) => {
			say(`${what}…`);
			try {
				await action();
				say(`${what}: done`);
			} catch (e) {
				say(`${what}: ${e?.message ?? e}`);
			}
		};
		function mount() {
			const host = document.createElement('div');
			host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647';
			root = host.attachShadow({ mode: 'open' });
			root.innerHTML = `
				<style>
					div { font: 12px system-ui, sans-serif; background: #111; color: #eee; padding: 8px;
						border-radius: 6px; width: 260px; box-shadow: 0 2px 8px #0008; }
					b { display: block; margin-bottom: 4px; }
					button { font: inherit; margin: 2px 2px 2px 0; }
					textarea { width: 100%; box-sizing: border-box; height: 40px; margin-top: 4px; }
					p { margin: 4px 0 0; color: #aaa; }
				</style>
				<div>
					<b>eqcaps recorder</b>
					<span id="counts"></span>
					<div style="padding:0;box-shadow:none">
						<button id="read" title="Ask the app to run its own reads, then snapshot">Read all</button>
						<button id="snap" title="Snapshot what the app shows now">Snapshot</button>
						<button id="export">Export</button>
						<button id="clear">Clear</button>
					</div>
					<textarea id="notes" placeholder="Notes: firmware, USB mode, what you changed"></textarea>
					<p id="status">Recording. Connect the device in the app.</p>
				</div>`;
			status = root.getElementById('status');
			counts = root.getElementById('counts');
			notes = root.getElementById('notes');
			root.getElementById('read').onclick = () =>
				run('Read all', async () => {
					await adapter.readAll();
					takeSnapshot('read all');
				});
			root.getElementById('snap').onclick = () => run('Snapshot', () => takeSnapshot('manual'));
			root.getElementById('export').onclick = () => run('Export', exportRecording);
			root.getElementById('clear').onclick = () => {
				events.length = 0;
				snapshots.length = 0;
				update();
				say('Cleared.');
			};
			if (!adapter) {
				for (const id of ['read', 'snap']) root.getElementById(id).disabled = true;
			}
			document.body.append(host);
			update();
		}
		function update() {
			if (counts) {
				counts.textContent = `${events.length} reports, ${snapshots.length} snapshots`;
			}
		}
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', mount, { once: true });
		} else mount();
		return { update, notes: () => notes?.value ?? '' };
	})();
})();
