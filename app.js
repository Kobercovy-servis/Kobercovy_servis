const CFG = window.APP_CONFIG || {};

const mapEl = document.getElementById("map");
const mapStatusEl = document.getElementById("mapStatus");
const placesListEl = document.getElementById("placesList");
const addrInput = document.getElementById("addr");
const searchAddrBtn = document.getElementById("searchAddrBtn");
const geoBtn = document.getElementById("geoBtn");
const reloadBtn = document.getElementById("reloadBtn");

let map;
let geocoder;
let infoWindow;
let markers = [];
let userMarker = null;
let placesCache = [];

function cleanStr(v) {
  return (v ?? "").toString().trim();
}

function escapeHtml(str) {
  return cleanStr(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toNum(v) {
  const n = parseFloat(cleanStr(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(key) {
  return cleanStr(key)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_]/g, "");
}

function pick(row, keys) {
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (normalized in row) return cleanStr(row[normalized]);
  }
  return "";
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(value);
      if (row.some(cell => cleanStr(cell) !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some(cell => cleanStr(cell) !== "")) rows.push(row);

  if (!rows.length) return [];

  const headers = rows[0].map(h => normalizeKey(h));
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] ?? "";
    });
    return obj;
  });
}

function setStatus(text) {
  if (mapStatusEl) mapStatusEl.textContent = text;
}

function buildInfoContent(place) {
  return `
    <div style="min-width:220px;line-height:1.5">
      <strong>${escapeHtml(place.name)}</strong><br>
      ${place.address ? `${escapeHtml(place.address)}<br>` : ""}
      ${place.hours ? `Otevírací doba: ${escapeHtml(place.hours)}<br>` : ""}
      ${place.phone ? `Tel: ${escapeHtml(place.phone)}<br>` : ""}
      ${place.email ? `Email: ${escapeHtml(place.email)}<br>` : ""}
      ${place.web ? `<a href="${escapeHtml(place.web)}" target="_blank" rel="noopener noreferrer">Web</a>` : ""}
    </div>
  `;
}

function renderPlacesList(places) {
  if (!placesListEl) return;

  if (!places.length) {
    placesListEl.innerHTML = `
      <div class="card" style="padding:12px; box-shadow:none;">
        Žádná sběrná místa nebyla načtena.
      </div>
    `;
    return;
  }

  placesListEl.innerHTML = places.map(place => `
    <div class="card" style="padding:12px; box-shadow:none;">
      <div style="font-weight:950; margin-bottom:6px;">${escapeHtml(place.name)}</div>
      ${place.address ? `<div class="mini" style="margin-bottom:6px;">${escapeHtml(place.address)}</div>` : ""}
      ${place.hours ? `<div class="mini">Otevírací doba: ${escapeHtml(place.hours)}</div>` : ""}
      ${place.phone ? `<div class="mini">Tel: <a href="tel:${escapeHtml(place.phone)}">${escapeHtml(place.phone)}</a></div>` : ""}
      ${place.email ? `<div class="mini">Email: <a href="mailto:${escapeHtml(place.email)}">${escapeHtml(place.email)}</a></div>` : ""}
      ${place.web ? `<div class="mini">Web: <a href="${escapeHtml(place.web)}" target="_blank" rel="noopener noreferrer">${escapeHtml(place.web)}</a></div>` : ""}
    </div>
  `).join("");
}

function clearMarkers() {
  markers.forEach(marker => marker.setMap(null));
  markers = [];
}

function renderMarkers(places) {
  if (!map || !window.google?.maps) return;

  clearMarkers();

  const validPlaces = places.filter(place =>
    Number.isFinite(place.lat) && Number.isFinite(place.lng)
  );

  if (!validPlaces.length) {
    setStatus("Místa byla načtena, ale chybí souřadnice lat/lng.");
    return;
  }

  const bounds = new google.maps.LatLngBounds();

  validPlaces.forEach(place => {
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map,
      title: place.name
    });

    marker.addListener("click", () => {
      infoWindow.setContent(buildInfoContent(place));
      infoWindow.open(map, marker);
    });

    markers.push(marker);
    bounds.extend(marker.getPosition());
  });

  if (validPlaces.length === 1) {
    map.setCenter({ lat: validPlaces[0].lat, lng: validPlaces[0].lng });
    map.setZoom(13);
  } else {
    map.fitBounds(bounds, 60);
  }

  setStatus(`Načteno sběrných míst: ${validPlaces.length}`);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sortPlacesByDistance(lat, lng) {
  const sorted = [...placesCache].sort((a, b) => {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return 1;
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return -1;

    const da = distanceKm(lat, lng, a.lat, a.lng);
    const db = distanceKm(lat, lng, b.lat, b.lng);
    return da - db;
  });

  renderPlacesList(sorted);
}

