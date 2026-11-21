// T1 identify and T2 read as one session (INSPECTOR §2): the device the user chose, the profiles
// it matches, the profile and protocol in use, the open device, the EQ being read and what was
// read. The connect route shows `state` and calls the methods; nothing here touches the page or a
// browser chooser, so a test drives it with a fake device and an index of its own.
//
// The inspector never writes to a device (D40): the session opens one for reading only.

import { eqProfile, type Filter, type IndexEntry, type Profile } from '@potatosalad775/eqcaps-core';
import type { DeviceMatch, MatchResult } from '@potatosalad775/eqcaps-client';
import {
	protocolFor,
	type DeviceIdentity,
	type DeviceReader,
	type HidCollectionInfo,
	type OpenOptions,
	type Protocol,
	type ProtocolChoice,
	type ProtocolEq,
	type PullResult,
	type Transport
} from '@potatosalad775/eqcaps-device-bridge';
import { findingLines, readChannels, type ChannelRead } from './connect.ts';
import { readEvidence, type EvidenceReport } from './evidence.ts';
import type { Handoff } from './handoff.ts';

/**
 * A device the user chose. A HID device is open at once; a serial port or a BLE device opens once
 * the protocol is known, since it sets the baud rate or the GATT layout.
 */
export type Chosen =
	| {
			kind: 'hid';
			identity: DeviceIdentity;
			transport: Transport;
			collections: readonly HidCollectionInfo[];
	  }
	| {
			kind: 'serial' | 'ble';
			identity: DeviceIdentity;
			choice: { open(protocol: Protocol): Promise<Transport> };
	  };

export interface ReadState {
	chosen: Chosen | null;
	/** The profiles the device's identity matches, most specific first. */
	matches: DeviceMatch<IndexEntry>[];
	/** Several match equally well: the user picks. */
	ambiguous: boolean;
	/** The profile the read is checked against: the best match's, or the user's pick; '' for none. */
	profileId: string;
	/** `profileId`'s profile; null without one, and until it has loaded. */
	profile: Profile | null;
	/**
	 * How the device is driven and where that came from (the bridge's `protocolFor`); undefined
	 * when the bridge has no protocol for it.
	 */
	driver: ProtocolChoice | undefined;
	/** The id of the device's other EQ to read (SPEC §9.2); '' for the profile's own. */
	eqId: string;
	/** The other EQ chosen, when the protocol in use lists it. */
	listedEq: ProtocolEq | undefined;
	/** The profile of the EQ being read: `profile`, or that of its listed EQ. */
	eqShown: Profile | null;
	/** Bands to read where neither the protocol nor a profile says how many. */
	bandsWanted: number;
	/**
	 * The protocol can't read, known before any read: a HID protocol's capabilities need no I/O.
	 * (A serial port or a BLE device is opened first.)
	 */
	writeOnly: boolean;
	device: DeviceReader | null;
	pulled: PullResult | null;
	/** The read as channels: one, or the left and the right where the pull returned them apart. */
	channels: ChannelRead[] | null;
}

export interface ReadSessionDeps {
	/** The index's entries, as they are now. */
	entries(): readonly IndexEntry[];
	/** The client's `matchDevice`. */
	match(identity: DeviceIdentity): Promise<MatchResult<IndexEntry>>;
	loadProfile(id: string): Promise<Profile | null>;
	/** The bridge's `openReader`. */
	open(transport: Transport, protocol: Protocol, options?: OpenOptions): DeviceReader;
	/** Called with the new state after every change. */
	onChange?(state: ReadState): void;
}

const EMPTY: ReadState = {
	chosen: null,
	matches: [],
	ambiguous: false,
	profileId: '',
	profile: null,
	driver: undefined,
	eqId: '',
	listedEq: undefined,
	eqShown: null,
	bandsWanted: 10,
	writeOnly: false,
	device: null,
	pulled: null,
	channels: null
};

export class ReadSession {
	#state: ReadState = EMPTY;
	readonly #deps: ReadSessionDeps;

	constructor(deps: ReadSessionDeps) {
		this.#deps = deps;
	}

	/** The state as it is now: a new object after every change, never edited in place. */
	get state(): ReadState {
		return this.#state;
	}

	/** Applies a change, then works out what follows from it. */
	#set(change: Partial<ReadState>): void {
		const s = { ...this.#state, ...change };
		s.listedEq = s.driver?.protocol.eqs?.find((e) => e.id === s.eqId);
		s.eqShown =
			s.profile && s.listedEq ? (eqProfile(s.profile, s.listedEq.id) ?? s.profile) : s.profile;
		s.channels =
			s.pulled && s.device ? readChannels(s.pulled, s.eqShown, s.device.capabilities) : null;
		this.#state = s;
		this.#deps.onChange?.(s);
	}

