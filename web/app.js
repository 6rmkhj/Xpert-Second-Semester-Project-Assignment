const state = {
  config: null,
  setupMap: null,
  routesMap: null,
  nodesLayer: null,
  markers: { start: null, destination: null },
  points: { start: null, destination: null },
  pickMode: "start",
  result: null,
  routeLayers: new Map(),
  selectedRouteId: null,
  armedRouteId: null,
  loadingTimer: null,
  weeklyRecords: [],
  resultRecorded: false,
  user: null,
  authMode: "login",
  tripsPage: 1,
  editingTripId: null,
};

const routeColors = ["#356feb", "#ff7a1a", "#19a956", "#a458ec"];
const WEEKLY_STORAGE_KEY = "ecoroute-weekly-records-v2";
const DIESEL_KWH_PER_LITER = 9.8;
const DIESEL_PRICE_KRW_PER_LITER = 1774;
const CO2_KG_PER_KWH = 8.887 / 33.7;
const weekDays = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];
const screens = [...document.querySelectorAll(".screen")];
const RIGHT_CHEVRON = `
  <span class="button-arrow" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"></path></svg>
  </span>`;

function renderIntroStrokeText(target, options) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svgNode = (name, attributes = {}) => {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const addCharacters = (textNode, kind) => {
    Array.from(options.text).forEach((character) => {
      const span = svgNode("tspan");
      span.dataset[kind] = "";
      span.textContent = character;
      textNode.appendChild(span);
    });
  };

  target.replaceChildren();
  target.className = "stroke-text";
  target.setAttribute("role", "img");
  target.setAttribute("aria-label", options.text);
  target.style.setProperty("--stroke-text-height", `${Math.round(options.fontSize * 1.3)}px`);

  const svg = svgNode("svg", {
    class: "stroke-text__svg",
    viewBox: `0 ${-options.fontSize} 600 ${options.fontSize * 1.3}`,
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
  });
  const clipId = `intro-text-wipe-${Math.random().toString(36).slice(2, 9)}`;
  const defs = svgNode("defs");
  const clipPath = svgNode("clipPath", { id: clipId, clipPathUnits: "userSpaceOnUse" });
  const wipeRect = svgNode("rect", { x: 0, y: 0, width: 0, height: 0 });
  clipPath.appendChild(wipeRect);
  defs.appendChild(clipPath);
  svg.appendChild(defs);

  const commonTextStyle = (node) => {
    node.style.fontSize = `${options.fontSize}px`;
    node.style.fontWeight = String(options.fontWeight);
    node.style.letterSpacing = `${options.letterSpacing}px`;
  };
  const strokeText = svgNode("text", {
    class: "stroke-text__stroke",
    x: 0,
    y: 0,
    fill: "none",
    stroke: options.strokeColor,
    "stroke-width": options.strokeWidth,
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
  commonTextStyle(strokeText);
  addCharacters(strokeText, "strokeChar");

  const fillText = svgNode("text", {
    class: "stroke-text__fill",
    x: 0,
    y: 0,
    fill: options.fillColor,
    "clip-path": `url(#${clipId})`,
  });
  commonTextStyle(fillText);
  addCharacters(fillText, "fillChar");
  svg.append(strokeText, fillText);
  target.appendChild(svg);

  const startAnimation = async () => {
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch {}
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const bounds = strokeText.getBBox();
    if (!bounds?.width) return;
    const padding = Math.max(options.strokeWidth, options.fontSize * .1);
    const box = {
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    };
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    wipeRect.setAttribute("x", box.x);
    wipeRect.setAttribute("y", box.y);
    wipeRect.setAttribute("width", box.width);
    wipeRect.setAttribute("height", box.height);

    const strokes = [...target.querySelectorAll("[data-stroke-char]")];
    const dash = Math.max(options.fontSize * 7, 200);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      strokes.forEach((stroke) => {
        stroke.style.strokeDasharray = String(dash);
        stroke.style.strokeDashoffset = "0";
      });
      return;
    }

    strokes.forEach((stroke, index) => {
      stroke.style.strokeDasharray = String(dash);
      stroke.style.strokeDashoffset = String(dash);
      stroke.animate(
        [{ strokeDashoffset: dash }, { strokeDashoffset: 0 }],
        {
          duration: options.drawDuration * 1000,
          delay: index * options.stagger * 1000,
          easing: "cubic-bezier(.25,.46,.45,.94)",
          fill: "forwards",
        },
      );
    });
    wipeRect.style.transformBox = "fill-box";
    wipeRect.style.transformOrigin = "left center";
    wipeRect.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      {
        duration: Math.max(400, options.drawDuration * 500),
        delay: (options.drawDuration + options.fillDelay) * 1000,
        easing: "cubic-bezier(.45,0,.55,1)",
        fill: "both",
      },
    );
  };
  startAnimation();
}

function initializeIntroHero() {
  const hero = document.querySelector("#intro-hero");
  const skipButton = document.querySelector("#skip-intro");
  if (!hero) return;
  document.body.classList.add("intro-active");

  let dismissed = false;
  let dismissTimer = null;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    window.clearTimeout(dismissTimer);
    document.body.classList.remove("intro-active");
    hero.classList.add("leaving");
    window.setTimeout(() => hero.remove(), 720);
  };

  const strokeTarget = document.querySelector("#intro-stroke-text");
  if (strokeTarget) {
    renderIntroStrokeText(strokeTarget, {
      text: "ECOROUTE",
      strokeColor: "#2f80ed",
      fillColor: "#f5fcff",
      strokeWidth: 1.6,
      drawDuration: 1.05,
      fillDelay: 0.12,
      stagger: 0.04,
      fontSize: 132,
      fontWeight: 850,
      letterSpacing: -5,
    });
  } else {
    hero.classList.add("intro-fallback");
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  dismissTimer = window.setTimeout(dismiss, reducedMotion ? 700 : 2350);
  skipButton?.addEventListener("click", dismiss, { once: true });
  hero.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") dismiss();
  });
}

