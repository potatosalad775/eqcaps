export interface Maintainer {
	handle: string;
	former: boolean;
}

/**
 * Parses the repository's MAINTAINERS file: one GitHub handle per line, optionally followed by
 * `former`; `#` starts a comment. Former maintainers stay listed, so their past verifications stay
 * valid (DECISIONS D28).
 */
export function parseMaintainers(text: string): Maintainer[] {
	const out: Maintainer[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const [handle, ...rest] = raw.replace(/#.*/, '').trim().split(/\s+/);
		if (!handle) continue;
		out.push({ handle: handle.replace(/^@/, ''), former: rest.includes('former') });
	}
	return out;
}
