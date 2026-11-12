// Device controls (SPEC §9.1): which values a control takes, and whether it exists on the device
// right now. The bridge checks writes with these; apps use them to show what the device offers.

import { near, onGrid } from './domain.ts';
import { firmwareInRange } from './firmware.ts';
import type { Control } from './types/schema.generated.ts';

/** The current value of each control by id; null or missing for one not read, or absent. */
export type ControlValues = Readonly<Record<string, number | null | undefined>>;

/** Whether `control` takes `value`: 0 or 1 for a toggle, a listed value, or a number in range. */
export function controlTakes(control: Control, value: number): boolean {
	if (!Number.isFinite(value)) return false;
	switch (control.kind) {
		case 'toggle':
			return value === 0 || value === 1;
		case 'choice':
			return (control.values ?? []).some((v) => near(v.value, value));
		case 'range': {
			const r = control.range;
			if (!r) return false;
			const inside = (value > r.min || near(value, r.min)) && (value < r.max || near(value, r.max));
			return inside && ('step' in r ? onGrid(value, r.step) : true);
		}
		default:
			return false;
	}
}

/**
 * Whether a control exists on the device now: the device's firmware is in its `firmware` range
 * (unknown firmware fails one), and the control its `when` names holds one of the listed values.
 */
export function controlPresent(
	control: Control,
	device: { firmware?: string | null; values: ControlValues }
): boolean {
	if (control.firmware && !firmwareInRange(control.firmware, device.firmware ?? undefined)) {
		return false;
	}
	if (control.when) {
		const current = device.values[control.when.control];
		if (current === null || current === undefined) return false;
		if (!control.when.values.some((v) => near(v, current))) return false;
	}
	return true;
}

/** The controls whose current value stops the device applying its EQ (`disablesEq`). */
export function eqDisabledBy(controls: readonly Control[], values: ControlValues): Control[] {
	return controls.filter((c) => {
		const v = values[c.id];
		return v !== null && v !== undefined && (c.disablesEq ?? []).some((d) => near(d, v));
	});
}
