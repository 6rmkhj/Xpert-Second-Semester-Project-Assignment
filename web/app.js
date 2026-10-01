// EcoRoute 프런트엔드 — Figma "EcoRoute Wireframe v2" 흐름(D1–D7) 기준.
// 모션 역할: anime.js = SVG 경로 드로잉·카운트업·막대 stagger, Motion = 스프링 UI 전환.
const anime = window.anime;
const Motion = window.Motion;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = (lib) => Boolean(lib) && !reduceMotion;

// 휘발유 기준으로 통일 (route_energy.py: 33.7kWh/gal, 8.887kgCO₂/gal ≈ 8.9kWh/L, 2.35kgCO₂/L)
const GASOLINE_KWH_PER_L = 8.9;
const GASOLINE_CO2_KG_PER_L = 2.35;
const GASOLINE_KRW_PER_L = 1680; // 와이어프레임 v2 예시 단가
const CO2_KG_PER_KWH = GASOLINE_CO2_KG_PER_L / GASOLINE_KWH_PER_L;

const ECO_COLOR = "#0e9f6e";
const FAST_COLOR = "#6b7682";
const ALT_COLORS = ["#c4891c", "#8b5e3c", "#5a7896"];
const WEEK = ["월", "화", "수", "목", "금", "토", "일"];
const VEHICLE_LABELS = { compact: "소형차", midsize: "중형차", truck: "트럭" };
const GUEST_KEY = "ecoroute-weekly-records-v2";
const INTRO_KEY = "ecoroute-intro-seen";
const SUGGESTED_PLACES = [
  "Depot Plaza",
  "Yost Ice Arena",
  "University of Michigan Soccer Complex",
  "Ann Arbor District Library Traverwood",
  "Gallup One Stop",
  "Lawton Park",
];
const VIEWS = ["plan", "weekly", "trips"];

const state = {
  config: null,
  map: null,
  regionLayer: null,
  nodesLayer: null,
  ghost: null,
  markers: { start: null, destination: null },
  points: { start: null, destination: null },
  pickMode: "start",
  step: "pick",
  calc: null,
  calcTimer: null,
  needsFit: false,
  result: null,
  routeLayers: new Map(),
  routeColors: new Map(),
  selectedRouteId: null,
  saved: null,
  weekly: [],
  user: null,
  tripsPage: 1,
  drawerTrip: null,
  pendingDelete: null,
  toastTimer: null,
  car: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const pad2 = (value) => String(value).padStart(2, "0");
const fmt = (value, digits = 1) => Number(value).toLocaleString("ko-KR", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const signed = (value, digits = 1) => {
  const rounded = Number(Math.abs(value).toFixed(digits));
  if (rounded === 0) return fmt(0, digits);
  return `${value > 0 ? "+" : "−"}${fmt(rounded, digits)}`;
};
const toneOf = (change) => (change < -0.05 ? "good" : change > 0.05 ? "bad" : "base");
const todayIndex = () => (new Date().getDay() + 6) % 7;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function api(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `요청을 처리하지 못했어요. (${response.status})`);
  return payload;
}

/* ── 첫 방문 인트로 (1.2초 이내, 한 번만) ─────────── */
function playIntro() {
  let seen = true;
  try {
    seen = Boolean(localStorage.getItem(INTRO_KEY));
    localStorage.setItem(INTRO_KEY, "1");
  } catch {}
  if (seen || !canAnimate(anime) || !Motion) return;

  const intro = $("#intro");
  intro.hidden = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    Motion.animate(intro, { opacity: 0 }, { duration: 0.26 }).then(() => intro.remove());
  };
  const road = anime.svg.createDrawable(".intro-road path");
  anime.animate(road, { draw: ["0 0", "0 1"], duration: 700, ease: "outExpo" });
  Motion.animate(".intro-mark", { opacity: [0, 1], y: [10, 0] }, { type: "spring", stiffness: 260, damping: 26 });
  setTimeout(finish, 900);
  intro.addEventListener("click", finish, { once: true });
  window.addEventListener("keydown", finish, { once: true });
}

/* ── 상단 탭 / 화면 전환 ──────────────────────────── */
function currentView() {
  const view = location.hash.slice(1);
  return VIEWS.includes(view) ? view : "plan";
}

