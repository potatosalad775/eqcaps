// Guided reads (INSPECTOR §3, DECISIONS D41): the user changes the EQ in the vendor's own app, one
// step at a time, and the inspector reads the device back after each step. Nothing here talks to a
// device: the page reads, and these modules plan the steps and interpret the reads.

import type { Filter, FilterType } from '@potatosalad775/eqcaps-core';

/** What a read returned: written values in band order (null for a band that is off), the preamp. */
export interface Snapshot {
	filters: (Filter | null)[];
	preamp?: number;
	slot?: number;
}

/** A numeric field a step can ask about. */
export type NumField = 'gain' | 'freq' | 'q' | 'preamp';

export type StepField = NumField | 'type' | 'bands' | 'restore';

/**
 * What a step asks for: the app's highest or lowest value, one step of it, every type it offers
 * (`each`, one read per type), a value the user types into the app (`value`, the grid check), the
 * number of bands it shows (`count`), or the EQ put back as it was (`restore`).
 */
export type StepAsk = 'max' | 'min' | 'step' | 'each' | 'value' | 'count' | 'restore';

/** One instruction. `band` is 1-based, as the vendor apps and this page number bands. */
export interface Step {
	id: string;
	field: StepField;
	ask: StepAsk;
	band?: number;
}

/** A change between two reads. `band` is absent for the preamp; `filter` is a band turning on or off. */
export interface Change {
	band?: number;
	field: 'type' | 'freq' | 'q' | 'gain' | 'preamp' | 'filter';
	from: number | string | null;
	to: number | string | null;
}

/** What a step established. One of the value fields is set, matching the step's ask. */
export interface Conclusion {
	band?: number;
	field: StepField;
	min?: number;
	max?: number;
	step?: number;
	type?: FilterType;
	bands?: number;
	/** `value` steps: what the user typed into the app, and what the device then held. */
	typed?: number;
	read?: number;
	/** `restore`: whether the last read equals the first. */
	matchesFirst?: boolean;
}

/**
 * One entry in a guided read's log, in the order things happened. A step may have several: a read
 * that showed no change, then one that did; a redo; one read per type. The last one counts, except
 * for `each` steps, which collect every read until `done`.
 */
export type Entry =
	| {
			kind: 'read';
			step: Step;
			read: Snapshot;
			/** Since the previous read (of any step), or since the first read for `restore`. */
			changed: Change[];
			/** `value` and `count` steps: the number the user typed. */
			typed?: number;
			/** The user says the value already was where the step asks, so no change is expected. */
			already?: boolean;
	  }
	| { kind: 'skip'; step: Step }
	| { kind: 'done'; step: Step };

/** What the page knows before the first step. */
export interface GuidedContext {
	/** The first read: the EQ before any step, which the last step puts back. */
	first: Snapshot;
	/** The protocol reads a preamp. */
	readsPreamp: boolean;
	/** The protocol has a Q field. */
	hasQ: boolean;
	/**
	 * What the protocol's frames carry per field (the bridge's `WireGrid`): its step tells the
	 * app's values from the wire's rounding of them, and its limits stand in for a field nobody
	 * checked when no profile has one.
	 */
	wire: Partial<Record<NumField, { min: number; max: number; step?: number }>>;
}
