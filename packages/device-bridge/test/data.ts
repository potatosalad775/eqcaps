// The repository's profiles and the protocols they give the bridge, for tests that drive the
// database's devices.

import type { Profile } from '@potatosalad775/eqcaps-core';
import { validateRepository } from '../../build/src/node.ts';
import { protocolOf, type Protocol } from '../src/index.ts';

/** Every published profile of the repository, flattened, by id. */
export const profiles: ReadonlyMap<string, Profile> = validateRepository().profiles;

/** The protocol of every profile that has one, by profile id. */
export const PROTOCOLS: Readonly<Record<string, Protocol>> = Object.fromEntries(
	[...profiles.values()].flatMap((p) => {
		const protocol = protocolOf(p);
		return protocol ? [[p.id, protocol]] : [];
	})
);

/** The protocol of a profile in the repository. */
export function protocolFor(profileId: string): Protocol | undefined {
	return Object.hasOwn(PROTOCOLS, profileId) ? PROTOCOLS[profileId] : undefined;
}