function renderView() {
  const view = currentView();
  VIEWS.forEach((name) => { $(`#view-${name}`).hidden = name !== view; });
  $$(".tabs a").forEach((link) => {
    if (link.dataset.tab === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  moveTabIndicator();
  if (view === "plan") {
    setTimeout(() => {
      state.map?.invalidateSize();
      if (state.needsFit) fitRegion();
    }, 0);
  }
  if (view === "weekly") showWeekly();
  if (view === "trips") showTrips();
}

function moveTabIndicator(instant = false) {
  const indicator = $(".tab-indicator");
  const active = $(".tabs a[aria-current='page']");
  if (!active || getComputedStyle(indicator).display === "none") return;
  const target = { x: active.offsetLeft, width: active.offsetWidth };
  if (!Motion) {
    indicator.style.transform = `translateX(${target.x}px)`;
    indicator.style.width = `${target.width}px`;
    return;
  }
  const first = !indicator.style.width;
  Motion.animate(indicator, target, instant || first || reduceMotion
    ? { duration: 0 }
    : { type: "spring", stiffness: 500, damping: 30 });
}

/* ── 지도 ─────────────────────────────────────────── */
function initMap() {
  state.map = L.map("map", { zoomControl: false, maxZoom: 17, zoomSnap: 0.5 });
  L.control.zoom({ position: "bottomright" }).addTo(state.map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.map.on("click", onMapClick);
  state.map.on("mousemove", onMapHover);
  state.map.on("mouseout", hideGhost);
  state.map.on("zoomend", restartCarAfterZoom);
}

function regionBounds() {
  const bounds = state.config.selectable_bounds;
  return L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
}

function loadRegion(config) {
  state.config = config;
  state.regionLayer?.remove();
  state.nodesLayer?.remove();
  const bounds = regionBounds();
  const [south, west, north, east] = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
  const pad = 3;
  const mask = { stroke: false, fillColor: "#ffffff", fillOpacity: 0.72, interactive: false };
  state.regionLayer = L.layerGroup([
    L.rectangle([[south - pad, west - pad], [south, east + pad]], mask),
    L.rectangle([[north, west - pad], [north + pad, east + pad]], mask),
    L.rectangle([[south, west - pad], [north, west]], mask),
    L.rectangle([[south, east], [north, east + pad]], mask),
    L.rectangle(bounds, { color: "#16202a", weight: 1.5, opacity: 0.45, dashArray: "6 6", fill: false, interactive: false }),
  ]).addTo(state.map);

  const renderer = L.canvas({ padding: 0.35 });
  state.nodesLayer = L.layerGroup(config.nodes.map((node) => L.circleMarker([node.lat, node.lon], {
    renderer,
    radius: 3,
    stroke: false,
    fillColor: "#16202a",
    fillOpacity: 0.32,
    interactive: false,
  })));
  if (state.step === "pick") state.nodesLayer.addTo(state.map);
  const region = config.regions.find((item) => item.key === config.region);
  $("#map-caption").textContent = `점선 안의 ${region?.short_label || ""} 도로에서 고를 수 있어요`;
  state.map.setMaxBounds(bounds.pad(2));
  state.map.setView([config.center.lat, config.center.lon], 13, { animate: false });
  fitRegion();
}

// 지도가 숨겨진 화면(주간 리포트 등)에서 맞추면 크기 0 기준으로 줌이 잠기므로, 보일 때까지 미룬다.
function fitRegion() {
  const container = state.map.getContainer();
  if (!container.clientWidth || !container.clientHeight) {
    state.needsFit = true;
    return;
  }
  state.needsFit = false;
  state.map.setMinZoom(0);
  // 애니메이션 중에는 getZoom()이 이전 값이라 최소 줌이 잘못 잠기므로 즉시 맞춘다.
  state.map.fitBounds(regionBounds(), { ...fitOptions(24), animate: false });
  state.map.setMinZoom(state.map.getZoom() - 0.5);
}

// 패널이 지도 위에 떠 있으므로(데스크톱은 왼쪽, 모바일은 아래) 그만큼 비워 두고 맞춘다.
function fitOptions(pad) {
  const panel = $("#panel");
  return matchMedia("(max-width: 760px)").matches
    ? { paddingTopLeft: [pad, pad], paddingBottomRight: [pad, pad + panel.offsetHeight] }
    : { paddingTopLeft: [pad + panel.offsetLeft + panel.offsetWidth, pad], paddingBottomRight: [pad, pad] };
}

function nearestNode(latlng) {
  const lonScale = Math.cos(latlng.lat * Math.PI / 180);
  let nearest = null;
  let best = Infinity;
  state.config.nodes.forEach((node) => {
    const dy = node.lat - latlng.lat;
    const dx = (node.lon - latlng.lng) * lonScale;
    const score = dx * dx + dy * dy;
    if (score < best) { best = score; nearest = node; }
  });
  return nearest;
}

function nodeLabel(node) {
  if (state.config.region === "ann_arbor" && node.place_label) return node.place_label;
  return `지점 ${node.lat.toFixed(4)}, ${node.lon.toFixed(4)}`;
}

function pinIcon(kind) {
  const size = kind === "ghost" ? 16 : 20;
  return L.divIcon({
    className: "",
    html: `<span class="pin pin-${kind}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function showMapHint(message) {
  const map = $("#map");
  $(".map-hint", map)?.remove();
  const hint = document.createElement("div");
  hint.className = "map-hint";
  hint.textContent = message;
  map.append(hint);
  setTimeout(() => hint.remove(), 1600);
}

function onMapClick({ latlng }) {
  if (state.step !== "pick" || !state.config) return;
  if (!regionBounds().contains(latlng)) {
    showMapHint("점선 사각형 안을 눌러 주세요");
    return;
  }
  const node = nearestNode(latlng);
  if (node) pickNode(node);
}

let hoverFrame = 0;
function onMapHover({ latlng }) {
  if (state.step !== "pick" || !state.config || !matchMedia("(pointer: fine)").matches) return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const node = regionBounds().contains(latlng) && nearestNode(latlng);
    if (!node) {
      hideGhost();
      return;
    }
    const text = `${state.pickMode === "start" ? "출발" : "도착"}: ${escapeHtml(nodeLabel(node))}`;
    if (!state.ghost) {
      state.ghost = L.marker([node.lat, node.lon], { icon: pinIcon("ghost"), interactive: false, keyboard: false })
        .bindTooltip(text, { direction: "top", offset: [0, -10], className: "map-tip ghost" })
        .addTo(state.map);
    }
    state.ghost.setLatLng([node.lat, node.lon]);
    state.ghost.setTooltipContent(text);
    state.ghost.openTooltip();
  });
}

function hideGhost() {
  cancelAnimationFrame(hoverFrame);
  state.ghost?.remove();
  state.ghost = null;
}

/* ── D1 지점 고르기 ───────────────────────────────── */
function pickNode(node) {
  setPoint(state.pickMode, node);
  if (state.pickMode === "start" && !state.points.destination) setPickMode("destination");
  else if (state.pickMode === "destination" && !state.points.start) setPickMode("start");
  hideGhost();
  renderGuide();
}

function setPoint(kind, node) {
  state.points[kind] = {
    node_id: node.id,
    lat: node.lat,
    lon: node.lon,
    label: nodeLabel(node),
    ...(node.place_label ? { place_label: node.place_label } : {}),
  };
  state.markers[kind]?.remove();
  state.markers[kind] = L.marker([node.lat, node.lon], {
    icon: pinIcon(kind === "start" ? "start" : "end"),
    keyboard: false,
    interactive: false,
  }).bindTooltip(kind === "start" ? "출발" : "도착", {
    permanent: true, direction: "top", offset: [0, -12], className: "map-tip",
  }).addTo(state.map);
  renderStops();
}

function clearPoint(kind) {
  state.points[kind] = null;
  state.markers[kind]?.remove();
  state.markers[kind] = null;
}

function setPickMode(kind) {
  state.pickMode = kind;
  $$(".stop").forEach((stop) => stop.classList.toggle("active", stop.dataset.pick === kind));
  renderGuide();
}

function renderStops() {
  ["start", "destination"].forEach((kind) => {
    const label = $(`#stop-${kind} strong`);
    const point = state.points[kind];
    label.textContent = point ? point.label : "지도에서 선택";
    label.classList.toggle("placeholder", !point);
    label.title = point ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : "";
  });
  $$("#suggestion-chips .chip").forEach((chip) => {
    const picked = Object.values(state.points).some((point) => point?.node_id === chip.dataset.node);
    chip.setAttribute("aria-pressed", String(picked));
  });
  const { start, destination } = state.points;
  $("#find-routes").disabled = !(start && destination);
  $("#cta-hint").textContent = start && destination
    ? ""
    : `${start ? "도착지" : destination ? "출발지" : "출발지와 도착지"}를 고르면 비교할 수 있어요`;
}

function renderGuide() {
  const guide = $("#pick-guide");
  const ready = Boolean(state.points.start && state.points.destination);
  guide.classList.toggle("ready", ready);
  $("b", guide).textContent = ready ? "✓" : state.pickMode === "start" ? "1" : "2";
  $("span", guide).textContent = ready
    ? "준비됐어요. 바꿀 칸을 누르고 지도를 다시 눌러도 돼요"
    : state.pickMode === "start"
      ? "지도에서 출발지를 눌러 주세요"
      : "이제 도착지를 눌러 주세요";
}

function swapStops() {
  const { start, destination } = state.points;
  if (!start && !destination) return;
  const byId = (point) => point && state.config.nodes.find((node) => node.id === point.node_id);
  const [newStart, newDestination] = [byId(destination), byId(start)];
  clearPoint("start");
  clearPoint("destination");
  if (newStart) setPoint("start", newStart);
  if (newDestination) setPoint("destination", newDestination);
  renderStops();
  setPickMode(!state.points.start ? "start" : "destination");
}

function renderSuggestions() {
  const nodes = state.config.region === "ann_arbor"
    ? SUGGESTED_PLACES
      .map((label) => state.config.nodes.find((node) => node.place_label === label))
      .filter(Boolean)
    : [];
  $("#suggestions").hidden = nodes.length === 0;
  $("#suggestion-chips").innerHTML = nodes.map((node) => `
    <button class="chip" type="button" data-node="${escapeHtml(node.id)}" aria-pressed="false">${escapeHtml(node.place_label)}</button>`).join("");
}

function fillConditions() {
  const now = new Date();
  $("#weekday").innerHTML = WEEK.map((day, index) => `
    <option value="${index}"${index === todayIndex() ? " selected" : ""}>${day}요일</option>`).join("");
  $("#hour").innerHTML = Array.from({ length: 24 }, (_, hour) => `
    <option value="${hour}"${hour === now.getHours() ? " selected" : ""}>${pad2(hour)}:00</option>`).join("");
}

function conditions() {
  return {
    hour: Number($("#hour").value),
    weekday: Number($("#weekday").value),
    vehicle: $("input[name='vehicle']:checked").value,
  };
}

function renderConditions() {
  const { hour, weekday, vehicle } = conditions();
  const isNow = hour === new Date().getHours() && weekday === todayIndex();
  const region = state.config?.regions.find((item) => item.key === state.config.region);
  $("#conditions-summary").innerHTML = [
    isNow ? '<span class="now">지금 출발</span>' : `<span>${WEEK[weekday]} ${pad2(hour)}:00</span>`,
    `<span>${VEHICLE_LABELS[vehicle]}</span>`,
    region ? `<span>${escapeHtml(region.short_label)}</span>` : "",
  ].join("");
}

function renderRegionOptions() {
  $("#region-options").innerHTML = state.config.regions.map((region) => `
    <label><input type="radio" name="region" value="${escapeHtml(region.key)}"${region.key === state.config.region ? " checked" : ""}>
    <span>${escapeHtml(region.short_label)}</span></label>`).join("");
}

async function switchRegion(key) {
  if (key === state.config.region) return;
  const inputs = $$("input[name='region']");
  inputs.forEach((input) => { input.disabled = true; });
  $("#pick-error").textContent = "";
  try {
    const config = await api(`/api/regions/${encodeURIComponent(key)}`);
    clearPoint("start");
    clearPoint("destination");
    loadRegion(config);
    renderRegionOptions();
    renderSuggestions();
    renderStops();
    setPickMode("start");
    renderConditions();
  } catch (error) {
    $("#pick-error").textContent = error.message;
    renderRegionOptions();
  }
}

/* ── 패널 단계 전환 ───────────────────────────────── */
function setStep(step, { animate = true } = {}) {
  state.step = step;
  $$(".step").forEach((element) => { element.hidden = element.dataset.step !== step; });
  const panel = $("#panel");
  panel.classList.remove("collapsed");
  $("#sheet-handle").setAttribute("aria-expanded", "true");
  $("#map").classList.toggle("picking", step === "pick");
  $("#map-caption").hidden = step !== "pick";
  if (step === "pick") {
    clearRoutes();
    state.nodesLayer?.addTo(state.map);
  } else {
    state.nodesLayer?.remove();
    hideGhost();
  }
  const current = $(`.step[data-step="${step}"]`);
  $(".step-body", current).scrollTop = 0;
  if (animate && canAnimate(Motion)) {
    Motion.animate(current, { opacity: [0, 1], x: [14, 0] }, { type: "spring", stiffness: 260, damping: 26 });
  }
}

/* ── D2 계산 중 ───────────────────────────────────── */
function startCalcProgress() {
  const items = $$("#calc-steps li");
  let index = 0;
  const paint = () => items.forEach((item, i) => {
    item.classList.toggle("done", i < index);
    item.classList.toggle("active", i === index);
  });
  paint();
  state.calcTimer = setInterval(() => {
    if (index < items.length - 1) index += 1;
    paint();
  }, 1400);
}

function stopCalcProgress(complete) {
  clearInterval(state.calcTimer);
  if (complete) $$("#calc-steps li").forEach((item) => { item.classList.remove("active"); item.classList.add("done"); });
}

async function calculateRoutes() {
  if (!(state.points.start && state.points.destination)) return;
  $("#pick-error").textContent = "";
  setStep("calc");
  startCalcProgress();
  const controller = new AbortController();
  state.calc = controller;
  const strip = ({ node_id: nodeId, lat, lon }) => ({ node_id: nodeId, lat, lon });
  try {
    const result = await api("/api/route-calculations", {
      method: "POST",
      signal: controller.signal,
      body: {
        region: state.config.region,
        start: strip(state.points.start),
        destination: strip(state.points.destination),
        ...conditions(),
      },
    });
    stopCalcProgress(true);
    await new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : 220));
    if (controller.signal.aborted) return;
    state.result = result;
    state.saved = null;
    showCompare();
  } catch (error) {
    stopCalcProgress(false);
    if (controller.signal.aborted) return;
    setStep("pick");
    $("#pick-error").textContent = error.message;
  } finally {
    if (state.calc === controller) state.calc = null;
  }
}

function cancelCalculation() {
  state.calc?.abort();
  stopCalcProgress(false);
  setStep("pick");
}

/* ── D3 경로 비교 ─────────────────────────────────── */
function fastestRoute(routes) {
  return routes.find((route) => route.is_fastest_route)
    || [...routes].sort((a, b) => a.traffic_travel_time_min - b.traffic_travel_time_min)[0];
}

function orderedRoutes(routes) {
  const eco = routes.find((route) => route.is_greenest_route);
  const fastest = fastestRoute(routes);
  const head = [eco, fastest].filter((route, index, list) => route && list.indexOf(route) === index);
  const rest = routes.filter((route) => !head.includes(route)).sort((a, b) => a.total_co2_kg - b.total_co2_kg);
  return [...head, ...rest];
}

function routeName(route) {
  if (route.is_greenest_route && route.is_fastest_route) return "저탄소·최단 시간 경로";
  if (route.is_greenest_route) return "저탄소 경로";
  if (route.is_fastest_route) return "가장 빠른 경로";
  return `대안 경로 ${String(route.route_id).split("_").pop()}`;
}

function co2Change(route, fastest) {
  return fastest.total_co2_kg > 0 ? (route.total_co2_kg / fastest.total_co2_kg - 1) * 100 : 0;
}

function clearRoutes() {
  stopCar();
  state.routeLayers.forEach(({ casing, line, tip }) => { casing.remove(); line.remove(); tip?.remove(); });
  state.routeLayers.clear();
}

function routeElements(routeId) {
  const { casing, line } = state.routeLayers.get(routeId);
  return [casing, line].flatMap((group) => group.getLayers().map((layer) => layer.getElement())).filter(Boolean);
}

function showCompare({ returning = false } = {}) {
  const { routes, geojson } = state.result;
  clearRoutes();
  const fastest = fastestRoute(routes);
  const ordered = orderedRoutes(routes);
  let alt = 0;
  state.routeColors = new Map(ordered.map((route) => [route.route_id,
    route.is_greenest_route ? ECO_COLOR
      : route === fastest ? FAST_COLOR
        : ALT_COLORS[alt++ % ALT_COLORS.length]]));

  setStep("compare");
  const featureById = new Map(geojson.features.map((feature) => [feature.properties.route_id, feature]));
  const bounds = L.latLngBounds([]);
  [...ordered].reverse().forEach((route) => {
    const feature = featureById.get(route.route_id);
    if (!feature) return;
    const style = { lineCap: "round", lineJoin: "round" };
    const casing = L.geoJSON(feature, { style: { ...style, color: "#ffffff", weight: 9, opacity: 0.85 }, interactive: false }).addTo(state.map);
    const line = L.geoJSON(feature, { style: { ...style, color: state.routeColors.get(route.route_id), weight: 5, opacity: 0.9 } }).addTo(state.map);
    // 경로가 구간별 MultiLineString이라 Leaflet 기본 중심은 첫 구간에 붙는다. 전체 좌표의 가운데에 단다.
    const points = line.getLayers().flatMap((layer) => layer.getLatLngs().flat(Infinity));
    // 선 위가 아니라 옆에 달아야 달리는 차를 가리지 않는다.
    const tip = points.length ? L.tooltip({ permanent: true, direction: "right", offset: [10, 0], className: "route-tip" })
      .setLatLng(points[Math.floor(points.length / 2)])
      .setContent(`${fmt(route.traffic_travel_time_min, 0)}분`)
      .addTo(state.map) : null;
    line.on("click", () => {
      const input = $(`#route-list input[value="${CSS.escape(String(route.route_id))}"]`);
      if (input) { input.checked = true; selectRoute(route.route_id); }
    });
    state.routeLayers.set(route.route_id, { casing, line, tip });
    bounds.extend(line.getBounds());
  });

  const { vehicle, weekday, hour } = state.result;
  $("#compare-title").textContent = ordered.length > 1 ? `경로 ${ordered.length}개를 비교했어요` : "경로를 찾았어요";
  $("#compare-meta").textContent = `${vehicle.label}로 ${WEEK[weekday]}요일 ${pad2(hour)}:00에 출발할 때`;
  const maxRelative = Math.max(100, ...ordered.map((route) => 100 + co2Change(route, fastest))) * 1.04;
  $("#route-list").innerHTML = ordered.map((route) => routeItemHtml(route, fastest, maxRelative)).join("");
  $$("#route-list input").forEach((input) => input.addEventListener("change", () => selectRoute(input.value)));

  const keep = returning && ordered.some((route) => String(route.route_id) === state.selectedRouteId);
  const first = keep ? state.selectedRouteId : String(ordered[0].route_id);
  $(`#route-list input[value="${CSS.escape(first)}"]`).checked = true;
  // 처음 보여 줄 때는 경로 드로잉(최대 약 1.35초)이 끝난 뒤 차를 출발시킨다.
  selectRoute(first, returning ? 0 : 1300);
  // 목록을 채운 뒤 맞춰야 모바일 시트 높이가 반영된다.
  if (bounds.isValid()) state.map.fitBounds(bounds, fitOptions(48));
  if (!returning) animateCompare(ordered);
}

function routeItemHtml(route, fastest, maxRelative) {
  const isFastest = route === fastest;
  const change = co2Change(route, fastest);
  const tone = isFastest ? "base" : toneOf(change);
  const minutes = route.traffic_travel_time_min - fastest.traffic_travel_time_min;
  const timeText = isFastest ? "가장 빠름" : Math.abs(minutes) < 0.5 ? "같은 시간" : `${signed(minutes, 0)}분`;
  const relative = 100 + change;
  const tag = route.is_greenest_route ? '<span class="tag tag-eco">추천</span>' : "";
  return `<label class="route" style="--route-color:${state.routeColors.get(route.route_id)}">
    <input type="radio" name="route" value="${escapeHtml(route.route_id)}">
    <span class="route-name">${routeName(route)} ${tag}</span>
    <span class="route-meta"><span><b>${fmt(route.traffic_travel_time_min, 0)}</b>분</span><span><b>${fmt(route.distance_km, 1)}</b>km</span></span>
    <span class="route-delta">
      <span class="co2 ${tone}">${isFastest ? "기준" : `${signed(change)}%`}<small>CO₂</small></span>
      <span class="time">${timeText}</span>
    </span>
    <span class="tradeoff" aria-hidden="true">
      <i class="${tone}" style="transform:scaleX(${(relative / maxRelative).toFixed(4)})"></i>
      <em style="left:${(100 / maxRelative * 100).toFixed(2)}%"></em>
    </span>
  </label>`;
}

function selectRoute(routeId, carDelay = 0) {
  state.selectedRouteId = String(routeId);
  state.routeLayers.forEach(({ casing, line, tip }, id) => {
    const selected = String(id) === state.selectedRouteId;
    casing.setStyle({ weight: selected ? 13 : 8, opacity: selected ? 1 : 0.7 });
    line.setStyle({ weight: selected ? 7 : 4, opacity: selected ? 1 : 0.5 });
    tip?.getElement()?.classList.toggle("selected", selected);
  });
  const selected = [...state.routeLayers.entries()].find(([id]) => String(id) === state.selectedRouteId)?.[1];
  selected?.casing.bringToFront();
  selected?.line.bringToFront();
  startCar(carDelay);
}

// D3-M7: 선택한 경로를 따라 달리는 차. 화면에 하나뿐인 장식 루프라 탭이 숨겨지면 멈춘다.
function startCar(delay = 0) {
  stopCar();
  if (!canAnimate(anime)) return;
  const entry = [...state.routeLayers.entries()].find(([id]) => String(id) === state.selectedRouteId)?.[1];
  const path = entry?.line.getLayers()[0]?.getElement();
  if (!path) return;
  const color = [...state.routeColors].find(([id]) => String(id) === state.selectedRouteId)?.[1];
  // 경로와 같은 Leaflet SVG 안에 넣어야 같은 좌표계로 움직인다. 0°(오른쪽)를 향한 위에서 본 차.
  const car = document.createElementNS("http://www.w3.org/2000/svg", "g");
  car.setAttribute("class", "route-car");
  car.style.visibility = "hidden";
  car.innerHTML = `
    <circle r="12" fill="#fff" stroke="${color}" stroke-width="2.5"></circle>
    <path d="M-7 -5h8.5l4.5 3v4l-4.5 3h-8.5a1.5 1.5 0 0 1-1.5-1.5v-7a1.5 1.5 0 0 1 1.5-1.5z" fill="${color}" stroke="none"></path>
    <path d="M1.8-3.4 4-1.8v3.6L1.8 3.4z" fill="#fff" stroke="none" opacity=".9"></path>`;
  path.parentNode.appendChild(car);
  const { translateX, translateY, rotate } = anime.svg.createMotionPath(path);
  const animation = anime.animate(car, {
    translateX,
    translateY,
    rotate,
    duration: 4000,
    delay,
    loop: true,
    ease: "linear",
    onBegin: () => { car.style.visibility = ""; },
  });
  if (document.hidden) animation.pause();
  state.car = { el: car, animation, startAt: performance.now() + delay };
}

function stopCar() {
  state.car?.animation.cancel();
  state.car?.el.remove();
  state.car = null;
}

// 줌하면 Leaflet이 경로 좌표를 다시 계산하므로, 같은 진행률에서 새 경로로 다시 출발시킨다.
function restartCarAfterZoom() {
  if (!state.car) return;
  const wait = Math.max(0, state.car.startAt - performance.now());
  const progress = state.car.animation.iterationProgress;
  // Leaflet 경로가 zoomend 처리기에서 다시 그려진 다음에 읽어야 한다.
  setTimeout(() => {
    if (!state.car) return;
    startCar(wait);
    if (!wait) state.car.animation.iterationProgress = progress;
  }, 0);
}

// 한 화면의 연출: 경로가 순서대로 그려지고 트레이드오프 막대가 차오른다.
function animateCompare(ordered) {
  if (!canAnimate(anime)) return;
  ordered.forEach((route, index) => {
    if (!state.routeLayers.has(route.route_id)) return;
    const elements = routeElements(route.route_id);
    anime.animate(anime.svg.createDrawable(elements), {
      draw: ["0 0", "0 1"],
      duration: 900,
      delay: index * 150,
      ease: "outExpo",
      onComplete: () => elements.forEach((element) => {
        element.removeAttribute("pathLength");
        element.style.strokeDasharray = "";
        element.style.strokeDashoffset = "";
      }),
    });
  });
  anime.animate("#route-list .tradeoff i", {
    scaleX: { from: 0 },
    duration: 700,
    delay: anime.stagger(60, { start: 200 }),
    ease: "outExpo",
  });
}

/* ── D4 선택 완료 ─────────────────────────────────── */
function showDone() {
  const routes = state.result.routes;
  const chosen = routes.find((route) => String(route.route_id) === state.selectedRouteId);
  const fastest = fastestRoute(routes);
  if (!chosen) return;
  const change = co2Change(chosen, fastest);
  const tone = toneOf(change);
  const relative = 100 + change;

  $("#done-title").textContent = chosen.is_greenest_route && chosen === fastest
    ? "가장 빠르면서 덜 배출하는 길이에요"
    : tone === "good"
      ? "덜 배출하는 길을 골랐어요"
      : chosen === fastest
        ? "가장 빠른 길을 골랐어요"
        : tone === "bad" ? "조금 더 배출하는 길을 골랐어요" : "가장 빠른 길과 배출이 같은 길이에요";
  $("#done-label").textContent = tone === "good"
    ? "가장 빠른 길보다 CO₂ 감소"
    : tone === "bad" ? "가장 빠른 길보다 CO₂ 증가" : "가장 빠른 길과 같은 CO₂";
  const number = $("#done-number");
  number.className = `figure ${tone}`;
  const scale = Math.max(100, relative);
  const fastBar = $("#bar-fastest");
  const chosenBar = $("#bar-chosen");
  chosenBar.classList.toggle("bad", tone === "bad");
  $("#bar-chosen-label").textContent = `${fmt(relative)}%`;
  const { weekday, hour, vehicle } = state.result;
  $("#done-meta").textContent = `${WEEK[weekday]}요일 ${pad2(hour)}:00 출발 · ${vehicle.label} · ${fmt(chosen.distance_km, 1)}km · 약 ${fmt(chosen.traffic_travel_time_min, 0)}분`;
  // 가장 빠른 길 대비 아낀 양 (음수면 더 쓴 양)
  const savedLiters = (fastest.total_energy_kwh - chosen.total_energy_kwh) / GASOLINE_KWH_PER_L;
  const savedGrams = (fastest.total_co2_kg - chosen.total_co2_kg) * 1000;
  const savedWon = savedLiters * GASOLINE_KRW_PER_L;
  const word = (value, less, more) => (value >= 0 ? less : more);
  $("#done-savings").className = `savings ${tone}`;
  $("#done-savings").innerHTML = [
    ["CO₂", `${fmt(Math.abs(savedGrams), 0)}<small>g</small>`, word(savedGrams, "적게", "많이")],
    ["휘발유", `${fmt(Math.abs(savedLiters), 2)}<small>L</small>`, word(savedLiters, "절약", "더 씀")],
    ["기름값", `${Math.round(Math.abs(savedWon)).toLocaleString("ko-KR")}<small>원</small>`, word(savedWon, "절약", "더 듦")],
  ].map(([term, value, note]) => `<div><dt>${term}</dt><dd><span class="num">${value}</span> ${note}</dd></div>`).join("");

  setStep("done");
  const target = Math.abs(change);
  const fastScale = 100 / scale;
  const chosenScale = relative / scale;
  if (canAnimate(anime)) {
    const counter = { value: 0 };
    anime.animate(counter, {
      value: target,
      duration: 1000,
      ease: "outExpo",
      onUpdate: () => { number.innerHTML = `${fmt(counter.value)}<small>%</small>`; },
    });
    anime.animate(fastBar, { scaleX: [0, fastScale], duration: 800, ease: "outExpo" });
    anime.animate(chosenBar, { scaleX: [0, chosenScale], duration: 800, delay: 120, ease: "outExpo" });
  } else {
    number.innerHTML = `${fmt(target)}<small>%</small>`;
    fastBar.style.transform = `scaleX(${fastScale})`;
    chosenBar.style.transform = `scaleX(${chosenScale})`;
  }
  recordChoice(chosen, fastest);
}

function tripPayload(chosen, fastest) {
  const weekday = Number(state.result.weekday);
  const point = (kind) => ({
    lat: state.result[kind].lat,
    lon: state.result[kind].lon,
    label: (state.points[kind]?.place_label || "").slice(0, 100),
  });
  return {
    name: `${WEEK[weekday]}요일 ${routeName(chosen)}`,
    driven_on: dateOfWeekday(weekday),
    region: state.result.region,
    hour: Number(state.result.hour),
    weekday,
    vehicle: state.result.vehicle.key,
    start: point("start"),
    destination: point("destination"),
    route_label: routeName(chosen),
    distance_km: chosen.distance_km,
    baseline_energy_kwh: fastest.total_energy_kwh,
    chosen_energy_kwh: chosen.total_energy_kwh,
    baseline_co2_kg: fastest.total_co2_kg,
    chosen_co2_kg: chosen.total_co2_kg,
  };
}

async function recordChoice(chosen, fastest) {
  const status = $("#save-status");
  const routeId = String(chosen.route_id);
  if (state.saved?.routeId === routeId) {
    renderWeekDots();
    return;
  }
  const payload = tripPayload(chosen, fastest);
  if (!state.user) {
    recordGuest(payload);
    state.saved = { routeId };
    renderWeekDots(payload.weekday);
    status.classList.add("guest");
    status.innerHTML = '<span>로그인하면 이 기록이 계정에 저장돼요. 지금은 이 탭에만 남아요.</span><button type="button" data-login="save">로그인</button>';
    return;
  }
  status.classList.remove("guest");
  status.textContent = "내 기록에 저장하고 있어요…";
  try {
    // 같은 계산 결과에서 경로만 바꿔 고르면 이전 저장분을 대체한다.
    if (state.saved?.tripId) await api(`/api/trips/${state.saved.tripId}`, { method: "DELETE" }).catch(() => {});
    const trip = await api("/api/trips", { method: "POST", body: payload });
    state.saved = { routeId, tripId: trip.id };
    state.weekly = await loadServerWeekly();
    renderWeekDots(payload.weekday);
    status.textContent = "내 기록에 저장했어요.";
  } catch (error) {
    state.saved = null;
    status.textContent = `기록을 저장하지 못했어요. ${error.message}`;
  }
}

function renderWeekDots(bounceDay) {
  const recorded = new Set(state.weekly.map((record) => record.dayIndex));
  $("#week-count").textContent = `${recorded.size} / 7일`;
  $("#week-dots").innerHTML = WEEK.map((day, index) => {
    const classes = [recorded.has(index) ? "filled" : "", index === todayIndex() ? "today" : ""].join(" ").trim();
    return `<li class="${classes}" aria-label="${day}요일 ${recorded.has(index) ? "기록 있음" : "기록 없음"}">${day}</li>`;
  }).join("");
  if (bounceDay !== undefined && canAnimate(Motion)) {
    const dot = $$("#week-dots li")[bounceDay];
    Motion.animate(dot, { scale: [0.4, 1] }, { type: "spring", stiffness: 400, damping: 15, delay: 0.5 });
  }
}

/* ── 주간 기록 (게스트: sessionStorage, 로그인: 서버) ── */
function localDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateOfWeekday(weekday) {
  const date = new Date();
  date.setDate(date.getDate() - todayIndex() + weekday);
  return localDate(date);
}

function weekdayOfDate(isoDate) {
  return (new Date(`${isoDate}T00:00:00`).getDay() + 6) % 7;
}

function loadGuest() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(GUEST_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    const latest = new Map();
    stored
      .filter((record) => Number.isInteger(record?.dayIndex) && record.dayIndex >= 0 && record.dayIndex < 7
        && Number.isFinite(record.baselineEnergy) && Number.isFinite(record.chosenEnergy))
      .forEach((record) => latest.set(record.dayIndex, record));
    return [...latest.values()].sort((a, b) => a.dayIndex - b.dayIndex);
  } catch {
    return [];
  }
}

function saveGuest(records) {
  try { sessionStorage.setItem(GUEST_KEY, JSON.stringify(records)); } catch {}
}

function recordGuest(payload) {
  const record = {
    dayIndex: payload.weekday,
    baselineEnergy: payload.baseline_energy_kwh,
    chosenEnergy: payload.chosen_energy_kwh,
    baselineCo2: payload.baseline_co2_kg,
    chosenCo2: payload.chosen_co2_kg,
    regionLabel: state.result.region_label || payload.region,
    routeLabel: payload.route_label,
    distanceKm: payload.distance_km,
    trip: payload,
  };
  state.weekly = [...loadGuest().filter((item) => item.dayIndex !== record.dayIndex), record]
    .sort((a, b) => a.dayIndex - b.dayIndex);
  saveGuest(state.weekly);
}

async function loadServerWeekly() {
  const params = new URLSearchParams({
    from: dateOfWeekday(0), to: dateOfWeekday(6), sort: "created_at", order: "desc", size: "50",
  });
  const { items } = await api(`/api/trips?${params}`);
  const latest = new Map();
  items.forEach((trip) => {
    const dayIndex = weekdayOfDate(trip.driven_on);
    if (latest.has(dayIndex)) return;
    latest.set(dayIndex, {
      dayIndex,
      baselineEnergy: trip.baseline_energy_kwh,
      chosenEnergy: trip.chosen_energy_kwh,
      baselineCo2: trip.baseline_co2_kg,
      chosenCo2: trip.chosen_co2_kg,
      regionLabel: regionLabel(trip.region),
      routeLabel: trip.route_label,
      distanceKm: trip.distance_km,
    });
  });
  return [...latest.values()].sort((a, b) => a.dayIndex - b.dayIndex);
}

function regionLabel(key) {
  return state.config?.regions.find((region) => region.key === key)?.short_label || key;
}

const co2Of = (record, kind) => {
  const stored = Number(record[`${kind}Co2`]);
  return Number.isFinite(stored) ? stored : Number(record[`${kind}Energy`]) * CO2_KG_PER_KWH;
};

/* ── D5 주간 리포트 ───────────────────────────────── */
async function showWeekly() {
  if (state.user) {
    try { state.weekly = await loadServerWeekly(); } catch {}
  } else {
    state.weekly = loadGuest();
  }
  renderWeekly();
}

function renderWeekly() {
  const records = state.weekly;
  const monday = new Date(`${dateOfWeekday(0)}T00:00:00`);
  const sunday = new Date(`${dateOfWeekday(6)}T00:00:00`);
  const md = (date) => `${date.getMonth() + 1}월 ${date.getDate()}일`;
  $("#weekly-range").textContent = `${md(monday)}부터 ${md(sunday)}까지`;
  $("#weekly-progress").textContent = `${records.length} / 7일`;
  $("#weekly-empty").hidden = records.length > 0;
  $("#weekly-content").hidden = records.length === 0;
  $("#weekly-note").textContent = `휘발유 ${GASOLINE_KWH_PER_L}kWh/L, ${GASOLINE_CO2_KG_PER_L}kgCO₂/L, ${GASOLINE_KRW_PER_L.toLocaleString("ko-KR")}원/L로 환산한 모델 추정값이에요. 같은 요일을 다시 고르면 최신 기록으로 바뀌어요.${state.user ? "" : " 로그인하지 않으면 이 탭을 닫을 때 기록이 사라져요."}`;
  if (!records.length) return;

  const sum = (pick) => records.reduce((total, record) => total + pick(record), 0);
  const baseCo2 = sum((record) => co2Of(record, "baseline"));
  const chosenCo2 = sum((record) => co2Of(record, "chosen"));
  const baseEnergy = sum((record) => Number(record.baselineEnergy));
  const chosenEnergy = sum((record) => Number(record.chosenEnergy));
  const change = baseCo2 > 0 ? (chosenCo2 / baseCo2 - 1) * 100 : 0;
  const tone = toneOf(change);
  const savedCo2 = baseCo2 - chosenCo2;
  const savedFuel = (baseEnergy - chosenEnergy) / GASOLINE_KWH_PER_L;
  const savedCost = savedFuel * GASOLINE_KRW_PER_L;
  const less = savedCo2 >= 0;

  const figure = $("#weekly-change");
  figure.className = `figure ${tone}`;
  $("#weekly-change-label").textContent = tone === "base"
    ? "가장 빠른 길로만 다녔을 때와 CO₂가 같아요"
    : `가장 빠른 길로만 다녔을 때보다 CO₂가 ${tone === "good" ? "줄었어요" : "늘었어요"}`;
  $("#weekly-co2").previousElementSibling.textContent = less ? "줄인 CO₂" : "늘어난 CO₂";
  $("#weekly-fuel").previousElementSibling.textContent = less ? "아낀 휘발유" : "더 쓴 휘발유";
  $("#weekly-cost").previousElementSibling.textContent = less ? "아낀 기름값" : "더 든 기름값";
  $("#weekly-co2").innerHTML = `${fmt(Math.abs(savedCo2), 2)}<small>kg</small>`;
  $("#weekly-fuel").innerHTML = `${fmt(Math.abs(savedFuel), 2)}<small>L</small>`;
  $("#weekly-cost").innerHTML = `${Math.round(Math.abs(savedCost)).toLocaleString("ko-KR")}<small>원</small>`;

  renderWeekChart(records);
  renderWeekTable(records, { baseCo2, chosenCo2, chosenEnergy, change });

  if (canAnimate(anime)) {
    const counter = { value: 0 };
    anime.animate(counter, {
      value: change,
      duration: 1000,
      ease: "outExpo",
      onUpdate: () => { figure.innerHTML = `${signed(counter.value)}<small>%</small>`; },
    });
  } else {
    figure.innerHTML = `${signed(change)}<small>%</small>`;
  }
}

function recordChange(record) {
  const base = co2Of(record, "baseline");
  return base > 0 ? (co2Of(record, "chosen") / base - 1) * 100 : 0;
}

function renderWeekChart(records) {
  const byDay = new Map(records.map((record) => [record.dayIndex, recordChange(record)]));
  // 위쪽 = 감소(좋음), 아래쪽 = 증가
  const values = [...byDay.values()].map((value) => -value);
  const top = Math.max(5, ...values) * 1.25;
  const deepest = Math.max(0, ...values.map((value) => -value));
  // 아래쪽 막대도 수치 라벨이 들어갈 자리를 남긴다.
  const bottom = deepest > 0 ? Math.max(deepest * 1.6, top * 0.35) : 0;
  const total = top + bottom;
  const zero = top / total * 100;
  const chart = $("#weekly-chart");
  chart.setAttribute("aria-label", WEEK.map((day, index) => (byDay.has(index)
    ? `${day}요일 ${signed(byDay.get(index))}%`
    : `${day}요일 기록 없음`)).join(", "));
  chart.innerHTML = WEEK.map((day, index) => {
    const today = index === todayIndex() ? " today" : "";
    if (!byDay.has(index)) {
      return `<div class="wk-col"><div class="wk-plot"><span class="wk-empty">기록 없음</span></div><span class="wk-day${today}">${day}</span></div>`;
    }
    const change = byDay.get(index);
    const tone = toneOf(change);
    const height = Math.max(1.5, Math.abs(change) / total * 100);
    const up = change <= 0;
    const bar = up
      ? `<i class="wk-bar" style="bottom:${100 - zero}%;height:${height}%;transform-origin:bottom"></i>`
      : `<i class="wk-bar bad" style="top:${zero}%;height:${height}%;transform-origin:top"></i>`;
    const label = up
      ? `<span class="wk-value ${tone}" style="bottom:calc(${100 - zero + height}% + 6px)">${signed(change)}%</span>`
      : `<span class="wk-value bad" style="top:calc(${zero + height}% + 6px)">${signed(change)}%</span>`;
    return `<div class="wk-col"><div class="wk-plot"><span class="wk-zero" style="top:${zero}%"></span>${bar}${label}</div><span class="wk-day${today}">${day}</span></div>`;
  }).join("");
  if (canAnimate(anime)) {
    anime.animate("#weekly-chart .wk-bar", {
      scaleY: { from: 0 },
      duration: 800,
      delay: anime.stagger(50),
      ease: "outExpo",
    });
  }
}

function renderWeekTable(records, totals) {
  const krw = (energy) => Math.round(energy / GASOLINE_KWH_PER_L * GASOLINE_KRW_PER_L).toLocaleString("ko-KR");
  const deltaCell = (change) => `<td class="num"><span class="delta ${toneOf(change)}">${signed(change)}%</span></td>`;
  $("#weekly-rows").innerHTML = records.map((record) => {
    const energy = Number(record.chosenEnergy);
    return `<tr>
      <td><b>${WEEK[record.dayIndex]}</b></td>
      <td>${escapeHtml(record.routeLabel || "")} <span class="sub">${escapeHtml(record.regionLabel || "")}</span></td>
      <td class="num">${fmt(record.distanceKm || 0, 1)} km</td>
      <td class="num">${fmt(co2Of(record, "chosen"), 2)} <span class="sub">/ ${fmt(co2Of(record, "baseline"), 2)} kg</span></td>
      <td class="num">${fmt(energy / GASOLINE_KWH_PER_L, 2)} L</td>
      <td class="num">${krw(energy)}원</td>
      ${deltaCell(recordChange(record))}
    </tr>`;
  }).join("");
  const distance = records.reduce((total, record) => total + Number(record.distanceKm || 0), 0);
  $("#weekly-total").innerHTML = `<tr>
    <td>합계</td><td></td>
    <td class="num">${fmt(distance, 1)} km</td>
    <td class="num">${fmt(totals.chosenCo2, 2)} <span class="sub">/ ${fmt(totals.baseCo2, 2)} kg</span></td>
    <td class="num">${fmt(totals.chosenEnergy / GASOLINE_KWH_PER_L, 2)} L</td>
    <td class="num">${krw(totals.chosenEnergy)}원</td>
    ${deltaCell(totals.change)}
  </tr>`;
}

/* ── D6 내 기록 ───────────────────────────────────── */
function showTrips() {
  $("#trips-locked").hidden = Boolean(state.user);
  $("#trips-content").hidden = !state.user;
  if (state.user) loadTrips(1);
  else $("#trips-total").textContent = "0건";
}

async function loadTrips(page) {
  const filter = $("#trips-filter");
  const [sort, order] = filter.elements.sort.value.split(":");
  const params = new URLSearchParams({ q: filter.elements.q.value.trim(), sort, order, page, size: 10 });
  $("#trips-error").textContent = "";
  try {
    const result = await api(`/api/trips?${params}`);
    if (result.page > 1 && result.page > result.total_pages) {
      loadTrips(Math.max(1, result.total_pages));
      return;
    }
    state.tripsPage = result.page;
    renderTrips(result);
  } catch (error) {
    $("#trips-error").textContent = error.message;
  }
}

function tripRoute(trip) {
  const from = trip.start?.label;
  const to = trip.destination?.label;
  return from && to ? `${from}에서 ${to}까지` : `${trip.route_label}, ${regionLabel(trip.region)}`;
}

function renderTrips({ items, page, total, total_pages: totalPages }) {
  const template = $("#trip-row-template");
  const pending = state.pendingDelete?.trip.id;
  $("#trip-list").replaceChildren(...items.map((trip) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.hidden = trip.id === pending;
    row.dataset.id = trip.id;
    const [, month, day] = trip.driven_on.split("-");
    $(".trip-date b", row).textContent = `${Number(month)}.${day}`;
    $(".trip-date small", row).textContent = `${WEEK[weekdayOfDate(trip.driven_on)]} ${pad2(trip.hour)}시`;
    $(".trip-main strong", row).textContent = trip.name;
    $(".trip-main span", row).textContent = tripRoute(trip);
    $(".trip-main em", row).textContent = trip.memo || "";
    $(".trip-main em", row).hidden = !trip.memo;
    $(".trip-distance", row).textContent = `${fmt(trip.distance_km, 1)}km`;
    const change = -trip.reduction_percent;
    const delta = $(".delta", row);
    delta.textContent = `${signed(change)}%`;
    delta.classList.add(toneOf(change));
    $(".trip-row", row).addEventListener("click", () => openDrawer(trip));
    return row;
  }));
  const searching = $("#trips-filter").elements.q.value.trim() !== "";
  $("#trips-empty").hidden = total > 0;
  $("#trips-empty").textContent = searching
    ? "검색어와 맞는 기록이 없어요. 다른 단어로 찾아보세요."
    : "아직 저장된 기록이 없어요. 길찾기에서 경로를 고르면 여기에 쌓여요.";
  $("#trips-total").textContent = `${total}건`;
  $("#trips-page").textContent = totalPages > 1 ? `${page} / ${totalPages}` : "";
  $("#trips-prev").disabled = page <= 1;
  $("#trips-next").disabled = page >= totalPages;
  if (canAnimate(anime) && items.length) {
    anime.animate("#trip-list .trip-row", { opacity: { from: 0 }, y: { from: 6 }, duration: 260, delay: anime.stagger(30), ease: "outQuad" });
  }
}

