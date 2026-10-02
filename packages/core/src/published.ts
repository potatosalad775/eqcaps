import type { Match, Meta, Profile } from './types/schema.generated.ts';

/** One profile in `index.json` (SPEC §14). */
export interface IndexEntry {
	id: string;
	kind: Profile['kind'];
	brand: string;
	model: string;
	aliases?: string[];
	engine?: string;
	status: Meta['status'];
	replacedBy?: string;
	/** Hardware only. Lets a client identify a device without fetching every profile. */
	match?: Match;
	/** Relative to the index: `profiles/<id>.json`. */
	path: string;
	/** Hex SHA-256 of the profile file's bytes. Profiles are cacheable by it. */
	sha256: string;
	bytes: number;
}

/** `index.json` (SPEC §14). */
export interface DataIndex {
	schemaVersion: string;
	/** `YYYY.MM.DD-<short git sha>` */
	dataVersion: string;
	/** ISO 8601 */
	generatedAt: string;
	profiles: IndexEntry[];
}

/** `bundle.json`: every non-deprecated profile in one file, for apps that embed a snapshot. */
export interface DataBundle {
	schemaVersion: string;
	dataVersion: string;
	generatedAt: string;
	profiles: Profile[];
}

/** The index entry of a profile, without the file fields (`path`, `sha256`, `bytes`). */
export function indexFields(p: Profile): Omit<IndexEntry, 'path' | 'sha256' | 'bytes'> {
	return {
		id: p.id,
		kind: p.kind,
		brand: p.device.brand,
		model: p.device.model,
		...(p.device.aliases ? { aliases: p.device.aliases } : {}),
		...(p.engine !== undefined ? { engine: p.engine } : {}),
		status: p.meta.status,
		...(p.meta.replacedBy !== undefined ? { replacedBy: p.meta.replacedBy } : {}),
		...(p.match ? { match: p.match } : {})
	};
}
