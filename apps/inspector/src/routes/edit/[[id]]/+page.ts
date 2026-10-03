import type { PageLoad } from './$types';

// Not prerendered: ids come from the data, which changes without a redeploy of the app.
export const prerender = false;

export const load: PageLoad = ({ params }) => ({ id: params.id ?? null });