function showScreen(id) {
  screens.forEach((screen) => screen.classList.toggle("active", screen.id === id));
  if (id === "setup-screen") setTimeout(() => state.setupMap?.invalidateSize(), 80);
  if (id === "routes-screen") setTimeout(() => state.routesMap?.invalidateSize(), 80);
}

function fillHours() {
  const select = document.querySelector("#departure-hour");
  const currentHour = new Date().getHours();
  for (let hour = 0; hour < 24; hour += 1) {
    const option = document.createElement("option");
    option.value = hour;
    option.textContent = `${String(hour).padStart(2, "0")}:00`;
    option.selected = hour === currentHour;
    select.append(option);
  }
}

function fillWeekdays() {
  const select = document.querySelector("#departure-weekday");
  weekDays.forEach((day, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = day;
    option.selected = index === 0;
    select.append(option);
  });
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `요청에 실패했습니다. (${response.status})`);
  return payload;
}

async function loadCurrentUser() {
  try {
    state.user = await api("/api/users/me");
  } catch {
    state.user = null;
  }
  renderAuthStatus();
}

function renderAuthStatus() {
  const userLabel = document.querySelector("#auth-user");
  userLabel.hidden = !state.user;
  userLabel.textContent = state.user ? `${state.user.nickname}님` : "";
  document.querySelector("#auth-button").textContent = state.user ? "로그아웃" : "로그인";
  document.querySelector("#trips-button").hidden = !state.user;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";
  const form = document.querySelector("#auth-form");
  form.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === mode);
    button.setAttribute("aria-pressed", String(button.dataset.authMode === mode));
  });
  form.querySelectorAll("[data-signup-only]").forEach((field) => {
    field.hidden = !signup;
    field.querySelector("input").required = signup;
  });
  form.elements.password.autocomplete = signup ? "new-password" : "current-password";
  document.querySelector("#auth-title").textContent = signup ? "회원가입" : "로그인";
  document.querySelector("#auth-submit").textContent = signup ? "가입하기" : "로그인";
  document.querySelector("#auth-error").textContent = "";
}

function bindAuthEvents() {
  const form = document.querySelector("#auth-form");
  document.querySelector("#auth-button").addEventListener("click", async () => {
    if (!state.user) {
      setAuthMode("login");
      showScreen("auth-screen");
      form.elements.username.focus();
      return;
    }
    try {
      await api("/api/sessions/current", { method: "DELETE" });
    } finally {
      state.user = null;
      state.weeklyRecords = loadWeeklyRecords();
      renderAuthStatus();
      if (document.querySelector("#trips-screen").classList.contains("active")) showScreen("setup-screen");
    }
  });
  form.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { username, password, nickname } = Object.fromEntries(new FormData(form));
    const submit = document.querySelector("#auth-submit");
    submit.disabled = true;
    try {
      state.user = state.authMode === "signup"
        ? await api("/api/users", { method: "POST", body: { username, password, nickname } })
        : (await api("/api/sessions", { method: "POST", body: { username, password } })).user;
      form.reset();
      renderAuthStatus();
      showScreen("setup-screen");
    } catch (error) {
      document.querySelector("#auth-error").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

function bindAccountEvents() {
  const dialog = document.querySelector("#account-dialog");
  const message = document.querySelector("#account-message");
  const nicknameForm = document.querySelector("#nickname-form");
  const passwordForm = document.querySelector("#password-form");
  const deleteForm = document.querySelector("#delete-account-form");
  const showMessage = (text, ok = false) => {
    message.textContent = text;
    message.classList.toggle("ok", ok);
  };

  document.querySelector("#auth-user").addEventListener("click", () => {
    document.querySelector("#account-username").textContent = `아이디: ${state.user.username}`;
    nicknameForm.elements.nickname.value = state.user.nickname;
    passwordForm.reset();
    deleteForm.reset();
    showMessage("");
    dialog.showModal();
  });
  document.querySelector("#account-close").addEventListener("click", () => dialog.close());

  nicknameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.user = await api("/api/users/me", {
        method: "PATCH",
        body: { nickname: nicknameForm.elements.nickname.value },
      });
      renderAuthStatus();
      showMessage("닉네임을 변경했어요.", true);
    } catch (error) {
      showMessage(error.message);
    }
  });

  passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/users/me", { method: "PATCH", body: Object.fromEntries(new FormData(passwordForm)) });
      passwordForm.reset();
      showMessage("비밀번호를 변경했어요. 다른 기기에서는 로그아웃됩니다.", true);
    } catch (error) {
      showMessage(error.message);
    }
  });

  deleteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!window.confirm("정말 탈퇴할까요? 모든 주행 기록이 삭제되며 되돌릴 수 없습니다.")) return;
    try {
      await api("/api/users/me", { method: "DELETE", body: Object.fromEntries(new FormData(deleteForm)) });
      dialog.close();
      state.user = null;
      state.weeklyRecords = loadWeeklyRecords();
      renderAuthStatus();
      resetDemo();
    } catch (error) {
      showMessage(error.message);
    }
  });
}

