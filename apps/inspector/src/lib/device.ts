// The inspector never writes to a device (invariant 9, D40). This is the one module that opens
// a device bridge device, and what it hands out has no `push` or `setEnabled`: only reads.
// no-writes.test.ts checks that nothing else in the inspector imports a way to write.

import { openDevice, type BridgeDevice } from '@potatosalad775/eqcaps-device-bridge';

/** A bridge device without its writing methods. */
export type ReadOnlyDevice = Pick<
	BridgeDevice,
	'transport' | 'protocol' | 'identity' | 'capabilities' | 'pull'
>;

/** `openDevice`, minus `push` and `setEnabled`. */
export function openReadOnly(...args: Parameters<typeof openDevice>): ReadOnlyDevice {
	const d = openDevice(...args);
	return {
		transport: d.transport,
		protocol: d.protocol,
		identity: d.identity,
		capabilities: d.capabilities,
		pull: (request) => d.pull(request)
	};
}
