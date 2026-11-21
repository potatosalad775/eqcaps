// How an edit begins, and which evidence it may cite (INSPECTOR §2 T4): the choices the editor
// makes before the first keystroke, given what the route has fetched. Nothing here reads a file.

import type { AuthoringProfile } from '@potatosalad775/eqcaps-core';
import { blankProfile } from './editor.ts';
import { citeEvidence, profileForDevice, type Handoff } from './handoff.ts';

/** What the route found for the page's address. */
export interface StartFrom {
	/**
	 * The file of the id in the address, parsed; null where its text isn't a JSON object. Left out
	 * when the address names no id.
	 */
	existing?: AuthoringProfile | null;
	/** The file `?copy=` names, parsed. */
	copy?: AuthoringProfile;
	/** What the connect page handed over (`?device`): a reviewed evidence file and its read-back. */
	handoff?: Handoff | null;
	/** `?extends=`, for a blank file. */
	extends?: string | null;
	/** `?kind=`, for a blank file. */
	kind?: 'hardware' | 'software';
}

/**
 * The file an edit starts from, or null to keep an existing file's text exactly as it is (an
 * existing file with nothing handed over: the editor never reformats what the user didn't touch).
 *
 * - An existing file with a handoff: that file citing the handoff's evidence. One whose text
 *   isn't a JSON object starts from a blank file instead.
 * - A copy: the other file as a draft of a new profile, with no id, no sources and no match of
 *   its own (an empty USB list for hardware, to fill in).
 * - A handoff alone: a profile for the device that was read.
 * - Otherwise a blank file, extending `extends` or of `kind`.
 */
export function startingProfile(from: StartFrom): AuthoringProfile | null {
	const { handoff } = from;
	if (from.existing !== undefined) {
		return handoff ? citeEvidence(from.existing ?? blankProfile(), handoff) : null;
	}
	if (from.copy) {
		const { match: _match, ...rest } = from.copy;
		return {
			...rest,
			id: '',
			...(rest.kind === 'hardware' ? { match: { usb: [] } } : {}),
			meta: { status: 'draft', sources: [] }
		};
	}
	if (handoff) return profileForDevice(handoff);
	return blankProfile({
		...(from.extends ? { extends: from.extends } : {}),
		kind: from.kind === 'software' ? 'software' : 'hardware'
	});
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The handoff's evidence file by name, wherever it lives; '' without a handoff. */
export const evidenceName = (handoff: Handoff | null): string =>
	handoff ? fileName(handoff.evidence.path) : '';

/**
 * The handoff's evidence file as `data` cites it: a new device's evidence moves to
 * `evidence/<id>/` once the profile has an id, so the ref is found by the file's name. Where the
 * file doesn't cite it, the path it was handed over under; '' without a handoff.
 */
export function evidenceRef(data: AuthoringProfile | null, handoff: Handoff | null): string {
	if (!handoff) return '';
	const name = evidenceName(handoff);
	const cited = (data?.meta?.sources ?? []).find(
		(s) => s.ref.startsWith('evidence/') && s.ref.endsWith(`/${name}`)
	);
	return cited?.ref ?? handoff.evidence.path;
}

/**
 * The evidence files the check takes as present: those the file cited before the edit (they are
 * in the repository), and the one handed over (it is sent with the change).
 */
export function presentEvidence(
	original: AuthoringProfile | null,
	handedOver: string
): Set<string> {
	const refs = new Set<string>();
	for (const s of original?.meta?.sources ?? []) {
		if (s.ref.startsWith('evidence/')) refs.add(s.ref);
	}
	if (handedOver) refs.add(handedOver);
	return refs;
}
