// Probe mode (T3, INSPECTOR §3): the shapes the engine, the planner and the UI share.

import type { Filter, FilterType, When } from '@potatosalad775/eqcaps-core';
import type {
	DeviceCapabilities,
	PullRequest,
	PullResult,
	PushRequest,
	PushResult
} from '@potatosalad775/eqcaps-device-bridge';
import type { Rounding, StepResult } from './infer.ts';

/**
 * What the probe engine drives: EQ push and pull, nothing else (INSPECTOR §3.4). A connected
 * `BridgeDevice` is one; tests use a `FakeDevice`.
 */
export interface ProbeIO {
	readonly capabilities: DeviceCapabilities;
	pull(request?: PullRequest): Promise<PullResult>;
	push(request: PushRequest): Promise<PushResult>;
}

export type ProbeMode = 'quick' | 'full';

export type ExperimentId =
	| 'backup'
	| 'band-count'
	| 'settle'
	| 'gain-step'
	| 'gain-range'
	| 'q-step'
	| 'q-range'
	| 'freq-step'
	| 'freq-range'
	| 'types'
	| 'conditions'
	| 'order'
	| 'preamp'
	| 'restore';

/** One push and the pull after it, as the evidence file records it (INSPECTOR §6). */
export interface PushRecord {
	sent: { filters: Filter[]; preamp?: number };
	/** Absent when the push or the pull failed. */
	readBack?: { filters: (Filter | null)[]; preamp?: number };
	/** Time from the push to the end of the pull. */
	ms: number;
	/** What went wrong or looked odd: "rejected by the device", "whole write rejected"… */
	note?: string;
}

export interface ExperimentRecord {
	id: ExperimentId;
	pushes: PushRecord[];
	conclusion: Record<string, unknown>;
}

/** How a bound was found. `limit`: the search limit was accepted, so the bound is at least it. */
export type BoundHow = 'clamped' | 'rejected' | 'limit' | 'inconclusive';

export interface Bound {
	value: number;
	how: BoundHow;
}

/** What the probe learnt about one field of one slot. */
export interface FieldFinding {
	min?: Bound;
	max?: Bound;
	/** Set when the field has no uniform grid: the distinct values the device stored. */
	values?: number[];
}

export interface SlotFindings {
	/** Types the slot kept, in preference order. Unset when types weren't probed. */
	types?: FilterType[];
	/** What happened to the types it didn't keep: "LPQ became PK", "BP rejected". */
	typeNotes?: string[];
	gain?: FieldFinding;
	q?: FieldFinding;
	freq?: FieldFinding;
	/** Frequency windows under other conditions than a negative-gain peaking band. */
	conditions?: { label: string; when: When; freq: FieldFinding }[];
}

export interface Findings {
	bandCount?: { value: number; atLeast: boolean };
	steps: Partial<Record<'gain' | 'q' | 'freq' | 'preamp', StepResult>>;
	slots: SlotFindings[];
	order?: { rule: 'none' | 'reorders' | 'rejects'; strict?: boolean } | { skipped: string };
	preamp?: FieldFinding;
	/** The device rejected whole writes for one bad band, so searches ran slot by slot. */
	wholeSet: boolean;
	/** Writes after which bands the probe didn't touch changed: possible silent resets. */
	resets: number;
}

export interface Backup {
	filters: (Filter | null)[];
	preamp?: number;
	slot?: number;
}

export interface RestoreResult {
	attempted: boolean;
	/** The device read back what it held before the probe. */
	verified: boolean;
	/** Differences between the backup and the read-back after restoring. */
	mismatches: string[];
	error?: string;
}

export interface ProbeProgress {
	experiment: ExperimentId;
	writes: number;
	planned: number;
	message: string;
}

export interface ProbeResult {
	mode: ProbeMode;
	backup: Backup | null;
	restore: RestoreResult;
	experiments: ExperimentRecord[];
	findings: Findings;
	writes: number;
	/** Why the probe stopped early, if it did. */
	aborted?: string;
	/** Things the engine noticed but did not interpret (INSPECTOR §3.5). */
	anomalies: string[];
}

export type { Rounding };
