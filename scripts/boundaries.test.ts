// The import boundaries eslint.config.js derives from ARCHITECTURE §5 and §9, and its rule that a
// workspace package is imported by name, run through ESLint with the repository's own config on
// code at paths that need not exist.

import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
const RULES = new Set(['no-restricted-imports', 'no-restricted-globals']);

/** The boundary rules that report on `code` placed at `filePath`. */
async function broken(filePath: string, code: string): Promise<string[]> {
	const [result] = await eslint.lintText(code, { filePath });
	return result!.messages.flatMap((m) => (m.ruleId && RULES.has(m.ruleId) ? [m.ruleId] : []));
}

const IMPORTS = 'no-restricted-imports';
const GLOBALS = 'no-restricted-globals';

describe('import boundaries', () => {
	it.each([
		['core imports a Node module', 'packages/core/src/a.ts', "import 'node:fs';", [IMPORTS]],
		[
			'core imports a workspace package',
			'packages/core/src/a.ts',
			"import '@potatosalad775/eqcaps-client';",
			[IMPORTS]
		],
		['core imports its own file', 'packages/core/src/a.ts', "import './b.ts';", []],
		['a core test imports vitest', 'packages/core/src/a.test.ts', "import 'vitest';", []],
		[
			'client imports the bridge',
			'packages/client/src/a.ts',
			"import '@potatosalad775/eqcaps-device-bridge';",
			[IMPORTS]
		],
		[
			'client imports core',
			'packages/client/src/a.ts',
			"import '@potatosalad775/eqcaps-core';",
			[]
		],
		[
			"build imports the bridge's browser subpath",
			'packages/build/src/a.ts',
			"import '@potatosalad775/eqcaps-device-bridge/browser';",
			[IMPORTS]
		],
		[
			'build imports client',
			'packages/build/src/a.ts',
			"import '@potatosalad775/eqcaps-client';",
			[]
		],
		[
			'bridge src imports client',
			'packages/device-bridge/src/a.ts',
			"import '@potatosalad775/eqcaps-client';",
			[IMPORTS]
		],
		[
			'bridge src imports core',
			'packages/device-bridge/src/a.ts',
			"import '@potatosalad775/eqcaps-core';",
			[]
		],
		[
			'a handler imports a browser transport',
			'packages/device-bridge/src/handlers/a.ts',
			"import '../browser/webhid.ts';",
			[IMPORTS]
		],
		[
			'a handler imports the browser subpath',
			'packages/device-bridge/src/handlers/a.ts',
			"import '@potatosalad775/eqcaps-device-bridge/browser';",
			[IMPORTS]
		],
		[
			'a handler uses navigator',
			'packages/device-bridge/src/handlers/a.ts',
			'export const hid = navigator.hid;',
			[GLOBALS]
		],
		[
			'src/browser uses navigator',
			'packages/device-bridge/src/browser/a.ts',
			'export const hid = navigator.hid;',
			[]
		],
		[
			'src/browser imports the transports',
			'packages/device-bridge/src/browser/a.ts',
			"import '../transport.ts';",
			[]
		],
		[
			'src/browser imports client',
			'packages/device-bridge/src/browser/a.ts',
			"import '@potatosalad775/eqcaps-client';",
			[IMPORTS]
		],
		[
			"a bridge test imports build's src by path",
			'packages/device-bridge/test/a.test.ts',
			"import '../../build/src/node.ts';",
			[IMPORTS]
		],
		[
			'a bridge test imports build by name',
			'packages/device-bridge/test/a.test.ts',
			"import '@potatosalad775/eqcaps-build/node';",
			[]
		],
		[
			"a script imports core's src by path",
			'scripts/a.ts',
			"import '../packages/core/src/index.ts';",
			[IMPORTS]
		],
		[
			"client src imports core's src by path",
			'packages/client/src/a.ts',
			"import '../../core/src/index.ts';",
			[IMPORTS]
		],
		[
			'a bridge test imports its own src',
			'packages/device-bridge/test/a.test.ts',
			"import '../src/index.ts';",
			[]
		],
		[
			'a bridge test imports client',
			'packages/device-bridge/test/a.test.ts',
			"import '@potatosalad775/eqcaps-client';",
			[]
		]
	])('%s', async (_, filePath, code, expected) => {
		expect(await broken(filePath, code)).toEqual(expected);
	});
});
