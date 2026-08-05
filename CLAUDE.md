# Bike Map

## What this is

A multi-operator micromobility map: live vehicle locations from several operators on one map, destination search, and a routed price/time comparison between operators for a given trip. Long-term vision is "Google Maps for micromobility" — eventually including zone-aware navigation (no-parking/no-ride zones, geofencing).

## Architecture

- **Frontend**: static site, no framework, no build step. `index.html` / `app.js` / `config.js` / `style.css`. MapLibre GL JS + OpenFreeMap vector tiles (free, no API key; style switchable via `?style=liberty|positron`, default **positron** — chosen after comparing both live). Deployed on GitHub Pages. Vehicles render as a GPU circle layer (not DOM markers — thousands of them would lag on a phone); destination/my-location stay as regular `maplibregl.Marker` DOM elements since there's only one of each. Selected vehicle grows and gets a soft accent halo via MapLibre `setFeatureState` (not by touching the GeoJSON data), cleared explicitly at every real deselection point.
- **Design system**: CSS custom properties in `style.css` — one teal accent (`--accent`), a small grey scale, three radii, two shadow levels, Inter font with a system-font fallback. `@media (prefers-color-scheme: dark)` redefines the same tokens, so dark mode falls out of using them consistently rather than needing a parallel theme. Applied to the header strip, search bar, bottom sheet, buttons, and popups (including overriding MapLibre's own popup chrome, which defaults to a hardcoded white box).
- **Feed proxy**: `worker/` is a Cloudflare Worker that fetches operator GBFS feeds server-side, combines them into one JSON response, and caches it at the edge for 60s. Fetches happen only when a request arrives — no cron/scheduled fetching. The frontend calls this one Worker endpoint instead of hitting operator feeds directly.
- **Routing**: OSRM public demo API (routing.openstreetmap.de) for bike/foot routes, with a straight-line fallback (×1.4 detour factor) if it errors.
- **Geocoding**: Nominatim (OpenStreetMap) for destination search, bounded to the current city's viewbox.

## Key rules

- No API keys or secrets in the static site or in git. Ever. Operator config lives in `worker/wrangler.toml` `[vars]` (non-secret); real secrets go in via `wrangler secret put <NAME>`, referenced as `env.<NAME>` in `worker/src/index.js`.
- Never guess external endpoints. Verify with curl (or the official feed catalogue) before wiring anything in — this codebase has a history of guessed URLs turning out wrong.
- Build one slice at a time. Don't add features, refactors, or config beyond what was asked.
- Commit after each slice with a descriptive message (why, not just what).
- Pricing in `config.js` is placeholder test data, explicitly marked `// PLACEHOLDER`. Never present it as real tariffs.

## Current state

Live in Zurich with three free, verified GBFS feeds (Lime, Bolt, Dott) flowing through the Worker end-to-end. Frontend does one fetch on page load plus a manual Refresh button (last-updated timestamp shown); `AUTO_REFRESH_ENABLED` config toggle brings back polling, default off. Deployed at https://theo-el.github.io/bike-map/, Worker at https://bike-map-feeds.bikemaptheo.workers.dev/vehicles.

UI is mobile-first (this is primarily used on phones), desktop kept via media query rather than separate markup:

- Mobile (`max-width: 640px`): map fills the viewport. A collapsible strip at the top (default collapsed) shows operator counts (skeleton-shimmer placeholder until the first refresh completes); the destination search is a single full-width bar below it. The trip card is a bottom sheet, animated via real CSS transitions (slide up/down, expand/collapse) — collapsed shows one prominent summary line (e.g. "Dott · 12 min · CHF 3.40"), tap to expand for the quieter walk/bike-leg detail, swipe down to dismiss. Refresh and "locate me" are floating action buttons bottom-right (thumb reach); both hide while the sheet is open so it never renders underneath them, and (fixed in the visual design pass) the desktop header's own Refresh/Locate buttons are now hidden on mobile instead of showing redundantly alongside the FABs. Vehicle tap targets are a 44px-diameter near-invisible GL circle layer stacked under the 14px visible dot (see Architecture). Inputs are 16px+ to avoid iOS auto-zoom, and top/bottom chrome respects `env(safe-area-inset-*)`.
- Desktop: unchanged top-left stacked panel; Refresh/locate are small inline buttons in the header, trip card always shows expanded.
- Geolocation: requested automatically on load via `watchPosition` (silent on denial, no repeated re-prompting), centres the map once on first fix, tracks your marker continuously, and is used as the walk-leg origin instead of the old click-to-set-location (removed in the mobile-first slice). "Locate me" re-centres if known, otherwise is the one deliberate retry path. The marker itself is a pulsing accent dot, not an emoji.
- Touch: pinch-zoom and rotate are on; tilt is disabled (`maxPitch: 0`, confirmed this clamps even a direct `map.setPitch()` call).
- Operator colours are real brand colours, corrected in the visual design pass (Dott and Bolt had been swapped/wrong before): Lime green, Bolt lime-yellow, Dott blue. A dark-green shade is reserved in `config.js` comments for Forest, once London/Fluctuo adds it as a fourth operator.

### Fluctuo / London — paused, in progress

A Fluctuo trial key is stored as a Worker secret (`FLUCTUO_API_KEY`, `wrangler secret put`, never in code/git). Verified: GraphQL, `POST https://flow-api.fluctuo.com/v1?access_token=KEY`. Two findings so far, both blocking the London switch:

1. **Nearby-mode is the trial's actual architecture, not a workaround.** The trial tier excludes the bulk city query (`area(id)`/`areas`, needs `areas:read` scope this key doesn't have) by design. The only available query is `vehicles(lat, lng)` — fixed 400m radius, ~90 cost-units/call observed, trial-rate-limited to 10 requests/minute. The Worker will need to accept a lat/lng per request (from the map center or the user's location) and query near that point, rather than fetching one whole-city dataset like the Zurich GBFS path does. Throttling (queue or reject with a "try again shortly" message when over 10/min, rather than erroring) is not implemented yet — that was the next step before this got paused.
2. **Even nearby-mode isn't returning dockless operators.** Across 7 test points — including central London hotspots (Oxford Circus, Shoreditch, Liverpool Street) and a location the user personally confirmed has visible Forest bikes right now (2b Inner Park Road, SW19 6DZ) — `vehicles()` returned only Santander Cycles docked stations, zero results from Lime/HumanForest/Dott/Bolt/Voi, even with them forced via `includeProviders`. All five are registered `enabled: true` providers in Fluctuo's global `providers` query, so this looks like a separate provider-level access gap on the trial, not sparse coverage.

User has emailed Fluctuo about both issues. Work is paused pending their reply — do not guess around either blocker (e.g. don't build point-tiling for city coverage, don't assume provider access will just start working) until we hear back. The Zurich GBFS path remains the dev/demo data source in the meantime (config-switchable, so this is safe to keep building around).

## Roadmap next

1. Resolve the two Fluctuo blockers above (waiting on their support reply).
2. Implement Worker-side rate limiting/throttling for the 10 req/min trial limit.
3. Wire nearby-mode into the Worker for real, normalized into the existing vehicle format (operator, lat/lon, type, battery).
4. Switch the app from Zurich to London; restrict Nominatim search to Greater London.
5. Add pricing config entries (PLACEHOLDER) for each operator that actually shows up in London.
6. Field testing.
7. City-wide `area()` query is a Pro-tier decision, deferred until after the trial verdict.
8. PWA.
9. Zone overlays (no-parking/no-ride).
10. Operator deep links (open the right app to actually rent the vehicle).
