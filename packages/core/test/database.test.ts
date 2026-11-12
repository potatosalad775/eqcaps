import { describe, expect, it } from 'vitest';
import { checkDatabase, type Profile } from '../src/index.ts';
import { profile } from './fixtures.ts';

// The match-collision rule (SPEC §3): a group profile yields to a device profile, nothing else does.

const codes = (profiles: Profile[]) => checkDatabase(profiles).map((i) => i.code);
const make = (id: string, group: boolean, patch: object = {}) =>
	profile({ id, device: { group }, ...patch });

describe('match collisions', () => {
	it('lets a group profile share a match entry with a device profile', () => {
		expect(codes([make('group', true), make('device', false)])).toEqual([]);
		expect(codes([make('device', false), make('group', true)])).toEqual([]);
	});

	it('lets a device profile claim one pair out of a group entry that lists many', () => {
		const family = make('group', true, {
			match: { usb: [{ vendorId: ['0x0001', '0x0002'], productId: ['0x0010', '0x0011'] }] }
		});
		const device = make('device', false, {
			match: { usb: [{ vendorId: '0x0002', productId: '0x0011' }] }
		});
		expect(codes([family, device])).toEqual([]);
	});

	it('still rejects two group profiles sharing a match entry', () => {
		expect(codes([make('group-a', true), make('group-b', true)])).toEqual(['match-collision']);
	});

	it('still rejects two device profiles sharing a match entry', () => {
		expect(codes([make('device-a', false), make('device-b', false)])).toEqual(['match-collision']);
		const unmarked = profile({ id: 'device-c' });
		expect(codes([profile({ id: 'device-d' }), unmarked])).toEqual(['match-collision']);
	});

	it('reports only the device pair when a group shares their entry too', () => {
		const ids = checkDatabase([make('group', true), make('a', false), make('b', false)]).map(
			(i) => i.profileId
		);
		expect(ids).toEqual(['b']);
	});
});
