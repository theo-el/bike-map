const styleParam = new URLSearchParams(location.search).get("style");
const styleUrl = MAP_STYLES[styleParam] || MAP_STYLES[DEFAULT_MAP_STYLE];

// `map` isn't assigned until initMap()'s fetch below resolves — every
// other reference to it in this file is inside a function body called
// later (button handlers, the "load" callback, etc.), never at top-level
// script-evaluation time, so this is safe.
let map;

async function initMap() {
  // OpenFreeMap's style includes a "ne2_shaded" background hillshade
  // source (a decorative low-zoom world backdrop, maxzoom 6) whose tile
  // request never actually fires in this app — confirmed via network
  // inspection: MapLibre logs a sourcedataloading event for it but the
  // browser never issues the underlying request, so it never resolves.
  // That stalls the map's "load" event (and isStyleLoaded()) forever,
  // since both wait on every source to finish. It's not real map content,
  // so rather than chase the root cause, fetch the style ourselves and
  // strip it before handing it to MapLibre.
  const style = await fetch(styleUrl).then((r) => r.json());
  delete style.sources.ne2_shaded;
  style.layers = style.layers.filter((l) => l.source !== "ne2_shaded");

  map = new maplibregl.Map({
    container: "map",
    style,
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    attributionControl: false,
    maxPitch: 0, // tilt disabled — pinch-zoom and rotate stay on
  });
  map.addControl(
    new maplibregl.AttributionControl({ compact: true, customAttribution: "© OpenMapTiles © OpenStreetMap contributors" })
  );
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), "top-right");

  map.on("load", () => {
    setupVehicleLayers();
    setupRouteLayers();
    refreshAll();
    if (AUTO_REFRESH_ENABLED) {
      setInterval(refreshAll, REFRESH_INTERVAL_MS);
    }
  });
}

const statusHeader = document.getElementById("status-header");
const statusEl = document.getElementById("status");
const statusLines = document.getElementById("status-lines");
const lastUpdatedEl = document.getElementById("last-updated");
const refreshBtn = document.getElementById("refresh-btn");
const refreshFab = document.getElementById("refresh-fab");
const locateBtn = document.getElementById("locate-btn");
const locateFab = document.getElementById("locate-fab");
const locateFeedback = document.getElementById("locate-feedback");
const destinationForm = document.getElementById("destination-form");
const destinationInput = document.getElementById("destination-input");
const destinationFeedback = document.getElementById("destination-feedback");
const priceCard = document.getElementById("price-card");
const priceCardSummary = document.getElementById("price-card-summary");
const priceCardLines = document.getElementById("price-card-lines");
const sheetHandle = document.querySelector("#price-card .sheet-handle");

function makeEmojiMarkerEl(emoji, className) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = emoji;
  return el;
}

// A dot with a soft pulsing ring, standard "you are here" styling —
// replaces a static emoji for a small extra touch of polish.
function makeMyLocationEl() {
  const el = document.createElement("div");
  el.className = "my-location-marker";
  el.innerHTML = '<div class="my-location-pulse"></div><div class="my-location-dot"></div>';
  return el;
}

// Set once a destination search succeeds. { lat, lng }
let destination = null;
let destinationMarker = null;

// Set from geolocation (see startGeolocation/locateMe below). { lat, lng }
let myLocation = null;
let myLocationMarker = null;
let hasCenteredOnMyLocation = false;
// Last position a trip recompute used, so small GPS jitter while walking
// doesn't re-trigger an OSRM call on every watchPosition tick.
let lastTripComputeLocation = null;

// The vehicle currently priced in the trip card. { opId, vehicleId }
let selectedVehicle = null;

// Bumped on every updateTripCard() call so a slow, superseded OSRM response
// can't overwrite a newer one.
let tripRequestToken = 0;

// vehicleId -> { lat, lon, operatorId, batteryPct }. Rebuilt fresh on every
// refresh (refreshes are manual/infrequent, so a full rebuild is simpler
// than incremental diffing) and mirrored into the "vehicles" GeoJSON source
// that the map layers render from.
let vehiclesById = new Map();

// operator.id -> { count, error }
const operatorState = new Map(OPERATORS.map((op) => [op.id, { count: 0, error: null }]));

// Set once any refresh cycle completes. Shown next to the Refresh button
// instead of a per-operator timestamp, since all operators now come from
// one fetch to the Worker.
let lastUpdatedAt = null;