function openDrawer(trip) {
  state.drawerTrip = trip;
  const drawer = $("#trip-drawer");
  const change = -trip.reduction_percent;
  const tone = toneOf(change);
  const figure = $("#drawer-change");
  figure.className = `figure ${tone}`;
  figure.innerHTML = `${signed(change)}<small>%</small>`;
  $("#drawer-change-label").textContent = "가장 빠른 길 대비 CO₂";
  $("#drawer-facts").innerHTML = [
    ["주행일", `${escapeHtml(trip.driven_on)} ${pad2(trip.hour)}:00`],
    ["지역", escapeHtml(regionLabel(trip.region))],
    ["출발", escapeHtml(trip.start?.label || `${trip.start.lat.toFixed(4)}, ${trip.start.lon.toFixed(4)}`)],
    ["도착", escapeHtml(trip.destination?.label || `${trip.destination.lat.toFixed(4)}, ${trip.destination.lon.toFixed(4)}`)],
    ["경로", escapeHtml(trip.route_label)],
    ["차종", VEHICLE_LABELS[trip.vehicle] || escapeHtml(trip.vehicle)],
    ["거리", `<span class="num">${fmt(trip.distance_km, 2)}</span> km`],
    ["CO₂ 선택 / 빠른 길", `<span class="num">${fmt(trip.chosen_co2_kg, 2)} / ${fmt(trip.baseline_co2_kg, 2)}</span> kg`],
  ].map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("");
  const form = $("#trip-edit-form");
  form.elements.name.value = trip.name;
  form.elements.driven_on.value = trip.driven_on;
  form.elements.memo.value = trip.memo || "";
  $("#trip-edit-error").textContent = "";
  drawer.showModal();
  if (canAnimate(Motion)) {
    const mobile = matchMedia("(max-width: 760px)").matches;
    Motion.animate(drawer, mobile ? { y: ["40%", "0%"] } : { x: [48, 0], opacity: [0, 1] }, { type: "spring", stiffness: 260, damping: 26 });
  }
}

