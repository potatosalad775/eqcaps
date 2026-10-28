// Recordings of vendor web apps (tools/userscripts/, test/recordings/): for each, the handler must
// read the recorded answers as the app did, send the app's writes as the same bytes, and the
// profile must offer what the app read from the device. A synthetic recording, made by an app
// written like Fosi's against the fake DS3, checks the checks.

import { compareFirmware, type Profile } from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import { profiles } from './data.ts';
import { FakeDs3 } from './fake-ds3.ts';
import {
	deviceAt,
	exchangesOf,
	loadRecordings,
	type RecordedEvent,
	type Recording
} from './recording.ts';
import { FakeWalkplay } from './fake-walkplay.ts';
import * as fosi from './recording-fosi.ts';
import { checkReads, checkWrites, type FosiState } from './recording-fosi.ts';
import * as nicehck from './recording-nicehck.ts';
import type { NicehckState } from './recording-nicehck.ts';

const all = [...profiles.values()];

/** Each vendor app's checks, by the userscript adapter that recorded it. */
const CHECKS: Record<string, typeof fosi | typeof nicehck> = {
	'fosi-cc': fosi,
	'nicehck-app': nicehck
};

/**
 * Apps whose writes are checked but whose snapshots aren't yet: Walkplay's own app sends the band
 * and control frames NICEHCK's does (docs/plans/walkplay.md).
 */
const WRITES_ONLY: Record<string, (recording: Recording) => Promise<string[]>> = {
	'walkplay-peq': nicehck.checkWrites
};

/** The checks for each snapshot: the profile it picks, then every disagreement; then the writes. */
async function check(recording: Recording) {
	const out: string[] = [];
	for (const snapshot of recording.snapshots) {
		if (WRITES_ONLY[snapshot.adapter]) continue;
		const checks = CHECKS[snapshot.adapter];
		if (!checks) {
			out.push(`${snapshot.label} at ${snapshot.t} ms: no checks for adapter ${snapshot.adapter}`);
			continue;
		}
		const state = snapshot.state as FosiState & NicehckState;
		const profile = checks.profileFor(recording, state, all, deviceAt(recording, snapshot.t));
		if (typeof profile === 'string') {
			out.push(`${snapshot.label} at ${snapshot.t} ms: ${profile}`);
			continue;
		}
		out.push(
			...(await checks.checkReads(recording, snapshot, profile)),
			...checks.checkData(snapshot, profile)
		);
	}
	const adapter = recording.snapshots[0]?.adapter;
	const writes = adapter ? (CHECKS[adapter]?.checkWrites ?? WRITES_ONLY[adapter]) : undefined;
	return [...out, ...(writes ? await writes(recording) : [])];
}

/**
 * Talks to a device as Fosi's web app does: each command an output report, its answer read from
 * the feature report, logged as the userscript logs them. Decodes the answers on its own, into
 * the app's store layout.
 */
class FosiLikeApp {
	readonly events: RecordedEvent[] = [];
	private t = 0;
	private readonly device: FakeDs3;
	constructor(device: FakeDs3) {
		this.device = device;
	}

	private log(op: RecordedEvent['op'], data: Uint8Array) {
		const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
		this.events.push({ t: ++this.t, device: 0, op, reportId: 1, data: hex });
	}

	async send(cmd: number, fill: (v: DataView, b: Uint8Array) => void = () => {}) {
		const packet = new Uint8Array(63);
		packet.set([0x77, cmd]);
		fill(new DataView(packet.buffer), packet);
		await this.device.sendReport(1, packet);
		this.log('output', packet);
		const answer = await this.device.receiveFeatureReport(1);
		this.log('feature-in', answer);
		const d = answer[0] === 1 && answer[1] === 0x77 ? answer.subarray(1) : answer;
		return new DataView(d.buffer, d.byteOffset, d.byteLength);
	}