// Normalizes GBFS v1/v2 ("data.bikes") and v3 ("data.vehicles") shapes into
// a flat array of { id, lat, lon, batteryPct }.
function extractVehicles(json) {
  const data = json && json.data ? json.data : {};
  const rawList = data.bikes || data.vehicles || [];

  return rawList
    .filter((v) => typeof v.lat === "number" && typeof v.lon === "number")
    .map((v) => {
      const batteryPct =
        typeof v.current_fuel_percent === "number"
          ? Math.round(v.current_fuel_percent * 100)
          : null;

      return {
        id: v.bike_id || v.vehicle_id || `${v.lat},${v.lon}`,
        lat: v.lat,
        lon: v.lon,
        batteryPct,
      };
    });
}

function popupHtml(op, vehicle) {
  return `<div class="bike-popup">
    <strong>${op.name}</strong><br/>
    <span class="popup-id">#${vehicle.id.slice(0, 8)}</span>
    ${vehicle.batteryPct !== null ? `<div class="popup-battery">🔋 ${vehicle.batteryPct}%</div>` : ""}
  </div>`;
}

function vehiclesGeoJSON() {
  return {
    type: "FeatureCollection",
    features: [...vehiclesById.entries()].map(([id, v]) => {
      const op = OPERATORS.find((o) => o.id === v.operatorId);
      return {
        type: "Feature",
        id, // top-level id, required for setFeatureState (used for the "selected" look)
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: {
          id,
          operatorId: v.operatorId,
          batteryPct: v.batteryPct,
          color: op ? op.color : "#999",
        },
      };
    }),
  };
}

// Currently-selected vehicle's feature id, so its "selected" feature-state
// can be cleared when a different vehicle is picked (or none).
let selectedFeatureId = null;

function setSelectedFeatureState(id) {
  if (selectedFeatureId !== null) {
    map.setFeatureState({ source: "vehicles", id: selectedFeatureId }, { selected: false });
  }
  selectedFeatureId = id;
  if (id !== null) {
    map.setFeatureState({ source: "vehicles", id }, { selected: true });
  }
}

const SELECTED = ["boolean", ["feature-state", "selected"], false];

// Vehicles render as a GL circle layer, not individual DOM markers — with
// ~3000 vehicles, thousands of Marker DOM elements would visibly lag on a
// phone, while a GPU-rendered layer stays smooth. Three stacked layers:
// vehicle-hit is a near-invisible 44px-diameter circle (opacity 0.01, not
// 0 — hit-testing should ignore opacity, but this removes any doubt) that
// owns the click handler, reproducing the old divIcon's bigger-tap-target
// trick; vehicle-selected-halo is a soft accent glow that only appears
// behind the selected vehicle; vehicle-dot is the visible dot on top,
// grown and given a thicker ring when selected.
function setupVehicleLayers() {
  map.addSource("vehicles", { type: "geojson", data: vehiclesGeoJSON() });

  map.addLayer({
    id: "vehicle-hit",
    type: "circle",
    source: "vehicles",
    paint: { "circle-radius": 22, "circle-color": "#000", "circle-opacity": 0.01 },
  });

  map.addLayer({
    id: "vehicle-selected-halo",
    type: "circle",
    source: "vehicles",
    paint: {
      "circle-radius": ["case", SELECTED, 17, 0],
      "circle-color": "#0ea5a0",
      "circle-opacity": 0.25,
    },
  });

  map.addLayer({
    id: "vehicle-dot",
    type: "circle",
    source: "vehicles",
    paint: {
      "circle-radius": ["case", SELECTED, 10, 7],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": ["case", SELECTED, 3, 2],
    },
  });

  map.on("mouseenter", "vehicle-hit", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "vehicle-hit", () => {
    map.getCanvas().style.cursor = "";
  });

  map.on("click", "vehicle-hit", (e) => {
    const f = e.features[0];
    const { id, operatorId, batteryPct } = f.properties;
    const op = OPERATORS.find((o) => o.id === operatorId);
    if (!op) return;

    new maplibregl.Popup({ offset: 12, closeButton: false })
      .setLngLat(f.geometry.coordinates)
      .setHTML(popupHtml(op, { id, batteryPct: batteryPct === undefined ? null : batteryPct }))
      .addTo(map);

    setSelectedFeatureState(id);
    selectedVehicle = { opId: op.id, vehicleId: id };
    priceCard.classList.remove("expanded");
    updateTripCard();
  });
}