async function initialize() {
  bindAuthEvents();
  bindAccountEvents();
  bindTripEvents();
  loadCurrentUser();
  fillHours();
  fillWeekdays();
  state.weeklyRecords = loadWeeklyRecords();
  try {
    const { items } = await api("/api/regions");
    const defaultRegion = items.find((region) => region.is_default) || items[0];
    state.config = await api(`/api/regions/${encodeURIComponent(defaultRegion.key)}`);
    renderRegionSelector();
    initializeSetupMap();
    bindEvents();
  } catch (error) {
    document.querySelector("#setup-error").textContent = error.message;
  }
}

function renderRegionSelector() {
  const selector = document.querySelector("#region-selector");
  selector.innerHTML = state.config.regions.map((region) => `
    <button class="region-button${region.key === state.config.region ? " active" : ""}"
      type="button" data-region="${region.key}"
      aria-pressed="${region.key === state.config.region}">${region.short_label}</button>`).join("");
  selector.querySelectorAll(".region-button").forEach((button) => {
    button.addEventListener("click", () => selectRegion(button.dataset.region));
  });
}

async function selectRegion(regionKey) {
  if (regionKey === state.config.region) return;
  const selector = document.querySelector("#region-selector");
  selector.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  document.querySelector("#setup-error").textContent = "지도를 전환하고 있어요...";
  try {
    const payload = await api(`/api/regions/${encodeURIComponent(regionKey)}`);
    clearPoint("start");
    clearPoint("destination");
    if (state.setupMap) state.setupMap.remove();
    state.setupMap = null;
    state.nodesLayer = null;
    state.markers = { start: null, destination: null };
    state.config = payload;
    renderRegionSelector();
    initializeSetupMap();
    document.querySelector("#start-field strong").textContent = "지도에서 출발 노드를 선택하세요";
    document.querySelector("#destination-field strong").textContent = "지도에서 도착 노드를 선택하세요";
    setPickMode("start");
    updateSubmitState();
    document.querySelector("#setup-error").textContent = "";
  } catch (error) {
    document.querySelector("#setup-error").textContent = error.message;
    renderRegionSelector();
  }
}

function tileLayer() {
  return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  });
}

function initializeSetupMap() {
  const { nodes } = state.config;
  const selectionBounds = boundsFromConfig();
  state.setupMap = L.map("setup-map", {
    zoomControl: false,
    preferCanvas: true,
    maxBounds: selectionBounds.pad(.50),
    maxBoundsViscosity: 0.3,
    maxZoom: 17,
  });
  tileLayer().addTo(state.setupMap);
  addCoverageFrame(state.setupMap, selectionBounds);
  const sharedRenderer = L.canvas({ padding: .35 });
  state.nodesLayer = L.layerGroup();
  nodes.forEach((node) => {
    L.circleMarker([node.lat, node.lon], {
      renderer: sharedRenderer,
      radius: 4,
      weight: 1.5,
      color: "#ffffff",
      fillColor: "#269fde",
      fillOpacity: .78,
      interactive: false,
    }).addTo(state.nodesLayer);
  });
  state.nodesLayer.addTo(state.setupMap);
  state.setupMap.fitBounds(selectionBounds, { padding: [24, 24] });
  state.setupMap.setMinZoom(state.setupMap.getZoom());
  state.setupMap.on("click", ({ latlng }) => {
    if (selectionBounds.contains(latlng)) selectNearestNode(latlng);
    else showTemporaryMapHint("선택 가능한 사각형 안을 눌러 주세요");
  });
}

function boundsFromConfig() {
  const bounds = state.config.selectable_bounds;
  return L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
}

function addCoverageFrame(map, bounds) {
  const south = bounds.getSouth();
  const west = bounds.getWest();
  const north = bounds.getNorth();
  const east = bounds.getEast();
  const pad = 3;
  const maskStyle = {
    stroke: false,
    fillColor: "#dceef8",
    fillOpacity: .82,
    interactive: false,
  };
  [
    [[south - pad, west - pad], [south, east + pad]],
    [[north, west - pad], [north + pad, east + pad]],
    [[south, west - pad], [north, west]],
    [[south, east], [north, east + pad]],
  ].forEach((rectangle) => L.rectangle(rectangle, maskStyle).addTo(map));
  L.rectangle(bounds, {
    color: "#238bc5",
    weight: 2,
    opacity: .8,
    fill: false,
    interactive: false,
    dashArray: "7 6",
  }).addTo(map);
}

