// ---------------------------------------------------------------------------
// Fill these in before running the app.
// ---------------------------------------------------------------------------

// GBFS free_bike_status / vehicle_status feed URLs for each operator.
//
// London turned out to be a dead end for a live multi-operator demo: Lime
// and Forest (the two operators actually asked for) don't publish a
// discoverable public GBFS feed there, and the only other Greater London
// feeds we could find (Beryl's Hackney/Westminster cargo-bike schemes) are
// docked, not free-floating, and were sitting at 0 available bikes.
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
const OPERATORS = [
  {
    id: "lime",
    name: "Lime",
    color: "#00e676", // Lime green
    gbfsUrl: "https://api.mobidata-bw.de/sharing/gbfs/v3/lime_zurich/vehicle_status",
    pricing: { unlockFeeChf: 1.5, perMinuteChf: 0.45 }, // PLACEHOLDER
  },
  {
    id: "bolt",
    name: "Bolt",
    color: "#1565c0", // blue
    gbfsUrl: "https://api.mobidata-bw.de/sharing/gbfs/v3/bolt_zurich/vehicle_status",
    pricing: { unlockFeeChf: 1.0, perMinuteChf: 0.35 }, // PLACEHOLDER
  },
  {
    id: "dott",
    name: "Dott",
    color: "#7c3aed", // purple
    gbfsUrl: "https://gbfs.api.ridedott.com/public/v2/zurich/free_bike_status.json",
    pricing: { unlockFeeChf: 0.5, perMinuteChf: 0.25 }, // PLACEHOLDER
  },
];

// How often to refresh the feeds, in milliseconds.
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