async function saveTripEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const { name, driven_on: drivenOn, memo } = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/trips/${state.drawerTrip.id}`, { method: "PATCH", body: { name, driven_on: drivenOn, memo } });
    $("#trip-drawer").close();
    showToast("변경을 저장했어요");
    loadTrips(state.tripsPage);
  } catch (error) {
    $("#trip-edit-error").textContent = error.message;
  }
}

// 삭제는 5초 동안 되돌릴 수 있고, 그 뒤에 서버에서 지운다.
function requestDelete() {
  const trip = state.drawerTrip;
  $("#trip-drawer").close();
  commitDelete();
  const row = $(`#trip-list li[data-id="${trip.id}"]`);
  if (row) row.hidden = true;
  state.pendingDelete = { trip, row, timer: setTimeout(commitDelete, 5000) };
  showToast(`'${trip.name}' 기록을 삭제했어요`, { label: "되돌리기", onClick: undoDelete }, 5000);
}

function undoDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingDelete = null;
  if (pending.row) pending.row.hidden = false;
  showToast("삭제를 취소했어요");
}

async function commitDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingDelete = null;
  try {
    await api(`/api/trips/${pending.trip.id}`, { method: "DELETE" });
  } catch (error) {
    $("#trips-error").textContent = error.message;
  }
  if (currentView() === "trips") loadTrips(state.tripsPage);
}