	async readAll(): Promise<FosiState> {
		const bcd = (b: number) => (b >> 4) * 10 + (b & 15);
		const fw = await this.send(0xa6);
		const firmwareVersion = [2, 3, 4].map((i) => bcd(fw.getUint8(i))).join('.');
		const count = await this.send(0x91);
		const total = count.getUint8(2);
		const predefined = count.getUint8(3);
		const eqModeInfo: NonNullable<FosiState['eqModeInfo']> = [];
		for (let index = 0; index < total; index++) {
			const m = await this.send(0x8b, (v) => v.setUint8(2, index));
			const name = new Uint8Array(m.buffer, m.byteOffset + 7, 16);
			const bandList = [];
			const bands =
				index < predefined ? 8 : compareFirmware(firmwareVersion, '1.4.15') >= 0 ? 32 : 8;
			for (let band = 0; band < bands; band++) {
				const b = await this.send(0x8e, (v) => (v.setUint8(2, index), v.setUint8(3, band)));
				bandList.push({
					bandIndex: b.getUint8(3),
					filterType: b.getUint8(4),
					centerFreq: b.getFloat32(5, true),
					q: b.getFloat32(9, true),
					gain: b.getFloat32(17, true)
				});
			}
			eqModeInfo.push({
				index,
				gain: m.getInt32(3, true),
				nameRaw: new TextDecoder().decode(name).replace(/\0+$/, ''),
				bandList
			});
		}
		const byte = async (cmd: number, at = 2, lead?: number) =>
			(await this.send(cmd, (v) => lead !== undefined && v.setUint8(2, lead))).getUint8(at);
		return {
			firmwareVersion,
			eqModeCount: { total, predefined },
			eqModeInfo,
			volume: await byte(0x94),
			gainMode: await byte(0xa1),
			filterMode: await byte(0xa3),
			gameMode: await byte(0xa5),
			upsampleEnable: (await byte(0x81)) === 1,
			currentUacMode: await byte(0x9c),
			ledSwitch: await byte(0x97, 3, 0)
		};
	}

	recording(snapshots: Recording['snapshots']): Recording {
		return {
			file: 'synthetic',
			recording: 'eqcaps-webhid',
			version: 1,
			recordedAt: '2026-10-28T00:00:00.000Z',
			page: { origin: 'https://cc.fosiaudio.com', path: '/ds3' },
			devices: [{ vendorId: 0x152a, productId: 0x889b, productName: 'Fosi Audio DS3' }],
			snapshots,
			events: this.events
		};
	}
}

describe('the checks, on a synthetic recording', () => {
	async function recorded(edit?: (app: FosiLikeApp) => Promise<void>) {
		const app = new FosiLikeApp(new FakeDs3());
		await edit?.(app);
		const state = await app.readAll();
		return app.recording([{ t: 1e9, label: 'read all', adapter: 'fosi-cc', state }]);
	}

	test('exchanges pair each request with the answers that follow it', async () => {
		const x = exchangesOf(await recorded());
		expect(x[0]!.request.slice(0, 2)).toEqual(Uint8Array.from([0x77, 0xa6]));
		expect(x[0]!.answers).toHaveLength(1);
		expect(x.every((e) => e.answers.length === 1 && !e.feature)).toBe(true);
	});

	test('the handler, the data and the app agree', async () => {
		const recording = await recorded(async (app) => {
			// Writes as the app makes them: a band (bandwidth 1), a pre-gain with the name, controls.
			await app.send(0x8d, (v) => {
				[7, 0, 2].forEach((b, i) => v.setUint8(2 + i, b));
				v.setFloat32(5, 120, true);
				v.setFloat32(9, 0.71, true);
				v.setFloat32(13, 1, true);
				v.setFloat32(17, 4.5, true);
			});
			await app.send(0x8c, (v, b) => {
				v.setUint8(2, 7);
				v.setInt32(3, -6, true);
				b.set(new TextEncoder().encode('MyCurve'), 7);
			});
			await app.send(0x93, (v) => v.setUint8(2, 33));
			await app.send(0x96, (v) => (v.setUint8(2, 0), v.setUint8(3, 0)));
		});
		expect(await check(recording)).toEqual([]);
	});

	test('a write the handler would send differently is reported', async () => {
		const recording = await recorded(async (app) => {
			await app.send(0x96, (v) => (v.setUint8(2, 5), v.setUint8(3, 1)));
		});
		expect(await checkWrites(recording)).toEqual([
			expect.stringMatching(/^write 0x96 at \d+ ms: byte 2 is 5 from the app, 0 from the handler$/)
		]);
	});

	test('a read the handler decodes differently is reported', async () => {
		const recording = await recorded();
		const state = recording.snapshots[0]!.state as FosiState;
		state.volume = 21;
		state.eqModeInfo![7]!.bandList![0]!.gain = 1;
		const profile = profiles.get('fosi-audio-ds3') as Profile;
		expect(await checkReads(recording, recording.snapshots[0]!, profile)).toEqual([
			'preset 7 band 0: the handler reads PK 1000 Hz Q 1 0 dB, the app PK 1000 Hz Q 1 1 dB',
			'control volume: the handler reads 20, the app 21'
		]);
	});
});