function showTemporaryMapHint(message) {
  document.querySelector("#setup-error").textContent = message;
  window.setTimeout(() => {
    if (document.querySelector("#setup-error").textContent === message) {
      document.querySelector("#setup-error").textContent = "";
    }
  }, 1500);
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

function selectNearestNode(latlng) {
  const node = nearestNode(latlng);
  if (!node) return;
  setPoint(state.pickMode, node);
  if (state.pickMode === "start" && !state.points.destination) setPickMode("destination");
}

function setPoint(kind, node) {
  state.points[kind] = {
    node_id: node.id,
    lat: node.lat,
    lon: node.lon,
    ...(node.place_label ? { place_label: node.place_label } : {}),
  };
  if (state.markers[kind]) state.setupMap.removeLayer(state.markers[kind]);
  const isStart = kind === "start";
  state.markers[kind] = L.circleMarker([node.lat, node.lon], {
    radius: 9, color: "#fff", weight: 3,
    fillColor: isStart ? "#22b6e8" : "#ff5961", fillOpacity: 1,
  }).addTo(state.setupMap).bindTooltip(isStart ? "출발" : "도착", {
    permanent: true, direction: "top", offset: [0, -8], className: "node-tooltip",
  });
  const field = document.querySelector(`#${kind === "start" ? "start" : "destination"}-field strong`);
  const coordinates = `Node ${node.id} · ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}`;
  const usePlaceLabel = state.config.region === "ann_arbor" && node.place_label;
  field.textContent = usePlaceLabel ? node.place_label : coordinates;
  field.title = usePlaceLabel ? coordinates : "";
  updateSubmitState();
}

function setPickMode(kind) {
  state.pickMode = kind;
  document.querySelectorAll(".location-field").forEach((field) => {
    field.classList.toggle("active", field.dataset.pick === kind);
  });
}

function updateSubmitState() {
  document.querySelector("#find-routes").disabled = !(state.points.start && state.points.destination);
}

function bindEvents() {
  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => setPickMode(button.dataset.pick));
  });
  document.querySelector("#swap-locations").addEventListener("click", swapLocations);
  document.querySelectorAll("input[name='vehicle']").forEach((input) => {
    input.addEventListener("change", () => {
      document.querySelectorAll(".vehicle-card").forEach((card) => card.classList.remove("selected"));
      input.closest(".vehicle-card").classList.add("selected");
    });
  });
  document.querySelector("#find-routes").addEventListener("click", calculateRoutes);
  document.querySelector("#view-weekly").addEventListener("click", showWeeklyReport);
  document.querySelector("#weekly-back").addEventListener("click", () => showScreen("impact-screen"));
  document.querySelectorAll("[data-go-home]").forEach((button) => button.addEventListener("click", resetDemo));
}

function swapLocations() {
  const start = state.points.start;
  const destination = state.points.destination;
  if (!start && !destination) return;
  if (start) setPoint("destination", start);
  else clearPoint("destination");
  if (destination) setPoint("start", destination);
  else clearPoint("start");
}

function clearPoint(kind) {
  state.points[kind] = null;
  if (state.markers[kind]) state.setupMap.removeLayer(state.markers[kind]);
  state.markers[kind] = null;
}

function startLoadingMessages() {
  const steps = [
    "24시간 교통 프로필을 불러오고 있어요",
    "다익스트라 기반 후보 경로를 비교하고 있어요",
    "도로를 250m 구간으로 나누고 있어요",
    "DNN이 에너지와 탄소 배출량을 추정하고 있어요",
  ];
  let index = 0;
  document.querySelector("#loading-step").textContent = steps[index];
  state.loadingTimer = setInterval(() => {
    index = (index + 1) % steps.length;
    document.querySelector("#loading-step").textContent = steps[index];
  }, 2100);
}

async function calculateRoutes() {
  document.querySelector("#setup-error").textContent = "";
  showScreen("loading-screen");
  startLoadingMessages();
  const vehicle = document.querySelector("input[name='vehicle']:checked").value;
  const hour = Number(document.querySelector("#departure-hour").value);
  const weekday = Number(document.querySelector("#departure-weekday").value);
  try {
    state.result = await api("/api/route-calculations", {
      method: "POST",
      body: {
        region: state.config.region,
        start: state.points.start,
        destination: state.points.destination,
        hour,
        weekday,
        vehicle,
      },
    });
    state.resultRecorded = false;
    showScreen("routes-screen");
    renderRouteResults();
  } catch (error) {
    document.querySelector("#setup-error").textContent = error.message;
    showScreen("setup-screen");
  } finally {
    clearInterval(state.loadingTimer);
  }
}

function orderedRoutes(routes) {
  const eco = routes.find((route) => route.is_greenest_route);
  const fastest = routes.find((route) => route.is_fastest_route && route.route_id !== eco?.route_id);
  const selected = [eco, fastest].filter(Boolean);
  const rest = routes
    .filter((route) => !selected.some((item) => item.route_id === route.route_id))
    .sort((a, b) => a.total_co2_kg - b.total_co2_kg);
  return [...selected, ...rest];
}

