import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
	fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
	resolve: {
		// Same mapping as the `paths` in tsconfig.json: tests run against sources, not dist/.
		alias: {
			'@potatosalad775/eqcaps-core': src('core'),
			'@potatosalad775/eqcaps-client': src('client'),
			'@potatosalad775/eqcaps-build': src('build'),
			'@potatosalad775/eqcaps-device-bridge/browser': fileURLToPath(
				new URL('./packages/device-bridge/src/browser/index.ts', import.meta.url)
			),
			'@potatosalad775/eqcaps-device-bridge': src('device-bridge')
		}
	},
	test: {
		include: ['packages/*/{src,test}/**/*.test.ts', 'scripts/**/*.test.ts']
	}
});
