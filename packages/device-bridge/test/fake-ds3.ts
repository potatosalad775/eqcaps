// A Fosi Audio DS3 simulated from what Fosi's web control center sends and expects back, for
// handler and recording tests.

import type { HidTransport } from '../src/index.ts';

/**
 * A DS3 as Fosi's web app talks to it: every command, output or feature report, is answered on
 * the feature report (with the report id in front, as WebHID gives it). `stuck` ignores writes.
 */
export class FakeDs3 implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId = 0x152a;
	readonly productId = 0x889b;
	readonly productName = 'Fosi Audio DS3';
	readonly collections = [];
	readonly sent: number[] = [];
	firmware = [0x01, 0x05, 0x08];
	values: Record<string, number> = { uacMode: 0, upsample: 0, volume: 20, gainMode: 0, led: 1 };
	stuck?: string;
	readonly presets = new Map([
		[2, { gain: -3, name: 'Rock' }],
		[7, { gain: 0, name: 'MyCurve' }]
	]);
	readonly bands = new Map<string, number[]>();
	private answer = new Uint8Array(63);

	private static readonly CONTROLS: Record<number, [string, 'get' | 'set']> = {
		0x94: ['volume', 'get'],
		0x93: ['volume', 'set'],
		0xa1: ['gainMode', 'get'],
		0xa0: ['gainMode', 'set'],
		0x81: ['upsample', 'get'],
		0x80: ['upsample', 'set'],
		0x9c: ['uacMode', 'get'],
		0x9b: ['uacMode', 'set'],
		0xa5: ['gameMode', 'get'],
		0xa4: ['gameMode', 'set'],
		0x97: ['led', 'get'],
		0x96: ['led', 'set']
	};

	private reply(...data: number[]) {
		this.answer = new Uint8Array(63);
		this.answer.set(data);
	}

	private handle(d: Uint8Array) {
		const cmd = d[1]!;
		this.sent.push(cmd);
		const name = (p: { name: string }) => [...Buffer.from(p.name.padEnd(16, '\0'))];
		const control = FakeDs3.CONTROLS[cmd];
		if (control) {
			const [id, op] = control;
			const lead = id === 'led' ? [d[2]!] : [];
			const at = id === 'led' ? 3 : 2;
			if (op === 'set' && this.stuck !== id) this.values[id] = d[at]!;
			return this.reply(0x77, cmd, ...lead, this.values[id] ?? 0);
		}
		switch (cmd) {
			case 0xa6:
				return this.reply(0x77, cmd, ...this.firmware);
			case 0x91:
				return this.reply(0x77, cmd, 10, 7);
			case 0x8b: {
				const p = this.presets.get(d[2]!) ?? { gain: 0, name: '' };
				return this.reply(
					0x77,
					cmd,
					d[2]!,
					...new Uint8Array(new Int32Array([p.gain]).buffer),
					...name(p)
				);
			}
			case 0x8c: {
				const gain = new DataView(d.buffer, d.byteOffset).getInt32(3, true);
				const label = Buffer.from(d.subarray(7, 23)).toString('utf8').replace(/\0+$/, '');
				this.presets.set(d[2]!, { gain, name: label });
				return this.reply(0x77, cmd, d[2]!);
			}
			case 0x8d:
				this.bands.set(`${d[2]}:${d[3]}`, [...d]);
				return this.reply(0x77, cmd, d[2]!);
			case 0x8e: {
				const band = this.bands.get(`${d[2]}:${d[3]}`);
				if (band) return this.reply(0x77, 0x8e, ...band.slice(2));
				return this.reply(0x77, 0x8e, d[2]!, d[3]!, 2, 0, 0, 0x7a, 0x44, 0, 0, 0x80, 0x3f);
			}
			case 0x9d:
				return this.reply(0x77, cmd, 0, d[2]!);
			case 0x9e:
				return this.reply(0x77, cmd, 1);
			default:
				return this.reply(0x77, cmd);
		}
	}

	async sendReport(_id: number, data: Uint8Array) {
		this.handle(data);
	}
	async sendFeatureReport(_id: number, data: Uint8Array) {
		this.handle(data);
	}
	async receiveFeatureReport(id: number) {
		return Uint8Array.from([id, ...this.answer]);
	}
	onInputReport() {
		return () => {};
	}
	async close() {}
}
