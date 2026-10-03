# @potatosalad775/eqcaps-client

Fetches, caches and matches [eqcaps](https://github.com/potatosalad775/eqcaps) EQ constraint
profiles. Zero runtime dependencies besides `@potatosalad775/eqcaps-core`, no DOM types, works in
browsers, Node and WebViews.

```ts
import { createClient, webStorageStore } from '@potatosalad775/eqcaps-client';
import { fit, complete, validateList } from '@potatosalad775/eqcaps-core';

const client = createClient({ store: webStorageStore(localStorage) });

// What WebHID (or a native USB plugin) reports for the connected device.
const { best, matches } = await client.matchDevice({
	usb: { vendorId: device.vendorId, productId: device.productId, productName: device.productName }
});
const profile = best && (await client.loadProfile(best.id));
if (profile) {
	const problems = validateList(profile, filters); // while editing: flag, don't rewrite
	const result = fit(profile, filters, preamp); // before writing: what to send
	const slots = complete(profile, result.slots).filters; // every slot, neutral fillers included
}
```

- **Never throws, never blocks.** Every failure (offline, HTTP error, malformed data, a full
  cache) resolves to `null` or no matches and is reported to `onError`. The app keeps working
  without constraints.
- **Caching.** `index.json` and `bundle.json` are fresh for `ttl` (default 24 h), then revalidated
  with their ETag. Profiles are cached by the `sha256` the index lists for them. The store is
  pluggable: `memoryStore()` (default), `webStorageStore(localStorage)`, or your own `CacheStore`.
- **Offline.** Pass an embedded `bundle.json` as `snapshot`; it answers whenever neither the network
  nor the cache can.
- **Matching** follows the format's specificity rules: `best` is set only for a unique top match.
  On a tie (`ambiguous`), let the user choose. Deprecated profiles never match.

The default `baseUrl` is the format's channel `V1_URL`
(`https://potatosalad775.github.io/eqcaps/v1/`). Versions before 0.2.0 defaulted to the pre-freeze
channel `NEXT_URL`, which is still served.

License: MIT. The data it fetches is CC0-1.0.
