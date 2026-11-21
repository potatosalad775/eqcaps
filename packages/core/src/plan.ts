import { complete, type CompleteWarning } from './complete.ts';
import type { Filter } from './filter.ts';
import { fit, type FitResult } from './fit.ts';
import type { Profile } from './types/schema.generated.ts';

/** The EQ the user wants on a device: one channel's filters and preamp, or both channels'. */
export interface PlanWanted {
	filters: readonly Filter[];
	/** dB. Left out, 0. */
	preamp?: number;
	/**
	 * The right channel, wanted apart from the left: `filters` and `preamp` are then the left's, and
	 * `right.preamp` left out is `preamp`. Left out, both channels are wanted alike.
	 */
	right?: { filters: readonly Filter[]; preamp?: number };
}

/** What the engine holds now, by slot: what a read returned. A device bridge pull fits as is. */
export interface PlanHeld {
	filters: readonly (Filter | null | undefined)[];
	/** The right channel, where it was read apart. */
	right?: { filters: readonly (Filter | null | undefined)[] } | undefined;
}

/**
 * What the write path can do, and what the engine holds. A device bridge's `capabilities` fit as
 * they are for the first two.
 */
export interface PlanOptions {
	/** The write carries a preamp. Default false: none is sent. */
	writesPreamp?: boolean | undefined;
	/** The write drives left and right apart. Default false: both channels are written alike. */
	perChannel?: boolean | undefined;
	/**
	 * What each slot holds now, as `complete`'s hints, so the slots a write leaves empty keep the
	 * engine's own layout. The right channel takes `held.right`, or `held` where it wasn't read
	 * apart.
	 */
	held?: PlanHeld | null | undefined;
}

/** What to send to the engine. The device bridge's push takes it as is. */
export interface PlanWrite {
	/** Written values: exactly `bandCount` filters (the non-null ones when unbounded). */
	filters: Filter[];
	/** The preamp to send; left out when none is sent (`sendsPreamp`). */
	preamp?: number;
	/** The right channel, where it is written apart: `filters` and `preamp` are then the left's. */
	right?: { filters: Filter[]; preamp?: number };
}

/** How one written channel came out. */
export interface PlanChannel {
	/** `fit` of the channel's wanted filters and preamp: what moved, what got no slot. */
	fit: FitResult;
	/** `complete`'s warnings about the slots the fit left empty. */
	warnings: CompleteWarning[];
}

export interface Plan {
	write: PlanWrite;
	/**
	 * The written channels: one entry where both channels are written alike, else the left's, then
	 * the right's.
	 */
	channels: PlanChannel[];
	/**
	 * A preamp is sent: the write carries one and the profile's mode is `manual` or `unknown`. Where
	 * it isn't and the filters boost, the engine can't be told to make room (SPEC §9).
	 */
	sendsPreamp: boolean;
}

/**
 * What a write of `wanted` sends to the engine `profile` describes (SPEC §13.10, the hard path of
 * D12): `fit`, then `complete` with what the engine holds as hints, for each written channel.
 *
 * The right channel is written apart only where the profile's `channels` are `independent`, the
 * write drives them apart and a right channel is wanted; elsewhere the left goes to both. The
 * preamp is sent only where the write carries one and the mode is `manual` (fitted to its domain)
 * or `unknown` (as wanted).
 *
 * For a device's listed EQ (SPEC §9.2), pass `eqProfile(profile, id)`.
 */
export function plan(profile: Profile, wanted: PlanWanted, options: PlanOptions = {}): Plan {
	const mode = profile.preamp.mode;
	const sendsPreamp = options.writesPreamp === true && (mode === 'manual' || mode === 'unknown');
	const held = options.held ?? undefined;

	const channel = (
		filters: readonly Filter[],
		preamp: number,
		hints: PlanHeld['filters'] | undefined
	) => {
		const fitted = fit(profile, filters, preamp);
		const completed = complete(profile, fitted.slots, hints ? { hints } : {});
		return {
			write: { filters: completed.filters, ...(sendsPreamp ? { preamp: fitted.preamp } : {}) },
			report: { fit: fitted, warnings: completed.warnings }
		};
	};

	const preamp = wanted.preamp ?? 0;
	const left = channel(wanted.filters, preamp, held?.filters);
	const apart =
		profile.channels === 'independent' && options.perChannel === true && wanted.right !== undefined;
	if (!apart) return { write: left.write, channels: [left.report], sendsPreamp };

	const right = channel(
		wanted.right!.filters,
		wanted.right!.preamp ?? preamp,
		held?.right?.filters ?? held?.filters
	);
	return {
		write: { ...left.write, right: right.write },
		channels: [left.report, right.report],
		sendsPreamp
	};
}
