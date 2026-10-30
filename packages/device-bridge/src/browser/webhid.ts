import { BridgeError } from '../errors.ts';
import { chooserFilters, type ChooserEntry } from '../chooser.ts';
import { after } from '../platform.ts';
import type { HidCollectionInfo, HidReportInfo, HidTransport } from '../transport.ts';
import {
	browserApis,
	bytesOf,
	type HidCollectionInfoLike,
	type HidConnectionEventLike,
	type HidDeviceLike,
	type HidInputReportEventLike,
	type HidLike,
	type HidReportInfoLike
} from './web-apis.ts';

function reportInfo(r: HidReportInfoLike): HidReportInfo {
	const bits = (r.items ?? []).reduce(
		(sum, item) => sum + (item.reportSize ?? 0) * (item.reportCount ?? 0),
		0
	);
	const info: HidReportInfo = { reportId: r.reportId ?? 0 };
	if (bits > 0) info.size = Math.ceil(bits / 8);
	return info;
}

/** The descriptor's collections in the bridge's shape (also the T1 descriptor dump). */
export function hidCollections(collections: readonly HidCollectionInfoLike[]): HidCollectionInfo[] {
	return collections.map((c) => ({
		usagePage: c.usagePage ?? 0,
		usage: c.usage ?? 0,
		inputReports: (c.inputReports ?? []).map(reportInfo),
		outputReports: (c.outputReports ?? []).map(reportInfo),
		featureReports: (c.featureReports ?? []).map(reportInfo),
		children: hidCollections(c.children ?? [])
	}));
}

const transportError = (what: string) => (cause: unknown) => {
	throw new BridgeError('transport', `WebHID: ${what} failed`, { cause });
};

/** Wraps a WebHID device (opened if it isn't) as a bridge transport. */
export async function hidTransport(device: HidDeviceLike): Promise<HidTransport> {
	if (!device.opened) await device.open().catch(transportError('open'));
	return {
		kind: 'hid',
		vendorId: device.vendorId,
		productId: device.productId,
		productName: device.productName,
		collections: hidCollections(device.collections),
		sendReport: (id, data) => device.sendReport(id, data).catch(transportError('sendReport')),
		sendFeatureReport: (id, data) =>
			device.sendFeatureReport(id, data).catch(transportError('sendFeatureReport')),
		receiveFeatureReport: async (id) =>
			bytesOf(await device.receiveFeatureReport(id).catch(transportError('receiveFeatureReport'))),
		onInputReport(listener) {
			const handler = (e: HidInputReportEventLike) => listener(e.reportId, bytesOf(e.data));
			device.addEventListener('inputreport', handler);
			return () => device.removeEventListener('inputreport', handler);
		},
		close: () => device.close().catch(transportError('close'))
	};
}

const hasVendorCollection = (d: HidDeviceLike) =>
	d.collections.some((c) => (c.usagePage ?? 0) >= 0xff00);

export interface RequestHidOptions {
	/** Database entries whose devices to offer, on top of the vendors `guessProtocol` knows. */
	entries?: Iterable<ChooserEntry>;
	/** Offer every HID device: for identifying unknown devices (INSPECTOR T1). */
	anyDevice?: boolean;
	/** Default: `navigator.hid`. */
	hid?: HidLike;
}

/**
 * Shows the browser's HID chooser and returns the chosen device as a transport, or null if the
 * user cancelled. A device with several HID interfaces of the same name (Qudelix 5K) may be
 * chosen on its audio interface; the vendor-defined interface is preferred when it was granted
 * too.
 */
export async function requestHidDevice(
	options: RequestHidOptions = {}
): Promise<HidTransport | null> {
	const hid = options.hid ?? browserApis().hid;
	if (!hid) throw new BridgeError('unsupported', 'WebHID is not available in this browser');
	const filters = options.anyDevice
		? []
		: chooserFilters(options.entries).hidVendorIds.map((vendorId) => ({ vendorId }));
	const chosen = await hid.requestDevice({ filters }).catch(transportError('requestDevice'));
	let device = chosen[0];
	if (!device) return null;
	if (!hasVendorCollection(device)) {
		const granted = await hid.getDevices().catch(() => []);
		const sibling = granted.find(
			(d) =>
				d !== device &&
				d.vendorId === device!.vendorId &&
				d.productId === device!.productId &&
				hasVendorCollection(d)
		);
		if (sibling) device = sibling;
	}
	return hidTransport(device);
}

/**
 * A device this site was already granted, found again without the chooser: after it was unplugged
 * and plugged back in, say, or moved to a phone and back. Matches vendor id, product id and the
 * exact product name, preferring the vendor-defined interface; null if it isn't connected. Several
 * identities are for a device that can come back as any of them (the Fosi DS3 has one per USB
 * mode); a device granted under one of them is found.
 */
export async function grantedHidDevice(
	identity: HidIdentity | readonly HidIdentity[],
	hid: HidLike | undefined = browserApis().hid
): Promise<HidTransport | null> {
	if (!hid) throw new BridgeError('unsupported', 'WebHID is not available in this browser');
	const granted = await hid.getDevices().catch(transportError('getDevices'));
	const device = pickGranted(granted, identity);
	return device ? hidTransport(device) : null;
}

