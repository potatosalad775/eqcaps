// The few platform facilities handlers need, read from globalThis with only the types used, so
// the package has no DOM or Node types (same approach as the client, D32).

interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const timers = globalThis as unknown as Timers;

/** Resolves after `ms` milliseconds. */
export function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

/** Runs `fn` after `ms`; returns a cancel function. */
export function after(ms: number, fn: () => void): () => void {
	const handle = timers.setTimeout(fn, ms);
	return () => timers.clearTimeout(handle);
}

/** UTF-8 encoding without TextEncoder, which ES2023 doesn't declare. */
export function utf8Encode(text: string): Uint8Array {
	const out: number[] = [];
	for (const ch of text) {
		const c = ch.codePointAt(0)!;
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else
			out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return new Uint8Array(out);
}

/** UTF-8 decoding; malformed sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length;) {
		const b = bytes[i]!;
		const n = b < 0x80 ? 0 : b >= 0xf8 ? -1 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
		if (n <= 0) {
			out += n === 0 ? String.fromCharCode(b) : '�';
			i++;
			continue;
		}
		let c = b & (0x3f >> n);
		let ok = true;
		for (let k = 1; k <= n; k++) {
			const cont = bytes[i + k];
			if (cont === undefined || (cont & 0xc0) !== 0x80) ok = false;
			else c = (c << 6) | (cont & 63);
		}
		if (!ok) {
			out += '�';
			i++;
			continue;
		}
		out += String.fromCodePoint(c);
		i += n + 1;
	}
	return out;
}
