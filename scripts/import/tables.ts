// Hand-curated inputs of the seed import (DECISIONS D23, D31). Everything here is a fact taken
// from a cited source, or a naming choice for a permanent profile id. Review before re-running.

/** What a devicePEQ handler file puts on the wire (research/prior-art.md §2, checked in code). */
export interface Codec {
	/** Prefix of the base ids built from this codec. */
	family: string;
	/** Wire grids. Missing = the wire carries a float or JSON number. */
	freqStep?: number;
	gainStep?: number;
	qStep?: number;
	/** Wire limits, intersected with devicePEQ's constraints. */
	gain?: [number, number];
	q?: [number, number];
	/**
	 * Preamp: `writes` = the handler writes the host's preamp when deviceHandlesPregain is false,
	 * with `preamp` as its wire domain; `ignores` = it never sends one; `unknown` = it sends one
	 * whose range isn't known.
	 */
	preamp: 'writes' | 'ignores' | 'unknown';
	/** Wire domain of the preamp. `gain` = the model's own gain range on the gain grid. */
	preampDomain?: { min: number; max: number; step: number } | 'gain';
}

const INT8_DB = { min: -128, max: 127, step: 1 };

/** Keyed by the upstream handler file. */
export const CODECS: Record<string, Codec> = {
	'fiioUsbHidHandler.js': {
		family: 'fiio',
		freqStep: 1,
		gainStep: 0.1,
		qStep: 0.01,
		preamp: 'writes',
		preampDomain: 'gain'
	},
	'fiioUsbSerialHandler.js': {
		family: 'fiio',
		freqStep: 1,
		gainStep: 0.1,
		qStep: 0.01,
		preamp: 'writes',
		preampDomain: 'gain'
	},
	'fiioSppSerialHandler.js': {
		family: 'fiio-spp',
		freqStep: 1,
		gainStep: 0.1,
		qStep: 0.01,
		preamp: 'ignores'
	},
	'fiioBleHandler.js': {
		family: 'fiio-spp',
		freqStep: 1,
		gainStep: 0.1,
		qStep: 0.01,
		preamp: 'ignores'
	},
	'walkplayHidHandler.js': {
		family: 'walkplay',
		freqStep: 1,
		gainStep: 1 / 256,
		qStep: 1 / 256,
		preamp: 'writes',
		preampDomain: INT8_DB
	},
	'moondropUsbHidHandler.js': {
		family: 'moondrop',
		freqStep: 1,
		gainStep: 1 / 256,
		qStep: 1 / 256,
		preamp: 'writes',
		preampDomain: { min: -128, max: 32767 / 256, step: 1 / 256 }
	},
	'moondropOldFashionedUsbHidHandler.js': {
		family: 'moondrop-old-fashioned',
		freqStep: 1,
		gainStep: 0.1,
		gain: [-12.8, 12.7],
		qStep: 0.001,
		preamp: 'ignores'
	},
	'conexantUsbHidHandler.js': {
		family: 'conexant',
		freqStep: 1,
		gainStep: 1 / 256,
		qStep: 1 / 256,
		preamp: 'ignores'
	},
	'ktmicroUsbHidHandler.js': {
		family: 'ktmicro',
		freqStep: 1,
		gainStep: 0.1,
		qStep: 0.001,
		preamp: 'writes',
		preampDomain: INT8_DB
	},
	'fosiAudioUsbHidHandler.js': { family: 'fosi-audio', preamp: 'ignores' },
	'jdsLabsUsbSerialHandler.js': { family: 'jds-labs', preamp: 'unknown' },
	'nothingUsbSerialHandler.js': { family: 'nothing', preamp: 'unknown' },
	'ritaUsbSerialHandler.js': {
		family: 'tanchjim-rita',
		freqStep: 1,
		gainStep: 0.01,
		qStep: 0.01,
		preamp: 'ignores'
	},
	'moondropEdgeUsbSerialHandler.js': {
		family: 'moondrop-edge',
		freqStep: 1,
		gainStep: 1 / 60,
		qStep: 1 / 4096,
		preamp: 'ignores'
	},
	'edifierUsbSerialHandler.js': {
		family: 'edifier',
		gainStep: 0.25,
		gain: [-6, 6],
		qStep: 1 / 14,
		q: [0.5, 5],
		preamp: 'ignores'
	},
	'airohaBleHandler.js': {
		family: 'airoha',
		freqStep: 0.01,
		gainStep: 0.01,
		qStep: 0.01,
		preamp: 'ignores'
	}
};

