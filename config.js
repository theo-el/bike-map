// ---------------------------------------------------------------------------
// Fill these in before running the app.
// ---------------------------------------------------------------------------

// Feed data comes from our Cloudflare Worker (see worker/), which fetches
// Lime/Bolt/Dott's GBFS feeds server-side, combines them, and caches the
// result for 60s. Operator feed URLs live in worker/wrangler.toml now, not
// here — the static site only knows about this one endpoint.
//
// Zurich, Switzerland has four competing free-floating operators all listed
// in the MobilityData systems.csv catalogue with working discovery URLs —
// no guessing required. All confirmed live via curl with real vehicle
// counts and Zurich-area coordinates:
//   - Lime:  1478 vehicles
//   - Bolt:  1003 vehicles
//   - Dott:   797 vehicles
//   - Bird:   793 vehicles (excluded — its feed has no CORS headers, so a
//             browser fetch() from this app would be blocked; would need a
//             proxy to include)
// PLACEHOLDER pricing — these are test values, not real tariffs. Replace
// with each operator's actual unlock fee / per-minute rate before relying
// on the price comparison for anything real.
const FEEDS_ENDPOINT = "https://bike-map-feeds.bikemaptheo.workers.dev/vehicles";

const OPERATORS = [
  {
    id: "lime",
    name: "Lime",
    color: "#00e676", // Lime green
    pricing: { unlockFeeChf: 1.5, perMinuteChf: 0.45 }, // PLACEHOLDER
  },
  {
    id: "bolt",
    name: "Bolt",
    color: "#1565c0", // blue
    pricing: { unlockFeeChf: 1.0, perMinuteChf: 0.35 }, // PLACEHOLDER
  },
  {
    id: "dott",
    name: "Dott",
    color: "#7c3aed", // purple
    pricing: { unlockFeeChf: 0.5, perMinuteChf: 0.25 }, // PLACEHOLDER
  },
];

// The app always fetches once on page load and whenever the Refresh button
// is clicked. Set this true to also poll automatically every
// REFRESH_INTERVAL_MS — off by default so the Worker's 60s cache is hit
// only when someone's actually looking at the page.
const AUTO_REFRESH_ENABLED = false;
const REFRESH_INTERVAL_MS = 30_000;

// Initial map view, centred on Zurich. Leaflet uses [lat, lon] order.
const MAP_CENTER = [47.3769, 8.5417];
const MAP_ZOOM = 12.5;

// Trip time estimation. Distance (routed via OSRM when available, otherwise
// straight-line × detourFactor as a fallback) is divided by the relevant
// speed to get a duration.
const TRIP_ESTIMATE = {
  detourFactor: 1.4, // only applied to the straight-line fallback distance
  bikeSpeedKmh: 15,
  walkSpeedKmh: 5,
};

// Public OSRM demo server (FOSSGIS), no API key. Bike/foot profiles are
// separate services: {OSRM_BASE_URL}/routed-{profile}/route/v1/{profile}/...
const OSRM_BASE_URL = "https://routing.openstreetmap.de";

// Bounding box used to restrict Nominatim (OpenStreetMap) destination
// search results to the Zurich area. [minLon, minLat, maxLon, maxLat].
const ZURICH_SEARCH_BOUNDS = [8.4, 47.3, 8.65, 47.45];