/** A peaking biquad as NICEHCK's app computes it: RBJ, normalised, [b0, b1, b2, -a1, -a2]. */
function appCoefficients(freq: number, gain: number, q: number, rate = 96000) {
	const w = (2 * Math.PI * freq) / rate;
	const a = Math.sqrt(10 ** (gain / 20));
	const alpha = Math.sin(w) / (2 * q);
	const a0 = 1 + alpha / a;
	return [1 + alpha * a, -2 * Math.cos(w), 1 - alpha * a, 2 * Math.cos(w), -(1 - alpha / a)].map(
		(c) => Math.round((c / a0) * 2 ** 30)
	);
}

const s16 = (v: DataView, at: number) => v.getInt16(at, true) / 256;
const db16 = (db: number) => {
	const v = Math.round(db * 256) & 0xffff;
	return [v & 0xff, v >> 8];
};

/**
 * Talks to a device as NICEHCK's web app does: output reports 0x4B, answers as input reports,
 * logged as the userscript logs them. Decodes the answers on its own, into the app's store layout.
 */
class NicehckLikeApp {
	readonly events: RecordedEvent[] = [];
	readonly state: NicehckState = {
		firmwareVersion: '0',
		offset: 0,
		bands: [],
		micGainDb: 0,
		channelBalance: 0,
		equalizerSetting: {
			minFrequency: 20,
			maxFrequency: 20000,
			frequencyNumber: 10,
			minGain: -12,
			maxGain: 12,
			minQValue: 0.2,
			maxQValue: 12,
			minOffset: -12,
			maxOffset: 8
		},
		capabilities: {
			equalizer: true,
			digitalFilter: true,
			gainLevel: true,
			workMode: true,
			microphoneGain: true,
			channelBalance: true,
			deviceVolume: true
		}
	};
	private t = 0;
	private readonly device: FakeWalkplay;
	constructor(device: FakeWalkplay) {
		this.device = device;
		device.onInputReport((_reportId, data) => {
			this.log('input', data);
			this.decode(new DataView(data.buffer, data.byteOffset, data.byteLength));
		});
	}

	private log(op: RecordedEvent['op'], data: Uint8Array) {
		const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
		this.events.push({ t: ++this.t, device: 0, op, reportId: 0x4b, data: hex });
	}

	private decode(v: DataView) {
		if (v.getUint8(0) !== 0x80) return;
		const s = this.state;
		const byte = v.getUint8(3);
		switch (v.getUint8(1)) {
			case 0x0c: {
				// Byte 2 as the length, as the app takes it.
				let text = '';
				for (let i = 3; i < 3 + v.getUint8(2) && v.getUint8(i) !== 0; i++) {
					text += String.fromCharCode(v.getUint8(i));
				}
				s.firmwareVersion = text.replace(/[^0-9.]/g, '');
				return;
			}
			case 0x09: {
				const id = v.getUint8(4);
				s.bands![id] = {
					id,
					frequency: v.getUint16(27, true),
					qValue: Number(s16(v, 29).toFixed(2)),
					gain: Number(s16(v, 31).toFixed(2))
				};
				s.eqIndex = v.getUint8(35);
				return;
			}
			case 0x03:
				s.offset = Math.round(s16(v, 3));
				return;
			case 0x11:
				s.tkFilterTypeIndex = { value: byte };
				return;
			case 0x19:
				s.gainLevel = byte;
				return;
			case 0x1d:
				s.workMode = byte;
				return;
			case 0x85:
				s.deviceVolume = byte;
				return;
			case 0x02:
				s.micGainDb = s16(v, 3);
				return;
			case 0x16: {
				const cut = Math.round(s16(v, 4));
				if (cut !== 0) s.channelBalance = byte === 0 ? -cut : cut;
				return;
			}
		}
	}

	async send(...data: number[]) {
		const report = Uint8Array.from(data);
		this.log('output', report);
		await this.device.sendReport(0x4b, report);
	}

	async readAll() {
		await this.send(0x80, 0x0c);
		for (let i = 0; i < 10; i++) await this.send(0x80, 0x09, 0, 0, i);
		for (const cmd of [0x03, 0x11, 0x19, 0x1d, 0x85, 0x02]) await this.send(0x80, cmd);
		await this.send(0x80, 0x16, 4, 0);
		await this.send(0x80, 0x16, 4, 1);
		return structuredClone(this.state);
	}

