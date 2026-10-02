/**
 * Line numbers of JSON Pointers in a JSON text, so reports and CI annotations can point at the
 * line an issue is about. Object members map to the line of their key, array items and the root
 * to the line their value starts on. The text must be valid JSON.
 */
export function jsonLines(text: string): Map<string, number> {
	const lines = new Map<string, number>();
	let i = 0;
	let line = 1;

	const skipSpace = () => {
		for (; i < text.length; i++) {
			const c = text[i];
			if (c === '\n') line++;
			else if (c !== ' ' && c !== '\t' && c !== '\r') return;
		}
	};
	const readString = (): string => {
		let out = '';
		for (i++; i < text.length && text[i] !== '"';) {
			if (text[i] !== '\\') {
				out += text[i++];
				continue;
			}
			const e = text[i + 1] ?? '';
			if (e === 'u') {
				out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
				i += 6;
			} else {
				out += ESCAPES[e] ?? e;
				i += 2;
			}
		}
		i++;
		return out;
	};
	const readValue = (pointer: string) => {
		skipSpace();
		if (!lines.has(pointer)) lines.set(pointer, line);
		const c = text[i];
		if (c === '{' || c === '[') {
			const close = c === '{' ? '}' : ']';
			i++;
			skipSpace();
			if (text[i] === close) {
				i++;
				return;
			}
			for (let n = 0; ; n++) {
				let child = `${pointer}/${n}`;
				if (c === '{') {
					skipSpace();
					const keyLine = line;
					child = `${pointer}/${pointerSegment(readString())}`;
					lines.set(child, keyLine);
					skipSpace();
					i++; // ':'
				}
				readValue(child);
				skipSpace();
				if (text[i++] !== ',') return;
			}
		}
		if (c === '"') {
			readString();
			return;
		}
		while (i < text.length && !/[\s,\]}]/.test(text[i] as string)) i++;
	};

	readValue('');
	return lines;
}

/** Line of `pointer`, or of its longest prefix present in the text (inherited keys). */
export function lineOf(lines: Map<string, number>, pointer: string): number {
	for (let p = pointer; ; p = p.slice(0, p.lastIndexOf('/'))) {
		const line = lines.get(p);
		if (line !== undefined) return line;
		if (p === '') return 1;
	}
}

export const pointerSegment = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