/* ── 토스트 ───────────────────────────────────────── */
function showToast(text, action, duration = 3000) {
  const toast = $("#toast");
  const button = $("#toast-action");
  clearTimeout(state.toastTimer);
  $("#toast-text").textContent = text;
  button.hidden = !action;
  button.textContent = action?.label || "";
  button.onclick = action ? () => { hideToast(); action.onClick(); } : null;
  const wasHidden = toast.hidden;
  toast.hidden = false;
  // 되돌리기 같은 시한부 동작은 남은 시간을 막대로 보여 준다.
  toast.classList.remove("timed");
  if (action) {
    toast.style.setProperty("--toast-ms", `${duration}ms`);
    void toast.offsetWidth;
    toast.classList.add("timed");
  }
  if (wasHidden && canAnimate(Motion)) {
    Motion.animate(toast, { y: [16, 0], opacity: [0, 1] }, { type: "spring", stiffness: 500, damping: 30 });
  }
  state.toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(state.toastTimer);
  $("#toast").hidden = true;
}

/* ── D7 로그인 · 계정 ─────────────────────────────── */
async function loadUser() {
  try {
    state.user = await api("/api/users/me");
  } catch {
    state.user = null;
  }
  renderAccount();
}

function renderAccount() {
  $("#account-button span").textContent = state.user ? `${state.user.nickname}님` : "로그인";
}

