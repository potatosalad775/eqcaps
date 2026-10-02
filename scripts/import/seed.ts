// One-off seed import (PLAN Phase 3, DECISIONS D23, D26, D31). Reads upstream devicePEQ (0BSD),
// facts from modernGraphTool and AutoEQ transcribed in tables.ts, and writes draft profiles to
// data/. After the import, data/ is maintained by hand: this script refuses to overwrite it
// unless given --force.
//
// Usage: node scripts/import/seed.ts [--devicepeq ../devicePEQ] [--force]
//
// Only devicePEQ's own files are read: devicePEQ/*.js configs and handlers, and
// tests/captures/*.json. Never fiio-js-capture/, walkplayJS/, walkplayPreprocessor/, Q5K/ or
// bluetooth_tools/ (D25).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { format, resolveConfig } from 'prettier';
import { brandSlug } from '../../packages/build/src/layout.ts';
import type {
	BluetoothMatch,
	Domain,
	FilterType,
	Preamp,
	Realization,
	Source,
	UsbMatch
} from '../../packages/core/src/index.ts';
import {
	AUTOEQ_ENGINES,
	CODECS,
	HID_DEVICES,
	MGT_DEVICES,
	NOT_IMPORTED,
	SERIAL_DEVICES,
	type Codec,
	type DeviceName
} from './tables.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DATE = '2026-10-02';
const MGT_COMMIT = 'fd55b9f8fdf6ac2c080aaf6fb59dab584c5dfe93';
const AUTOEQ_COMMIT = '7ae0f56d53074872b028649617a22bbb4232feb7';

/* eslint-disable @typescript-eslint/no-explicit-any -- upstream config objects are untyped */
type Cfg = Record<string, any>;

// --- Upstream ------------------------------------------------------------------------------------

