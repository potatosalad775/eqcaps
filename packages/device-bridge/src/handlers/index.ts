import { airoha } from './airoha.ts';
import { conexantUsbHid } from './conexant-usb-hid.ts';
import { edifierSerial } from './edifier-serial.ts';
import { fiioF110 } from './fiio-f110.ts';
import { fiioUsbHid } from './fiio-usb-hid.ts';
import { fiioUsbSerial } from './fiio-usb-serial.ts';
import { fosiAudioUsbHid } from './fosi-audio-usb-hid.ts';
import { jdsLabsUsbSerial } from './jds-labs-usb-serial.ts';
import { ktmicroUsbHid } from './ktmicro-usb-hid.ts';
import { moondropEdgeSerial } from './moondrop-edge-serial.ts';
import { moondropOldFashionedHid } from './moondrop-old-fashioned-hid.ts';
import { moondropUsbHid } from './moondrop-usb-hid.ts';
import { nothingUsbSerial } from './nothing-usb-serial.ts';
import { qudelixUsbHid } from './qudelix-usb-hid.ts';
import { tanchjimRitaSerial } from './tanchjim-rita-serial.ts';
import { walkplayHid } from './walkplay-hid.ts';

/** Every handler, by id. */
export const HANDLERS = {
	'fiio-usb-hid': fiioUsbHid,
	'walkplay-hid': walkplayHid,
	'moondrop-usb-hid': moondropUsbHid,
	'moondrop-old-fashioned-hid': moondropOldFashionedHid,
	'conexant-usb-hid': conexantUsbHid,
	'ktmicro-usb-hid': ktmicroUsbHid,
	'fosi-audio-usb-hid': fosiAudioUsbHid,
	'qudelix-usb-hid': qudelixUsbHid,
	'jds-labs-usb-serial': jdsLabsUsbSerial,
	'nothing-usb-serial': nothingUsbSerial,
	'fiio-usb-serial': fiioUsbSerial,
	'fiio-f110': fiioF110,
	'tanchjim-rita-serial': tanchjimRitaSerial,
	'moondrop-edge-serial': moondropEdgeSerial,
	'edifier-serial': edifierSerial,
	airoha
} as const;

export type Handlers = typeof HANDLERS;
export type HandlerId = keyof Handlers;
export type HandlerOptions<K extends HandlerId> = Handlers[K] extends {
	capabilities(transport: never, options: infer O): unknown;
}
	? O
	: never;