const AUTH_REASONS = {
  save: "로그인하면 방금 고른 경로가 계정에 저장돼요.",
  trips: "로그인하면 고른 경로를 계정에 모아 볼 수 있어요.",
};

function openAuth(reason) {
  const dialog = $("#auth-dialog");
  const form = $("#auth-form");
  form.hidden = false;
  $("#migrate").hidden = true;
  form.reset();
  setAuthMode("login");
  $("#auth-reason").textContent = AUTH_REASONS[reason] || "";
  $("#auth-reason").hidden = !AUTH_REASONS[reason];
  dialog.showModal();
  popIn(dialog);
}

function popIn(dialog) {
  if (canAnimate(Motion)) Motion.animate(dialog, { scale: [0.96, 1], opacity: [0, 1] }, { type: "spring", stiffness: 500, damping: 30 });
}

function setAuthMode(mode) {
  const form = $("#auth-form");
  const signup = mode === "signup";
  form.elements.mode.value = mode;
  $$("[data-signup-only]", form).forEach((field) => {
    field.hidden = !signup;
    $("input", field).required = signup;
  });
  form.elements.password.autocomplete = signup ? "new-password" : "current-password";
  $("#auth-title").textContent = signup ? "회원가입" : "로그인";
  $("#auth-submit").textContent = signup ? "가입하고 시작하기" : "로그인";
  $("#auth-error").textContent = "";
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const { mode, username, password, nickname } = Object.fromEntries(new FormData(form));
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    state.user = mode === "signup"
      ? await api("/api/users", { method: "POST", body: { username, password, nickname } })
      : (await api("/api/sessions", { method: "POST", body: { username, password } })).user;
    renderAccount();
    afterLogin();
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function afterLogin() {
  const movable = loadGuest().filter((record) => record.trip);
  if (movable.length) {
    $("#auth-form").hidden = true;
    $("#migrate").hidden = false;
    $("#migrate-error").textContent = "";
    $("#migrate-text").textContent = `로그인 전에 이 탭에서 고른 경로 ${movable.length}건이 있어요. 계정으로 옮기면 내 기록과 주간 리포트에 함께 보여요.`;
  } else {
    $("#auth-dialog").close();
    showToast(`반가워요, ${state.user.nickname}님`);
    refreshAfterAuth();
  }
}

async function migrateGuest() {
  const movable = loadGuest().filter((record) => record.trip);
  const button = $("#migrate-confirm");
  button.disabled = true;
  try {
    for (const record of movable) await api("/api/trips", { method: "POST", body: record.trip });
    saveGuest([]);
    $("#auth-dialog").close();
    showToast(`기록 ${movable.length}건을 계정으로 옮겼어요`);
    if (state.step === "done") {
      $("#save-status").classList.remove("guest");
      $("#save-status").textContent = "내 기록에 저장했어요.";
    }
  } catch (error) {
    $("#migrate-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function refreshAfterAuth() {
  state.saved = state.saved && { routeId: state.saved.routeId };
  if (state.user) {
    try { state.weekly = await loadServerWeekly(); } catch {}
  } else {
    state.weekly = loadGuest();
  }
  if (state.step === "done") renderWeekDots();
  renderView();
}

function openAccount() {
  const dialog = $("#account-dialog");
  $("#account-username").textContent = `아이디 ${state.user.username}`;
  $("#nickname-form").elements.nickname.value = state.user.nickname;
  $("#password-form").reset();
  $("#delete-account-form").reset();
  setAccountMessage("");
  dialog.showModal();
  popIn(dialog);
}

function setAccountMessage(text, ok = false) {
  const message = $("#account-message");
  message.textContent = text;
  message.classList.toggle("ok", ok);
}

async function logout() {
  try { await api("/api/sessions/current", { method: "DELETE" }); } catch {}
  state.user = null;
  state.saved = null;
  renderAccount();
  $("#account-dialog").close();
  showToast("로그아웃했어요");
  refreshAfterAuth();
}

function bindAccountForms() {
  $("#nickname-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.user = await api("/api/users/me", { method: "PATCH", body: { nickname: event.currentTarget.elements.nickname.value } });
      renderAccount();
      setAccountMessage("닉네임을 바꿨어요.", true);
    } catch (error) {
      setAccountMessage(error.message);
    }
  });
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/users/me", { method: "PATCH", body: Object.fromEntries(new FormData(form)) });
      form.reset();
      setAccountMessage("비밀번호를 바꿨어요. 다른 기기에서는 로그아웃돼요.", true);
    } catch (error) {
      setAccountMessage(error.message);
    }
  });
  $("#delete-account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/users/me", { method: "DELETE", body: Object.fromEntries(new FormData(event.currentTarget)) });
      state.user = null;
      state.saved = null;
      renderAccount();
      $("#account-dialog").close();
      showToast("탈퇴했어요. 그동안 이용해 주셔서 고마워요");
      refreshAfterAuth();
    } catch (error) {
      setAccountMessage(error.message);
    }
  });
}

