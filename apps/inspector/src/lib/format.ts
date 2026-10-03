// Number formatting shared by the views. describe() in core has the sentence-level text.

/** Up to 6 significant digits, no trailing zeros. */
export function formatNumber(x: number): string {
	return String(Number(x.toPrecision(6)));
}

/** "31.5 Hz", "1 kHz", "16.5 kHz". */
export function formatHz(f: number): string {
	return f >= 1000 ? `${formatNumber(f / 1000)} kHz` : `${formatNumber(f)} Hz`;
}

/** Axis label: "20", "1k", "20k". */
export function formatTick(f: number): string {
	return f >= 1000 ? `${formatNumber(f / 1000)}k` : formatNumber(f);
}

/** "+3 dB", "−4.5 dB", "0 dB". */
export function formatDb(x: number): string {
	const sign = x > 0 ? '+' : x < 0 ? '−' : '';
	return `${sign}${formatNumber(Math.abs(x))} dB`;
}

/** Fixed decimals for tables of filters: freq 2, q 3, gain 2; trailing zeros dropped. */
export function formatField(field: 'freq' | 'q' | 'gain' | 'preamp', x: number): string {
	if (!Number.isFinite(x)) return String(x);
	const digits = field === 'q' ? 3 : 2;
	return String(Number(x.toFixed(digits)));
}