function renderRouteResults() {
  if (state.routesMap) state.routesMap.remove();
  const { center } = state.config;
  const selectionBounds = boundsFromConfig();
  state.routesMap = L.map("routes-map", {
    zoomControl: false,
    maxBounds: selectionBounds.pad(.08),
    maxBoundsViscosity: 1,
    maxZoom: 17,
  }).setView([center.lat, center.lon], 13);
  tileLayer().addTo(state.routesMap);
  state.routeLayers.clear();

  const summaryById = new Map(state.result.routes.map((route) => [route.route_id, route]));
  const bounds = [];
  state.result.geojson.features.forEach((feature, index) => {
    const route = summaryById.get(feature.properties.route_id);
    const layer = L.geoJSON(feature, {
      style: { color: routeColors[index], weight: 5, opacity: .75, lineCap: "round", lineJoin: "round" },
    }).addTo(state.routesMap);
    layer.on("click", () => selectRoute(route.route_id, false));
    state.routeLayers.set(route.route_id, layer);
    bounds.push(layer.getBounds());
  });
  if (bounds.length) {
    const merged = bounds.slice(1).reduce((result, bound) => result.extend(bound), bounds[0]);
    state.routesMap.fitBounds(merged, { padding: [35, 35] });
  }

  const routes = orderedRoutes(state.result.routes);
  document.querySelector("#trip-summary").innerHTML = `
    <strong>${state.result.vehicle.label}</strong><span class="dot">•</span>
    <span>${weekDays[state.result.weekday]} · ${String(state.result.hour).padStart(2, "0")}:00 출발</span><span class="dot">•</span>
    <span>경로 ${routes.length}개 분석 완료</span>`;
  document.querySelector("#route-list").innerHTML = routes.map(routeCardHtml).join("");
  document.querySelectorAll(".route-card").forEach((card) => {
    card.addEventListener("click", () => {
      const repeat = state.armedRouteId === card.dataset.routeId;
      if (repeat) showImpact(card.dataset.routeId);
      else {
        selectRoute(card.dataset.routeId, true);
        state.armedRouteId = card.dataset.routeId;
      }
    });
  });
  state.armedRouteId = null;
  selectRoute(routes[0].route_id, true);
}

function routeCardHtml(route) {
  const originalIndex = Number(route.route_id.split("_")[1]) - 1;
  const badges = [
    route.is_greenest_route ? '<span class="badge eco">ECO</span>' : "",
    route.is_fastest_route ? '<span class="badge fast">FASTEST</span>' : "",
  ].join("");
  return `<button class="route-card" type="button" data-route-id="${route.route_id}">
    <span class="route-stripe" style="background:${routeColors[originalIndex]}"></span>
    <span class="route-card-content">
      <span class="route-card-top">
        <span class="route-name">${routeLabel(route)}</span>
        <span class="badges">${badges}</span>
      </span>
      <span class="route-metrics">
        <span class="metric"><small>예상시간</small><strong>${route.traffic_travel_time_min.toFixed(1)}분</strong></span>
        <span class="metric"><small>총 거리</small><strong>${route.distance_km.toFixed(2)}km</strong></span>
        <span class="metric"><small>예상 탄소배출</small><strong>약 ${route.total_co2_kg.toFixed(3)}kg</strong></span>
      </span>
      <span class="route-confirm">한 번 더 누르면 이 경로로 안내를 시작합니다 <svg class="nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg></span>
    </span>
  </button>`;
}

function routeLabel(route) {
  if (route.is_greenest_route && route.is_fastest_route) return "예상 저탄소·최단시간 경로";
  if (route.is_greenest_route) return "예상 저탄소 경로";
  if (route.is_fastest_route) return "가장 빠른 경로";
  return `대안 경로 ${route.route_id.split("_")[1]}`;
}

