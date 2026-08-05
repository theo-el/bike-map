const map = L.map("map").setView(MAP_CENTER, MAP_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

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

// Set once a destination search succeeds. { lat, lng }
let destination = null;
let destinationMarker = null;

const destinationIcon = L.divIcon({
  html: "📍",
  className: "destination-icon",
  iconSize: [26, 26],
  iconAnchor: [13, 26],
});

// Set from geolocation (see startGeolocation/locateMe below). { lat, lng }
let myLocation = null;
let myLocationMarker = null;
let hasCenteredOnMyLocation = false;
// Last position a trip recompute used, so small GPS jitter while walking
// doesn't re-trigger an OSRM call on every watchPosition tick.
let lastTripComputeLocation = null;

const myLocationIcon = L.divIcon({
  html: "🧍",
  className: "my-location-icon",
  iconSize: [26, 26],
  iconAnchor: [13, 26],
});

// The vehicle currently priced in the trip card. { op, marker }
let selectedVehicle = null;

let bikeRouteLine = null;
let walkRouteLine = null;

// Bumped on every updateTripCard() call so a slow, superseded OSRM response
// can't overwrite a newer one.
let tripRequestToken = 0;

// operator.id -> Map(vehicleId -> L.Marker)
const markersByOperator = new Map(OPERATORS.map((op) => [op.id, new Map()]));

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
  return `<div class="bike-popup"><strong>${op.name}</strong><br/>
    ID: ${vehicle.id}<br/>
    ${vehicle.batteryPct !== null ? `Battery: ${vehicle.batteryPct}%` : ""}</div>`;
}

// A small visual dot inside a larger (44px) invisible tap target — the dot
// alone would be too small to reliably hit on a touchscreen.
function vehicleIcon(color) {
  return L.divIcon({
    html: `<div class="vehicle-marker-hit"><span class="vehicle-marker-dot" style="background:${color}"></span></div>`,
    className: "vehicle-marker-icon",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function renderOperator(op, vehicles) {
  const markers = markersByOperator.get(op.id);
  const seen = new Set();

  for (const vehicle of vehicles) {
    seen.add(vehicle.id);
    const existing = markers.get(vehicle.id);

    if (existing) {
      existing.setLatLng([vehicle.lat, vehicle.lon]);
      existing.setPopupContent(popupHtml(op, vehicle));
    } else {
      const marker = L.marker([vehicle.lat, vehicle.lon], { icon: vehicleIcon(op.color) })
        .bindPopup(popupHtml(op, vehicle))
        .on("click", () => {
          selectedVehicle = { op, marker };
          priceCard.classList.remove("expanded");
          updateTripCard();
        })
        .addTo(map);
      markers.set(vehicle.id, marker);
    }
  }

  // Remove markers for vehicles no longer present in the feed.
  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
      if (selectedVehicle && selectedVehicle.marker === marker) {
        selectedVehicle = null;
        updateTripCard();
      }
    }
  }
}

function renderStatus() {
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

    for (const op of OPERATORS) {
      const state = operatorState.get(op.id);
      const feed = combined[op.id];
      try {
        if (feed && feed.error) throw new Error(feed.error);
        const vehicles = extractVehicles(feed);
        renderOperator(op, vehicles);
        state.count = vehicles.length;
        state.error = null;
      } catch (err) {
        state.error = err.message || String(err);
      }
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

function clearRouteLines() {
  if (bikeRouteLine) {
    map.removeLayer(bikeRouteLine);
    bikeRouteLine = null;
  }
  if (walkRouteLine) {
    map.removeLayer(walkRouteLine);
    walkRouteLine = null;
  }
}

function drawRouteLines(bikeLeg, walkLeg) {
  clearRouteLines();
  bikeRouteLine = L.polyline(bikeLeg.latlngs, { color: "#333", weight: 4, opacity: 0.8 }).addTo(map);
  if (walkLeg) {
    walkRouteLine = L.polyline(walkLeg.latlngs, {
      color: "#333",
      weight: 3,
      opacity: 0.7,
      dashArray: "4,6",
    }).addTo(map);
  }
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
    ${walkHtml}
    <div class="trip-leg">🚲 ${legLabel(bikeLeg)} to destination</div>
    <div class="price-row">
      <span><span class="swatch" style="background:${op.color}"></span> ${op.name}</span>
      <span>${formatChf(cost)}</span>
    </div>
    ${anyFallback ? '<div class="trip-note">~ routing unavailable for this leg — straight-line estimate shown instead</div>' : ""}
  `;
  priceCard.classList.remove("hidden");
}

async function updateTripCard() {
  if (!destination || !selectedVehicle) {
    hideTripCard();
    return;
  }

  const token = ++tripRequestToken;
  const { op, marker } = selectedVehicle;
  const vehicleLatLng = marker.getLatLng();

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
  const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
  myLocation = latlng;

  if (myLocationMarker) {
    myLocationMarker.setLatLng(latlng);
  } else {
    myLocationMarker = L.marker(latlng, { icon: myLocationIcon }).addTo(map);
  }

  if (!hasCenteredOnMyLocation) {
    map.setView(latlng, MY_LOCATION_ZOOM);
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
    map.setView(myLocation, MY_LOCATION_ZOOM);
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
      destinationMarker.setLatLng(destination);
    } else {
      destinationMarker = L.marker(destination, { icon: destinationIcon }).addTo(map);
    }
    map.panTo(destination);
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
refreshAll();
if (AUTO_REFRESH_ENABLED) {
  setInterval(refreshAll, REFRESH_INTERVAL_MS);
}
