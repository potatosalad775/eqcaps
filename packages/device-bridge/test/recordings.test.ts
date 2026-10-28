// Recordings of vendor web apps (tools/userscripts/, test/recordings/): for each, the handler must
// read the recorded answers as the app did, send the app's writes as the same bytes, and the
// profile must offer what the app read from the device. A synthetic recording, made by an app
// written like Fosi's against the fake DS3, checks the checks.

import { compareFirmware, type Profile } from '@potatosalad775/eqcaps-core';
import { describe, expect, test } from 'vitest';
import { profiles } from './data.ts';
import { FakeDs3 } from './fake-ds3.ts';
import { exchangesOf, loadRecordings, type RecordedEvent, type Recording } from './recording.ts';
import {
	checkData,
	checkReads,
	checkWrites,
	profileFor,
	type FosiState
} from './recording-fosi.ts';

const all = [...profiles.values()];

/** The checks for one snapshot: the profile it picks, then every disagreement. */
async function check(recording: Recording) {
	const out: string[] = [];
	for (const snapshot of recording.snapshots.filter((s) => s.adapter === 'fosi-cc')) {
		const profile = profileFor(recording, snapshot.state as FosiState, all);
		if (typeof profile === 'string') {
			out.push(`${snapshot.label} at ${snapshot.t} ms: ${profile}`);
			continue;
		}
		out.push(...(await checkReads(recording, snapshot, profile)), ...checkData(snapshot, profile));
	}
	return [...out, ...(await checkWrites(recording))];
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

	test('the handler, the data and the app agree, but for the built-in presets', async () => {
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
		const builtIns = Array.from({ length: 7 }, (_, id) =>
			id === 2
				? `preset 2 (Rock) isn't in fosi-audio-ds3`
				: `preset ${id} (no name) isn't in fosi-audio-ds3`
		);
		expect(await check(recording)).toEqual(builtIns);
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

const recordings = loadRecordings();

describe.runIf(recordings.length > 0).each(recordings.map((r) => [r.file, r] as const))(
	'%s',
	(_file, recording) => {
		test('the handler, the data and the vendor app agree', async () => {
			expect(await check(recording)).toEqual([]);
		});
	}
);