	/** A band write as the app makes it: its own coefficients, the pre-gain at 34, the preset at 35. */
	async writeBand(index: number, freq: number, gain: number, q: number, preset = 32, offset = 0) {
		const d = new Array(36).fill(0);
		d.splice(0, 5, 0x01, 0x09, 33, 0, index);
		appCoefficients(freq, gain, q).forEach((c, i) => {
			d.splice(7 + i * 4, 4, c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, (c >> 24) & 0xff);
		});
		d.splice(27, 9, freq & 0xff, freq >> 8, ...db16(q), ...db16(gain), 2, offset & 0xff, preset);
		await this.send(...d);
	}

	recording(snapshots: Recording['snapshots']): Recording {
		return {
			file: 'synthetic',
			recording: 'eqcaps-webhid',
			version: 1,
			recordedAt: '2026-10-28T00:00:00.000Z',
			page: { origin: 'https://app.nicehck.cn', path: '/device' },
			devices: [{ vendorId: 0x3302, productId: 0x4322, productName: 'NICEHCK PureAural' }],
			snapshots,
			events: this.events
		};
	}
}

describe('the NICEHCK checks, on a synthetic recording', () => {
	async function recorded(
		edit?: (app: NicehckLikeApp) => Promise<void>,
		device = new FakeWalkplay()
	) {
		const app = new NicehckLikeApp(device);
		await edit?.(app);
		const state = await app.readAll();
		return app.recording([{ t: 1e9, label: 'read all', adapter: 'nicehck-app', state }]);
	}

	test('the handler, the data and the app agree', async () => {
		const recording = await recorded(async (app) => {
			await app.writeBand(0, 120, 4.5, 0.71, 32, -3);
			await app.writeBand(1, 8000, -2.25, 3);
			await app.send(0x01, 0x85, 1, 40);
			await app.send(0x01, 0x02, 2, ...db16(-6));
			await app.send(0x01, 0x16, 4, 1, ...db16(-7));
		});
		expect(await check(recording)).toEqual([]);
	});

	test('a write the handler would send differently is reported', async () => {
		const recording = await recorded(async (app) => {
			await app.send(0x01, 0x85, 2, 40);
		});
		expect(await nicehck.checkWrites(recording)).toEqual([
			expect.stringMatching(/^write 0x85 at \d+ ms: byte 2 is 2 from the app, 1 from the handler$/)
		]);
	});

	test('a read the handler decodes differently is reported', async () => {
		// A mic gain of 0 leaves byte 4 of the 0x16 answers at 0, so the balance is compared.
		const device = new FakeWalkplay();
		device.values.micGain = 0;
		const recording = await recorded(undefined, device);
		const state = recording.snapshots[0]!.state as NicehckState;
		state.deviceVolume = 61;
		state.bands![1]!.gain = -1;
		state.channelBalance = 3;
		const profile = profiles.get('nicehck-pureaural') as Profile;
		expect(await nicehck.checkReads(recording, recording.snapshots[0]!, profile)).toEqual([
			'band 1: the handler reads PK 3000 Hz Q 2 -1.25 dB, the app PK 3000 Hz Q 2 -1 dB',
			'control volume: the handler reads 60, the app 61',
			'control leftGain: the handler reads 0, the app -3',
			'control rightGain: the handler reads -4, the app 0'
		]);
	});

	test('the data is checked against the app config', async () => {
		const recording = await recorded();
		const state = recording.snapshots[0]!.state as NicehckState;
		state.equalizerSetting!.maxGain = 15;
		delete state.capabilities!.workMode;
		const profile = profiles.get('nicehck-pureaural') as Profile;
		expect(nicehck.checkData(recording.snapshots[0]!, profile)).toEqual([
			'gain: the app allows -12 to 15, nicehck-pureaural -12 to 12',
			"control workMode is in nicehck-pureaural, the app doesn't offer it"
		]);
	});
});

const recordings = loadRecordings();

describe.runIf(recordings.length > 0).each(recordings.map((r) => [r.file, r] as const))(
	'%s',
	(_file, recording) => {
		test('the handler, the data and the vendor app agree', async () => {
			expect(await check(recording)).toEqual([]);
		});
	}
);