/** What a granted device is found again by. */
export interface HidIdentity {
	vendorId: number;
	productId: number;
	productName: string;
}

const isSame = (d: HidDeviceLike, identity: HidIdentity | readonly HidIdentity[]) =>
	(Array.isArray(identity) ? identity : [identity]).some(
		(i: HidIdentity) =>
			d.vendorId === i.vendorId && d.productId === i.productId && d.productName === i.productName
	);

function pickGranted(
	granted: readonly HidDeviceLike[],
	identity: HidIdentity | readonly HidIdentity[]
) {
	const same = granted.filter((d) => isSame(d, identity));
	return same.find(hasVendorCollection) ?? same[0];
}

export interface WaitForHidOptions {
	/** How long to wait before giving up with null, ms. */
	timeoutMs: number;
	/** How often `getDevices()` is asked meanwhile, ms (default 250). */
	pollMs?: number;
	/**
	 * Skip the matching devices granted at the call: for a device about to re-enumerate (one that
	 * restarts to save), whose old handle stays listed for a moment and fails once it goes.
	 */
	ignoreCurrent?: boolean;
	/**
	 * With `ignoreCurrent`: a skipped handle still listed this long after the call, never having
	 * gone, is taken after all. Some devices keep their HID interface through the restart and only
	 * drop the audio one (the Tanchjim FOLA on macOS): their old handle is the device back.
	 */
	reuseAfterMs?: number;
	/**
	 * Called on `navigator.hid`'s connect and disconnect events for a matching device, with `gone`
	 * when a poll first misses a skipped one, and with `reused` when a skipped handle that never went
	 * is taken (`reuseAfterMs`). For diagnostics: whether the browser reports the device leaving and
	 * coming back, and when.
	 */
	onEvent?: (event: 'connect' | 'disconnect' | 'gone' | 'reused') => void;
	/** Default: `navigator.hid`. */
	hid?: HidLike;
}

/**
 * Waits for a device this site was granted to be connected, as `grantedHidDevice` finds it: on
 * the browser's `connect` event or a `getDevices()` poll, whichever comes first. Null after
 * `timeoutMs`, which is also what a device whose grant the browser dropped comes to: this never
 * shows the chooser (that needs a click).
 */
export async function waitForGrantedHidDevice(
	identity: HidIdentity | readonly HidIdentity[],
	options: WaitForHidOptions
): Promise<HidTransport | null> {
	const hid = options.hid ?? browserApis().hid;
	if (!hid) throw new BridgeError('unsupported', 'WebHID is not available in this browser');
	const stale = new Set(
		options.ignoreCurrent
			? (await hid.getDevices().catch(() => [])).filter((d) => isSame(d, identity))
			: []
	);
	const device = await new Promise<HidDeviceLike | null>((resolve) => {
		let settled = false;
		let checking = false;
		let gone = stale.size === 0;
		let reuse = false;
		let cancelPoll = () => {};
		const finish = (d: HidDeviceLike | null) => {
			if (settled) return;
			settled = true;
			cancelTimeout();
			cancelReuse();
			cancelPoll();
			hid.removeEventListener?.('connect', onConnect);
			hid.removeEventListener?.('disconnect', onDisconnect);
			resolve(d);
		};
		const check = async () => {
			if (settled || checking) return;
			checking = true;
			try {
				const granted = await hid.getDevices().catch(() => []);
				if (!gone && !granted.some((d) => stale.has(d))) {
					gone = true;
					options.onEvent?.('gone');
				}
				// Once the old handles have gone, one coming back is the device back.
				const usable = gone || reuse ? granted : granted.filter((d) => !stale.has(d));
				const found = pickGranted(usable, identity);
				if (!found) return;
				if (!gone && stale.has(found)) options.onEvent?.('reused');
				finish(found);
			} finally {
				checking = false;
			}
		};
		const onConnect = ({ device: d }: HidConnectionEventLike) => {
			if (!isSame(d, identity)) return;
			options.onEvent?.('connect');
			if (stale.has(d)) gone = true;
			// Through `getDevices()`, so a device with several interfaces still gets the vendor one.
			void check();
		};
		const onDisconnect = ({ device: d }: HidConnectionEventLike) => {
			if (isSame(d, identity)) options.onEvent?.('disconnect');
		};
		hid.addEventListener?.('connect', onConnect);
		hid.addEventListener?.('disconnect', onDisconnect);
		const cancelTimeout = after(options.timeoutMs, () => finish(null));
		const cancelReuse =
			options.reuseAfterMs !== undefined && stale.size > 0
				? after(options.reuseAfterMs, () => {
						reuse = true;
						void check();
					})
				: () => {};
		const poll = () => {
			cancelPoll = after(options.pollMs ?? 250, () => {
				void check();
				poll();
			});
		};
		poll();
		void check();
	});
	return device ? hidTransport(device) : null;
}
