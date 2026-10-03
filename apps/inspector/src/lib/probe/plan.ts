// Before a probe (INSPECTOR §3.1, §3.3): whether the device can be probed, which preset slot to
// probe, which experiments run, and about how many writes they take.

import type { Profile } from '@potatosalad775/eqcaps-core';
import type { CodecAnalysis, DeviceCapabilities } from '@potatosalad775/eqcaps-device-bridge';
import type { ExperimentId, ProbeMode } from './types.ts';

export interface Precondition {
	id: 'read' | 'write' | 'reconnect' | 'bands';
	ok: boolean;
	text: string;
}

/**
 * What must hold before probing (INSPECTOR §3.1). Raw push always holds: the bridge sends
 * written values as given (D33). The safety acknowledgement is the UI's.
 */
export function preconditions(
	caps: Pick<DeviceCapabilities, 'canRead' | 'canWrite' | 'disconnectOnSave'>,
	analysis: Pick<CodecAnalysis, 'bands'>
): Precondition[] {
	return [
		{
			id: 'read',
			ok: caps.canRead,
			text: caps.canRead
				? 'The protocol reads the EQ back.'
				: 'The protocol can’t read the EQ back, so nothing can be learnt from a write.'
		},
		{
			id: 'write',
			ok: caps.canWrite,
			text: caps.canWrite ? 'The protocol writes the EQ.' : 'The protocol can’t write the EQ.'
		},
		{
			id: 'reconnect',
			ok: !caps.disconnectOnSave,
			text: caps.disconnectOnSave
				? 'The device drops the connection after every save, and the inspector can’t reconnect on its own yet.'
				: 'The device stays connected while it saves.'
		},
		{
			id: 'bands',
			ok: analysis.bands.max > 0,
			text:
				analysis.bands.max > 0
					? `A write carries ${analysis.bands.min === analysis.bands.max ? analysis.bands.max : `${analysis.bands.min} to ${analysis.bands.max}`} bands.`
					: 'The codec refuses every band count.'
		}
	];
}

/**
 * The preset slot to probe (INSPECTOR §3.2 step 2): a spare user slot when the protocol can read
 * and write a chosen slot, so nothing audible changes; otherwise the current preset.
 */
export function targetSlot(
	caps: Pick<DeviceCapabilities, 'readsSlot' | 'writesSlot' | 'slots'>,
	current: number | null
): { slot?: number; text: string } {
	if (caps.readsSlot && caps.writesSlot) {
		const spare = caps.slots
			.filter((s) => s.id !== current)
			.sort(
				(a, b) =>
					Number(/user|custom/i.test(b.name)) - Number(/user|custom/i.test(a.name)) || a.id - b.id
			)[0];
		if (spare) {
			return {
				slot: spare.id,
				text: `Probing preset “${spare.name}”, which isn’t the one playing.`
			};
		}
	}
	return {
		text: 'Probing the current preset: the protocol can’t read a chosen preset, so what you hear changes during the probe.'
	};
}

/** The experiments a mode runs, in order (INSPECTOR §3.2, §3.3). */
export function experimentsFor(
	mode: ProbeMode,
	caps: Pick<DeviceCapabilities, 'readsPreamp' | 'writesPreamp'>,
	analysis: Pick<CodecAnalysis, 'q' | 'wire'>
): ExperimentId[] {
	const quick: ExperimentId[] = ['band-count', 'settle', 'gain-step', 'gain-range'];
	if (mode === 'quick') return quick;
	const ids: ExperimentId[] = [...quick];
	if (analysis.wire.q) ids.push('q-step', 'q-range');
	ids.push('freq-step', 'freq-range', 'order', 'types', 'conditions');
	if (caps.readsPreamp && caps.writesPreamp && analysis.wire.preamp) ids.push('preamp');
	return ids;
}

/** Writes a bound search usually takes when the device rejects rather than clamps. */
const SEARCH = 6;

/**
 * About how many writes a probe takes (INSPECTOR §3.3): shown before it starts. Devices that clamp
 * take fewer; devices that reject whole writes take up to `bands` times more.
 */
export function estimateWrites(
	experiments: readonly ExperimentId[],
	bands: number,
	analysis: Pick<CodecAnalysis, 'types'>
): number {
	const types = analysis.types.filter((t) => !t.startsWith('x-')).length;
	const per: Record<ExperimentId, number> = {
		backup: 0,
		'band-count': Math.max(2, Math.ceil(Math.log(Math.max(bands, 2)) / Math.log(4))) + 1,
		settle: 2,
		'gain-step': Math.max(2, Math.ceil(10 / Math.max(bands, 1))),
		'gain-range': 2 * SEARCH,
		'q-step': Math.max(2, Math.ceil(8 / Math.max(bands, 1))),
		'q-range': 2 * SEARCH,
		'freq-step': Math.max(2, Math.ceil(8 / Math.max(bands, 1))),
		'freq-range': 2 * SEARCH,
		types,
		conditions: types * 2 * SEARCH,
		order: 2,
		preamp: 5 + 2 * SEARCH,
		restore: 1
	};
	return experiments.reduce((n, id) => n + per[id], per.restore);
}

/**
 * How many bands the band-count experiment writes: enough past the profile's count to find a
 * truncation point, without writing dozens of bands into a device known to have ten.
 */
export function bandsToTry(
	analysis: Pick<CodecAnalysis, 'bands'>,
	profile: Pick<Profile, 'bandCount'> | undefined,
	cap = 64
): number {
	const known = profile?.bandCount ?? undefined;
	const wanted = known !== undefined ? known + 6 : cap;
	return Math.max(analysis.bands.min, Math.min(analysis.bands.max, cap, wanted));
}
