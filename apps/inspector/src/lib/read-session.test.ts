import { describe, expect, it, vi } from 'vitest';
import { matchDevice } from '@potatosalad775/eqcaps-client';
import type { Filter, IndexEntry, Profile } from '@potatosalad775/eqcaps-core';
import type {
	DeviceIdentity,
	DeviceReader,
	Protocol,
	PullResult,
	Transport
} from '@potatosalad775/eqcaps-device-bridge';
import { readHandoff, ReadSession, type Chosen, type ReadState } from './read-session.ts';

// The read session against an index of its own and a device that answers from memory: no page,
// no browser chooser, no bridge handler doing I/O.

const pk = (freq: number, gain: number): Filter => ({ type: 'PK', freq, q: 1, gain });

const entry = (id: string, extra: Partial<IndexEntry>): IndexEntry =>
	({
		id,
		kind: 'hardware',
		brand: 'Acme',
		model: id,
		status: 'draft',
		path: `profiles/${id}.json`,
		sha256: `sha-${id}`,
		bytes: 1,
		...extra
	}) as IndexEntry;

const KA17 = { vendorId: '0x2972', productId: '0x0093' };
const QUDELIX = { vendorId: '0x0a12', productId: '0x4025' };
const entries: IndexEntry[] = [
	entry('ka17', { match: { usb: [KA17] }, protocol: { handler: 'fiio-usb-hid' } }),
	// A device profile without a protocol of its own, under the group that has one.
	entry('micro', { match: { usb: [{ vendorId: '0x3302', productId: '0xc20f' }] } }),
	entry('walkplay-group', {
		group: true,
		match: { usb: [{ vendorId: '0x3302', productId: ['0xc20f', '0xc210'] }] },
		protocol: { handler: 'walkplay-hid' }
	}),
	entry('5k', {
		match: { usb: [QUDELIX] },
		protocol: {
			handler: 'qudelix-usb-hid',
			eqs: [{ id: 'spk', name: 'SPK EQ', bandCount: 20, channels: 'independent' }]
		}
	}),
	entry('fw-old', { match: { usb: [{ vendorId: '0x152a' }], firmware: { max: '1.5' } } }),
	entry('fw-new', { match: { usb: [{ vendorId: '0x152a' }], firmware: { min: '1.5' } } }),
	entry('serial-dac', {
		match: { usb: [{ vendorId: '0x0001', productId: '0x0001' }] },
		protocol: { handler: 'jds-labs-usb-serial' }
	})
];

const profileOf = (id: string): Profile => {
	const e = entries.find((x) => x.id === id)!;
	return {
		schemaVersion: '1.5',
		id,
		kind: 'hardware',
		device: { brand: e.brand, model: e.model, ...(e.group ? { group: true } : {}) },
		bandCount: id === '5k' ? 10 : 5,
		band: {
			types: ['PK'],
			freq: { min: 20, max: 20000 },
			q: { min: 0.1, max: 10 },
			gain: { min: -12, max: 12 }
		},
		preamp: { mode: 'unknown' },
		...(e.protocol ? { protocol: e.protocol } : {}),
		meta: { status: 'draft', sources: [] }
	} as Profile;
};

const transportOf = (kind: Transport['kind']) =>
	({ kind, close: vi.fn(async () => {}) }) as unknown as Transport & {
		close: ReturnType<typeof vi.fn>;
	};

const hid = (usb: { vendorId: string; productId?: string }): Chosen & { kind: 'hid' } => ({
	kind: 'hid',
	identity: { usb },
	transport: transportOf('hid'),
	collections: []
});

