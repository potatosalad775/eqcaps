// A static SPA (INSPECTOR §5): nothing renders on the server, and the pages without parameters
// are prerendered as shells. /p/<id> boots from the 404.html fallback.
export const ssr = false;
export const prerender = true;