function renderStatus() {
  // Skeleton placeholders until the first refresh (success or failure)
  // completes — after that we always have real counts or an error to show.
  if (!lastUpdatedAt) {
    statusLines.innerHTML = OPERATORS.map(
      () => `<div class="row"><span class="skeleton skeleton-swatch"></span><span class="skeleton skeleton-text"></span></div>`
    ).join("");
    return;
  }

  statusLines.innerHTML = OPERATORS.map((op) => {
    const state = operatorState.get(op.id);
    const line = state.error
      ? `<span class="error">error: ${state.error}</span>`
      : `${state.count} bikes`;
    return `<div class="row"><span class="swatch" style="background:${op.color}"></span>${op.name}: ${line}</div>`;
  }).join("");
}

function renderLastUpdated() {
  lastUpdatedEl.textContent = lastUpdatedAt
    ? `Last updated: ${lastUpdatedAt.toLocaleTimeString()}`
    : "Not loaded yet";
}

// Single fetch to the Worker's combined endpoint, then distributed per
// operator. One operator's feed failing (Worker reports it as
// { error: "..." }) doesn't block the others; the whole request failing
// (Worker unreachable, bad JSON, etc.) marks every operator as errored.
async function refreshAll() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";

  try {
    const res = await fetch(FEEDS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const combined = await res.json();

    const newVehiclesById = new Map();

    for (const op of OPERATORS) {
      const state = operatorState.get(op.id);
      const feed = combined[op.id];
      try {
        if (feed && feed.error) throw new Error(feed.error);
        const vehicles = extractVehicles(feed);
        for (const v of vehicles) {
          newVehiclesById.set(v.id, { lat: v.lat, lon: v.lon, operatorId: op.id, batteryPct: v.batteryPct });
        }
        state.count = vehicles.length;
        state.error = null;
      } catch (err) {
        state.error = err.message || String(err);
      }
    }

    vehiclesById = newVehiclesById;
    map.getSource("vehicles").setData(vehiclesGeoJSON());

    if (selectedVehicle && !vehiclesById.has(selectedVehicle.vehicleId)) {
      setSelectedFeatureState(null);
      selectedVehicle = null;
      hideTripCard();
    }
  } catch (err) {
    for (const op of OPERATORS) {
      operatorState.get(op.id).error = err.message || String(err);
    }
  } finally {
    lastUpdatedAt = new Date();
    renderStatus();
    renderLastUpdated();
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

// Straight-line distance between two lat/lon points, in km.
function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatChf(amount) {
  return `CHF ${amount.toFixed(2)}`;
}

// Calls the public OSRM demo server for a route between two points.
// Throws on any HTTP-level or routing-level ("code" !== "Ok") failure.
async function osrmRoute(profile, from, to) {
  const url =
    `${OSRM_BASE_URL}/routed-${profile}/route/v1/${profile}/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.code !== "Ok") {
    throw new Error(json.message || `HTTP ${res.status}`);
  }

  const route = json.routes[0];
  return {
    distanceKm: route.distance / 1000,
    latlngs: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
  };
}

// Routes from -> to with OSRM. Falls back to a straight-line × detourFactor
// estimate (flagged via `routed: false`) if OSRM errors or is unreachable.
async function computeLeg(profile, from, to, speedKmh) {
  try {
    const { distanceKm, latlngs } = await osrmRoute(profile, from, to);
    const minutes = Math.ceil((distanceKm / speedKmh) * 60);
    return { distanceKm, minutes, latlngs, routed: true };
  } catch (err) {
    const distanceKm = haversineKm(from, to) * TRIP_ESTIMATE.detourFactor;
    const minutes = Math.ceil((distanceKm / speedKmh) * 60);
    return { distanceKm, minutes, latlngs: [from, to], routed: false, error: err.message || String(err) };
  }
}

// computeLeg's `latlngs` mixes [lat,lng] arrays (from OSRM) and {lat,lng}
// objects (from the straight-line fallback) — Leaflet accepted both
// interchangeably, MapLibre GeoJSON needs a single normalized [lng,lat].
function toLngLat(p) {
  return Array.isArray(p) ? [p[1], p[0]] : [p.lng, p.lat];
}

function emptyLineFC() {
  return { type: "FeatureCollection", features: [] };
}

function lineFC(points) {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: points.map(toLngLat) }, properties: {} },
    ],
  };
}

function setupRouteLayers() {
  map.addSource("bike-route", { type: "geojson", data: emptyLineFC() });
  map.addLayer({
    id: "bike-route",
    type: "line",
    source: "bike-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#333", "line-width": 4, "line-opacity": 0.8 },
  });

  map.addSource("walk-route", { type: "geojson", data: emptyLineFC() });
  map.addLayer({
    id: "walk-route",
    type: "line",
    source: "walk-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#333", "line-width": 3, "line-opacity": 0.7, "line-dasharray": [2, 2] },
  });
}

function clearRouteLines() {
  map.getSource("bike-route").setData(emptyLineFC());
  map.getSource("walk-route").setData(emptyLineFC());
}

function drawRouteLines(bikeLeg, walkLeg) {
  map.getSource("bike-route").setData(lineFC(bikeLeg.latlngs));
  map.getSource("walk-route").setData(walkLeg ? lineFC(walkLeg.latlngs) : emptyLineFC());
}

function legLabel(leg) {
  const prefix = leg.routed ? "" : "~";
  return `${prefix}${leg.minutes} min (${prefix}${leg.distanceKm.toFixed(1)} km)`;
}

// The bottom sheet and the FABs both live in the bottom-right corner on
// mobile — hide the FABs while the sheet is showing so its content (the
// price row especially) never renders underneath them. Setting inline
// style.display and clearing it (rather than a fixed value) lets the
// existing CSS (hidden on desktop, flex on mobile) take back over.
function setFabsVisible(visible) {
  refreshFab.style.display = visible ? "" : "none";
  locateFab.style.display = visible ? "" : "none";
}

function hideTripCard() {
  priceCard.classList.add("hidden");
  priceCard.classList.remove("expanded");
  clearRouteLines();
  setFabsVisible(true);
}

function renderTripCard(op, bikeLeg, walkLeg, cost) {
  const walkHtml = walkLeg
    ? `<div class="trip-leg">🚶 ${legLabel(walkLeg)} to bike</div>`
    : `<div class="trip-leg trip-leg-hint">Tap 📍 to enable a walk-to-bike estimate.</div>`;

  const anyFallback = !bikeLeg.routed || (walkLeg && !walkLeg.routed);
  const prefix = bikeLeg.routed ? "" : "~";

  priceCardSummary.textContent = `${op.name} · ${prefix}${bikeLeg.minutes} min · ${formatChf(cost)}`;

  priceCardLines.innerHTML = `
    <div class="trip-winner">
      <div class="price-row">
        <span><span class="swatch" style="background:${op.color}"></span> ${op.name}</span>
        <span>${formatChf(cost)}</span>
      </div>
    </div>
    ${walkHtml}
    <div class="trip-leg">🚲 ${legLabel(bikeLeg)} to destination</div>
    ${anyFallback ? '<div class="trip-note">~ routing unavailable for this leg — straight-line estimate shown instead</div>' : ""}
  `;
  priceCard.classList.remove("hidden");
}

async function updateTripCard() {
  if (!destination || !selectedVehicle) {
    hideTripCard();
    return;
  }

  const vehicle = vehiclesById.get(selectedVehicle.vehicleId);
  if (!vehicle) {
    setSelectedFeatureState(null);
    selectedVehicle = null;
    hideTripCard();
    return;
  }
  const op = OPERATORS.find((o) => o.id === selectedVehicle.opId);
  const vehicleLatLng = { lat: vehicle.lat, lng: vehicle.lon };

  const token = ++tripRequestToken;

  priceCardSummary.textContent = "Calculating…";
  priceCardLines.innerHTML = "<div>Calculating route…</div>";
  priceCard.classList.remove("hidden");
  setFabsVisible(false);

  const [bikeLeg, walkLeg] = await Promise.all([
    computeLeg("bike", vehicleLatLng, destination, TRIP_ESTIMATE.bikeSpeedKmh),
    myLocation ? computeLeg("foot", myLocation, vehicleLatLng, TRIP_ESTIMATE.walkSpeedKmh) : Promise.resolve(null),
  ]);

  if (token !== tripRequestToken) return; // a newer click/search superseded this request

  const cost = op.pricing.unlockFeeChf + bikeLeg.minutes * op.pricing.perMinuteChf;
  renderTripCard(op, bikeLeg, walkLeg, cost);
  drawRouteLines(bikeLeg, walkLeg);
}

// Distance (km) beyond which a fresh GPS fix is considered "moved enough"
// to bother recomputing the walk leg of an already-selected trip.
const TRIP_RECOMPUTE_THRESHOLD_KM = 0.03;

function onGeoPosition(pos) {
  const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  myLocation = latlng;

  if (myLocationMarker) {
    myLocationMarker.setLngLat([latlng.lng, latlng.lat]);
  } else {
    myLocationMarker = new maplibregl.Marker({ element: makeMyLocationEl(), anchor: "center" })
      .setLngLat([latlng.lng, latlng.lat])
      .addTo(map);
  }

  if (!hasCenteredOnMyLocation) {
    map.flyTo({ center: [latlng.lng, latlng.lat], zoom: MY_LOCATION_ZOOM });
    hasCenteredOnMyLocation = true;
  }

  if (
    selectedVehicle &&
    (!lastTripComputeLocation || haversineKm(lastTripComputeLocation, latlng) > TRIP_RECOMPUTE_THRESHOLD_KM)
  ) {
    lastTripComputeLocation = latlng;
    updateTripCard();
  }
}

// Fires once on load (silently — no permission-prompt nagging) and again
// whenever the position changes, for as long as permission stays granted.
function startGeolocation() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.watchPosition(onGeoPosition, () => {}, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 15_000,
  });
}

// "Locate me" button: re-centre if we already know where you are, otherwise
// this is the one deliberate retry path after a denial — the automatic
// watch above never re-prompts on its own.
function locateMe() {
  if (myLocation) {
    map.flyTo({ center: [myLocation.lng, myLocation.lat], zoom: MY_LOCATION_ZOOM });
    return;
  }
  if (!("geolocation" in navigator)) {
    locateFeedback.textContent = "Geolocation isn't supported on this browser.";
    return;
  }

  locateFeedback.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateFeedback.textContent = "";
      onGeoPosition(pos);
      startGeolocation();
    },
    () => {
      locateFeedback.textContent = "Location unavailable — check permission in your browser/phone settings.";
    },
    { enableHighAccuracy: true, timeout: 10_000 }
  );
}

locateBtn.addEventListener("click", locateMe);
locateFab.addEventListener("click", locateMe);
startGeolocation();

async function geocodeDestination(query) {
  const [minLon, minLat, maxLon, maxLat] = ZURICH_SEARCH_BOUNDS;
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?format=json&q=${encodeURIComponent(query)}` +
    `&viewbox=${minLon},${maxLat},${maxLon},${minLat}&bounded=1&limit=1`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const results = await res.json();
  return results[0] || null;
}

destinationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = destinationInput.value.trim();
  if (!query) return;

  destinationFeedback.textContent = "Searching…";
  try {
    const result = await geocodeDestination(query);
    if (!result) {
      destinationFeedback.textContent = "No results found in Zurich.";
      return;
    }

    destination = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };
    destinationFeedback.textContent = `Destination: ${result.display_name}`;

    if (destinationMarker) {
      destinationMarker.setLngLat([destination.lng, destination.lat]);
    } else {
      destinationMarker = new maplibregl.Marker({ element: makeEmojiMarkerEl("📍", "destination-icon"), anchor: "bottom" })
        .setLngLat([destination.lng, destination.lat])
        .addTo(map);
    }
    map.panTo([destination.lng, destination.lat]);
    updateTripCard();
  } catch (err) {
    destinationFeedback.textContent = `Search failed: ${err.message || err}`;
  }
});