/** A session over `entries`, and what it asked of its device. */
function setup(
	options: { canRead?: boolean; load?: (id: string) => Promise<Profile | null> } = {}
) {
	const states: ReadState[] = [];
	const pulls: { eq: string | undefined; bands: number | undefined }[] = [];
	const opened: { transport: Transport; protocol: Protocol }[] = [];
	const held: PullResult = { filters: [pk(1000, 3), null, pk(4000, -2), null, null] };
	const open = (transport: Transport, protocol: Protocol): DeviceReader => {
		opened.push({ transport, protocol });
		const view = (eq?: string): DeviceReader =>
			({
				transport,
				protocol,
				identity: {} as DeviceIdentity,
				capabilities: { canRead: options.canRead ?? true, needsBandCount: false },
				pull: async (request: { bands?: number } = {}) => {
					pulls.push({ eq, bands: request.bands });
					return eq ? { ...held, right: { filters: [pk(80, 1)] } } : held;
				},
				eq: view
			}) as unknown as DeviceReader;
		return view();
	};
	const session = new ReadSession({
		entries: () => entries,
		match: async (identity) => matchDevice(entries, identity),
		loadProfile: options.load ?? (async (id) => profileOf(id)),
		open,
		onChange: (s) => states.push(s)
	});
	// Opening to learn a HID protocol's capabilities isn't opening the device to read it.
	const reads = () => opened.filter((_, i) => i >= probes());
	let probed = 0;
	const probes = () => probed;
	const markProbes = () => (probed = opened.length);
	return { session, states, pulls, opened, held, reads, markProbes };
}

describe('identifying a device', () => {
	it('takes the unique best match as the profile, loads it and drives by its own protocol', async () => {
		const { session } = setup();
		await session.connect(hid(KA17));
		const s = session.state;
		expect(s.matches.map((m) => m.id)).toEqual(['ka17']);
		expect(s).toMatchObject({ ambiguous: false, profileId: 'ka17' });
		expect(s.profile?.id).toBe('ka17');
		expect(s.driver).toMatchObject({
			source: 'profile',
			profileId: 'ka17',
			protocol: { handler: 'fiio-usb-hid' }
		});
	});

	it('drives a device profile without a protocol by the group it also matches', async () => {
		const { session } = setup();
		await session.connect(hid({ vendorId: '0x3302', productId: '0xc20f' }));
		expect(session.state.profileId).toBe('micro');
		expect(session.state.driver).toMatchObject({
			source: 'match',
			profileId: 'walkplay-group',
			protocol: { handler: 'walkplay-hid' }
		});
	});

	it('guesses from the USB vendor for a HID device no profile matches', async () => {
		const { session } = setup();
		await session.connect(hid({ vendorId: '0x2972', productId: '0xffff' }));
		expect(session.state).toMatchObject({ matches: [], profileId: '', profile: null });
		expect(session.state.driver).toMatchObject({
			source: 'guess',
			protocol: { handler: 'fiio-usb-hid', experimental: true }
		});
	});

	it('has no protocol for a serial port no profile matches: the vendor guesses are HID', async () => {
		const { session } = setup();
		await session.connect({
			kind: 'serial',
			identity: { usb: { vendorId: '0x2972', productId: '0xffff' } },
			choice: { open: async () => transportOf('serial') }
		});
		expect(session.state.driver).toBeUndefined();
	});

	it('leaves a tie to the user, and takes their pick', async () => {
		const { session } = setup();
		await session.connect(hid({ vendorId: '0x152a' }));
		expect(session.state).toMatchObject({ ambiguous: true, profileId: '', profile: null });
		expect(session.state.matches.map((m) => m.id)).toEqual(['fw-new', 'fw-old']);
		await session.pickProfile('fw-old');
		expect(session.state.profile?.id).toBe('fw-old');
	});

	it('keeps the profile picked last when an earlier one loads late', async () => {
		const waiting = new Map<string, (p: Profile) => void>();
		const { session } = setup({
			load: (id) => new Promise((done) => waiting.set(id, done))
		});
		const connecting = session.connect(hid({ vendorId: '0x152a' }));
		await vi.waitFor(() => expect(session.state.ambiguous).toBe(true));
		const first = session.pickProfile('fw-old');
		const second = session.pickProfile('fw-new');
		waiting.get('fw-new')!(profileOf('fw-new'));
		waiting.get('fw-old')!(profileOf('fw-old'));
		await Promise.all([connecting, first, second]);
		expect(session.state.profile?.id).toBe('fw-new');
	});

	it('says before any read that a HID protocol cannot read', async () => {
		const { session, pulls } = setup({ canRead: false });
		await session.connect(hid(KA17));
		expect(session.state.writeOnly).toBe(true);
		expect(pulls).toEqual([]);
	});
});

