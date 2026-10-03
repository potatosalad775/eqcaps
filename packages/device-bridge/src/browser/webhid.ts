import { BridgeError } from '../errors.ts';
import { chooserFilters, type ChooserEntry } from '../chooser.ts';
import type { HidCollectionInfo, HidReportInfo, HidTransport } from '../transport.ts';
import {
	browserApis,
	bytesOf,
	type HidCollectionInfoLike,
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
 * exact product name, preferring the vendor-defined interface; null if it isn't connected.
 */
export async function grantedHidDevice(
	identity: { vendorId: number; productId: number; productName: string },
	hid: HidLike | undefined = browserApis().hid
): Promise<HidTransport | null> {
	if (!hid) throw new BridgeError('unsupported', 'WebHID is not available in this browser');
	const granted = await hid.getDevices().catch(transportError('getDevices'));
	const same = granted.filter(
		(d) =>
			d.vendorId === identity.vendorId &&
			d.productId === identity.productId &&
			d.productName === identity.productName
	);
	const device = same.find(hasVendorCollection) ?? same[0];
	return device ? hidTransport(device) : null;
}
