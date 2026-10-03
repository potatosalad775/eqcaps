import { base } from '$app/paths';
import { REPO_URL } from './repo.ts';

/**
 * The data channel the app reads: /v1/ on the app's own origin (Pages, or the local build in
 * dev). VITE_EQCAPS_DATA overrides it, e.g. to try the live /v1/ from a dev server.
 */
export function dataUrl(): string {
	const configured = import.meta.env.VITE_EQCAPS_DATA as string | undefined;
	return configured || new URL(`${base}/v1/`, location.href).href;
}

/**
 * Where the editor reads authoring files (the repository's data/, with `extends` and bases): the
 * dev server's copy of the local checkout, else main on GitHub. VITE_EQCAPS_SOURCES overrides it.
 */
export function sourcesUrl(): string {
	const configured = import.meta.env.VITE_EQCAPS_SOURCES as string | undefined;
	if (configured) return configured;
	if (import.meta.env.DEV) return new URL(`${base}/data/`, location.href).href;
	return `${REPO_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/main/data/`;
}

/** The commit the app was built from (vite.config.ts). */
export const APP_COMMIT = (import.meta.env.VITE_EQCAPS_COMMIT as string | undefined) ?? 'unknown';
