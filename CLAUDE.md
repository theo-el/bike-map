# Bike Map

## What this is

A multi-operator micromobility map: live vehicle locations from several operators on one map, destination search, and a routed price/time comparison between operators for a given trip. Long-term vision is "Google Maps for micromobility" — eventually including zone-aware navigation (no-parking/no-ride zones, geofencing).

## Architecture

- **Frontend**: static site, no framework, no build step. `index.html` / `app.js` / `config.js` / `style.css`. Leaflet + OpenStreetMap tiles. Deployed on GitHub Pages.
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

- Mobile (`max-width: 640px`): map fills the viewport. A collapsible strip at the top (default collapsed) shows operator counts; the destination search is a single full-width bar below it. The trip card is a bottom sheet — collapsed shows one summary line (e.g. "Dott · 12 min · CHF 3.40"), tap to expand, swipe down to dismiss. Refresh and "locate me" are floating action buttons bottom-right (thumb reach); both hide while the sheet is open so it never renders underneath them. Vehicle markers use a divIcon with a 44px invisible tap target around the visible dot. Inputs are 16px+ to avoid iOS auto-zoom, and top/bottom chrome respects `env(safe-area-inset-*)`.
- Desktop: unchanged top-left stacked panel; Refresh/locate are small inline buttons in the header, trip card always shows expanded.
- Geolocation: requested automatically on load via `watchPosition` (silent on denial, no repeated re-prompting), centres the map once on first fix, tracks your marker continuously, and is used as the walk-leg origin instead of the old click-to-set-location (removed this slice). "Locate me" re-centres if known, otherwise is the one deliberate retry path.

## Roadmap next

1. Add a Fluctuo Pro API key to the Worker (paid, real multi-operator feed).
2. Switch the app from Zurich to London.
3. Replace placeholder pricing with real London tariffs.
4. Field testing.
5. PWA.
6. Zone overlays (no-parking/no-ride).
7. Operator deep links (open the right app to actually rent the vehicle).
