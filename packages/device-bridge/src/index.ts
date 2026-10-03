// @potatosalad775/eqcaps-device-bridge: reads and writes parametric EQ on audio hardware.
// Platform-free: handlers talk to the transport interfaces below. Browser transports (WebHID,
// Web Serial, Web Bluetooth) are in the `./browser` entry point.

export { BridgeError, isBridgeError } from './errors.ts';
export type { BridgeErrorCode } from './errors.ts';
export type {
	HidCollectionInfo,
	HidReportInfo,
	HidTransport,
	SerialPortIdentity,
	StreamTransport,
	Transport,
	TransportKind
} from './transport.ts';
export type {
	AnyHandler,
	Codec,
	Handler,
	HandlerCapabilities,
	HandlerContext,
	PullRequest,
	PullResult,
	PushRequest,
	PushResult,
	HidFrame,
	HidHandler,
	Slot,
	StreamHandler,
	WireField,
	WireGrid,
	WriteState
} from './handler.ts';
export { SPP } from './handler.ts';
export { HANDLERS } from './handlers/index.ts';
export type { HandlerId, HandlerOptions } from './handlers/index.ts';
export {
	guessProtocol,
	KNOWN_HID_VENDORS,
	protocolForMatches,
	protocolOf,
	protocolProblem
} from './protocols.ts';
export type { Protocol } from './protocols.ts';
export { chooserFilters } from './chooser.ts';
export type { ChooserEntry, ChooserFilters } from './chooser.ts';
export { identityOf, usbHex } from './identity.ts';
export type { DeviceIdentity } from './identity.ts';
export { analyzeCodec, handlerCodeUrl, MAX_ANALYSED_BANDS } from './analysis.ts';
export type { CodecAnalysis } from './analysis.ts';
export { openDevice, transportsOf } from './device.ts';
export type { BridgeDevice, DeviceCapabilities, OpenOptions } from './device.ts';