	/**
	 * The protocol for the device as chosen and matched now. A device opened on another protocol
	 * is let go, to be opened again by the next read: its transport is closed unless it is the HID
	 * device the user chose, which stays open.
	 */
	#drive(change: Partial<ReadState>): void {
		const s = { ...this.#state, ...change };
		const driver = protocolFor({
			chosen: s.profileId ? this.#deps.entries().find((e) => e.id === s.profileId) : null,
			matches: s.matches,
			usbVendorId: s.chosen?.kind === 'hid' ? s.chosen.identity.usb?.vendorId : null
		});
		let writeOnly = false;
		if (s.chosen?.kind === 'hid' && driver) {
			try {
				writeOnly = !this.#deps.open(s.chosen.transport, driver.protocol).capabilities.canRead;
			} catch {
				// A protocol that doesn't run over HID: the read says so.
			}
		}
		const stale = s.device;
		if (stale && s.chosen?.kind !== 'hid') stale.transport.close().catch(() => {});
		this.#set({ ...change, driver, writeOnly, device: null, pulled: null });
	}

	/**
	 * Takes the device the user chose in place of any before it, and matches it against the
	 * database: the unique best match becomes the profile in use.
	 */
	async connect(chosen: Chosen): Promise<void> {
		await this.disconnect();
		this.#drive({ chosen });
		const found = await this.#deps.match(chosen.identity);
		if (this.#state.chosen !== chosen) return;
		this.#set({ matches: found.matches, ambiguous: found.ambiguous });
		await this.pickProfile(found.best?.id ?? '');
	}

	/**
	 * Checks the device against another profile, or none (''). The protocol may be another one, so
	 * what was read is dropped and the device opens again on the next read.
	 */
	async pickProfile(id: string): Promise<void> {
		this.#drive({ profileId: id, profile: null });
		if (!id) return;
		const profile = await this.#deps.loadProfile(id);
		// The user may have picked another while this one loaded.
		if (this.#state.profileId === id) this.#set({ profile });
	}

	/** Reads another of the device's EQs, or the profile's own (''). It holds other values. */
	pickEq(id: string): void {
		this.#set({ eqId: id, pulled: null });
	}

	setBands(bands: number): void {
		this.#set({ bandsWanted: bands });
	}

	/**
	 * Reads the EQ in use. The band count asked for is its profile's, or `bandsWanted` without one
	 * (a protocol that knows its own count ignores it).
	 */
	async read(): Promise<void> {
		const { chosen, driver } = this.#state;
		if (!chosen || !driver) return;
		this.#set({ pulled: null });
		let device = this.#state.device;
		if (!device) {
			const transport =
				chosen.kind === 'hid' ? chosen.transport : await chosen.choice.open(driver.protocol);
			device = this.#deps.open(transport, driver.protocol);
			// Chosen again or driven otherwise while the port opened: this one is nobody's.
			if (this.#state.chosen !== chosen || this.#state.driver !== driver) {
				if (chosen.kind !== 'hid') transport.close().catch(() => {});
				return;
			}
			this.#set({ device });
		}
		const { eqShown, listedEq, bandsWanted } = this.#state;
		const pulled = await device.eq(listedEq?.id).pull({ bands: eqShown?.bandCount ?? bandsWanted });
		if (this.#state.device === device && this.#state.listedEq === listedEq) this.#set({ pulled });
	}

	/** Takes a device reopened elsewhere (a guided read finding it again after an unplug). */
	adopt(device: DeviceReader): void {
		this.#set({ device });
	}

	/** Lets the device go and forgets what was learnt about it. */
	async disconnect(): Promise<void> {
		const { device, chosen, bandsWanted, eqId } = this.#state;
		const open = device?.transport ?? (chosen?.kind === 'hid' ? chosen.transport : null);
		this.#set({ ...EMPTY, bandsWanted, eqId });
		try {
			await open?.close();
		} catch {
			// Already gone.
		}
	}
}

const present = (xs: readonly (Filter | null)[]) => xs.filter((x): x is Filter => x !== null);

/** The filters a read holds, without the bands that are off. */
export const readFilters = (pulled: PullResult): Filter[] => present(pulled.filters);

/**
 * A read as evidence: the report a contributor reviews and sends, and what the editor is handed
 * to start or fix a profile from it. Null until something was read. The evidence file records one
 * channel, the left where the pull returned two.
 */
export function readHandoff(
	state: ReadState,
	env: { date: string; commit: string; userAgent: string }
): {
	report: EvidenceReport;
	handoff: Omit<Handoff, 'evidence' | 'firmware' | 'action' | 'extends'>;
} | null {
	const { pulled, chosen, driver, profileId, profile, channels, device } = state;
	if (!pulled || !chosen || !driver) return null;
	const { protocol } = driver;
	const checked = profileId && profile ? profileId : undefined;
	const first = channels?.[0];
	const report = readEvidence({
		transport: chosen.kind,
		identity: chosen.identity,
		handler: protocol.handler,
		experimental: protocol.experimental === true,
		...(checked ? { profile: checked } : {}),
		pull: pulled,
		findings: first?.findings ? findingLines(first.findings, first.filters) : [],
		commit: env.commit,
		userAgent: env.userAgent,
		date: env.date
	});
	const handoff = {
		...(checked ? { profileId: checked } : {}),
		date: env.date,
		identity: chosen.identity,
		readBack: {
			filters: pulled.filters,
			...(pulled.preamp !== undefined ? { preamp: pulled.preamp } : {})
		},
		needsBandCount: device?.capabilities.needsBandCount ?? true,
		protocol: {
			handler: protocol.handler,
			...(protocol.options ? { options: protocol.options } : {}),
			commit: env.commit
		}
	};
	return { report, handoff };
}
