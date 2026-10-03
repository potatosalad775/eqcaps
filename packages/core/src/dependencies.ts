import type { SlotFields, Variant } from './types/schema.generated.ts';

/** A filter field. */
export type Field = 'type' | 'freq' | 'q' | 'gain';
/** A filter field with a numeric domain. */
export type NumericField = 'freq' | 'q' | 'gain';

export const NUMERIC_FIELDS = ['freq', 'q', 'gain'] as const;

/** Fields a variant's `when` reads. */
export function variantReads(v: Variant): Field[] {
	return (['type', 'freq', 'q', 'gain'] as const).filter((f) => v.when[f] !== undefined);
}

/** Fields a variant defines. */
export function variantDefines(v: Variant): NumericField[] {
	return NUMERIC_FIELDS.filter((f) => v[f] !== undefined);
}

/** Variant edges A → F of one merged slot. Self-references are left out. */
export function slotEdges(slot: SlotFields): [Field, NumericField][] {
	const edges: [Field, NumericField][] = [];
	for (const v of slot.variants ?? []) {
		for (const a of variantReads(v)) {
			for (const f of variantDefines(v)) if (a !== f) edges.push([a, f]);
		}
	}
	return edges;
}

export function findCycle(edges: readonly [Field, Field][]): Field[] | null {
	const next = new Map<Field, Field[]>();
	for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
	const state = new Map<Field, 'open' | 'done'>();
	const stack: Field[] = [];
	const visit = (n: Field): Field[] | null => {
		state.set(n, 'open');
		stack.push(n);
		for (const m of next.get(n) ?? []) {
			if (state.get(m) === 'open') return [...stack.slice(stack.indexOf(m)), m];
			if (!state.has(m)) {
				const c = visit(m);
				if (c) return c;
			}
		}
		stack.pop();
		state.set(n, 'done');
		return null;
	};
	for (const n of ['type', 'freq', 'q', 'gain'] as const) {
		if (!state.has(n)) {
			const c = visit(n);
			if (c) return c;
		}
	}
	return null;
}

/**
 * The order in which an engine evaluates a slot's numeric fields (SPEC §6, §13.1): topological
 * over the variant edges, ties broken freq, q, gain. `type` always comes first and is not
 * listed. On a cyclic (invalid) profile the remaining fields follow in that same order.
 */
export function fieldOrder(slot: SlotFields): NumericField[] {
	const edges = slotEdges(slot).filter(([a]) => a !== 'type');
	const order: NumericField[] = [];
	let remaining: NumericField[] = [...NUMERIC_FIELDS];
	while (remaining.length > 0) {
		const ready =
			remaining.find(
				(f) => !edges.some(([a, b]) => b === f && remaining.includes(a as NumericField))
			) ?? (remaining[0] as NumericField);
		order.push(ready);
		remaining = remaining.filter((f) => f !== ready);
	}
	return order;
}
