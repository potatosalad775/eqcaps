import { base } from '$app/paths';

/**
 * The data channel the app reads: /next/ on the app's own origin (Pages, or the local build in
 * dev). VITE_EQCAPS_DATA overrides it, e.g. to try the live /next/ from a dev server.
 */
export function dataUrl(): string {
	const configured = import.meta.env.VITE_EQCAPS_DATA as string | undefined;
	return configured || new URL(`${base}/next/`, location.href).href;
}