/** Evaluates a devicePEQ config module with its handler imports replaced by `{ file }` stubs. */
async function loadConfigModule(path: string, names: string[]): Promise<Cfg> {
	const src = readFileSync(path, 'utf8')
		.replace(
			/const\s*\{\s*(\w+)\s*\}\s*=\s*await import\(['"]\.\/([\w.]+)['"]\);/g,
			(_m, name: string, file: string) => `const ${name} = { file: ${JSON.stringify(file)} };`
		)
		.replace(/^export\s+/gm, '');
	const script = new vm.Script(`(async () => {\n${src}\nreturn { ${names.join(', ')} };\n})()`);
	return (await script.runInNewContext({ console, Map, Object })) as Cfg;
}

const hex = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

interface Capture {
	file: string;
	vendorId?: number;
	productId?: number;
	productName: string;
}

// --- Domains -------------------------------------------------------------------------------------

const tidy = (x: number) => Number(x.toPrecision(12));

/** A range on a wire grid, bounds moved inward onto the grid (SPEC §4). */
function onGrid(min: number, max: number, step?: number): Domain {
	if (!step) return { min, max };
	const lo = Math.ceil(tidy(min / step));
	const hi = Math.floor(tidy(max / step));
	return { min: tidy(lo * step), max: tidy(hi * step), step };
}

interface Constraints {
	minGain: number;
	maxGain: number;
	maxFilters: number;
	minQ: number;
	maxQ: number;
	ls: boolean;
	hs: boolean;
	lp: boolean;
	hp: boolean;
	bp: boolean;
	notch: boolean;
	allPass: boolean;
	deviceHandlesPregain: boolean;
}

function constraintsOf(c: Cfg): Constraints {
	return {
		minGain: c.minGain,
		maxGain: c.maxGain,
		maxFilters: c.maxFilters,
		minQ: c.minQ ?? 0.1,
		maxQ: c.maxQ ?? 10,
		ls: !!c.supportsLSFilter,
		hs: !!c.supportsHSFilter,
		lp: !!(c.supportsLPFilter ?? c.supportsLPHPFilters),
		hp: !!(c.supportsHPFilter ?? c.supportsLPHPFilters),
		bp: !!c.supportsBPFilter,
		notch: !!c.supportsNotchFilter,
		allPass: !!c.supportsAllPassFilter,
		deviceHandlesPregain: !!c.deviceHandlesPregain
	};
}

const typesOf = (c: Constraints): FilterType[] =>
	(
		[
			['PK', true],
			['LSC', c.ls],
			['HSC', c.hs],
			['LPQ', c.lp],
			['HPQ', c.hp],
			['BP', c.bp],
			['NO', c.notch],
			['AP', c.allPass]
		] as const
	)
		.filter(([, on]) => on)
		.map(([t]) => t);

interface Compensation {
	qCompensation?: Cfg;
	freqCompensation?: Cfg;
	shelfCompensation?: Cfg;
	compensate2X?: boolean;
}

/** The parts of a published profile the importer computes. */
interface Body {
	bandCount: number;
	band: Record<string, unknown>;
	bands?: Record<string, unknown>[];
	realization?: Realization;
	preamp: Preamp;
}

function body(
	codec: Codec,
	c: Constraints,
	comp: Compensation,
	notes: string[],
	freqValues?: number[]
): Body {
	const types = typesOf(c);
	let freqStep = codec.freqStep;
	const ratio = comp.freqCompensation?.model === 'ratio' ? comp.freqCompensation.factor : null;
	const factor = ratio ?? (comp.compensate2X && !comp.freqCompensation ? 2 : 1);
	if (factor !== 1) {
		freqStep = (freqStep ?? 1) * factor;
		notes.push(
			`The engine realizes ${factor} × the frequency on the wire, so frequencies are multiples of ${tidy(freqStep)} Hz; the codec divides by ${factor}.`
		);
	}
	const [gMin, gMax] = codec.gain
		? [Math.max(c.minGain, codec.gain[0]), Math.min(c.maxGain, codec.gain[1])]
		: [c.minGain, c.maxGain];
	const [qMin, qMax] = codec.q
		? [Math.max(c.minQ, codec.q[0]), Math.min(c.maxQ, codec.q[1])]
		: [c.minQ, c.maxQ];
	const band = {
		types,
		freq: freqValues ? { values: freqValues } : onGrid(20, 20000, freqStep),
		q: onGrid(qMin, qMax, codec.qStep),
		gain: onGrid(gMin, gMax, codec.gainStep)
	};

	let preamp: Preamp = { mode: 'unknown' };
	const wire = codec.preampDomain;
	if (codec.preamp === 'ignores') preamp = { mode: 'none' };
	else if (c.deviceHandlesPregain) preamp = { mode: 'auto' };
	else if (codec.preamp === 'writes' && wire) {
		const gain =
			wire === 'gain' ? onGrid(gMin, gMax, codec.gainStep) : onGrid(wire.min, wire.max, wire.step);
		preamp = { mode: 'manual', gain };
	}

	const laws: Realization['laws'] = [];
	const within = <T extends string>(all: readonly T[]) =>
		all.filter((t) => (types as string[]).includes(t));
	const q = comp.qCompensation;
	if (q?.model === 'rbjGain') {
		// FiiO measured the law on peaking filters only and limits it to them.
		const scope = codec.family === 'fiio' ? (['PK'] as const) : (['PK', 'LSC', 'HSC'] as const);
		laws.push({ law: 'gainScaledQ', types: within(scope) });
	} else if (q?.model === 'cosNyquist') {
		laws.push({
			law: 'nyquistScaledQ',
			types: within(['PK', 'LSC', 'HSC']),
			designRate: q.designFs
		});
		notes.push(
			`devicePEQ configures nyquistScaledQ with a design rate of ${q.designFs} Hz, while its own comments derive about 49152 Hz from measurements. Unresolved upstream.`
		);
	} else if (q) throw new Error(`unmapped qCompensation ${JSON.stringify(q)}`);
	const f = comp.freqCompensation;
	if (f?.model === 'shelfSqrtA') {
		laws.push({
			law: 'shelfFrequencyShift',
			types: within(['LSC', 'HSC']),
			designRate: f.fs ?? 48000
		});
	} else if (f && f.model !== 'ratio') throw new Error(`unmapped freqCompensation ${f.model}`);
	if (comp.shelfCompensation?.model === 'peakingAlpha') {
		notes.push(
			"devicePEQ's peakingAlpha shelf setting is not a law here: it converts its own slope convention to the Q this engine takes, which is exact RBJ Q (prior-art §2.1)."
		);
	}
	const kept = laws.filter((l) => l.types.length > 0);
	return {
		bandCount: c.maxFilters,
		band,
		preamp,
		...(kept.length > 0
			? {
					realization: {
						laws: kept,
						sources: [
							{
								kind: 'community',
								ref: `${dpqUrl}devicePEQ/compensation.js`,
								date: DATE
							}
						]
					} as Realization
				}
			: {})
	};
}

// --- Specs ---------------------------------------------------------------------------------------

interface Spec {
	id: string;
	name: DeviceName;
	codecFile: string;
	ref?: string;
	refConstraints?: Constraints;
	body: Body;
	usb: UsbMatch[];
	bluetooth: BluetoothMatch[];
	sources: Source[];
	notes: string[];
}

let dpq = '';
let dpqUrl = '';
const report: string[] = [];

const slug = (s: string) => brandSlug(s);
const idOf = (n: DeviceName) => n.id ?? `${slug(n.brand)}-${slug(n.model)}`;

/** `peq10Band12dBFullShelves` → `peq-10-band-12db-full-shelves`. */
function shapeId(ref: string): string {
	return ref
		.replace(/(\d+)Band/g, '-$1-band-')
		.replace(/(\d+)dB/g, '$1db-')
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.replace(/(\D)(\d+)$/, '$1-$2')
		.toLowerCase()
		.replace(/-+/g, '-')
		.replace(/-$/, '');
}

const dedupe = <T>(list: T[]) => {
	const seen = new Set<string>();
	return list.filter((x) => {
		const k = JSON.stringify(x);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
};

async function collect(): Promise<Spec[]> {
	const dir = join(dpq, 'devicePEQ');
	const registry = JSON.parse(readFileSync(join(dir, 'peqConstraintsConfig.json'), 'utf8'))
		.constraints as Record<string, Cfg>;
	const { usbHidDeviceHandlerConfig: hid } = await loadConfigModule(
		join(dir, 'usbDeviceConfig.js'),
		['usbHidDeviceHandlerConfig']
	);
	const { usbSerialDeviceHandlerConfig: serial } = await loadConfigModule(
		join(dir, 'usbSerialDeviceConfig.js'),
		['usbSerialDeviceHandlerConfig']
	);
	const { bluetoothBleDeviceHandlerConfig: ble } = await loadConfigModule(
		join(dir, 'bluetoothBleDeviceConfig.js'),
		['bluetoothBleDeviceHandlerConfig']
	);
	const captures: Capture[] = readdirSync(join(dpq, 'tests/captures'))
		.filter((f) => f.endsWith('.json'))
		.map((f) => ({
			file: f,
			...(JSON.parse(readFileSync(join(dpq, 'tests/captures', f), 'utf8')).device as Cfg)
		})) as Capture[];

	const resolveConstraints = (cfg: Cfg): { ref?: string; c: Constraints; raw?: Constraints } => {
		const ref = cfg.peqConstraintsRef as string | undefined;
		if (!ref) return { c: constraintsOf(cfg) };
		const entry = registry[ref];
		if (!entry) throw new Error(`unknown peqConstraintsRef ${ref}`);
		return {
			ref,
			raw: constraintsOf(entry.peqConstraints),
			c: constraintsOf({ ...entry.peqConstraints, ...(cfg.peqConstraintsOverride ?? {}) })
		};
	};
	const configUrl = (file: string) => `${dpqUrl}devicePEQ/${file}`;
	const captureUrl = (file: string) => `${dpqUrl}tests/captures/${file}`;

	const specs: Spec[] = [];
	const add = (spec: Spec) => {
		const prior = specs.find((s) => s.id === spec.id);
		if (!prior) return void specs.push(spec);
		// The same product-id group appears under two vendor blocks: one profile, more entries.
		if (JSON.stringify(prior.body) !== JSON.stringify(spec.body)) {
			throw new Error(`${spec.id}: two definitions with different constraints`);
		}
		prior.usb = dedupe([...prior.usb, ...spec.usb]);
	};

	const make = (
		id: string,
		name: DeviceName,
		codecFile: string,
		cfg: Cfg,
		notes: string[],
		extra: {
			usb?: UsbMatch[];
			bluetooth?: BluetoothMatch[];
			sources: Source[];
			freqValues?: number[];
		}
	): Spec => {
		const codec = CODECS[codecFile];
		if (!codec) throw new Error(`${id}: no codec for ${codecFile}`);
		const { ref, c, raw } = resolveConstraints(cfg);
		if (cfg.peqConstraintsOverride) {
			notes.push(
				`devicePEQ overrides its shared constraints with ${JSON.stringify(cfg.peqConstraintsOverride)}.`
			);
		}
		if (cfg.experimental) notes.push('devicePEQ marks this device experimental.');
		const flags = {
			...(ref ? registry[ref]?.peqConstraints : cfg),
			...(cfg.peqConstraintsOverride ?? {})
		};
		if (flags.supportsBandStopFilter || flags.supportsConstantQFilter) {
			notes.push(
				'devicePEQ also lists band-stop and constant-Q peaking filters. Band-stop is the notch (NO); constant-Q peaking has no code in the format.'
			);
		}
		const comp: Compensation = {
			qCompensation: cfg.qCompensation,
			freqCompensation: cfg.freqCompensation,
			shelfCompensation: cfg.shelfCompensation,
			compensate2X: cfg.compensate2X
		};
		return {
			id,
			name,
			codecFile,
			...(ref ? { ref, refConstraints: raw } : {}),
			body: body(codec, c, comp, notes, extra.freqValues),
			usb: dedupe(extra.usb ?? []),
			bluetooth: extra.bluetooth ?? [],
			sources: extra.sources,
			notes
		};
	};

	// USB HID: vendor blocks with named devices and product-id groups.
	const claimedPids = new Map<object, Set<number>>();
	for (const block of hid as Cfg[]) {
		const vids: number[] = block.vendorIds;
		const groups = Object.entries((block.deviceGroups ?? {}) as Record<string, Cfg>);
		const groupOfPid = (pid: number | undefined) =>
			pid === undefined
				? undefined
				: groups.find(([, g]) =>
						[...(g.productIds ?? []), ...(g.additionalProductIds ?? [])].includes(pid)
					);
		const claimed = new Set<number>();
		claimedPids.set(block, claimed);

		for (const [key, group] of groups) {
			const name = HID_DEVICES[key];
			const pids = [...(group.productIds ?? []), ...(group.additionalProductIds ?? [])] as number[];
			if (!name) {
				report.push(`skipped group ${key}: not in tables.ts`);
				continue;
			}
			const own = pids.filter((p) => !claimed.has(p));
			const taken = pids.length - own.length;
			own.forEach((p) => claimed.add(p));
			const notes = [
				`Every product id devicePEQ assigns to its "${key}" group, under each vendor id of the vendor block (${vids.map(hex).join(', ')}). devicePEQ doesn't record which vendor id goes with which product id, so most of these pairs don't exist. Replace with device profiles as devices are identified.`
			];
			if (taken > 0) {
				notes.push(
					`${taken} product id(s) of this group also appear in an earlier group, which devicePEQ checks first; they match that group's profile.`
				);
			}
			if (name.notes) notes.push(name.notes);
			const cfg = { ...block.defaultModelConfig, ...group.modelConfig };
			add(
				make(idOf(name), name, (group.handler ?? block.handler).file, cfg, notes, {
					usb: vids.flatMap((v) => own.map((p) => ({ vendorId: hex(v), productId: hex(p) }))),
					sources: [{ kind: 'handler-code', ref: configUrl('usbDeviceConfig.js'), date: DATE }]
				})
			);
		}

		const devices = (block.devices ?? {}) as Record<string, Cfg>;
		const variants = new Set(Object.values(HID_DEVICES).flatMap((n) => n.also ?? []));
		const mgtHere = Object.entries(MGT_DEVICES).filter(([, m]) =>
			groups.some(([g]) => g === m.group)
		);
		const entries: [string, Cfg | undefined, DeviceName][] = [
			...Object.keys(devices)
				.filter((k) => !variants.has(k))
				.map((k): [string, Cfg | undefined, DeviceName] => [
					k,
					devices[k],
					HID_DEVICES[k] as DeviceName
				]),
			...mgtHere.map(([k, m]): [string, Cfg | undefined, DeviceName] => [k, undefined, m])
		];
		for (const [key, device, name] of entries) {
			if (!name) {
				if (!NOT_IMPORTED[key]) report.push(`skipped device "${key}": not in tables.ts`);
				continue;
			}
			const mgt = MGT_DEVICES[key];
			const keys = [key, ...(name.also ?? [])];
			const names = [...keys, ...(name.names ?? [])];
			const caps = captures.filter(
				(c) => c.vendorId !== undefined && names.includes(c.productName)
			);
			const configKey = name.config ?? key;
			const model = mgt ? {} : (devices[configKey] ?? device ?? {});
			const group = mgt
				? groups.find(([g]) => g === mgt.group)
				: groupOfPid(caps.find((c) => vids.includes(c.vendorId as number))?.productId);
			const cfg = {
				...block.defaultModelConfig,
				...(group?.[1].modelConfig ?? {}),
				...(model.modelConfig ?? {})
			};
			const handler = model.handler ?? group?.[1].handler ?? block.handler;
			const notes: string[] = [];
			if (group) {
				notes.push(
					mgt
						? `Registered by modernGraphTool only. Constraints are devicePEQ's "${group[0]}" group, which its recorded capture's product id belongs to.`
						: `Its recorded capture's product id is in devicePEQ's "${group[0]}" group, whose settings apply under the device's own.`
				);
			}
			if (name.notes) notes.push(name.notes);
			for (const k of keys.slice(1)) {
				const other = devices[k];
				if (
					other &&
					JSON.stringify(other.modelConfig?.peqConstraintsRef) !==
						JSON.stringify(cfg.peqConstraintsRef) &&
					!name.config
				) {
					throw new Error(`${key}: variant ${k} has different constraints`);
				}
			}
			const sources: Source[] = [
				{ kind: 'handler-code', ref: configUrl('usbDeviceConfig.js'), date: DATE },
				...caps.map((c): Source => ({ kind: 'handler-code', ref: captureUrl(c.file), date: DATE }))
			];
			if (mgt || (name.names ?? []).some((n) => !captures.some((c) => c.productName === n))) {
				sources.push({
					kind: 'handler-code',
					ref: `https://github.com/potatosalad775/modernGraphTool/blob/${MGT_COMMIT}/src/lib/device-peq/handlers/walkplay-hid.ts`,
					date: DATE
				});
			}
			add(
				make(idOf(name), name, handler.file, cfg, notes, {
					usb: [
						...caps.map((c) => ({
							vendorId: hex(c.vendorId as number),
							productId: hex(c.productId as number),
							productName: c.productName
						})),
						...vids.flatMap((v) => names.map((n) => ({ vendorId: hex(v), productName: n })))
					],
					sources
				})
			);
		}
	}

	// USB serial and Bluetooth.
	const edifierFreqs = [
		...readFileSync(join(dir, 'edifierUsbSerialHandler.js'), 'utf8')
			.split('FREQ_TABLE: {')[1]!
			.split('}')[0]!
			.matchAll(/^\s*(\d+):/gm)
	].map((m) => Number(m[1]));
	const placeholder =
		'The Bluetooth name is a placeholder until confirmed: devicePEQ identifies this device only by its serial service class.';
	for (const block of serial as Cfg[]) {
		for (const [key, device] of Object.entries(block.devices as Record<string, Cfg>)) {
			const name = SERIAL_DEVICES[key];
			if (!name) {
				report.push(`skipped serial device "${key}": ${NOT_IMPORTED[key] ?? 'not in tables.ts'}`);
				continue;
			}
			const uuid = block.filters?.bluetoothServiceClassId as string | undefined;
			const notes: string[] = [];
			let usb: UsbMatch[] = [];
			let bluetooth: BluetoothMatch[] = [];
			if (block.vendorId !== undefined && device.usbProductId !== undefined) {
				usb = [{ vendorId: hex(block.vendorId), productId: hex(device.usbProductId) }];
			} else if (key.startsWith('FiiO EH')) {
				bluetooth = [{ name: key.replace('FiiO', 'FIIO') }];
			} else {
				const prefix =
					{ 'Nothing Headphones': 'Nothing Headphone', 'Edifier W830NB': 'EDIFIER W830NB' }[key] ??
					key;
				bluetooth = [{ namePrefix: prefix, ...(uuid ? { serviceUuid: uuid } : {}) }];
				notes.push(placeholder);
			}
			if (device.modelConfig.writeOnly)
				notes.push('Write-only: the device does not report its EQ back.');
			const freqValues = key === 'Edifier W830NB' ? edifierFreqs : undefined;
			if (freqValues) {
				notes.push(
					"The frequency list is the handler's lookup table of captured codes, not the device's set: the 16-bit frequency field follows no formula found so far (prior-art §2.2)."
				);
			}
			const spec = make(idOf(name), name, block.handler.file, device.modelConfig, notes, {
				usb,
				bluetooth,
				sources: [{ kind: 'handler-code', ref: configUrl('usbSerialDeviceConfig.js'), date: DATE }],
				...(freqValues ? { freqValues } : {})
			});
			if (key === 'Element IV') jdsLayout(spec);
			add(spec);
		}
	}
	for (const block of ble as Cfg[]) {
		for (const [key, device] of Object.entries(block.devices as Record<string, Cfg>)) {
			const id = idOf(
				SERIAL_DEVICES[key.replace('FIIO', 'FiiO')] ??
					SERIAL_DEVICES[key] ?? { brand: '?', model: key }
			);
			const cfg = { ...block.defaultModelConfig, ...device.modelConfig };
			const sources: Source[] = [
				{ kind: 'handler-code', ref: configUrl('bluetoothBleDeviceConfig.js'), date: DATE }
			];
			const prior = specs.find((s) => s.id === id);
			if (prior) {
				// FiiO EH11/EH13: same engine over Bluetooth SPP and BLE. Keep what both paths accept.
				const other = make(id, prior.name, block.handler.file, cfg, [], { sources });
				const pq = prior.body.band.q as { min: number; max: number; step: number };
				const oq = other.body.band.q as { min: number; max: number };
				prior.body.band.q = { ...pq, min: Math.max(pq.min, oq.min), max: Math.min(pq.max, oq.max) };
				prior.sources.push(...sources);
				prior.notes.push(
					'devicePEQ reaches this engine over Bluetooth SPP and BLE with slightly different limits; this profile keeps the values both accept.'
				);
				continue;
			}
			const name = SERIAL_DEVICES[key];
			if (!name) throw new Error(`BLE device ${key} not in tables.ts`);
			add(
				make(id, name, block.handler.file, cfg, [], {
					bluetooth: [
						{
							namePrefix: block.filters.namePrefix,
							...(block.filters.services ? { serviceUuid: block.filters.services[0] } : {})
						}
					],
					sources
				})
			);
		}
	}
	return specs;
}

/** JDS Labs Element IV: 12 slots, 2 low shelves + 8 peaking + 2 high shelves (prior-art §2). */
function jdsLayout(spec: Spec) {
	spec.body.bandCount = 12;
	spec.body.band.types = ['PK'];
	spec.body.bands = [
		{ index: [0, 1], types: ['LSC'], label: 'Lowshelf' },
		{ index: [10, 11], types: ['HSC'], label: 'Highshelf' }
	];
	spec.notes.push(
		'The handler writes 12 filters by type: slots 0-1 low shelves, 2-9 peaking, 10-11 high shelves. devicePEQ\'s shared 10-filter constraints are wrong for this device. Its preamp is sent with Mode "AUTO", so how the device treats it is unclear.'
	);
	delete spec.ref;
	delete spec.refConstraints;
}

// --- Files ---------------------------------------------------------------------------------------

type File = { path: string; data: Record<string, unknown> };

const KEY_ORDER = [
	'$schema',
	'abstract',
	'extends',
	'id',
	'schemaVersion',
	'kind',
	'device',
	'engine',
	'match',
	'bandCount',
	'band',
	'bands',
	'rules',
	'realization',
	'preamp',
	'channels',
	'meta'
];
const ordered = (o: Record<string, unknown>) =>
	Object.fromEntries(KEY_ORDER.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function files(specs: Spec[]): File[] {
	const out: File[] = [];
	/** Base id: codec family + devicePEQ shape name. Two shape names may describe one base. */
	const baseKey = (s: Spec) => {
		if (!s.ref) return null;
		const family = CODECS[s.codecFile]!.family;
		return `${family}-${shapeId(s.ref).replace(new RegExp(`^${family}-`), '')}`;
	};
	const counts = new Map<string, number>();
	for (const s of specs) {
		const k = baseKey(s);
		if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const bases = new Map<string, { id: string; body: Body; refs: string[] }>();
	for (const s of specs) {
		const id = baseKey(s);
		if (!id || (counts.get(id) ?? 0) < 2) continue;
		const b = body(CODECS[s.codecFile]!, s.refConstraints!, {}, []);
		const prior = bases.get(id);
		if (prior) {
			if (JSON.stringify(prior.body) !== JSON.stringify(b))
				throw new Error(`base ${id}: refs disagree`);
			if (!prior.refs.includes(s.ref!)) prior.refs.push(s.ref!);
			continue;
		}
		bases.set(id, { id, body: b, refs: [s.ref!] });
	}
	for (const [id, base] of bases) {
		const codecFile = specs.find((s) => baseKey(s) === id)!.codecFile;
		const shapes = base.refs.map((r) => `"${r}"`).join(' and ');
		out.push({
			path: `data/bases/${id}.json`,
			data: ordered({
				$schema: '../../schema/v1/source.schema.json',
				abstract: true,
				id,
				schemaVersion: '1.0',
				kind: 'hardware',
				...base.body,
				meta: {
					status: 'draft',
					sources: [
						{
							kind: 'handler-code',
							ref: `${dpqUrl}devicePEQ/peqConstraintsConfig.json`,
							date: DATE
						},
						{ kind: 'handler-code', ref: `${dpqUrl}devicePEQ/${codecFile}`, date: DATE }
					],
					notes: `devicePEQ's shared constraints ${shapes}, with the wire grids of ${codecFile}. Seeded by scripts/import/seed.ts; ranges are what the handler encodes, not verified firmware limits.`
				}
			})
		});
	}

	for (const s of specs) {
		const base = bases.get(baseKey(s) ?? '');
		const own: Record<string, unknown> = { ...s.body };
		if (base) {
			for (const k of Object.keys(own) as (keyof Body)[]) {
				if (k === 'band') {
					const band = Object.fromEntries(
						Object.entries(s.body.band).filter(
							([bk, v]) => JSON.stringify(v) !== JSON.stringify(base.body.band[bk])
						)
					);
					if (Object.keys(band).length > 0) own.band = band;
					else delete own.band;
				} else if (JSON.stringify(own[k]) === JSON.stringify(base.body[k])) delete own[k];
			}
		}
		const match =
			s.usb.length > 0 || s.bluetooth.length > 0
				? {
						...(s.usb.length > 0 ? { usb: s.usb } : {}),
						...(s.bluetooth.length > 0 ? { bluetooth: s.bluetooth } : {})
					}
				: undefined;
		const brand = slug(s.name.brand);
		out.push({
			path: `data/profiles/${brand}/${s.id}.json`,
			data: ordered({
				$schema: '../../../schema/v1/source.schema.json',
				...(base ? { extends: base.id } : {}),
				id: s.id,
				schemaVersion: '1.0',
				kind: 'hardware',
				device: { brand: s.name.brand, model: s.name.model },
				match,
				...own,
				meta: {
					status: 'draft',
					sources: s.sources,
					notes: [
						`Seeded from devicePEQ by scripts/import/seed.ts. Values are what devicePEQ's handler encodes, not verified device limits.`,
						...s.notes
					].join(' ')
				}
			})
		});
	}
	return out;
}

function autoEqFiles(): File[] {
	const ref = `https://github.com/jaakkopasanen/AutoEq/blob/${AUTOEQ_COMMIT}/autoeq/constants.py`;
	return AUTOEQ_ENGINES.map((e) => {
		const gain = { min: e.gain[0], max: e.gain[1] };
		const band = e.fixed
			? { types: ['PK'], freq: { value: e.fixed.freqs[0] }, q: { value: e.fixed.q }, gain }
			: {
					types: e.shelves ? ['PK', 'LSC', 'HSC'] : ['PK'],
					freq: { min: 20, max: 20000 },
					q: { min: e.q![0], max: e.q![1] },
					gain
				};
		const notes = e.fixed
			? `Fixed bands from AutoEQ's PEQ_CONFIGS ${e.key}.`
			: `Band count, gain range and peaking Q range from AutoEQ's PEQ_CONFIGS ${e.key}, which is an optimizer setting: the engine may allow more bands. The frequency range and the shelves' Q range are assumptions.`;
		const sources: Source[] = [{ kind: 'community', ref, date: DATE }];
		if (e.usb) {
			sources.push({
				kind: 'handler-code',
				ref: `${dpqUrl}tests/captures/qudelix_qudelix_5k.json`,
				date: DATE
			});
		}
		return {
			path: `data/profiles/${slug(e.brand)}/${e.id}.json`,
			data: ordered({
				$schema: '../../../schema/v1/source.schema.json',
				id: e.id,
				schemaVersion: '1.0',
				kind: e.kind,
				device: { brand: e.brand, model: e.model },
				...(e.usb ? { match: { usb: [e.usb] } } : {}),
				bandCount: e.bandCount,
				band,
				...(e.fixed
					? { bands: e.fixed.freqs.slice(1).map((f, i) => ({ index: i + 1, freq: { value: f } })) }
					: {}),
				preamp: { mode: 'unknown' },
				meta: {
					status: 'draft',
					sources,
					notes: `Seeded from AutoEQ by scripts/import/seed.ts. ${notes}${e.usb ? ' USB identity from a devicePEQ recorded capture.' : ''}`
				}
			})
		};
	});
}

// --- Main ----------------------------------------------------------------------------------------

async function main() {
	const { values } = parseArgs({
		options: { devicepeq: { type: 'string', default: '../devicePEQ' }, force: { type: 'boolean' } }
	});
	dpq = resolve(root, values.devicepeq!);
	const sha = execFileSync('git', ['-C', dpq, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	dpqUrl = `https://github.com/jeromeof/devicePEQ/blob/${sha}/`;

	const dataDir = join(root, 'data');
	const existing = ['profiles', 'bases'].some(
		(d) => existsSync(join(dataDir, d)) && readdirSync(join(dataDir, d)).length > 0
	);
	if (existing && !values.force) {
		console.error(
			'data/ already has profiles. The seed import is one-off; pass --force to overwrite.'
		);
		process.exitCode = 1;
		return;
	}
	rmSync(join(dataDir, 'profiles'), { recursive: true, force: true });
	rmSync(join(dataDir, 'bases'), { recursive: true, force: true });

	const all = [...files(await collect()), ...autoEqFiles()];
	const prettier = await resolveConfig(join(root, 'package.json'));
	for (const f of all) {
		const path = join(root, f.path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, await format(JSON.stringify(f.data), { ...prettier, filepath: path }));
	}
	const paths = all.map((f) => f.path);
	const twice = paths.filter((p, i) => paths.indexOf(p) !== i);
	if (twice.length > 0) throw new Error(`written twice: ${twice.join(', ')}`);
	for (const [what, why] of Object.entries(NOT_IMPORTED))
		report.push(`not imported ${what}: ${why}`);
	console.log(`devicePEQ ${sha}`);
	console.log(`Wrote ${all.length} files.`);
	console.log(report.join('\n'));
}

await main();
