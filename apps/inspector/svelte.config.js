import adapter from '@sveltejs/adapter-static';

// Pages serves the site under /eqcaps/ (DECISIONS D24). Unset for local dev and preview.
const BASE_PATH = process.env.BASE_PATH || '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			pages: 'dist',
			assets: 'dist',
			// A static SPA: pages with a parameter (/p/<id>) are not prerendered. GitHub Pages
			// answers every unknown path with 404.html, which boots the app on the right route.
			fallback: '404.html',
			precompress: false
		}),
		paths: { base: BASE_PATH }
	},
	vitePlugin: {
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
};

export default config;
