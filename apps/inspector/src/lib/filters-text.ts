// Filter lists in the formats people paste: Equalizer APO config text (which AutoEQ's
// ParametricEQ.txt also is) and JSON. Parsing is lenient line by line: every line it can't read
// is reported with its number, and the rest still parse.

import type { Filter, FilterType } from '@potatosalad775/eqcaps-core';

export interface ParsedFilters {
	filters: Filter[];
	preamp: number;
	/** 1-based line numbers for text; for JSON, the filter's index + 1 (0 for the whole input). */
	problems: { line: number; message: string }[];
	/** Filters switched OFF in the text, which are skipped. */
	skipped: number;
}

/** Butterworth Q, which Equalizer APO's LP and HP filters have. */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * Equalizer APO codes to SPEC types (§5.3). LP/HP have a fixed Q; LSQ/HSQ are modernGraphTool's
 * and devicePEQ's names for LSC/HSC (D22).
 */
const TYPES: Record<string, { type: FilterType; q?: number }> = {
	PK: { type: 'PK' },
	PEQ: { type: 'PK' },
	LSC: { type: 'LSC' },
	HSC: { type: 'HSC' },
	LSQ: { type: 'LSC' },
	HSQ: { type: 'HSC' },
	LPQ: { type: 'LPQ' },
	HPQ: { type: 'HPQ' },
	LP: { type: 'LPQ', q: BUTTERWORTH_Q },
	HP: { type: 'HPQ', q: BUTTERWORTH_Q },
	BP: { type: 'BP' },
	NO: { type: 'NO' },
	AP: { type: 'AP' }
};

/** Bandwidth in octaves → Q (RBJ cookbook, for peaking filters). */
export function bandwidthToQ(octaves: number): number {
	const p = Math.pow(2, octaves);
	return Math.sqrt(p) / (p - 1);
}

const NUMBER = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`;
const FILTER_LINE = new RegExp(
	String.raw`^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Z]+)(?:\s+${NUMBER}\s*dB)?\s+(.*)$`,
	'i'
);
const PREAMP_LINE = new RegExp(String.raw`^Preamp\s*:\s*${NUMBER}\s*dB\s*$`, 'i');

function param(rest: string, name: string, unit: string): number | undefined {
	const m = new RegExp(String.raw`\b${name}\s+${NUMBER}\s*${unit}`, 'i').exec(rest);
	return m ? Number(m[1]) : undefined;
}

/** Equalizer APO text. Lines other than Preamp and Filter (comments, Device:, …) are ignored. */
export function parseApo(text: string): ParsedFilters {
	const out: ParsedFilters = { filters: [], preamp: 0, problems: [], skipped: 0 };
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.replace(/#.*$/, '').trim();
		const n = i + 1;
		if (line === '') return;
		const pre = PREAMP_LINE.exec(line);
		if (pre) {
			out.preamp += Number(pre[1]);
			return;
		}
		if (/^GraphicEQ\s*:/i.test(line)) {
			out.problems.push({ line: n, message: 'GraphicEQ lines are curves, not filters: skipped' });
			return;
		}
		if (!/^Filter\b/i.test(line)) return;
		const m = FILTER_LINE.exec(line);
		if (!m) {
			out.problems.push({ line: n, message: 'not a filter line Equalizer APO would read' });
			return;
		}
		const [, state, code, slope, rest = ''] = m;
		if ((state as string).toUpperCase() === 'OFF') {
			out.skipped++;
			return;
		}
		const known = TYPES[(code as string).toUpperCase()];
		if (!known || slope !== undefined) {
			const why =
				slope !== undefined || /^(LS|HS)$/i.test(code as string)
					? 'shelves given by slope are not supported: write LSC/HSC with a Q'
					: `unknown filter type "${code}"`;
			out.problems.push({ line: n, message: why });
			return;
		}
		const freq = param(rest, 'Fc', 'Hz');
		const gain = param(rest, 'Gain', 'dB') ?? 0;
		const bw = param(rest, 'BW\\s+Oct', '');
		const q = param(rest, 'Q', '') ?? (bw !== undefined ? bandwidthToQ(bw) : known.q);
		if (freq === undefined) {
			out.problems.push({ line: n, message: 'no frequency (Fc … Hz)' });
			return;
		}
		if (q === undefined) {
			out.problems.push({ line: n, message: 'no Q (Q … or BW Oct …)' });
			return;
		}
		out.filters.push({ type: known.type, freq, q, gain });
	});
	return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * JSON: an array of filters, or `{ preamp, filters }`. A filter is `{ type, freq, q, gain }`;
 * `fc`/`frequency` stand for `freq`, and `disabled: true` skips it.
 */
export function parseJson(text: string): ParsedFilters {
	const out: ParsedFilters = { filters: [], preamp: 0, problems: [], skipped: 0 };
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		out.problems.push({ line: 0, message: `invalid JSON: ${(e as Error).message}` });
		return out;
	}
	let list: unknown = v;
	if (isObject(v)) {
		if (typeof v.preamp === 'number') out.preamp = v.preamp;
		list = v.filters;
	}
	if (!Array.isArray(list)) {
		out.problems.push({ line: 0, message: 'expected an array of filters, or { filters: [...] }' });
		return out;
	}
	list.forEach((f, i) => {
		if (!isObject(f)) {
			out.problems.push({ line: i + 1, message: 'not an object' });
			return;
		}
		if (f.disabled === true) {
			out.skipped++;
			return;
		}
		const code = typeof f.type === 'string' ? f.type : 'PK';
		const known = TYPES[code.toUpperCase()];
		const type = known?.type ?? (code.startsWith('x-') ? (code as FilterType) : undefined);
		const freq = f.freq ?? f.fc ?? f.frequency;
		const q = f.q ?? f.Q ?? known?.q;
		const gain = f.gain ?? 0;
		if (!type) out.problems.push({ line: i + 1, message: `unknown filter type "${code}"` });
		else if (typeof freq !== 'number' || typeof q !== 'number' || typeof gain !== 'number') {
			out.problems.push({ line: i + 1, message: 'freq, q and gain must be numbers' });
		} else out.filters.push({ type, freq, q, gain });
	});
	return out;
}

/** JSON if it looks like JSON, Equalizer APO text otherwise. */
export function parseFilters(text: string): ParsedFilters {
	return /^\s*[[{]/.test(text) ? parseJson(text) : parseApo(text);
}

const num = (x: number, digits: number) => String(Number(x.toFixed(digits)));

/** Equalizer APO text, readable by Equalizer APO, AutoEQ users and parseApo. */
export function formatApo(filters: readonly Filter[], preamp: number): string {
	const lines = [`Preamp: ${num(preamp, 2)} dB`];
	filters.forEach((f, i) => {
		lines.push(
			`Filter ${i + 1}: ON ${f.type} Fc ${num(f.freq, 2)} Hz Gain ${num(f.gain, 2)} dB Q ${num(f.q, 3)}`
		);
	});
	return lines.join('\n');
}
