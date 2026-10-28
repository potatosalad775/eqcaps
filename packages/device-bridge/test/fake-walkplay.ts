// A Walkplay device as NICEHCK's web app (app.nicehck.cn) talks to it, simulated from what the app
// sends and expects back, for handler and recording tests.

import type { HidTransport } from '../src/index.ts';

const READ = 0x80;
const WRITE = 0x01;

/** Controls held as one byte, by command. */
const BYTE_CONTROLS: Record<number, string> = {
	0x11: 'dacFilter',
	0x19: 'gainLevel',
	0x1d: 'workMode',
	0x85: 'volume'
};

const s16 = (d: ArrayLike<number>, i: number) => (((d[i]! | (d[i + 1]! << 8)) << 16) >> 16) / 256;
const le16 = (db: number) => {
	const v = Math.round(db * 256) & 0xffff;
	return [v & 0xff, v >> 8];
};

/**
 * Every request is an output report 0x4B; every answer an input report 0x4B that repeats
 * [0x80, cmd]. Band answers carry the band at bytes 27–33, the pre-gain at 34 and the preset at 35,
 * as the app parses them. `stuck` ignores writes to that control.
 */
export class FakeWalkplay implements HidTransport {
	readonly kind = 'hid' as const;
	readonly vendorId = 0x3302;
	readonly productId = 0x4322;
	readonly productName = 'PureAural';
	readonly collections = [];
	/** [op, cmd] of every request: op 0x80 reads, 0x01 writes. */
	readonly sent: [number, number][] = [];
	firmware = '1.0.3';
	preamp = -2;
	values: Record<string, number> = {
		dacFilter: 2,
		gainLevel: 1,
		workMode: 0,
		volume: 60,
		micGain: 3,
		leftGain: 0,
		rightGain: -4
	};
	stuck?: string;
	/** Band index → [freq, q, gain, type code, preset]. */
	readonly bands = new Map<number, [number, number, number, number, number]>([
		[0, [100, 0.75, 3.5, 2, 1]],
		[1, [3000, 2, -1.25, 2, 1]]
	]);
	private readonly listeners = new Set<(reportId: number, data: Uint8Array) => void>();

	private reply(...data: number[]) {
		const answer = new Uint8Array(63);
		answer.set(data);
		for (const l of [...this.listeners]) l(0x4b, Uint8Array.from(answer));
	}

	private band(i: number) {
		const [freq, q, gain, type, preset] = this.bands.get(i) ?? [0, 0, 0, 2, 0];
		const d = new Array(36).fill(0);
		d.splice(0, 5, READ, 0x09, 0, 0, i);
		d.splice(
			27,
			9,
			freq & 0xff,
			freq >> 8,
			...le16(q),
			...le16(gain),
			type,
			this.preamp & 0xff,
			preset
		);
		return d;
	}

	private handle(d: Uint8Array) {
		const [op, cmd] = [d[0]!, d[1]!];
		this.sent.push([op, cmd]);
		const control = BYTE_CONTROLS[cmd];
		if (op === READ) {
			if (control) return this.reply(READ, cmd, 1, this.values[control]!);
			switch (cmd) {
				case 0x0c:
					return this.reply(READ, cmd, 0, ...Buffer.from(this.firmware), 0);
				case 0x09:
					return this.reply(...this.band(d[4]!));
				case 0x03:
					return this.reply(READ, cmd, 2, ...le16(this.preamp));
				case 0x02:
					return this.reply(READ, cmd, 2, ...le16(this.values.micGain!));
				case 0x16: {
					const id = d[3] === 0 ? 'leftGain' : 'rightGain';
					return this.reply(READ, cmd, 4, d[3]!, ...le16(this.values[id]!));
				}
			}
			return;
		}
		if (op !== WRITE) return;
		const set = (id: string, value: number) => {
			if (this.stuck !== id) this.values[id] = value;
		};
		if (control) return set(control, d[3]!);
		switch (cmd) {
			case 0x09:
				this.bands.set(d[4]!, [d[27]! | (d[28]! << 8), s16(d, 29), s16(d, 31), d[33]!, d[35]!]);
				return;
			case 0x03:
				this.preamp = Math.round(s16(d, 3));
				return;
			case 0x02:
				return set('micGain', s16(d, 3));
			case 0x16:
				return set(d[3] === 0 ? 'leftGain' : 'rightGain', s16(d, 4));
		}
	}

	async sendReport(reportId: number, data: Uint8Array) {
		if (reportId === 0x4b) this.handle(data);
	}
	async sendFeatureReport() {}
	async receiveFeatureReport() {
		return new Uint8Array(63);
	}
	onInputReport(listener: (reportId: number, data: Uint8Array) => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}
	async close() {}
}