/**
 * One device (or product-id group) in devicePEQ, keyed by its config key. `brand` and `model`
 * make the permanent id `<brand>-<model>` unless `id` is given. `also` lists more config keys that
 * are the same device (USB name variants); `names` adds product names seen elsewhere (recorded
 * captures, modernGraphTool). `config` picks the key whose constraints win when variants disagree.
 */
export interface DeviceName {
	brand: string;
	model: string;
	id?: string;
	also?: string[];
	names?: string[];
	config?: string;
	notes?: string;
}

/** USB HID devices and groups of usbDeviceConfig.js. Keys missing here are not imported. */
export const HID_DEVICES: Record<string, DeviceName> = {
	// FiiO vendor block
	'FIIO QX13': { brand: 'FiiO', model: 'QX13' },
	'SNOWSKY Melody': { brand: 'Snowsky', model: 'Melody' },
	'JadeAudio JIEZI': { brand: 'JadeAudio', model: 'JIEZI' },
	'JadeAudio JA11': { brand: 'JadeAudio', model: 'JA11' },
	'FIIO KA17': { brand: 'FiiO', model: 'KA17', also: ['FIIO KA17 (MQA HID)'] },
	'FIIO Q7': { brand: 'FiiO', model: 'Q7' },
	'FIIO BT11': { brand: 'FiiO', model: 'BT11', also: ['FIIO BT11 (UAC1.0)'] },
	'FIIO Air Link': { brand: 'FiiO', model: 'Air Link' },
	'FIIO BTR13': { brand: 'FiiO', model: 'BTR13' },
	'FIIO BTR17': { brand: 'FiiO', model: 'BTR17', also: ['BTR17'] },
	'FIIO K19': { brand: 'FiiO', model: 'K19' },
	'FIIO K17': { brand: 'FiiO', model: 'K17' },
	'FIIO K15': { brand: 'FiiO', model: 'K15' },
	'FIIO KA15': { brand: 'FiiO', model: 'KA15' },
	'FIIO K13 R2R': { brand: 'FiiO', model: 'K13 R2R' },
	'FIIO BR15 R2R': { brand: 'FiiO', model: 'BR15 R2R' },
	'FIIO FP3': { brand: 'FiiO', model: 'FP3' },
	'SNOWSKY TINY A': { brand: 'Snowsky', model: 'Tiny A' },
	'SNOWSKY TINY B': { brand: 'Snowsky', model: 'Tiny B' },
	'FIIO FG3': { brand: 'FiiO', model: 'FG3' },
	'FIIO LS-TC2': { brand: 'FiiO', model: 'LS-TC2', names: ['LS-TC2'] },
	'FIIO OAK NANO': { brand: 'FiiO', model: 'Oak Nano', also: ['Oak Nano'] },
	'RETRO NANO': { brand: 'FiiO', model: 'Retro Nano' },
	'FIIO QX11': { brand: 'FiiO', model: 'QX11' },
	'FIIO AIR AMP': { brand: 'FiiO', model: 'Air Amp' },
	'FIIO DM15 R2R': { brand: 'FiiO', model: 'DM15 R2R' },
	'WalkPlay-SchemeNo10': {
		brand: 'Walkplay',
		model: 'SchemeNo10 devices',
		id: 'walkplay-schemeno10-devices'
	},

	// Walkplay vendor block: product-id groups
	SchemeNo10: { brand: 'Walkplay', model: 'SchemeNo10 devices' },
	SchemeNo11: { brand: 'Walkplay', model: 'SchemeNo11 devices' },
	SchemeNo13: { brand: 'Walkplay', model: 'SchemeNo13 devices' },
	SchemeNo15: { brand: 'Walkplay', model: 'SchemeNo15 devices' },
	SchemeNo16: { brand: 'Walkplay', model: 'SchemeNo16 devices' },
	SchemeNo17: { brand: 'Walkplay', model: 'SchemeNo17 devices' },
	SchemeNo18: { brand: 'Walkplay', model: 'SchemeNo18 devices' },
	SchemeNo19: { brand: 'Walkplay', model: 'SchemeNo19 devices' },
	SchemeNo20: { brand: 'Walkplay', model: 'SchemeNo20 devices' },
	SchemeNo21: { brand: 'Walkplay', model: 'SchemeNo21 devices' },

	// Walkplay vendor block: named devices
	'TANCHJIM-SPACE PRO': { brand: 'Tanchjim', model: 'Space Pro' },
	'TANCHJIM-OLA II DSP': { brand: 'Tanchjim', model: 'OLA II DSP' },
	'Old Fashioned': { brand: 'Moondrop', model: 'Old Fashioned' },
	'FIIO FX17': { brand: 'FiiO', model: 'FX17', names: ['FIIO FX17 '] },
	Rays: { brand: 'Moondrop', model: 'Rays' },
	Marigold: { brand: 'Moondrop', model: 'Marigold', also: ['MOONDROP Marigold'] },
	'FreeDSP Pro': { brand: 'Moondrop', model: 'FreeDSP Pro' },
	'MOONRIVER 3': { brand: 'Moondrop', model: 'Moonriver 3' },
	'FreeDSP Mini': { brand: 'Moondrop', model: 'FreeDSP Mini' },
	FreeDSP: {
		brand: 'Moondrop',
		model: 'FreeDSP',
		names: ['Moondrop FreeDSP'],
		notes:
			'AutoEQ optimizes for this device with 9 peaking filters, Q 0.5-6, 40 Hz-10 kHz and -12/+3 dB (PEQ_CONFIGS MOONDROP_FREE_DSP), which may be the vendor app limits.'
	},
	'DAWN PRO 2': {
		brand: 'Moondrop',
		model: 'Dawn Pro 2',
		also: ['DAWN PRO2'],
		config: 'DAWN PRO 2',
		notes:
			'devicePEQ has two entries for this device: "DAWN PRO 2" (Walkplay handler, ±10 dB) and "DAWN PRO2" (Moondrop handler, ±12 dB). This profile takes the narrower one.'
	},
	'Echo A': { brand: 'Moondrop', model: 'Echo A', names: ['ECHO-A'] },
	'ECHO-B': { brand: 'Moondrop', model: 'ECHO-B', names: ['Moondrop ECHO-B'] },
	'AG Rays': { brand: 'Moondrop', model: 'AG Rays' },
	DHA15: { brand: 'Moondrop', model: 'DHA15' },
	'Deco Audio System': { brand: 'Moondrop', model: 'Deco Audio System' },
	'INN Deco75-DH Audio': { brand: 'Moondrop', model: 'INN Deco75-DH Audio' },
	'ddHiFi DSP IEM - Memory': { brand: 'ddHiFi', model: 'DSP IEM' },
	'Protocol Max': { brand: 'CrinEar', model: 'Protocol Max' },
	Octave: { brand: 'NiceHCK', model: 'Octave' },
	'CS43131 HiFi Audio DSP': { brand: 'Walkplay', model: 'CS43131 HiFi Audio DSP' },
	'CS43198 HiFi DSP Audio': { brand: 'Walkplay', model: 'CS43198 HiFi DSP Audio' },
	'BGVP MX1': { brand: 'BGVP', model: 'MX1' },
	DT04: { brand: 'Letshuoer', model: 'DT04' },
	'MD-QT-042': { brand: 'Moondrop', model: 'MD-QT-042' },
	'MOONDROP HiFi with PD': { brand: 'Moondrop', model: 'HiFi with PD' },
	CS431XX: { brand: 'Walkplay', model: 'CS431XX' },
	'ES9039 ': { brand: 'Walkplay', model: 'ES9039' },
	'TANCHJIM-STARGATE II': { brand: 'Tanchjim', model: 'Stargate II' },
	'ddHiFi DSP Cable - Memory': {
		brand: 'ddHiFi',
		model: 'DSP Cable',
		also: ['didiHiFi DSP Cable - Memory']
	},
	'Dual CS43198': { brand: 'Walkplay', model: 'Dual CS43198' },
	'ES9039 HiFi DSP Audio': { brand: 'Walkplay', model: 'ES9039 HiFi DSP Audio' },
	'TRUTHEAR KEYX': { brand: 'Truthear', model: 'KEYX', names: ['Truthear KEYX'] },

	// KT Micro vendor block
	'Kiwi Ears-Allegro PRO': { brand: 'Kiwi Ears', model: 'Allegro Pro' },
	'Kiwi Ears-Allegro Mini': {
		brand: 'Kiwi Ears',
		model: 'Allegro Mini',
		also: ['Kiwi Ears Allegro Mini']
	},
	'KT02H20 HIFI Audio': { brand: 'JCally', model: 'KT02H20' },
	'TANCHJIM-ONE DSP': { brand: 'Tanchjim', model: 'One DSP' },
	'TANCHJIM BUNNY DSP': { brand: 'Tanchjim', model: 'Bunny DSP' },
	'TANCHJIM FISSION': { brand: 'Tanchjim', model: 'Fission', also: ['TANCHJIM-FISSION  DSP'] },
	CDSP: { brand: 'Moondrop', model: 'CDSP' },
	'Chu2 DSP': { brand: 'Moondrop', model: 'Chu 2 DSP' },
	'Kiwi Ears KT_1132L': {
		brand: 'Kiwi Ears',
		model: 'Chorus',
		notes: 'Product id 0x1132 is the Chorus; 0x3006 is a sibling devicePEQ groups with it.'
	},
	'Kiwi Ears KT_0211L': {
		brand: 'Kiwi Ears',
		model: 'KT0211L devices',
		notes: 'devicePEQ matches this product id only as a variant of the Allegro family.'
	},
	'Kiwi Ears KT_3016L': { brand: 'Kiwi Ears', model: 'S-Link', names: ['Kiwi Ears S-Link'] },

	// Fosi Audio vendor block
	'Fosi Audio DS3': { brand: 'Fosi Audio', model: 'DS3' }
};