function selectRoute(routeId, scrollCard) {
  state.selectedRouteId = routeId;
  state.routeLayers.forEach((layer, id) => {
    const selected = id === routeId;
    layer.setStyle({ weight: selected ? 10 : 5, opacity: selected ? 1 : .62 });
    if (selected) layer.bringToFront();
  });
  document.querySelectorAll(".route-card").forEach((card) => {
    const selected = card.dataset.routeId === routeId;
    card.classList.toggle("selected", selected);
    if (selected && scrollCard) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function showImpact(routeId) {
  const chosen = state.result.routes.find((route) => route.route_id === routeId);
  const fastest = state.result.routes.find((route) => route.is_fastest_route);
  if (!chosen || !fastest) return;
  document.querySelector("#impact-title").textContent = chosen.is_fastest_route && chosen.is_greenest_route
    ? "가장 빠르면서 친환경적인 길을 선택했어요"
    : chosen.is_fastest_route
      ? "가장 빠른 길을 선택했어요"
      : "대안 경로를 선택했어요";
  const relativePercent = fastest.total_energy_kwh > 0
    ? chosen.total_energy_kwh / fastest.total_energy_kwh * 100
    : 100;
  const reductionPercent = 100 - relativePercent;
  const absoluteChangePercent = Math.abs(reductionPercent);
  const tolerancePercent = .05;
  const isReduction = reductionPercent > tolerancePercent;
  const isIncrease = reductionPercent < -tolerancePercent;
  document.querySelector("#impact-comparison").textContent =
    `${absoluteChangePercent.toFixed(1)}%`;
  document.querySelector("#impact-comparison-label").textContent = isReduction
    ? "CO₂ 배출 절감"
    : isIncrease
      ? "CO₂ 배출 증가"
      : "CO₂ 배출 차이";
  document.querySelector("#comparison-chip").textContent = isReduction
    ? `가장 빠른 길 대비 ${absoluteChangePercent.toFixed(1)}% 낮음`
    : isIncrease
      ? `가장 빠른 길 대비 ${absoluteChangePercent.toFixed(1)}% 높음`
      : "가장 빠른 길과 동일";
  document.querySelector("#fast-carbon").textContent = "기준 100%";
  document.querySelector("#chosen-carbon").textContent = `${relativePercent.toFixed(1)}%`;
  const comparisonScale = Math.max(100, relativePercent, .001);
  document.querySelector("#fast-bar").style.width = `${100 / comparisonScale * 100}%`;
  document.querySelector("#chosen-bar").style.width = `${relativePercent / comparisonScale * 100}%`;
  document.querySelector("#impact-message").textContent = isReduction
    ? `가장 빠른 길보다 CO₂ 배출을 ${absoluteChangePercent.toFixed(1)}% 줄이는 경로를 선택했습니다.`
    : isIncrease
      ? `선택한 경로의 CO₂ 배출은 가장 빠른 길보다 ${absoluteChangePercent.toFixed(1)}% 높습니다.`
      : "선택한 경로와 가장 빠른 길의 CO₂ 배출은 동일합니다.";
  document.querySelector("#impact-route-meta").innerHTML = `
    <span>선택 경로 <strong>${routeLabel(chosen)}</strong></span>
    <span>요일 <strong>${weekDays[state.result.weekday]}</strong></span>
    <span>거리 <strong>${chosen.distance_km.toFixed(2)}km</strong></span>
    <span>예상시간 <strong>${chosen.traffic_travel_time_min.toFixed(1)}분</strong></span>`;
  if (!state.resultRecorded) {
    state.resultRecorded = true;
    if (state.user) {
      saveTrip(chosen, fastest);
    } else {
      recordWeeklyResult(chosen, fastest, reductionPercent);
      document.querySelector("#trip-save-status").textContent = "로그인하면 주행 기록이 계정에 저장돼요.";
    }
  }
  renderWeeklyButton();
  showScreen("impact-screen");
}

function renderWeeklyButton() {
  document.querySelector("#view-weekly").innerHTML =
    `주간 기록 보기 (${state.weeklyRecords.length}/7) ${RIGHT_CHEVRON}`;
}

function localDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateOfWeekday(weekday) {
  const date = new Date();
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + weekday);
  return localDate(date);
}

function weekdayOfDate(isoDate) {
  return (new Date(`${isoDate}T00:00:00`).getDay() + 6) % 7;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML.replaceAll('"', "&quot;");
}

async function saveTrip(chosen, fastest) {
  const status = document.querySelector("#trip-save-status");
  const weekday = Number(state.result.weekday);
  const pointPayload = (kind) => ({
    lat: state.result[kind].lat,
    lon: state.result[kind].lon,
    label: state.points[kind]?.place_label || "",
  });
  status.textContent = "주행 기록 저장 중…";
  try {
    await api("/api/trips", {
      method: "POST",
      body: {
        name: `${weekDays[weekday]} ${routeLabel(chosen)}`,
        driven_on: dateOfWeekday(weekday),
        region: state.result.region,
        hour: Number(state.result.hour),
        weekday,
        vehicle: state.result.vehicle.key,
        start: pointPayload("start"),
        destination: pointPayload("destination"),
        route_label: routeLabel(chosen),
        distance_km: chosen.distance_km,
        baseline_energy_kwh: fastest.total_energy_kwh,
        chosen_energy_kwh: chosen.total_energy_kwh,
        baseline_co2_kg: fastest.total_co2_kg,
        chosen_co2_kg: chosen.total_co2_kg,
      },
    });
    state.weeklyRecords = await loadServerWeeklyRecords();
    renderWeeklyButton();
    status.textContent = "내 주행 기록에 저장했어요.";
  } catch (error) {
    state.resultRecorded = false;
    status.textContent = `주행 기록을 저장하지 못했어요: ${error.message}`;
  }
}

async function loadServerWeeklyRecords() {
  const params = new URLSearchParams({
    from: dateOfWeekday(0),
    to: dateOfWeekday(6),
    sort: "created_at",
    order: "desc",
    size: "50",
  });
  const { items } = await api(`/api/trips?${params}`);
  const latestByDay = new Map();
  items.forEach((trip) => {
    const dayIndex = weekdayOfDate(trip.driven_on);
    if (latestByDay.has(dayIndex)) return;
    latestByDay.set(dayIndex, {
      dayIndex,
      day: weekDays[dayIndex],
      reductionPercent: trip.reduction_percent,
      baselineEnergy: trip.baseline_energy_kwh,
      chosenEnergy: trip.chosen_energy_kwh,
      baselineCo2: trip.baseline_co2_kg,
      chosenCo2: trip.chosen_co2_kg,
      region: trip.region,
      regionLabel: state.config?.regions.find((region) => region.key === trip.region)?.label || trip.region,
      routeLabel: trip.route_label,
      distanceKm: trip.distance_km,
    });
  });
  return [...latestByDay.values()].sort((a, b) => a.dayIndex - b.dayIndex);
}

function loadWeeklyRecords() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(WEEKLY_STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    const latestByDay = new Map();
    stored
      .filter((record) => (
        Number.isInteger(Number(record?.dayIndex))
        && Number(record.dayIndex) >= 0
        && Number(record.dayIndex) < weekDays.length
        && Number.isFinite(record?.baselineEnergy)
        && Number.isFinite(record?.chosenEnergy)
        && Number.isFinite(record?.reductionPercent)
      ))
      .forEach((record) => {
        const dayIndex = Number(record.dayIndex);
        latestByDay.set(dayIndex, { ...record, dayIndex, day: weekDays[dayIndex] });
      });
    return [...latestByDay.values()].sort((a, b) => a.dayIndex - b.dayIndex);
  } catch {
    return [];
  }
}

function saveWeeklyRecords() {
  try {
    sessionStorage.setItem(WEEKLY_STORAGE_KEY, JSON.stringify(state.weeklyRecords));
  } catch {
  }
}

function recordWeeklyResult(chosen, fastest, reductionPercent) {
  const dayIndex = Number(state.result.weekday);
  const latestRecord = {
    dayIndex,
    day: weekDays[dayIndex],
    reductionPercent,
    baselineEnergy: fastest.total_energy_kwh,
    chosenEnergy: chosen.total_energy_kwh,
    baselineCo2: fastest.total_co2_kg,
    chosenCo2: chosen.total_co2_kg,
    region: state.result.region,
    regionLabel: state.result.region_label || state.result.region,
    routeLabel: routeLabel(chosen),
    distanceKm: chosen.distance_km,
  };
  state.weeklyRecords = loadWeeklyRecords()
    .filter((record) => Number(record.dayIndex) !== dayIndex);
  state.weeklyRecords.push(latestRecord);
  state.weeklyRecords.sort((a, b) => a.dayIndex - b.dayIndex);
  saveWeeklyRecords();
}

async function showWeeklyReport() {
  if (!state.user) {
    state.weeklyRecords = loadWeeklyRecords();
  } else {
    try {
      state.weeklyRecords = await loadServerWeeklyRecords();
    } catch {
    }
  }
  renderWeeklyReport();
  showScreen("weekly-screen");
}

function renderWeeklyReport() {
  const completed = state.weeklyRecords.length;
  const recordsByDay = new Map(
    state.weeklyRecords.map((record, index) => [record.dayIndex ?? index, record])
  );
  const maxMagnitude = Math.max(
    10,
    ...state.weeklyRecords.map((record) => Math.abs(record.reductionPercent))
  );
  document.querySelector("#weekly-chart").innerHTML = weekDays.map((day, index) => {
    const record = recordsByDay.get(index);
    if (!record) {
      return `<div class="weekly-day">
        <span class="weekly-day-value pending">대기</span>
        <div class="weekly-bar-track"><div class="weekly-day-bar pending"></div></div>
        <span class="weekly-day-label">${day.slice(0, 1)}<small>미기록</small></span>
      </div>`;
    }
    const value = Number(record.reductionPercent);
    const height = Math.max(4, Math.abs(value) / maxMagnitude * 100);
    const negativeClass = value < 0 ? " negative" : "";
    return `<div class="weekly-day" title="${escapeHtml(`${record.regionLabel} · ${record.routeLabel}`)}">
      <span class="weekly-day-value${negativeClass}">${value.toFixed(1)}%</span>
      <div class="weekly-bar-track"><div class="weekly-day-bar${negativeClass}" style="height:${height}%"></div></div>
      <span class="weekly-day-label">${day.slice(0, 1)}<small>완료</small></span>
    </div>`;
  }).join("");

  const baselineTotal = state.weeklyRecords.reduce(
    (total, record) => total + Number(record.baselineEnergy), 0
  );
  const chosenTotal = state.weeklyRecords.reduce(
    (total, record) => total + Number(record.chosenEnergy), 0
  );
  const weeklyReduction = baselineTotal > 0
    ? (1 - chosenTotal / baselineTotal) * 100
    : 0;
  const chosenCo2Total = state.weeklyRecords.reduce((total, record) => {
    const storedCo2 = Number(record.chosenCo2);
    return total + (Number.isFinite(storedCo2)
      ? storedCo2
      : Number(record.chosenEnergy) * CO2_KG_PER_KWH);
  }, 0);
  const baselineCo2Total = state.weeklyRecords.reduce((total, record) => {
    const storedCo2 = Number(record.baselineCo2);
    return total + (Number.isFinite(storedCo2)
      ? storedCo2
      : Number(record.baselineEnergy) * CO2_KG_PER_KWH);
  }, 0);
  const chosenFuelLiters = chosenTotal / DIESEL_KWH_PER_LITER;
  const baselineFuelLiters = baselineTotal / DIESEL_KWH_PER_LITER;
  const chosenFuelCost = chosenFuelLiters * DIESEL_PRICE_KRW_PER_LITER;
  const baselineFuelCost = baselineFuelLiters * DIESEL_PRICE_KRW_PER_LITER;
  const savedFuelCost = baselineFuelCost - chosenFuelCost;
  const decimal = (value, digits = 2) => Number(value).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const won = (value) => Math.round(Math.abs(value)).toLocaleString("ko-KR");
  const setMetric = (selector, value, unit, digits = 2) => {
    document.querySelector(selector).innerHTML = `${decimal(value, digits)} <small>${unit}</small>`;
  };

  document.querySelector("#weekly-progress").textContent = `${completed} / 7일`;
  setMetric("#weekly-co2-chosen", chosenCo2Total, "kgCO₂eq");
  setMetric("#weekly-co2-fastest", baselineCo2Total, "kgCO₂eq");
  setMetric("#weekly-fuel-chosen", chosenFuelLiters, "L");
  setMetric("#weekly-fuel-fastest", baselineFuelLiters, "L");
  setMetric("#weekly-energy-chosen", chosenTotal, "kWh");
  setMetric("#weekly-energy-fastest", baselineTotal, "kWh");
  document.querySelector("#weekly-cost-chosen").innerHTML = `${won(chosenFuelCost)}<small>원</small>`;
  document.querySelector("#weekly-cost-fastest").innerHTML = `${won(baselineFuelCost)}<small>원</small>`;
  const costSavingElement = document.querySelector("#weekly-cost-saving");
  costSavingElement.textContent = Math.abs(savedFuelCost) < .5
    ? `경유 ${DIESEL_PRICE_KRW_PER_LITER.toLocaleString("ko-KR")}원/L · 차이 없음`
    : savedFuelCost > 0
      ? `약 ${won(savedFuelCost)}원 절약`
      : `약 ${won(savedFuelCost)}원 증가`;
  costSavingElement.classList.toggle("increase", savedFuelCost < -.5);
  document.querySelector("#weekly-chart").dataset.weeklyReduction = weeklyReduction.toFixed(1);
  document.querySelector("#weekly-next-route").innerHTML = completed >= 7
    ? '요일별 기록 수정하기 <span>↻</span>'
    : `다른 요일 경로 찾기 ${RIGHT_CHEVRON}`;
}

function bindTripEvents() {
  document.querySelector("#trips-button").addEventListener("click", () => {
    showScreen("trips-screen");
    loadTrips(1);
  });
  document.querySelector("#trips-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    loadTrips(1);
  });
  document.querySelector("#trips-filter").elements.sort.addEventListener("change", () => loadTrips(1));
  document.querySelector("#trips-prev").addEventListener("click", () => loadTrips(state.tripsPage - 1));
  document.querySelector("#trips-next").addEventListener("click", () => loadTrips(state.tripsPage + 1));

  const dialog = document.querySelector("#trip-dialog");
  const form = document.querySelector("#trip-edit-form");
  document.querySelector("#trip-edit-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { name, driven_on: drivenOn, memo } = Object.fromEntries(new FormData(form));
    try {
      await api(`/api/trips/${state.editingTripId}`, {
        method: "PATCH",
        body: { name, driven_on: drivenOn, memo },
      });
      dialog.close();
      loadTrips(state.tripsPage);
    } catch (error) {
      document.querySelector("#trip-edit-error").textContent = error.message;
    }
  });
}

