// Checked integer encoding shared by the codecs. A value is rounded onto its wire grid, then must
// fit the field; if it doesn't, the codec throws `unrepresentable` rather than clamp it (D33).

import { BridgeError } from './errors.ts';

/** `round(value · scale)` as an integer in [min, max], or `unrepresentable`. */
export function wireInt(value: number, scale: number, min: number, max: number, what: string) {
	const raw = Math.round(value * scale);
	if (!Number.isFinite(raw) || raw < min || raw > max) {
		throw new BridgeError(
			'unrepresentable',
			`${what} ${value} doesn't fit the wire field (${min / scale} to ${max / scale})`
		);
	}
	// Normalises -0, which some fields would otherwise encode differently from 0.
	return raw === 0 ? 0 : raw;
}

export const U8 = [0, 0xff] as const;
export const I8 = [-0x80, 0x7f] as const;
export const U16 = [0, 0xffff] as const;
export const I16 = [-0x8000, 0x7fff] as const;
export const U32 = [0, 0xffffffff] as const;
export const I32 = [-0x80000000, 0x7fffffff] as const;

/** Integer field: rounds `value · scale` and checks it against `range`. */
export function field(
	value: number,
	scale: number,
	range: readonly [number, number],
	what: string
) {
	return wireInt(value, scale, range[0], range[1], what);
}

export const le16 = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff];
export const be16 = (v: number): [number, number] => [(v >> 8) & 0xff, v & 0xff];
export const le32 = (v: number): [number, number, number, number] => [
	v & 0xff,
	(v >>> 8) & 0xff,
	(v >>> 16) & 0xff,
	(v >>> 24) & 0xff
];
export const be32 = (v: number): [number, number, number, number] => [
	(v >>> 24) & 0xff,
	(v >>> 16) & 0xff,
	(v >>> 8) & 0xff,
	v & 0xff
];

const at = (bytes: ArrayLike<number>, i: number) => bytes[i] ?? 0;

export const readU16le = (b: ArrayLike<number>, i: number) => at(b, i) | (at(b, i + 1) << 8);
export const readU16be = (b: ArrayLike<number>, i: number) => (at(b, i) << 8) | at(b, i + 1);
export const readI16le = (b: ArrayLike<number>, i: number) => (readU16le(b, i) << 16) >> 16;
export const readI16be = (b: ArrayLike<number>, i: number) => (readU16be(b, i) << 16) >> 16;
export const readU32le = (b: ArrayLike<number>, i: number) =>
	(at(b, i) | (at(b, i + 1) << 8) | (at(b, i + 2) << 16) | (at(b, i + 3) << 24)) >>> 0;
export const readI32le = (b: ArrayLike<number>, i: number) => readU32le(b, i) | 0;
export const readU32be = (b: ArrayLike<number>, i: number) =>
	((at(b, i) << 24) | (at(b, i + 1) << 16) | (at(b, i + 2) << 8) | at(b, i + 3)) >>> 0;
export const readI8 = (b: ArrayLike<number>, i: number) => (at(b, i) << 24) >> 24;

/** A 32-bit float field: rounded to the nearest float, refused when out of float range. */
export function f32le(value: number, what = 'value'): [number, number, number, number] {
	if (!(Math.abs(value) <= F32_FIELD.max)) {
		throw new BridgeError('unrepresentable', `${what} ${value} doesn't fit a 32-bit float`);
	}
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value, true);
	return [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)];
}

export function readF32le(b: ArrayLike<number>, i: number): number {
	const view = new DataView(new ArrayBuffer(4));
	for (let k = 0; k < 4; k++) view.setUint8(k, at(b, i + k));
	return view.getFloat32(0, true);
}

export function hex(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Float32 values decoded from the wire, rounded to what a float32 field can mean. */
export function tidyF32(v: number): number {
	return Number(v.toPrecision(7));
}

/** The wire field `round(value · scale)` in `range`, as canonical min, max and step. */
export function grid(scale: number, range: readonly [number, number]) {
	return { min: range[0] / scale, max: range[1] / scale, step: 1 / scale };
}

/** A float32 wire field: no grid, float32 range. */
export const F32_FIELD = { min: -3.4028234663852886e38, max: 3.4028234663852886e38 };