/**
 * Devices modernGraphTool registers that upstream devicePEQ lacks
 * (src/lib/device-peq/handlers/walkplay-hid.ts). They get the constraints of the upstream
 * product-id group their recorded capture falls in. Names already covered upstream are added
 * through `names` above; devices whose brand is unknown (AE6, KM_HA03, DA5, G303, Hi-MAX,
 * TP35 Pro) are left to their product-id group.
 */
export const MGT_DEVICES: Record<string, DeviceName & { group: string }> = {
	'EPZ TP13 AI ENC audio': { brand: 'EPZ', model: 'TP13', group: 'SchemeNo11' },
	Quark2: { brand: 'Moondrop', model: 'Quark2', group: 'SchemeNo11' },
	'HiFi DSP Audio with PD': {
		brand: 'ddHiFi',
		model: 'HiFi DSP Audio with PD',
		group: 'SchemeNo16'
	}
};

/** USB serial and Bluetooth devices of usbSerialDeviceConfig.js and bluetoothBleDeviceConfig.js. */
export const SERIAL_DEVICES: Record<string, DeviceName> = {
	'Element IV': { brand: 'JDS Labs', model: 'Element IV' },
	'Nothing Headphones': { brand: 'Nothing', model: 'Headphone (1)' },
	'FiiO Audio DSP': { brand: 'FiiO', model: 'Audio DSP' },
	'FiiO EH11': { brand: 'FiiO', model: 'EH11' },
	'FiiO EH13': { brand: 'FiiO', model: 'EH13' },
	'Tanchjim Rita': { brand: 'Tanchjim', model: 'Rita' },
	'Moondrop Edge': { brand: 'Moondrop', model: 'Edge' },
	'Edifier W830NB': { brand: 'Edifier', model: 'W830NB' },
	'Audeze Maxwell': { brand: 'Audeze', model: 'Maxwell' }
};