describe('reading', () => {
	it('reads the HID device the user chose, asking for the profile`s band count', async () => {
		const { session, pulls, opened, held, markProbes } = setup();
		const chosen = hid(KA17);
		await session.connect(chosen);
		markProbes();
		await session.read();
		expect(opened.at(-1)!.transport).toBe(chosen.transport);
		expect(pulls).toEqual([{ eq: undefined, bands: 5 }]);
		expect(session.state.pulled).toBe(held);
		expect(session.state.channels).toHaveLength(1);
		expect(session.state.channels![0]!.findings).toEqual({ bandCount: null, violations: [] });
	});

	it('opens a serial port only when it reads, on the protocol in use, and once', async () => {
		const { session, reads, markProbes } = setup();
		const port = transportOf('serial');
		const open = vi.fn(async () => port);
		await session.connect({
			kind: 'serial',
			identity: { usb: { vendorId: '0x0001', productId: '0x0001' } },
			choice: { open }
		});
		markProbes();
		expect(open).not.toHaveBeenCalled();
		await session.read();
		await session.read();
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(session.state.driver!.protocol);
		expect(reads()).toHaveLength(1);
	});

	it('asks for the bands the user wants where no profile says how many', async () => {
		const { session, pulls } = setup();
		await session.connect(hid({ vendorId: '0x2972', productId: '0xffff' }));
		session.setBands(7);
		await session.read();
		expect(pulls).toEqual([{ eq: undefined, bands: 7 }]);
		expect(session.state.channels![0]!.findings).toBeNull();
	});

	it('reads another EQ through its view, checked against that EQ`s profile, channel by channel', async () => {
		const { session, pulls } = setup();
		await session.connect(hid(QUDELIX));
		await session.read();
		session.pickEq('spk');
		// The other EQ holds other values: what was read is the previous one's.
		expect(session.state.pulled).toBeNull();
		expect(session.state.listedEq).toMatchObject({ id: 'spk', name: 'SPK EQ' });
		expect(session.state.eqShown).toMatchObject({ engine: 'SPK EQ', bandCount: 20 });
		await session.read();
		expect(pulls).toEqual([
			{ eq: undefined, bands: 10 },
			{ eq: 'spk', bands: 20 }
		]);
		expect(session.state.channels!.map((c) => c.channel)).toEqual(['Left', 'Right']);
	});

	it('ignores an EQ the protocol in use does not list', async () => {
		const { session, pulls } = setup();
		await session.connect(hid(KA17));
		session.pickEq('spk');
		expect(session.state.listedEq).toBeUndefined();
		await session.read();
		expect(pulls).toEqual([{ eq: undefined, bands: 5 }]);
	});

	it('drops the read and the open device when another profile is picked', async () => {
		const { session, reads, markProbes } = setup();
		const chosen = hid({ vendorId: '0x152a' });
		await session.connect(chosen);
		await session.pickProfile('ka17');
		markProbes();
		await session.read();
		expect(session.state.device).not.toBeNull();
		await session.pickProfile('walkplay-group');
		expect(session.state).toMatchObject({ device: null, pulled: null, channels: null });
		expect(session.state.driver!.protocol.handler).toBe('walkplay-hid');
		// The HID device the user chose stays open for the next read.
		expect(chosen.transport.close).not.toHaveBeenCalled();
		markProbes();
		await session.read();
		expect(reads()).toHaveLength(1);
		expect(reads()[0]!.protocol.handler).toBe('walkplay-hid');
	});

	it('closes a serial port opened on a protocol no longer in use', async () => {
		const { session } = setup();
		const port = transportOf('serial');
		await session.connect({
			kind: 'serial',
			identity: { usb: { vendorId: '0x0001', productId: '0x0001' } },
			choice: { open: async () => port }
		});
		await session.read();
		await session.pickProfile('ka17');
		expect(port.close).toHaveBeenCalledTimes(1);
		expect(session.state.device).toBeNull();
	});

	it('does nothing without a protocol', async () => {
		const { session, pulls } = setup();
		await session.read();
		await session.connect(hid({ vendorId: '0xdead' }));
		await session.read();
		expect(pulls).toEqual([]);
	});

	it('lets a failed read through to the page, the device still open', async () => {
		const { session } = setup();
		await session.connect(hid(KA17));
		await session.read();
		const device = session.state.device!;
		session.adopt({
			...device,
			eq: () => ({ ...device, pull: async () => Promise.reject(new Error('timed out')) })
		} as DeviceReader);
		await expect(session.read()).rejects.toThrow('timed out');
		expect(session.state.pulled).toBeNull();
		expect(session.state.device).not.toBeNull();
	});
});