/* ── 이벤트 연결 ──────────────────────────────────── */
function bindEvents() {
  window.addEventListener("hashchange", renderView);
  window.addEventListener("resize", () => moveTabIndicator(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) state.car?.animation.pause();
    else state.car?.animation.resume();
  });
  window.addEventListener("pagehide", () => {
    const pending = state.pendingDelete;
    if (pending) fetch(`/api/trips/${pending.trip.id}`, { method: "DELETE", keepalive: true });
  });

  $$(".stop").forEach((stop) => stop.addEventListener("click", () => setPickMode(stop.dataset.pick)));
  $("#swap-stops").addEventListener("click", swapStops);
  $("#suggestion-chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    const node = chip && state.config.nodes.find((item) => item.id === chip.dataset.node);
    if (!node) return;
    pickNode(node);
    state.map.panTo([node.lat, node.lon]);
  });
  $("#conditions").addEventListener("toggle", (event) => {
    $(".conditions-edit").textContent = event.currentTarget.open ? "접기" : "바꾸기";
  });
  ["#hour", "#weekday"].forEach((selector) => $(selector).addEventListener("change", renderConditions));
  $("#vehicle-options").addEventListener("change", renderConditions);
  $("#region-options").addEventListener("change", (event) => switchRegion(event.target.value));
  $("#find-routes").addEventListener("click", calculateRoutes);
  $("#cancel-calc").addEventListener("click", cancelCalculation);
  $("#choose-route").addEventListener("click", showDone);
  $("#restart").addEventListener("click", () => {
    clearPoint("start");
    clearPoint("destination");
    state.result = null;
    renderStops();
    setStep("pick");
    setPickMode("start");
    if (state.config) fitRegion();
  });
  $$("[data-to-step]").forEach((button) => button.addEventListener("click", () => {
    const step = button.dataset.toStep;
    if (step === "compare") showCompare({ returning: true });
    else setStep(step);
  }));
  $("#sheet-handle").addEventListener("click", () => {
    const collapsed = $("#panel").classList.toggle("collapsed");
    $("#sheet-handle").setAttribute("aria-expanded", String(!collapsed));
  });

  $("#account-button").addEventListener("click", () => (state.user ? openAccount() : openAuth()));
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-login]");
    if (trigger) openAuth(trigger.dataset.login);
  });
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#auth-form").addEventListener("change", (event) => {
    if (event.target.name === "mode") setAuthMode(event.target.value);
  });
  $("#migrate-confirm").addEventListener("click", migrateGuest);
  $("#logout").addEventListener("click", logout);
  bindAccountForms();

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
    });
  });
  $("#auth-dialog").addEventListener("close", () => {
    if (!$("#migrate").hidden) refreshAfterAuth();
  });

  $("#trips-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    loadTrips(1);
  });
  $("#trips-filter").elements.sort.addEventListener("change", () => loadTrips(1));
  $("#trips-prev").addEventListener("click", () => loadTrips(state.tripsPage - 1));
  $("#trips-next").addEventListener("click", () => loadTrips(state.tripsPage + 1));
  $("#trip-edit-form").addEventListener("submit", saveTripEdit);
  $("#trip-delete").addEventListener("click", requestDelete);
}

async function initialize() {
  playIntro();
  bindEvents();
  fillConditions();
  renderConditions();
  renderStops();
  renderGuide();
  initMap();
  await loadUser();
  state.weekly = state.user ? await loadServerWeekly().catch(() => []) : loadGuest();
  renderView();
  try {
    const { items } = await api("/api/regions");
    const region = items.find((item) => item.is_default) || items[0];
    loadRegion(await api(`/api/regions/${encodeURIComponent(region.key)}`));
    renderRegionOptions();
    renderSuggestions();
    renderConditions();
    setStep("pick", { animate: false });
  } catch (error) {
    $("#pick-error").textContent = `지도를 불러오지 못했어요. ${error.message}`;
  }
}

initialize();