async function loadTrips(page) {
  const filter = document.querySelector("#trips-filter");
  const [sort, order] = filter.elements.sort.value.split(":");
  const params = new URLSearchParams({ q: filter.elements.q.value.trim(), sort, order, page, size: 10 });
  const error = document.querySelector("#trips-error");
  error.textContent = "";
  try {
    const result = await api(`/api/trips?${params}`);
    if (result.page > 1 && result.page > result.total_pages) return loadTrips(Math.max(1, result.total_pages));
    state.tripsPage = result.page;
    renderTrips(result);
  } catch (loadError) {
    error.textContent = loadError.message;
  }
}

function renderTrips({ items, page, total, total_pages: totalPages }) {
  const template = document.querySelector("#trip-row-template");
  document.querySelector("#trip-list").replaceChildren(...items.map((trip) => {
    const row = template.content.firstElementChild.cloneNode(true);
    row.querySelector(".trip-name").textContent = trip.name;
    row.querySelector(".trip-meta").textContent =
      `${trip.driven_on} (${weekDays[weekdayOfDate(trip.driven_on)].slice(0, 1)}) · `
      + `${String(trip.hour).padStart(2, "0")}:00 · ${trip.route_label} · ${trip.distance_km.toFixed(2)}km`;
    const memo = row.querySelector(".trip-memo");
    memo.textContent = trip.memo;
    memo.hidden = !trip.memo;
    const reduction = row.querySelector(".trip-reduction");
    const value = trip.reduction_percent;
    reduction.textContent = value > 0
      ? `${value.toFixed(1)}% 절감`
      : value < 0 ? `${Math.abs(value).toFixed(1)}% 증가` : "차이 없음";
    reduction.classList.toggle("negative", value < 0);
    row.querySelector('[data-action="edit"]').addEventListener("click", () => openTripDialog(trip));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTrip(trip));
    return row;
  }));
  const searching = document.querySelector("#trips-filter").elements.q.value.trim() !== "";
  const empty = document.querySelector("#trips-empty");
  empty.hidden = total > 0;
  empty.textContent = searching
    ? "검색 결과가 없습니다."
    : "아직 저장된 주행 기록이 없습니다. 경로를 찾아 확정하면 여기에 쌓여요.";
  document.querySelector("#trips-total").textContent = `${total}건`;
  document.querySelector("#trips-page").textContent = totalPages ? `${page} / ${totalPages}` : "";
  document.querySelector("#trips-prev").disabled = page <= 1;
  document.querySelector("#trips-next").disabled = page >= totalPages;
}

function openTripDialog(trip) {
  const form = document.querySelector("#trip-edit-form");
  state.editingTripId = trip.id;
  form.elements.name.value = trip.name;
  form.elements.driven_on.value = trip.driven_on;
  form.elements.memo.value = trip.memo;
  document.querySelector("#trip-edit-error").textContent = "";
  document.querySelector("#trip-dialog").showModal();
}

async function deleteTrip(trip) {
  if (!window.confirm(`'${trip.name}' 기록을 삭제할까요?`)) return;
  try {
    await api(`/api/trips/${trip.id}`, { method: "DELETE" });
    loadTrips(state.tripsPage);
  } catch (error) {
    document.querySelector("#trips-error").textContent = error.message;
  }
}

function resetDemo() {
  state.result = null;
  state.resultRecorded = false;
  state.selectedRouteId = null;
  state.armedRouteId = null;
  clearPoint("start");
  clearPoint("destination");
  document.querySelector("#start-field strong").textContent = "지도에서 출발 노드를 선택하세요";
  document.querySelector("#destination-field strong").textContent = "지도에서 도착 노드를 선택하세요";
  setPickMode("start");
  updateSubmitState();
  showScreen("setup-screen");
}

initializeIntroHero();
initialize();
