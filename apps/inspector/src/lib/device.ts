// The inspector never writes to a device (invariant 9, D40). This is the one module that opens
// a device bridge device, and what it hands out has no `push` or `setEnabled`: only reads.
// no-writes.test.ts checks that nothing else in the inspector imports a way to write.

import { openDevice, type BridgeDevice } from '@potatosalad775/eqcaps-device-bridge';

/** A bridge device without its writing methods, viewed as one of its EQs (`eq`). */
export type ReadOnlyDevice = Pick<
	BridgeDevice,
	'transport' | 'protocol' | 'identity' | 'capabilities' | 'pull'
> & {
	/** The device viewed as another of its EQs (SPEC §9.2), read-only too. */
	eq(id?: string): ReadOnlyDevice;
};

const readOnly = (d: BridgeDevice): ReadOnlyDevice => ({
	transport: d.transport,
	protocol: d.protocol,
	identity: d.identity,
	capabilities: d.capabilities,
	pull: (request) => d.pull(request),
	eq: (id) => readOnly(d.eq(id))
});

/** `openDevice`, minus `push` and `setEnabled`. */
export function openReadOnly(...args: Parameters<typeof openDevice>): ReadOnlyDevice {
	return readOnly(openDevice(...args));
}