/**
 * Not imported, with the reason. Listed so the next person doesn't redo the analysis.
 */
export const NOT_IMPORTED: Record<string, string> = {
	'Space Gaming IEM':
		'devicePEQ marks its protocol a guess by vendor id; no response from the device was ever observed.',
	'EarFun Tune Pro':
		'the handler writes a fixed Q code (0x0B33) whose RBJ value is unknown, so no q domain can be stated.',
	WiiM: 'a network device; the format has no network identity to match it by.',
	Luxsin: 'a network device; the format has no network identity to match it by.',
	'AE6, KM_HA03, DA5, G303, Hi-MAX, TP35 Pro (modernGraphTool)':
		'brand unknown; these devices still match through their product-id group.',
	'MINIDSP_2X4HD, MINIDSP_IL_DSP (AutoEQ)': 'hardware without any device identity in the source.',
	'AUNBANDEQ (AutoEQ)': 'not clear which app this is.',
	'10_BAND_GRAPHIC_EQ, 31_BAND_GRAPHIC_EQ, *_PEAKING* (AutoEQ)': 'optimizer presets, not engines.'
};

/**
 * AutoEQ PEQ_CONFIGS entries that describe a real engine. Only the facts that read as engine
 * limits are taken: band count, gain range, peaking Q range, fixed bands. AutoEQ's own choices
 * (shelves fixed at 105 Hz / 10 kHz with Q 0.7, peaks capped at 10 kHz) are not limits.
 */
