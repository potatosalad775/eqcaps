// The evidence file of a probe (INSPECTOR §6): every push and read-back, what each experiment
// concluded, the backup and whether it was put back, and the constraints derived. A profile
// cites it as a `probe` source, which counts toward a verified status (SPEC §10).

import type { Filter, Source } from '@potatosalad775/eqcaps-core';
import type { DeviceIdentity } from '@potatosalad775/eqcaps-device-bridge';
import type { EvidenceReport, FilterTuple, ProbeExperiment } from '../evidence.ts';
import type { Derivation } from './derive.ts';
import type { ProbeResult } from './types.ts';

export const PROBE_CAVEATS = [
	'Read-back only: the device stores these values, but how they sound was not measured.',
	'A bound the device took at the probe’s search limit is a lower bound on its range, not the range itself.',
	'Probed on one unit, with one firmware: other firmware may accept other values.'
];

const tuple = (f: Filter): FilterTuple => [f.type, f.freq, f.q, f.gain];
const tuples = (fs: readonly (Filter | null)[]) => fs.map((f) => (f ? tuple(f) : null));

export function probeEvidence(input: {
	transport: 'hid' | 'serial' | 'ble';
	identity: DeviceIdentity;
	handler: string;
	experimental: boolean;
	profile?: string;
	result: ProbeResult;
	derivation: Derivation | null;
	commit: string;
	userAgent?: string;
	date: string;
}): EvidenceReport {
	const { result } = input;
	const u = input.identity.usb;
	const b = input.identity.bluetooth;
	const device: EvidenceReport['device'] = { transport: input.transport };
	if (u?.vendorId !== undefined) device.vendorId = u.vendorId;
	if (u?.productId !== undefined) device.productId = u.productId;
	if (u?.productName !== undefined) device.productName = u.productName;
	if (b?.name !== undefined) device.bluetoothName = b.name;
	const experiments: ProbeExperiment[] = result.experiments.map((e) => ({
		id: e.id,
		pushes: e.pushes.map((p) => ({
			sent: {
				filters: p.sent.filters.map(tuple),
				...(p.sent.preamp !== undefined ? { preamp: p.sent.preamp } : {})
			},
			...(p.readBack
				? {
						readBack: {
							filters: tuples(p.readBack.filters),
							...(p.readBack.preamp !== undefined ? { preamp: p.readBack.preamp } : {})
						}
					}
				: {}),
			ms: p.ms,
			...(p.note ? { note: p.note } : {})
		})),
		conclusion: e.conclusion
	}));
	const notes = [...(input.derivation?.notes ?? []), ...result.anomalies];
	return {
		evidenceVersion: 1,
		tool: {
			name: 'eqcaps inspector',
			commit: input.commit,
			...(input.userAgent ? { userAgent: input.userAgent } : {})
		},
		device,
		handler: input.handler,
		...(input.experimental ? { experimental: true as const } : {}),
		...(input.profile ? { profile: input.profile } : {}),
		date: input.date,
		probe: {
			mode: result.mode,
			writes: result.writes,
			...(result.aborted ? { aborted: result.aborted } : {})
		},
		...(result.backup
			? {
					backup: {
						filters: tuples(result.backup.filters),
						...(result.backup.preamp !== undefined ? { preamp: result.backup.preamp } : {}),
						...(result.backup.slot !== undefined ? { slot: result.backup.slot } : {})
					}
				}
			: {}),
		backupRestored: result.restore.verified,
		experiments,
		...(input.derivation
			? { derivedProfile: input.derivation.constraints as unknown as Record<string, unknown> }
			: {}),
		...(notes.length ? { notes } : {}),
		caveats: [...PROBE_CAVEATS]
	};
}

/** How a profile cites a probe's evidence file: counting evidence (SPEC §10). */
export function probeSource(ref: string, date: string, by?: string, firmware?: string): Source {
	return {
		kind: 'probe',
		ref,
		...(firmware ? { firmware } : {}),
		date,
		...(by ? { by } : {})
	};
}
