// JDS Labs Element IV: NUL-terminated JSON over USB serial (devicePEQ
// jdsLabsUsbSerialHandler.js, 0BSD, at 0617f38).
//
// Twelve named filters in a fixed order, two low shelves, eight peaking, two high shelves (SPEC
// example B). `{ Product, Action: "Describe" }` returns the configuration; `Action: "Update"`
// writes it and answers `{ Status: true }`. Values are JSON numbers.

import type { Filter, FilterType } from '@potatosalad775/eqcaps-core';
import { BridgeError } from '../errors.ts';
import type { Codec, HandlerContext, StreamHandler, WriteState } from '../handler.ts';
import { refuseUncarried, StreamReader } from '../io.ts';
import { utf8Decode, utf8Encode } from '../platform.ts';
import type { StreamTransport } from '../transport.ts';

const PRODUCT = 'JDS Labs Element IV';
export const JDS_BANDS = [
	'Lowshelf 1',
	'Lowshelf 2',
	'Peaking 1',
	'Peaking 2',
	'Peaking 3',
	'Peaking 4',
	'Peaking 5',
	'Peaking 6',
	'Peaking 7',
	'Peaking 8',
	'Highshelf 1',
	'Highshelf 2'
] as const;

const WIRE_TYPES: Partial<Record<FilterType, string>> = {
	PK: 'PEAKING',
	LSC: 'LOWSHELF',
	HSC: 'HIGHSHELF'
};

function wireType(type: FilterType): string {
	const t = WIRE_TYPES[type];
	if (!t) throw new BridgeError('unsupported-type', `jds-labs has no wire code for type ${type}`);
	return t;
}

const typeOf = (wire: string | undefined): FilterType =>
	(Object.entries(WIRE_TYPES).find(([, w]) => w === wire)?.[0] as FilterType | undefined) ??
	`x-wire-${(wire ?? 'none').toLowerCase()}`;

const json = (value: object) => utf8Encode(JSON.stringify(value) + '\0');

interface Setting<T> {
	Current: T;
}
interface JdsFilter {
	Type?: Setting<string>;
	Frequency: Setting<number>;
	Gain: Setting<number>;
	Q: Setting<number>;
}
interface Describe {
	Configuration?: {
		General?: Record<string, Setting<string> | undefined>;
		DSP?: {
			Headphone?: Record<string, JdsFilter | undefined> & { Preamp?: { Gain?: Setting<number> } };
		};
	};
}
interface Update {
	Configuration: {
		DSP: {
			Headphone: Record<string, { Gain: number; Frequency: number; Q: number; Type: string }>;
		};
	};
}

const ANY = { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };

/** JSON carries any finite number; Infinity and NaN would turn into null. */
function finite(value: number, what: string) {
	if (!Number.isFinite(value))
		throw new BridgeError('unrepresentable', `JDS Labs: ${what} ${value}`);
	return value;
}

export const jdsLabsCodec: Codec<object, Uint8Array> = {
	types: ['PK', 'LSC', 'HSC'],
	wire: () => ({ freq: ANY, q: ANY, gain: ANY, preamp: ANY }),
	encode(request) {
		refuseUncarried('jds-labs-usb-serial', request, { preamp: true });
		const { filters, preamp } = request;
		if (filters.length > JDS_BANDS.length) {
			throw new BridgeError(
				'invalid-request',
				`JDS Labs: ${filters.length} bands, the device has 12`
			);
		}
		const headphone: Record<string, unknown> = {};
		if (preamp !== undefined) headphone.Preamp = { Gain: finite(preamp, 'preamp'), Mode: 'AUTO' };
		filters.forEach((f, i) => {
			headphone[JDS_BANDS[i]!] = {
				Gain: finite(f.gain, 'gain'),
				Frequency: finite(f.freq, 'freq'),
				Q: finite(f.q, 'q'),
				Type: wireType(f.type)
			};
		});
		return [
			json({
				Product: PRODUCT,
				FormatOutput: true,
				Action: 'Update',
				Configuration: { DSP: { Headphone: headphone } }
			})
		];
	},
	decode(frames) {
		const state: WriteState = { filters: [] };
		for (const frame of frames) {
			const hp = (JSON.parse(utf8Decode(frame.subarray(0, -1))) as Update).Configuration.DSP
				.Headphone;
			JDS_BANDS.forEach((name, i) => {
				const f = hp[name];
				if (f) state.filters[i] = { type: typeOf(f.Type), freq: f.Frequency, q: f.Q, gain: f.Gain };
			});
			const pre = (hp as { Preamp?: { Gain: number } }).Preamp;
			if (pre) state.preamp = pre.Gain;
		}
		return state;
	}
};

type Ctx = HandlerContext<StreamTransport, object>;

async function call(ctx: Ctx, frame: Uint8Array): Promise<unknown> {
	const reader = new StreamReader(ctx.transport);
	await reader.send(frame);
	const answer = await reader.readFrame(
		(buf) => {
			const end = buf.indexOf(0);
			return end < 0 ? null : [0, end + 1];
		},
		5000,
		'JDS Labs command'
	);
	try {
		return JSON.parse(utf8Decode(answer.subarray(0, -1)));
	} catch (cause) {
		throw new BridgeError('bad-response', 'JDS Labs: answer is not JSON', { cause });
	}
}

const describe = async (ctx: Ctx) =>
	(await call(ctx, json({ Product: PRODUCT, Action: 'Describe' }))) as Describe;

export const jdsLabsUsbSerial: StreamHandler = {
	id: 'jds-labs-usb-serial',
	transport: 'serial',
	codec: jdsLabsCodec,

	capabilities: () => ({
		canRead: true,
		canWrite: true,
		readsPreamp: true,
		readsSlot: false,
		writesPreamp: true,
		writesSlot: false,
		bands: JDS_BANDS.length,
		needsBandCount: false,
		readsCurrentSlot: true,
		canEnable: false
	}),

	async pull(ctx) {
		const hp = (await describe(ctx)).Configuration?.DSP?.Headphone;
		if (!hp) throw new BridgeError('bad-response', 'JDS Labs: Describe has no DSP settings');
		// Firmware before 12-band support reports fewer filters; the missing ones read as null.
		const filters = JDS_BANDS.map((name): Filter | null => {
			const f = hp[name];
			return f
				? {
						type: typeOf(f.Type?.Current ?? 'PEAKING'),
						freq: f.Frequency.Current,
						q: f.Q.Current,
						gain: f.Gain.Current
					}
				: null;
		});
		const preamp = hp.Preamp?.Gain?.Current;
		return preamp === undefined ? { filters } : { filters, preamp };
	},

	async push(ctx, request) {
		const [frame] = jdsLabsCodec.encode(request, {});
		const answer = (await call(ctx, frame!)) as { Status?: boolean } | null;
		if (answer?.Status !== true)
			throw new BridgeError('rejected', 'JDS Labs: update was not applied');
		return { reconnect: false };
	},

	async currentSlot(ctx) {
		const mode = (await describe(ctx)).Configuration?.General?.['Input Mode']?.Current;
		if (mode === undefined) throw new BridgeError('bad-response', 'JDS Labs: no input mode');
		return mode === 'USB' ? 0 : 1;
	}
};
