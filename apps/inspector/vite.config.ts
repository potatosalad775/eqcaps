import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
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

/**
 * Serves the locally built channels (`npm run data:build` writes dist/site/next/) at /next/ in
 * dev and preview, where Pages serves them in production: the app always reads its data from
 * the same origin.
 */
function localData(): Plugin {
	const serve: Connect.NextHandleFunction = (req, res, next) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const match = /^\/(next|v1)\/(.*)$/.exec(url.pathname);
		if (!match) return next();
		const file = path.join(siteDir, match[1] as string, decodeURIComponent(match[2] as string));
		if (!file.startsWith(siteDir) || !existsSync(file) || !statSync(file).isFile()) {
			res.statusCode = 404;
			res.end(
				existsSync(siteDir)
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

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), localData()],
	// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
	resolve: { conditions: ['eqcaps:source', ...defaultClientConditions] },
	ssr: { resolve: { conditions: ['eqcaps:source', ...defaultServerConditions] } }
});