export interface AutoEqEngine {
	key: string;
	id: string;
	brand: string;
	model: string;
	kind: 'software' | 'hardware';
	bandCount: number;
	shelves: boolean;
	gain: [number, number];
	q?: [number, number];
	/** Graphic EQ: fixed centre frequencies and Q. */
	fixed?: { freqs: number[]; q: number };
	usb?: { vendorId: string; productId: string; productName: string };
}

export const AUTOEQ_ENGINES: AutoEqEngine[] = [
	{
		key: 'SPOTIFY',
		id: 'spotify',
		brand: 'Spotify',
		model: 'Equalizer',
		kind: 'software',
		bandCount: 6,
		shelves: false,
		gain: [-12, 12],
		fixed: { freqs: [60, 150, 400, 1000, 2400, 15000], q: 1 }
	},
	{
		key: 'POWERAMP_EQUALIZER',
		id: 'poweramp-equalizer',
		brand: 'Poweramp',
		model: 'Equalizer',
		kind: 'software',
		bandCount: 10,
		shelves: true,
		gain: [-15, 15],
		q: [0.1, 12]
	},
	{
		key: 'NEUTRON_MUSIC_PLAYER',
		id: 'neutron-music-player',
		brand: 'Neutron',
		model: 'Music Player',
		kind: 'software',
		bandCount: 10,
		shelves: true,
		gain: [-12, 12],
		q: [0.1, 5]
	},
	{
		key: 'USB_AUDIO_PLAYER_PRO',
		id: 'usb-audio-player-pro',
		brand: 'USB Audio Player PRO',
		model: 'Parametric EQ',
		kind: 'software',
		bandCount: 10,
		shelves: true,
		gain: [-20, 20],
		q: [0.1, 10]
	},
	{
		key: 'QUDELIX_5K',
		id: 'qudelix-5k',
		brand: 'Qudelix',
		model: '5K',
		kind: 'hardware',
		bandCount: 10,
		shelves: true,
		gain: [-12, 12],
		q: [0.1, 7],
		// From devicePEQ tests/captures/qudelix_qudelix_5k.json.
		usb: { vendorId: '0x0a12', productId: '0x4005', productName: 'Qudelix-5K USB DAC 48KHz' }
	}
];
