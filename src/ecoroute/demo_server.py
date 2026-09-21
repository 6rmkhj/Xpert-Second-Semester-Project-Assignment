from __future__ import annotations

import argparse
import json
import math
import os
import re
import threading
import time
import webbrowser
from collections import OrderedDict
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import networkx as nx
import osmnx as ox

from .database import SESSION_LIFETIME, ApiError, Database, unauthorized, validation_error
from .route_energy import load_hour_profiles, predict_route_energy


VEHICLES = {
    "compact": {
        "label": "소형차",
        "weight_kg": 1250.0,
        "engine_l": 1.6,
        "description": "가볍고 효율적인 도심형 차량",
    },
    "midsize": {
        "label": "중형차",
        "weight_kg": 1587.573295,
        "engine_l": 2.5,
        "description": "EcoRoute 기본 비교 차량",
    },
    "truck": {
        "label": "트럭",
        "weight_kg": 2267.96185,
        "engine_l": 4.8,
        "description": "중량과 배기량이 큰 화물 차량",
    },
}

SELECTABLE_NODE_SPACING_M = 400.0
DEMO_CONFIG_PATH = Path("config") / "demo_runtime.json"
DEFAULT_DB_PATH = Path("data") / "ecoroute.db"
TRIP_ID_PATTERN = re.compile(r"/api/trips/(\d+)")
REGION_KEY_PATTERN = re.compile(r"/api/regions/([a-z0-9_]+)")
API_ROUTES = {
    "/api/regions": {"GET"},
    "/api/regions/{key}": {"GET"},
    "/api/route-calculations": {"POST"},
    "/api/users": {"POST"},
    "/api/users/me": {"GET", "PATCH", "DELETE"},
    "/api/sessions": {"POST"},
    "/api/sessions/current": {"DELETE"},
    "/api/trips": {"GET", "POST"},
    "/api/trips/{id}": {"GET", "PATCH", "DELETE"},
}
PUBLIC_ROUTES = {
    ("GET", "/api/regions"),
    ("GET", "/api/regions/{key}"),
    ("POST", "/api/route-calculations"),
    ("POST", "/api/users"),
    ("POST", "/api/sessions"),
}
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 600
SECURITY_HEADERS = {
    "Content-Security-Policy": "; ".join([
        "default-src 'self'",
        "script-src 'self' https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
        "font-src 'self' https://cdn.jsdelivr.net",
        "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}
SECURE_COOKIE = os.environ.get("ECOROUTE_SECURE_COOKIE") == "1"


class DemoApplication:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.web_root = root / "web"
        config_path = root / DEMO_CONFIG_PATH
        if not config_path.exists():
            raise FileNotFoundError(config_path)
        settings = json.loads(config_path.read_text(encoding="utf-8"))
        self.default_region_key = str(settings["default_region"])
        self.route_candidate_count = int(settings.get("route_candidate_count", 6))
        self.penalty_candidate_count = int(settings.get("penalty_candidate_count", 8))
        self.profile_cache_size = int(settings.get("profile_cache_size", 4))
        checkpoint_path = root / str(settings["model_checkpoint_path"])
        if not checkpoint_path.exists():
            raise FileNotFoundError(checkpoint_path)

        self.regions: dict[str, dict] = {}
        for region_key, region_settings in settings["regions"].items():
            graph_path = root / str(region_settings["graph_path"])
            traffic_path = root / str(region_settings["traffic_profile_path"])
            place_labels_setting = region_settings.get("place_labels_path")
            place_labels_path = (
                root / str(place_labels_setting) if place_labels_setting else None
            )
            required_paths = [graph_path, traffic_path]
            if place_labels_path is not None:
                required_paths.append(place_labels_path)
            for required_path in required_paths:
                if not required_path.exists():
                    raise FileNotFoundError(required_path)
            graph = ox.io.load_graphml(graph_path)
            selectable_bounds = {
                key: float(region_settings["selectable_bounds"][key])
                for key in ("south", "west", "north", "east")
            }
            selectable_node_spacing_m = float(
                region_settings.get(
                    "selectable_node_spacing_m", SELECTABLE_NODE_SPACING_M
                )
            )
            nodes = select_spaced_nodes(
                graph,
                selectable_bounds,
                minimum_spacing_m=selectable_node_spacing_m,
            )
            if place_labels_path is not None:
                place_labels = load_node_place_labels(place_labels_path)
                nodes = attach_node_place_labels(nodes, place_labels)
            self.regions[str(region_key)] = {
                "key": str(region_key),
                "label": str(region_settings.get("label", region_key)),
                "short_label": str(
                    region_settings.get(
                        "short_label", region_settings.get("label", region_key)
                    )
                ),
                "graph": graph,
                "traffic_path": traffic_path,
                "route_candidate_count": int(
                    region_settings.get(
                        "route_candidate_count", self.route_candidate_count
                    )
                ),
                "penalty_candidate_count": int(
                    region_settings.get(
                        "penalty_candidate_count", self.penalty_candidate_count
                    )
                ),
                "selectable_bounds": selectable_bounds,
                "selectable_node_spacing_m": selectable_node_spacing_m,
                "nodes": nodes,
                "profile_cache": OrderedDict(),
            }
        if self.default_region_key not in self.regions:
            raise ValueError(f"Unknown default region: {self.default_region_key}")
        self.route_lock = threading.Lock()
        self.database = Database(
            Path(os.environ.get("ECOROUTE_DB_PATH", root / DEFAULT_DB_PATH)),
            region_bounds={key: region["selectable_bounds"] for key, region in self.regions.items()},
            vehicles=set(VEHICLES),
        )

    def _region(self, region_key: str | None) -> dict:
        selected_key = region_key or self.default_region_key
        if selected_key not in self.regions:
            raise ValueError("지원하지 않는 지도 지역입니다.")
        return self.regions[selected_key]

    def _profiles_for(self, region: dict, hour: int) -> object:
        cache: OrderedDict = region["profile_cache"]
        if hour in cache:
            profiles = cache.pop(hour)
            cache[hour] = profiles
            return profiles
        profiles = load_hour_profiles(region["traffic_path"], hour)
        cache[hour] = profiles
        while len(cache) > self.profile_cache_size:
            cache.popitem(last=False)
        return profiles

    def regions_payload(self) -> dict:
        return {
            "items": [
                {
                    "key": item["key"],
                    "label": item["label"],
                    "short_label": item["short_label"],
                    "is_default": item["key"] == self.default_region_key,
                }
                for item in self.regions.values()
            ],
        }

    def config_payload(self, region_key: str | None = None) -> dict:
        region = self._region(region_key)
        selectable_bounds = region["selectable_bounds"]
        return {
            "region": region["key"],
            "region_label": region["label"],
            "regions": [
                {
                    "key": item["key"],
                    "label": item["label"],
                    "short_label": item["short_label"],
                }
                for item in self.regions.values()
            ],
            "center": {
                "lat": (selectable_bounds["south"] + selectable_bounds["north"]) / 2,
                "lon": (selectable_bounds["west"] + selectable_bounds["east"]) / 2,
            },
            "selectable_bounds": selectable_bounds,
            "selectable_node_spacing_m": region["selectable_node_spacing_m"],
            "original_graph_node_count": len(region["graph"]),
            "selectable_node_count": len(region["nodes"]),
            "nodes": region["nodes"],
            "vehicles": VEHICLES,
        }

    def calculate_routes(self, payload: dict) -> dict:
        region = self._region(str(payload.get("region", self.default_region_key)))
        start = self._coordinate(region, payload, "start")
        destination = self._coordinate(region, payload, "destination")
        if payload.get("start", {}).get("node_id") == payload.get("destination", {}).get("node_id"):
            raise ValueError("출발지와 목적지는 서로 다른 노드를 선택해 주세요.")
        hour = int(payload.get("hour", 8))
        if not 0 <= hour <= 23:
            raise ValueError("출발시간은 0시부터 23시 사이여야 합니다.")
        weekday = int(payload.get("weekday", 0))
        if not 0 <= weekday <= 6:
            raise ValueError("요일은 월요일부터 일요일 사이여야 합니다.")
        vehicle_key = str(payload.get("vehicle", "midsize"))
        if vehicle_key not in VEHICLES:
            raise ValueError("지원하지 않는 차종입니다.")
        vehicle = VEHICLES[vehicle_key]

        with self.route_lock:
            started = time.perf_counter()
            profiles = self._profiles_for(region, hour)
            summary = predict_route_energy(
                root=self.root,
                region_key=region["key"],
                hour=hour,
                weekday=weekday,
                start=start,
                destination=destination,
                vehicle_weight_kg=float(vehicle["weight_kg"]),
                engine_displacement_l=float(vehicle["engine_l"]),
                route_count=4,
                candidate_count=region["route_candidate_count"],
                penalty_candidate_count=region["penalty_candidate_count"],
                requested_device="auto",
                prepared_graph=region["graph"],
                prepared_profiles=profiles,
                save_diagnostics=False,
            )
            result_dir = self.root / "results" / "route_energy" / region["key"]
            geojson = json.loads((result_dir / "routes.geojson").read_text(encoding="utf-8"))
            metadata = json.loads((result_dir / "metadata.json").read_text(encoding="utf-8"))
            elapsed_seconds = time.perf_counter() - started
            print(
                f"Demo routes ready for {region['key']} in {elapsed_seconds:.2f}s",
                flush=True,
            )

        routes = json.loads(summary.to_json(orient="records"))
        return {
            "region": region["key"],
            "region_label": region["label"],
            "hour": hour,
            "weekday": weekday,
            "vehicle": {"key": vehicle_key, **vehicle},
            "start": {"lat": start[0], "lon": start[1]},
            "destination": {"lat": destination[0], "lon": destination[1]},
            "routes": routes,
            "geojson": geojson,
            "carbon_scope": metadata["carbon_scope"],
        }

    def _coordinate(self, region: dict, payload: dict, name: str) -> tuple[float, float]:
        value = payload.get(name)
        if not isinstance(value, dict):
            raise ValueError(f"{name} 노드를 지도에서 선택해 주세요.")
        try:
            latitude = float(value["lat"])
            longitude = float(value["lon"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{name} 좌표가 올바르지 않습니다.") from error
        bounds = region["selectable_bounds"]
        if not (
            bounds["south"] <= latitude <= bounds["north"]
            and bounds["west"] <= longitude <= bounds["east"]
        ):
            raise ValueError(f"{region['label']} 지도 범위 안의 도로 노드를 선택해 주세요.")
        return latitude, longitude


def select_spaced_nodes(
    graph: object,
    bounds: dict[str, float],
    minimum_spacing_m: float,
) -> list[dict[str, float | str]]:
    strongly_connected = max(nx.strongly_connected_components(graph), key=len)
    center_latitude_rad = math.radians((bounds["south"] + bounds["north"]) / 2)
    longitude_scale = math.cos(center_latitude_rad)
    candidates = []
    for node_id, data in graph.nodes(data=True):
        latitude = float(data["y"])
        longitude = float(data["x"])
        if node_id not in strongly_connected:
            continue
        if not (
            bounds["south"] <= latitude <= bounds["north"]
            and bounds["west"] <= longitude <= bounds["east"]
        ):
            continue
        degree = int(graph.in_degree(node_id) + graph.out_degree(node_id))
        candidates.append((-degree, str(node_id), node_id, latitude, longitude))
    candidates.sort()

    selected = []
    spatial_cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for _, _, node_id, latitude, longitude in candidates:
        x_m = (longitude - bounds["west"]) * 111_320 * longitude_scale
        y_m = (latitude - bounds["south"]) * 111_320
        cell_x = math.floor(x_m / minimum_spacing_m)
        cell_y = math.floor(y_m / minimum_spacing_m)
        far_enough = True
        for nearby_x in range(cell_x - 1, cell_x + 2):
            for nearby_y in range(cell_y - 1, cell_y + 2):
                for selected_x, selected_y in spatial_cells.get((nearby_x, nearby_y), []):
                    if math.hypot(x_m - selected_x, y_m - selected_y) < minimum_spacing_m:
                        far_enough = False
                        break
                if not far_enough:
                    break
            if not far_enough:
                break
        if not far_enough:
            continue
        selected.append({"id": str(node_id), "lat": latitude, "lon": longitude})
        spatial_cells.setdefault((cell_x, cell_y), []).append((x_m, y_m))
    return selected


def load_node_place_labels(path: Path) -> dict[str, dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_labels = payload.get("nodes", {})
    if not isinstance(raw_labels, dict):
        raise ValueError(f"Invalid node place label file: {path}")
    return {
        str(node_id): label
        for node_id, label in raw_labels.items()
        if isinstance(label, dict)
    }


def attach_node_place_labels(
    nodes: list[dict[str, float | str]],
    labels: dict[str, dict[str, object]],
) -> list[dict[str, float | str]]:
    enriched_nodes = []
    for node in nodes:
        enriched = dict(node)
        label = labels.get(str(node["id"]), {})
        place_label = str(label.get("label", "")).strip()
        if place_label:
            enriched["place_label"] = place_label
            enriched["place_kind"] = str(label.get("kind", "place"))
            try:
                enriched["place_distance_m"] = float(label.get("distance_m", 0.0))
            except (TypeError, ValueError):
                enriched["place_distance_m"] = 0.0
        enriched_nodes.append(enriched)
    return enriched_nodes


def route_template(path: str) -> tuple[str, str | None]:
    if match := TRIP_ID_PATTERN.fullmatch(path):
        return "/api/trips/{id}", match[1]
    if match := REGION_KEY_PATTERN.fullmatch(path):
        return "/api/regions/{key}", match[1]
    return path, None


class LoginThrottle:

    def __init__(self) -> None:
        self.failures: dict[tuple[str, str], list[float]] = {}
        self.lock = threading.Lock()

    def _recent(self, key: tuple[str, str]) -> list[float]:
        now = time.monotonic()
        recent = [t for t in self.failures.pop(key, []) if now - t < LOGIN_WINDOW_SECONDS]
        if recent:
            self.failures[key] = recent
        return recent

    def check(self, key: tuple[str, str]) -> None:
        with self.lock:
            blocked = len(self._recent(key)) >= LOGIN_MAX_FAILURES
        if blocked:
            raise ApiError(
                HTTPStatus.TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                f"로그인 시도가 너무 많습니다. {LOGIN_WINDOW_SECONDS // 60}분 후 다시 시도해 주세요.",
            )

    def record_failure(self, key: tuple[str, str]) -> None:
        with self.lock:
            self.failures[key] = [*self._recent(key), time.monotonic()]

    def clear(self, key: tuple[str, str]) -> None:
        with self.lock:
            self.failures.pop(key, None)


def make_handler(application: DemoApplication) -> type[BaseHTTPRequestHandler]:
    login_throttle = LoginThrottle()
    static_files = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/logo.png": ("logo.png", "image/png"),
    }

    class DemoHandler(BaseHTTPRequestHandler):
        server_version = "EcoRouteDemo/1.0"

        def do_GET(self) -> None:
            if self._dispatch_api("GET"):
                return
            entry = static_files.get(urlparse(self.path).path)
            file_path = application.web_root / entry[0] if entry else None
            if file_path is None or not file_path.exists():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = file_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", entry[1])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            if not self._dispatch_api("POST"):
                self.send_error(HTTPStatus.NOT_FOUND)

        def do_PATCH(self) -> None:
            if not self._dispatch_api("PATCH"):
                self.send_error(HTTPStatus.NOT_FOUND)

        def do_DELETE(self) -> None:
            if not self._dispatch_api("DELETE"):
                self.send_error(HTTPStatus.NOT_FOUND)

        def do_PUT(self) -> None:
            if not self._dispatch_api("PUT"):
                self.send_error(HTTPStatus.NOT_FOUND)

        def end_headers(self) -> None:
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            super().end_headers()

        def _dispatch_api(self, method: str) -> bool:
            parsed = urlparse(self.path)
            if not parsed.path.startswith("/api/"):
                return False
            try:
                template, param = route_template(parsed.path)
                if template not in API_ROUTES:
                    raise ApiError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "존재하지 않는 API입니다.")
                if method not in API_ROUTES[template]:
                    raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "지원하지 않는 메서드입니다.")
                if method != "GET":
                    self._check_origin()
                token = user_id = None
                if (method, template) not in PUBLIC_ROUTES:
                    token = self._session_token()
                    user_id = application.database.user_id_for_session(token) if token else None
                    if user_id is None:
                        raise unauthorized()
                self._route_api(method, template, param, parsed.query, user_id, token)
            except ApiError as error:
                self._send_json(error.payload(), status=error.status)
            except Exception as error:
                print(f"API request failed: {error!r}", flush=True)
                self._send_json(
                    {"error": {"code": "INTERNAL_ERROR", "message": "서버 오류가 발생했습니다."}},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return True

        def _route_api(
            self,
            method: str,
            template: str,
            param: str | None,
            query: str,
            user_id: int | None,
            token: str | None,
        ) -> None:
            database = application.database
            route = (method, template)
            session_max_age = int(SESSION_LIFETIME.total_seconds())

            if route == ("GET", "/api/regions"):
                self._send_json(application.regions_payload())
            elif route == ("GET", "/api/regions/{key}"):
                try:
                    self._send_json(application.config_payload(param))
                except ValueError as error:
                    raise ApiError(HTTPStatus.NOT_FOUND, "NOT_FOUND", str(error)) from error
            elif route == ("POST", "/api/route-calculations"):
                payload = self._read_json()
                try:
                    result = application.calculate_routes(payload)
                except ValueError as error:
                    raise validation_error(None, str(error)) from error
                except Exception as error:
                    print(f"Demo route calculation failed: {error!r}", flush=True)
                    raise ApiError(
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                        "INTERNAL_ERROR",
                        "경로 계산에 실패했습니다. 다른 두 노드를 선택해 다시 시도해 주세요.",
                    ) from error
                self._send_json(result)
            elif route == ("POST", "/api/users"):
                user = database.create_user(self._read_json())
                new_token, _ = database.create_session(user["id"])
                self._send_json(user, HTTPStatus.CREATED, {
                    "Location": "/api/users/me",
                    "Set-Cookie": self._session_cookie(new_token, session_max_age),
                })
            elif route == ("POST", "/api/sessions"):
                payload = self._read_json()
                throttle_key = (self.client_address[0], str(payload.get("username", "")))
                login_throttle.check(throttle_key)
                try:
                    user = database.authenticate(payload)
                except ApiError:
                    login_throttle.record_failure(throttle_key)
                    raise
                login_throttle.clear(throttle_key)
                new_token, expires_at = database.create_session(user["id"])
                self._send_json({"user": user, "expires_at": expires_at}, HTTPStatus.CREATED, {
                    "Set-Cookie": self._session_cookie(new_token, session_max_age),
                })
            elif route == ("GET", "/api/users/me"):
                self._send_json(database.get_user(user_id))
            elif route == ("PATCH", "/api/users/me"):
                self._send_json(database.update_user(user_id, self._read_json(), token))
            elif route == ("DELETE", "/api/users/me"):
                database.delete_user(user_id, self._read_json())
                self._send_empty({"Set-Cookie": self._session_cookie("", 0)})
            elif route == ("DELETE", "/api/sessions/current"):
                database.delete_session(token)
                self._send_empty({"Set-Cookie": self._session_cookie("", 0)})
            elif route == ("GET", "/api/trips"):
                params = {key: values[0] for key, values in parse_qs(query).items()}
                self._send_json(database.list_trips(user_id, params))
            elif route == ("POST", "/api/trips"):
                trip = database.create_trip(user_id, self._read_json())
                self._send_json(trip, HTTPStatus.CREATED, {"Location": f"/api/trips/{trip['id']}"})
            elif route == ("GET", "/api/trips/{id}"):
                self._send_json(database.get_trip(user_id, int(param)))
            elif route == ("PATCH", "/api/trips/{id}"):
                self._send_json(database.update_trip(user_id, int(param), self._read_json()))
            elif route == ("DELETE", "/api/trips/{id}"):
                database.delete_trip(user_id, int(param))
                self._send_empty()

        def _check_origin(self) -> None:
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc != self.headers.get("Host"):
                raise ApiError(HTTPStatus.FORBIDDEN, "FORBIDDEN", "허용되지 않은 출처의 요청입니다.")

        def _session_token(self) -> str | None:
            morsel = SimpleCookie(self.headers.get("Cookie", "")).get("session_id")
            return morsel.value if morsel and morsel.value else None

        @staticmethod
        def _session_cookie(token: str, max_age: int) -> str:
            cookie = f"session_id={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax"
            return cookie + "; Secure" if SECURE_COOKIE else cookie

        def _send_empty(self, headers: dict[str, str] | None = None) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()

        def _read_json(self) -> dict:
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                raise validation_error(None, "Content-Type은 application/json이어야 합니다.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > 100_000:
                raise validation_error(None, "요청 데이터의 크기가 올바르지 않습니다.")
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise validation_error(None, "JSON 형식이 올바르지 않습니다.") from error
            if not isinstance(payload, dict):
                raise validation_error(None, "요청 본문은 JSON 객체여야 합니다.")
            return payload

        def _send_json(
            self,
            payload: dict,
            status: HTTPStatus = HTTPStatus.OK,
            headers: dict[str, str] | None = None,
        ) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format_string: str, *args: object) -> None:
            print(f"[EcoRoute web] {format_string % args}", flush=True)

    return DemoHandler


def run_server(root: Path, host: str, port: int, open_browser: bool = True) -> None:
    application = DemoApplication(root)
    server = ThreadingHTTPServer((host, port), make_handler(application))
    url = f"http://{host}:{port}"
    print(f"EcoRoute demo ready: {url}", flush=True)
    print("Stop the server with Ctrl+C.", flush=True)
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("EcoRoute demo stopped.", flush=True)
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the EcoRoute Washtenaw County web demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    run_server(root, args.host, args.port, open_browser=not args.no_browser)
