import { describe, expect, it } from 'vitest';
import { expandBluetoothMatch, expandMatch, expandUsbMatch, matchValues } from './match.ts';

describe('listed match values', () => {
	it('reads one value or a list', () => {
		expect(matchValues('0x2972')).toEqual(['0x2972']);
		expect(matchValues(['0x0a12', '0x2972'])).toEqual(['0x0a12', '0x2972']);
		expect(matchValues(undefined)).toEqual([]);
	});

	it('expands an entry into every combination, in field order', () => {
		expect(
			expandUsbMatch({
				vendorId: ['0x0001', '0x0002'],
				productId: '0x0010',
				productName: ['A', 'B']
			})
		).toEqual([
			{ vendorId: '0x0001', productId: '0x0010', productName: 'A' },
			{ vendorId: '0x0001', productId: '0x0010', productName: 'B' },
			{ vendorId: '0x0002', productId: '0x0010', productName: 'A' },
			{ vendorId: '0x0002', productId: '0x0010', productName: 'B' }
		]);
		expect(expandUsbMatch({ vendorId: '0x0001', productId: '0x0010' })).toEqual([
			{ vendorId: '0x0001', productId: '0x0010' }
		]);
		const uuid = '00001101-0000-1000-8000-00805f9b34fb';
		expect(expandBluetoothMatch({ namePrefix: ['A', 'B'], serviceUuid: uuid })).toEqual([
			{ namePrefix: 'A', serviceUuid: uuid },
			{ namePrefix: 'B', serviceUuid: uuid }
		]);
	});

	it('keeps the rest of the match', () => {
		const match = {
			usb: [{ vendorId: ['0x0001', '0x0002'], productId: '0x0010' }],
			firmware: { min: '1.0' }
		};
		expect(expandMatch(match)).toEqual({
			usb: [
				{ vendorId: '0x0001', productId: '0x0010' },
				{ vendorId: '0x0002', productId: '0x0010' }
			],
			firmware: { min: '1.0' }
		});
		expect(match.usb[0]!.vendorId).toHaveLength(2);
	});
});
