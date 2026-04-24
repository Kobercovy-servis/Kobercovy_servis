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
    <div class="card" style="padding:8px; box-shadow:none;">
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
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
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
// ===== KALKULAČKA KOBERCŮ =====
const rugsEl = document.getElementById("rugs");
const addRugBtn = document.getElementById("addRugBtn");
const resetRugsBtn = document.getElementById("resetRugsBtn");

const sumAreaEl = document.getElementById("sumArea");
const sumPerimEl = document.getElementById("sumPerim");
const sumBreakdownEl = document.getElementById("sumBreakdown");
const sumTotalEl = document.getElementById("sumTotal");

const PRICE_CLEAN = Number(CFG.PRICE_CLEAN_PER_M2) || 300;
const PRICE_EDGE = Number(CFG.PRICE_EDGE_PER_M) || 99;
const PRICE_IMP = Number(CFG.PRICE_IMP_PER_M2) || 40;

let rugCounter = 0;

function formatNum(value, decimals = 2) {
  return new Intl.NumberFormat("cs-CZ", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(value);
}

function formatCzk(value) {
  return `${new Intl.NumberFormat("cs-CZ", {
    maximumFractionDigits: 0
  }).format(Math.round(value))} Kč`;
}

function calcRug(shape, aCm, bCm, hasEdge, hasImp) {
  let area = 0;
  let perimeter = 0;

  if (shape === "rectangle") {
    area = (aCm * bCm) / 10000;
    perimeter = (2 * (aCm + bCm)) / 100;
  }

  if (shape === "square") {
    area = (aCm * aCm) / 10000;
    perimeter = (4 * aCm) / 100;
  }

  if (shape === "circle") {
    const diameterM = aCm / 100;
    const radiusM = diameterM / 2;
    area = Math.PI * radiusM * radiusM;
    perimeter = Math.PI * diameterM;
  }

  if (shape === "ellipse") {
    const semiA = (aCm / 100) / 2;
    const semiB = (bCm / 100) / 2;
    area = Math.PI * semiA * semiB;
    perimeter =
      Math.PI *
      (3 * (semiA + semiB) -
        Math.sqrt((3 * semiA + semiB) * (semiA + 3 * semiB)));
  }

  const cleanPrice = area * PRICE_CLEAN;
  const edgePrice = hasEdge ? perimeter * PRICE_EDGE : 0;
  const impPrice = hasImp ? area * PRICE_IMP : 0;
  const total = cleanPrice + edgePrice + impPrice;

  return {
    area,
    perimeter,
    cleanPrice,
    edgePrice,
    impPrice,
    total
  };
}

function getRugHtml(id) {
  return `
    <div class="rugRow" data-rug-id="${id}">
      <div class="rugTop">
        <div class="rugTitle">Koberec ${id}</div>
        <button class="smallBtn removeRugBtn" type="button">Odebrat</button>
      </div>

      <div class="rugGrid">
        <div>
          <label>Tvar</label>
          <select class="rugShape">
            <option value="rectangle">Obdélník</option>
            <option value="square">Čtverec</option>
            <option value="circle">Kruh</option>
            <option value="ellipse">Elipsa</option>
          </select>
        </div>

        <div class="rugDimA">
          <label class="rugLabelA">Šířka (cm)</label>
          <input type="number" class="rugWidth" min="1" step="1" placeholder="Např. 160">
        </div>

        <div class="rugDimB">
          <label class="rugLabelB">Délka (cm)</label>
          <input type="number" class="rugLength" min="1" step="1" placeholder="Např. 230">
        </div>

        <div>
          <label>Volby</label>
          <div class="rugOpts">
            <label style="margin:0; display:flex; gap:8px; align-items:center;">
              <input type="checkbox" class="rugEdge" style="width:auto;"> Obšívání
            </label>
            <label style="margin:0; display:flex; gap:8px; align-items:center;">
              <input type="checkbox" class="rugImp" style="width:auto;"> Impregnace
            </label>
          </div>
        </div>
      </div>

      <div class="rugOut">
        <div class="boxy">
          <div class="mini">Plocha</div>
          <div class="val rugArea">— m²</div>
        </div>
        <div class="boxy">
          <div class="mini">Obvod</div>
          <div class="val rugPerim">— m</div>
        </div>
        <div class="boxy">
          <div class="mini">Cena</div>
          <div class="val rugTotal">— Kč</div>
        </div>
      </div>
    </div>
  `;
}

function syncRugFields(row) {
  const shape = row.querySelector(".rugShape")?.value || "rectangle";
  const labelA = row.querySelector(".rugLabelA");
  const labelB = row.querySelector(".rugLabelB");
  const inputA = row.querySelector(".rugWidth");
  const inputB = row.querySelector(".rugLength");
  const dimBBox = row.querySelector(".rugDimB");

  if (!labelA || !labelB || !inputA || !inputB || !dimBBox) return;

  if (shape === "rectangle") {
    labelA.textContent = "Šířka (cm)";
    labelB.textContent = "Délka (cm)";
    inputA.placeholder = "Např. 160";
    inputB.placeholder = "Např. 230";
    inputB.disabled = false;
    dimBBox.style.display = "";
  }

  if (shape === "square") {
    labelA.textContent = "Strana (cm)";
    inputA.placeholder = "Např. 200";
    inputB.value = "";
    inputB.disabled = true;
    dimBBox.style.display = "none";
  }

  if (shape === "circle") {
    labelA.textContent = "Průměr (cm)";
    inputA.placeholder = "Např. 180";
    inputB.value = "";
    inputB.disabled = true;
    dimBBox.style.display = "none";
  }

  if (shape === "ellipse") {
    labelA.textContent = "Hlavní průměr (cm)";
    labelB.textContent = "Vedlejší průměr (cm)";
    inputA.placeholder = "Např. 220";
    inputB.placeholder = "Např. 160";
    inputB.disabled = false;
    dimBBox.style.display = "";
  }
}

function addRug(defaultShape = "rectangle", defaultA = "", defaultB = "", defaultEdge = false, defaultImp = false) {
  if (!rugsEl) return;

  rugCounter += 1;
  rugsEl.insertAdjacentHTML("beforeend", getRugHtml(rugCounter));

  const row = rugsEl.querySelector(`.rugRow[data-rug-id="${rugCounter}"]`);
  if (!row) return;

  row.querySelector(".rugShape").value = defaultShape;
  row.querySelector(".rugWidth").value = defaultA;
  row.querySelector(".rugLength").value = defaultB;
  row.querySelector(".rugEdge").checked = defaultEdge;
  row.querySelector(".rugImp").checked = defaultImp;

  syncRugFields(row);
  updateSingleRug(row);
  updateSummary();
}

function updateSingleRug(row) {
  const shape = row.querySelector(".rugShape")?.value || "rectangle";
  const a = Number(row.querySelector(".rugWidth")?.value) || 0;
  const b = Number(row.querySelector(".rugLength")?.value) || 0;
  const hasEdge = !!row.querySelector(".rugEdge")?.checked;
  const hasImp = !!row.querySelector(".rugImp")?.checked;

  const areaEl = row.querySelector(".rugArea");
  const perimEl = row.querySelector(".rugPerim");
  const totalEl = row.querySelector(".rugTotal");

  const needsOnlyA = shape === "square" || shape === "circle";
  const invalid = needsOnlyA ? a <= 0 : a <= 0 || b <= 0;

  if (invalid) {
    if (areaEl) areaEl.textContent = "— m²";
    if (perimEl) perimEl.textContent = "— m";
    if (totalEl) totalEl.textContent = "— Kč";
    row.dataset.area = "0";
    row.dataset.perimeter = "0";
    row.dataset.cleanPrice = "0";
    row.dataset.edgePrice = "0";
    row.dataset.impPrice = "0";
    row.dataset.total = "0";
    return;
  }

  const result = calcRug(shape, a, b, hasEdge, hasImp);

  if (areaEl) areaEl.textContent = `${formatNum(result.area)} m²`;
  if (perimEl) perimEl.textContent = `${formatNum(result.perimeter)} m`;
  if (totalEl) totalEl.textContent = formatCzk(result.total);

  row.dataset.area = String(result.area);
  row.dataset.perimeter = String(result.perimeter);
  row.dataset.cleanPrice = String(result.cleanPrice);
  row.dataset.edgePrice = String(result.edgePrice);
  row.dataset.impPrice = String(result.impPrice);
  row.dataset.total = String(result.total);
}

function updateSummary() {
  const rows = [...document.querySelectorAll(".rugRow")];

  let sumArea = 0;
  let sumPerim = 0;
  let sumClean = 0;
  let sumEdge = 0;
  let sumImp = 0;
  let sumTotal = 0;

  rows.forEach((row) => {
    sumArea += Number(row.dataset.area || 0);
    sumPerim += Number(row.dataset.perimeter || 0);
    sumClean += Number(row.dataset.cleanPrice || 0);
    sumEdge += Number(row.dataset.edgePrice || 0);
    sumImp += Number(row.dataset.impPrice || 0);
    sumTotal += Number(row.dataset.total || 0);
  });

  if (sumAreaEl) sumAreaEl.textContent = `${formatNum(sumArea)} m²`;
  if (sumPerimEl) sumPerimEl.textContent = `${formatNum(sumPerim)} m`;

  if (sumBreakdownEl) {
    sumBreakdownEl.innerHTML = `
      Čištění: ${formatCzk(sumClean)}<br>
      Obšívání: ${formatCzk(sumEdge)}<br>
      Impregnace: ${formatCzk(sumImp)}
    `;
  }

  if (sumTotalEl) sumTotalEl.textContent = formatCzk(sumTotal);
}

function resetCalculator() {
  if (!rugsEl) return;
  rugsEl.innerHTML = "";
  rugCounter = 0;
  addRug();
}

addRugBtn?.addEventListener("click", () => {
  addRug();
});

resetRugsBtn?.addEventListener("click", () => {
  resetCalculator();
});

rugsEl?.addEventListener("input", (e) => {
  const row = e.target.closest(".rugRow");
  if (!row) return;
  updateSingleRug(row);
  updateSummary();
});

rugsEl?.addEventListener("change", (e) => {
  const row = e.target.closest(".rugRow");
  if (!row) return;

  if (e.target.classList.contains("rugShape")) {
    syncRugFields(row);
  }

  updateSingleRug(row);
  updateSummary();
});

rugsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".removeRugBtn");
  if (!btn) return;

  const row = btn.closest(".rugRow");
  if (!row) return;

  row.remove();

  const remaining = [...document.querySelectorAll(".rugRow")];
  if (!remaining.length) {
    rugCounter = 0;
    addRug();
    return;
  }

  remaining.forEach((item, index) => {
    item.dataset.rugId = String(index + 1);
    const title = item.querySelector(".rugTitle");
    if (title) title.textContent = `Koberec ${index + 1}`;
  });

  rugCounter = remaining.length;
  updateSummary();
});

if (rugsEl && !rugsEl.children.length) {
  addRug();
}
document.addEventListener("DOMContentLoaded", loadPlaces);

