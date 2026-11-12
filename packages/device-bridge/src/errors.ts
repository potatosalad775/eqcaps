/**
 * Why a bridge operation failed. Every error the bridge throws on purpose is a `BridgeError` with
 * one of these codes, so a UI can explain it.
 *
 * - `unsupported-type`: the handler has no wire code for the filter type.
 * - `unrepresentable`: a value doesn't fit the wire field (out of its integer range, or missing
 *   from a lookup table). Codecs round onto their grid but never clamp a value into range.
 * - `unsupported`: the handler or transport can't do this at all (pull on a write-only device).
 * - `timeout`: the device didn't answer in time.
 * - `bad-response`: the device answered with something the handler can't parse.
 * - `rejected`: the device answered and said no.
 * - `transport`: the transport failed (disconnected, closed, permission lost).
 * - `invalid-request`: the caller asked for something the protocol can't express (a slot it
 *   doesn't have, a band count it can't read).
 */
export type BridgeErrorCode =
	| 'unsupported-type'
	| 'unrepresentable'
	| 'unsupported'
	| 'timeout'
	| 'bad-response'
	| 'rejected'
	| 'transport'
	| 'invalid-request';

export class BridgeError extends Error {
	readonly code: BridgeErrorCode;

	constructor(code: BridgeErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'BridgeError';
		this.code = code;
	}
}

export function isBridgeError(error: unknown, code?: BridgeErrorCode): error is BridgeError {
	return error instanceof BridgeError && (code === undefined || error.code === code);
}