refreshBtn.addEventListener("click", refreshAll);
refreshFab.addEventListener("click", refreshAll);

// Mobile-only: tap the strip to collapse/expand it (harmless no-op on
// desktop, which never applies the .collapsed styling). Clicks on the
// action buttons inside the header shouldn't also toggle it.
statusHeader.addEventListener("click", (e) => {
  if (e.target.closest("#locate-btn, #refresh-btn")) return;
  const collapsed = statusEl.classList.toggle("collapsed");
  statusHeader.setAttribute("aria-expanded", String(!collapsed));
});
statusHeader.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  statusHeader.click();
});

// Mobile bottom sheet: tap the summary to expand/collapse, swipe it down
// to dismiss (deselects the vehicle and clears the route lines).
priceCardSummary.addEventListener("click", () => {
  priceCard.classList.toggle("expanded");
});

let sheetTouchStartY = null;
function onSheetTouchStart(e) {
  sheetTouchStartY = e.touches[0].clientY;
}
function onSheetTouchEnd(e) {
  if (sheetTouchStartY === null) return;
  const deltaY = e.changedTouches[0].clientY - sheetTouchStartY;
  sheetTouchStartY = null;
  if (deltaY > 60) {
    setSelectedFeatureState(null);
    selectedVehicle = null;
    hideTripCard();
  }
}
priceCardSummary.addEventListener("touchstart", onSheetTouchStart, { passive: true });
priceCardSummary.addEventListener("touchend", onSheetTouchEnd);
sheetHandle.addEventListener("touchstart", onSheetTouchStart, { passive: true });
sheetHandle.addEventListener("touchend", onSheetTouchEnd);

renderStatus();
renderLastUpdated();
initMap();
