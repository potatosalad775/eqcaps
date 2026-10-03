import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	defaultClientConditions,
	defaultServerConditions,
	defineConfig,
	type Connect,
	type Plugin
} from 'vite';

const siteDir = fileURLToPath(new URL('../../dist/site/', import.meta.url));
const repoDir = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Serves the locally built channels (`npm run data:build` writes dist/site/v1/) in
 * dev and preview, where Pages serves them in production: the app always reads its data from
 * the same origin. Also serves the repository's data/ at /data/, so the editor starts from the
 * local authoring files (in production it reads them from GitHub).
 */
function localData(): Plugin {
	const serve: Connect.NextHandleFunction = (req, res, next) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const match = /^\/(v1|data)\/(.*)$/.exec(url.pathname);
		if (!match) return next();
		const dir = path.join(match[1] === 'data' ? repoDir : siteDir, match[1] as string);
		const file = path.join(dir, decodeURIComponent(match[2] as string));
		if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
			res.statusCode = 404;
			res.end(
				existsSync(siteDir) || match[1] === 'data'
					? 'Not found'
					: 'No local data: run `npm run data:build` at the repo root'
			);
			return;
		}
		res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/plain');
		res.setHeader('Cache-Control', 'no-cache');
		createReadStream(file).pipe(res);
	};
	return {
		name: 'eqcaps-local-data',
		configureServer: (server) => void server.middlewares.use(serve),
		configurePreviewServer: (server) => void server.middlewares.use(serve)
	};
}

// The commit the app is built from, for the evidence files it writes (INSPECTOR §6).
process.env.VITE_EQCAPS_COMMIT ??= (() => {
	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
})();

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), localData()],
	// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
	resolve: { conditions: ['eqcaps:source', ...defaultClientConditions] },
	ssr: { resolve: { conditions: ['eqcaps:source', ...defaultServerConditions] } }
});
