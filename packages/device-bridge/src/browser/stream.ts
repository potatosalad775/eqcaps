import { BridgeError } from '../errors.ts';
import { after } from '../platform.ts';

/**
 * Buffers received chunks for `StreamTransport.read`, so bytes that arrive between two reads
 * are kept rather than lost.
 */
export class ChunkQueue {
	private readonly chunks: Uint8Array[] = [];
	private readonly waiters: ((chunk: Uint8Array | null) => void)[] = [];
	private failure: unknown;

	push(chunk: Uint8Array) {
		const waiter = this.waiters.shift();
		if (waiter) waiter(chunk);
		else this.chunks.push(chunk);
	}

	/** Ends the stream: pending and later reads reject with a transport error. */
	fail(cause: unknown) {
		this.failure = cause ?? new Error('closed');
		for (const w of this.waiters.splice(0)) w(null);
	}

	read(timeoutMs: number): Promise<Uint8Array | null> {
		const chunk = this.chunks.shift();
		if (chunk) return Promise.resolve(chunk);
		if (this.failure !== undefined) return Promise.reject(this.closed());
		return new Promise((resolve, reject) => {
			const waiter = (c: Uint8Array | null) => {
				cancel();
				if (c) resolve(c);
				else reject(this.closed());
			};
			const cancel = after(timeoutMs, () => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve(null);
			});
			this.waiters.push(waiter);
		});
	}

	private closed() {
		return new BridgeError('transport', 'The device stream is closed', { cause: this.failure });
	}
}