describe('letting go', () => {
	it('closes the device and forgets it, keeping the band count the user typed', async () => {
		const { session } = setup();
		const chosen = hid(KA17);
		await session.connect(chosen);
		session.setBands(8);
		await session.read();
		await session.disconnect();
		expect(chosen.transport.close).toHaveBeenCalledTimes(1);
		expect(session.state).toMatchObject({
			chosen: null,
			matches: [],
			profileId: '',
			profile: null,
			driver: undefined,
			device: null,
			pulled: null,
			bandsWanted: 8
		});
	});

	it('closes the device before taking another', async () => {
		const { session } = setup();
		const first = hid(KA17);
		await session.connect(first);
		await session.connect(hid(QUDELIX));
		expect(first.transport.close).toHaveBeenCalledTimes(1);
		expect(session.state.profileId).toBe('5k');
	});

	it('survives a device that is already gone', async () => {
		const { session } = setup();
		const chosen = hid(KA17);
		chosen.transport.close = vi.fn(async () => Promise.reject(new Error('gone')));
		await session.connect(chosen);
		await expect(session.disconnect()).resolves.toBeUndefined();
		expect(session.state.chosen).toBeNull();
	});

	it('hands every change to the page as a new state', async () => {
		const { session, states } = setup();
		await session.connect(hid(KA17));
		expect(states.length).toBeGreaterThan(2);
		expect(new Set(states).size).toBe(states.length);
		expect(states.at(-1)).toBe(session.state);
	});
});

describe('a read as evidence', () => {
	const env = { date: '2026-11-22', commit: 'abc1234', userAgent: 'test' };

	it('is nothing until something was read', async () => {
		const { session } = setup();
		await session.connect(hid(KA17));
		expect(readHandoff(session.state, env)).toBeNull();
	});

	it('names the device, the protocol and the profile it was checked against', async () => {
		const { session, held } = setup();
		await session.connect(hid(KA17));
		await session.read();
		const { report, handoff } = readHandoff(session.state, env)!;
		expect(report).toMatchObject({ handler: 'fiio-usb-hid', profile: 'ka17', date: env.date });
		expect(handoff).toEqual({
			profileId: 'ka17',
			date: env.date,
			identity: { usb: KA17 },
			readBack: { filters: held.filters },
			needsBandCount: false,
			protocol: { handler: 'fiio-usb-hid', commit: 'abc1234' }
		});
	});

	it('names no profile for a guessed device, and says the protocol is a guess', async () => {
		const { session } = setup();
		await session.connect(hid({ vendorId: '0x2972', productId: '0xffff' }));
		await session.read();
		const { report, handoff } = readHandoff(session.state, env)!;
		expect(report).toMatchObject({ handler: 'fiio-usb-hid', experimental: true });
		expect(report).not.toHaveProperty('profile');
		expect(handoff).not.toHaveProperty('profileId');
	});
});
