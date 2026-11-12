import { describe, expect, it } from 'vitest';
import { bluetoothEntryText, identitySummary, usbEntryText } from './identity.ts';

const vendors = Array.from(
	{ length: 19 },
	(_, i) => `0x${(0x100 + i).toString(16).padStart(4, '0')}`
);

describe('match entries as text', () => {
	it('writes single values as they are and lists as alternatives', () => {
		expect(
			usbEntryText({ vendorId: '0x2972', productId: '0x0047', productName: 'FIIO KA17' })
		).toBe('0x2972:0x0047 "FIIO KA17"');
		expect(
			usbEntryText({ vendorId: ['0x0a12', '0x2972'], productName: ['FIIO BTR17', 'BTR17'] })
		).toBe('0x0a12 | 0x2972 "FIIO BTR17" | "BTR17"');
	});

	it('counts long lists unless asked for all of them', () => {
		const family = { vendorId: vendors, productId: ['0x4301', '0x4302', '0x4304', '0x4305'] };
		expect(usbEntryText(family)).toBe('19 vendor ids:4 product ids');
		expect(usbEntryText(family, Infinity)).toContain('0x0100 | 0x0101');
	});

	it('marks bluetooth prefixes and names the service', () => {
		const uuid = '00001101-0000-1000-8000-00805f9b34fb';
		expect(bluetoothEntryText({ namePrefix: 'Moondrop Edge', serviceUuid: uuid })).toBe(
			`"Moondrop Edge…" service ${uuid}`
		);
		expect(bluetoothEntryText({ name: ['EH13', 'EH11'] }, 3, false)).toBe('"EH13" | "EH11"');
	});

	it('sums up a match in one line', () => {
		expect(
			identitySummary({
				usb: [
					{ vendorId: vendors, productId: '0x4301' },
					{ vendorId: '0x3302', productName: 'A' }
				],
				bluetooth: [{ name: 'B' }]
			})
		).toBe('19 vendor ids:0x4301, 0x3302 "A", BT "B"');
		expect(identitySummary(undefined)).toBe('');
	});
});
