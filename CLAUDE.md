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

## Roadmap next

1. Add a Fluctuo Pro API key to the Worker (paid, real multi-operator feed).
2. Switch the app from Zurich to London.
3. Replace placeholder pricing with real London tariffs.
4. Field testing.
5. Mobile-first design pass.
6. PWA.
7. Zone overlays (no-parking/no-ride).
8. Operator deep links (open the right app to actually rent the vehicle).