function initMap() {
  if (!window.google?.maps || map) return;

  map = new google.maps.Map(mapEl, {
    center: { lat: 50.0755, lng: 14.4378 },
    zoom: 10,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true
  });

  geocoder = new google.maps.Geocoder();
  infoWindow = new google.maps.InfoWindow();
}

function loadGoogleMapsApi() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }

    const apiKey = cleanStr(CFG.GOOGLE_MAPS_API_KEY);
    if (!apiKey) {
      reject(new Error("Chybí GOOGLE_MAPS_API_KEY v config.js."));
      return;
    }

    const existingScript = document.querySelector('script[data-google-maps="1"]');
    if (existingScript) {
      existingScript.addEventListener("load", resolve, { once: true });
      existingScript.addEventListener("error", () => reject(new Error("Google Maps API se nepodařilo načíst.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "1";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google Maps API se nepodařilo načíst."));
    document.head.appendChild(script);
  });
}

async function loadPlaces() {
  const url = cleanStr(CFG.PLACES_DATA_URL);

  if (!url) {
    setStatus("Chybí PLACES_DATA_URL v config.js.");
    renderPlacesList([]);
    return;
  }

  setStatus("Načítám sběrná místa...");

  try {
    const separator = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${separator}v=${Date.now()}`);

    if (!res.ok) {
      throw new Error(`Nepodařilo se načíst data (${res.status}).`);
    }

    const text = await res.text();

    if (text.toLowerCase().includes("<html")) {
      throw new Error("Google Sheet není veřejně nasdílený jako CSV.");
    }

    const rows = parseCSV(text);

    const places = rows.map(row => ({
      name: pick(row, ["name", "nazev", "název"]),
      address: pick(row, ["address", "adresa"]),
      hours: pick(row, ["hours", "oteviracidoba", "oteviraci_doba", "otevíracídoba", "oteviracka"]),
      phone: pick(row, ["phone", "telefon", "tel"]),
      email: pick(row, ["email", "e-mail"]),
      web: pick(row, ["web", "url", "website"]),
      lat: toNum(pick(row, ["lat", "latitude"])),
      lng: toNum(pick(row, ["lng", "lon", "long", "longitude"]))
    })).filter(place => place.name || place.address);

    placesCache = places;

    renderPlacesList(places);
    await loadGoogleMapsApi();
    initMap();
    renderMarkers(places);
  } catch (err) {
    setStatus(err.message || "Chyba při načítání mapy.");
    renderPlacesList([]);
  }
}

function searchByAddress() {
  const address = cleanStr(addrInput?.value);

  if (!address) {
    alert("Zadej adresu.");
    return;
  }

  if (!geocoder || !map) {
    alert("Mapa ještě není připravená.");
    return;
  }

  geocoder.geocode({ address }, (results, status) => {
    if (status !== "OK" || !results?.length) {
      alert("Adresu se nepodařilo najít.");
      return;
    }

    const location = results[0].geometry.location;
    const lat = location.lat();
    const lng = location.lng();

    map.setCenter({ lat, lng });
    map.setZoom(12);

    if (userMarker) userMarker.setMap(null);

    userMarker = new google.maps.Marker({
      position: { lat, lng },
      map,
      title: "Hledaná adresa"
    });

    sortPlacesByDistance(lat, lng);
    setStatus("Seřazeno podle zadané adresy.");
  });
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    alert("Tento prohlížeč nepodporuje geolokaci.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      if (!map) {
        alert("Mapa ještě není připravená.");
        return;
      }

      map.setCenter({ lat, lng });
      map.setZoom(12);

      if (userMarker) userMarker.setMap(null);

      userMarker = new google.maps.Marker({
        position: { lat, lng },
        map,
        title: "Vaše poloha"
      });

      sortPlacesByDistance(lat, lng);
      setStatus("Seřazeno podle aktuální polohy.");
    },
    () => {
      alert("Nepodařilo se získat aktuální polohu.");
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

searchAddrBtn?.addEventListener("click", searchByAddress);
geoBtn?.addEventListener("click", useCurrentLocation);
reloadBtn?.addEventListener("click", loadPlaces);

document.addEventListener("DOMContentLoaded", loadPlaces);
