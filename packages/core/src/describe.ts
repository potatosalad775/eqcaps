import { isLockedDomain } from './domain.ts';
import { isKnownType } from './filter.ts';
import { engineProfile, type EngineSlot } from './resolve.ts';
import type { Domain, FilterType, Profile, Variant } from './types/schema.generated.ts';

/** Every slot is freq-locked: a graphic EQ (SPEC §5.4). */
export function isGraphic(profile: Profile): boolean {
	return engineProfile(profile).slots.every((s) => isLockedDomain(s.freq));
}

const KNOWN_RULES: ReadonlySet<string> = new Set(['ascendingFrequency', 'minSpacing']);

/**
 * What this engine can't model in a profile written for a newer format minor (SPEC §15). A
 * consumer MUST tell the user about unknown rules (§7), and SHOULD about types.
 */
export function unsupported(profile: Profile): {
	rules: string[];
	types: FilterType[];
} {
	const p = engineProfile(profile);
	const unique = <T>(xs: T[]) => [...new Set(xs)];
	return {
		rules: unique((profile.rules ?? []).map((r) => (r as { type: string }).type)).filter(
			(t) => !KNOWN_RULES.has(t)
		),
		types: unique(p.slots.flatMap((s) => s.types)).filter((t) => !isKnownType(t))
	};
}

// --- Text --------------------------------------------------------------------------------------

/** Plain-English summary of a profile for UIs (English only; apps that localize use the data). */
export interface ProfileDescription {
	/** "12 bands", "Unlimited bands". */
	bands: string;
	graphic: boolean;
	/** Runs of identical slots. */
	groups: SlotGroupDescription[];
	preamp: string;
	rules: string[];
}

export interface SlotGroupDescription {
	/** Slot indices, 0-based. Empty for an unbounded profile's template. */
	slots: number[];
	label?: string;
	types: string;
	freq: string;
	q: string;
	gain: string;
	/** One line per variant: "when gain > 0: freq 200 Hz – 8 kHz". */
	conditions: string[];
}

const TYPE_NAMES: Record<string, string> = {
	PK: 'peaking',
	LSC: 'low shelf',
	HSC: 'high shelf',
	LPQ: 'low-pass',
	HPQ: 'high-pass',
	BP: 'band-pass',
	NO: 'notch',
	AP: 'all-pass'
};

const trim = (x: number) => String(Number(x.toPrecision(6)));

function formatValue(x: number, field: 'freq' | 'q' | 'gain' | 'preamp'): string {
	if (field === 'freq') return x >= 1000 ? `${trim(x / 1000)} kHz` : `${trim(x)} Hz`;
	if (field === 'q') return trim(x);
	return `${x > 0 ? '+' : x < 0 ? '−' : ''}${trim(Math.abs(x))} dB`;
}

/** "20 Hz – 20 kHz", "−12 dB to +12 dB in 0.5 dB steps", "31, 62, 125 Hz", "1.41 (fixed)". */
export function describeDomain(d: Domain, field: 'freq' | 'q' | 'gain' | 'preamp'): string {
	const show = (x: number) => formatValue(x, field);
	if ('value' in d) return `${show(d.value)} (fixed)`;
	if ('values' in d) {
		const shown = d.values.length > 8 ? [...d.values.slice(0, 3), ...d.values.slice(-2)] : d.values;
		const list = shown.map(show);
		if (d.values.length > 8) list.splice(3, 0, '…');
		return `${list.join(', ')} (${d.values.length} values)`;
	}
	const range =
		field === 'freq' || field === 'q'
			? `${show(d.min)} – ${show(d.max)}`
			: `${show(d.min)} to ${show(d.max)}`;
	if (!('step' in d)) return range;
	const step =
		field === 'freq'
			? formatValue(d.step, 'freq')
			: field === 'q'
				? trim(d.step)
				: `${trim(d.step)} dB`;
	return `${range} in ${step} steps`;
}

function describeWhen(v: Variant): string {
	const parts: string[] = [];
	const ops = { eq: '=', gt: '>', gte: '≥', lt: '<', lte: '≤' } as const;
	if (v.when.type?.eq) parts.push(`type is ${TYPE_NAMES[v.when.type.eq] ?? v.when.type.eq}`);
	if (v.when.type?.in)
		parts.push(`type is ${v.when.type.in.map((t) => TYPE_NAMES[t] ?? t).join(' or ')}`);
	for (const f of ['freq', 'q', 'gain'] as const) {
		const c = v.when[f];
		if (!c) continue;
		for (const [op, sym] of Object.entries(ops)) {
			const x = c[op as keyof typeof ops];
			if (x !== undefined) parts.push(`${f} ${sym} ${formatValue(x, f)}`);
		}
	}
	const then = (['freq', 'q', 'gain'] as const).flatMap((f) => {
		const d = v[f];
		return d ? [`${f} ${describeDomain(d, f)}`] : [];
	});
	return `when ${parts.join(' and ')}: ${then.join(', ')}`;
}

function describeSlot(s: EngineSlot, slots: number[]): SlotGroupDescription {
	return {
		slots,
		...(s.label !== undefined && { label: s.label }),
		types: s.types.map((t) => TYPE_NAMES[t] ?? t).join(', '),
		freq: describeDomain(s.freq, 'freq'),
		q: describeDomain(s.q, 'q'),
		gain: describeDomain(s.gain, 'gain'),
		conditions: s.variants.map(describeWhen)
	};
}

export function describe(profile: Profile): ProfileDescription {
	const p = engineProfile(profile);
	const groups: SlotGroupDescription[] = [];
	if (p.bandCount === null) groups.push(describeSlot(p.slots[0] as EngineSlot, []));
	else {
		let prevKey = '';
		p.slots.forEach((s, i) => {
			const key = JSON.stringify([s.label, s.types, s.freq, s.q, s.gain, s.variants]);
			const last = groups[groups.length - 1];
			if (last && key === prevKey) last.slots.push(i);
			else groups.push(describeSlot(s, [i]));
			prevKey = key;
		});
	}

	const pre = profile.preamp;
	const preamp =
		pre.mode === 'manual'
			? `Preamp ${describeDomain(pre.gain, 'preamp')}`
			: pre.mode === 'auto'
				? 'Preamp set by the device'
				: pre.mode === 'none'
					? 'No preamp'
					: 'Preamp unknown';

	const rules = (profile.rules ?? []).map((r) => {
		if (r.type === 'ascendingFrequency') {
			return r.strict === false
				? 'Band frequencies must not decrease from slot to slot'
				: 'Band frequencies must increase from slot to slot';
		}
		if (r.type === 'minSpacing') return `Active filters at least ${trim(r.octaves)} octaves apart`;
		return `Unknown rule "${(r as { type: string }).type}": this app can't check it`;
	});

	return {
		bands:
			p.bandCount === null
				? 'Unlimited bands'
				: `${p.bandCount} band${p.bandCount === 1 ? '' : 's'}`,
		graphic: p.slots.every((s) => isLockedDomain(s.freq)),
		groups,
		preamp,
		rules
	};
}
