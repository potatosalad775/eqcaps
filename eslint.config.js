import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

// docs/ARCHITECTURE.md §5: the workspace packages each package's src may import.
const MAY_IMPORT = {
	core: [],
	client: ['core'],
	build: ['core', 'client'],
	'device-bridge': ['core']
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `no-restricted-imports` patterns for the workspace packages `pkg` may not import. */
function packageBans(pkg) {
	const allowed = MAY_IMPORT[pkg];
	return Object.keys(MAY_IMPORT)
		.filter((other) => other !== pkg && !allowed.includes(other))
		.map((other) => ({
			regex: `^${escape(`@potatosalad775/eqcaps-${other}`)}(/|$)`,
			message: `ARCHITECTURE §5: ${pkg} may import ${allowed.join(' and ')} only, not ${other}. Move what both need into a package ${pkg} may import.`
		}));
}

// core has no dependencies at all, which covers the workspace packages too.
const CORE_BANS = [
	{
		regex: '^(?!\\.\\.?/)',
		message:
			'ARCHITECTURE §5: core has zero dependencies and no environment types. Import only its own files, by relative path.'
	}
];

// Handlers see only the transports in src/transport.ts; the browser's are in src/browser/.
const BROWSER_IMPORT = {
	regex: '(^|/)browser(/|$)',
	message:
		'ARCHITECTURE §9: outside src/browser/, the bridge sees only the transports in src/transport.ts. Take a transport as a parameter.'
};
const BROWSER_GLOBALS = ['navigator', 'window', 'document'].map((name) => ({
	name,
	message: `ARCHITECTURE §9: outside src/browser/, the bridge sees only the transports in src/transport.ts. Use ${name} in src/browser/ and pass a transport in.`
}));

// A workspace package is imported by its name, from anywhere: a path into its src/ skips its
// exports and the aliases in tsconfig.json and vitest.config.ts.
const BY_NAME = {
	regex: `^(\\.\\.?/)+(packages/)?(${Object.keys(MAY_IMPORT).join('|')})/src/`,
	message:
		'Import a workspace package by its name (@potatosalad775/eqcaps-<package>, or its /node or /browser subpath), not by a path into its src/.'
};

// Every entry carries BY_NAME: a flat config replaces a rule's options instead of merging them.
const restrictImports = (patterns) => ({
	'no-restricted-imports': ['error', { patterns: [BY_NAME, ...patterns] }]
});
const BRIDGE = 'packages/device-bridge/src';

const boundaries = [
	{ rules: restrictImports([]) },
	...Object.keys(MAY_IMPORT).map((pkg) => ({
		files: [`packages/${pkg}/src/**`],
		ignores: ['**/*.test.ts'],
		rules: restrictImports(pkg === 'core' ? CORE_BANS : packageBans(pkg))
	})),
	{
		// Replaces the bridge's entry above for these files, so it repeats the package bans.
		files: [`${BRIDGE}/**`],
		ignores: ['**/*.test.ts', `${BRIDGE}/browser/**`],
		rules: {
			...restrictImports([...packageBans('device-bridge'), BROWSER_IMPORT]),
			'no-restricted-globals': ['error', ...BROWSER_GLOBALS]
		}
	}
];

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.node },
			parserOptions: {
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		// The inspector runs in the browser; its Vite config runs in Node.
		files: ['apps/inspector/src/**'],
		languageOptions: { globals: { ...globals.browser } }
	},
	{
		// Userscripts run in the vendor app's page.
		files: ['tools/userscripts/**'],
		languageOptions: { globals: { ...globals.browser } }
	},
	...boundaries,
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	}
);
