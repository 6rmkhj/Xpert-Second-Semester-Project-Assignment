import http.client
import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ecoroute.database import Database
from ecoroute.demo_server import LOGIN_MAX_FAILURES, make_handler


class StubApplication:
    web_root = ROOT / "web"

    def __init__(self, database: Database) -> None:
        self.database = database

    def regions_payload(self) -> dict:
        return {"items": [{"key": "ann_arbor", "label": "Ann Arbor", "short_label": "Ann Arbor", "is_default": True}]}

    def config_payload(self, region_key: str) -> dict:
        if region_key != "ann_arbor":
            raise ValueError("지원하지 않는 지도 지역입니다.")
        return {"region": region_key}

    def calculate_routes(self, payload: dict) -> dict:
        if payload.get("hour") == 99:
            raise ValueError("출발시간은 0시부터 23시 사이여야 합니다.")
        if payload.get("hour") == 13:
            raise RuntimeError("engine exploded")
        return {"routes": []}


class Client:
    def __init__(self, port: int) -> None:
        self.port = port
        self.cookie = ""

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        headers = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        if self.cookie:
            headers["Cookie"] = self.cookie
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        conn.close()
        is_json = (response.getheader("Content-Type") or "").startswith("application/json")
        return response.status, response, json.loads(raw) if is_json and raw else raw


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        bounds = {"ann_arbor": {"south": 42.0, "north": 43.0, "west": -84.0, "east": -83.0}}
        database = Database(Path(tmp) / "api.db", bounds, {"midsize"})
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(StubApplication(database)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            run_checks(server.server_address[1])
        finally:
            server.shutdown()
            server.server_close()
    print("api: all checks passed")


def run_checks(port):
    client = Client(port)

    status, response, _ = client.request("GET", "/")
    assert status == 200
    assert "frame-ancestors 'none'" in response.getheader("Content-Security-Policy")
    assert response.getheader("X-Content-Type-Options") == "nosniff"

    status, _, body = client.request("GET", "/api/nope")
    assert status == 404 and body["error"]["code"] == "NOT_FOUND"
    status, _, body = client.request("PUT", "/api/trips/1", body={})
    assert status == 405 and body["error"]["code"] == "METHOD_NOT_ALLOWED"

    assert client.request("GET", "/api/regions")[2]["items"][0]["is_default"] is True
    assert client.request("GET", "/api/regions/ann_arbor")[0] == 200
    assert client.request("GET", "/api/regions/mars")[0] == 404
    assert client.request("POST", "/api/route-calculations", body={"hour": 8})[0] == 200
    status, _, body = client.request("POST", "/api/route-calculations", body={"hour": 99})
    assert status == 400 and "0시부터" in body["error"]["message"]
    status, _, body = client.request("POST", "/api/route-calculations", body={"hour": 13})
    assert status == 500 and "exploded" not in body["error"]["message"]

    assert client.request("GET", "/api/trips")[0] == 401

    status, response, user = client.request(
        "POST", "/api/users", body={"username": "api_user", "password": "pass-1234", "nickname": "api"}
    )
    assert status == 201 and "password_hash" not in user
    assert "HttpOnly" in response.getheader("Set-Cookie") and "SameSite=Lax" in response.getheader("Set-Cookie")
    assert client.request("GET", "/api/users/me")[2]["username"] == "api_user"
    assert client.request("GET", "/api/trips")[0] == 200

    status, _, body = client.request("POST", "/api/trips", body={}, headers={"Origin": "https://evil.example"})
    assert status == 403 and body["error"]["code"] == "FORBIDDEN"
    status, _, _ = client.request("POST", "/api/trips", body={}, headers={"Origin": f"http://127.0.0.1:{port}"})
    assert status == 400
    status, _, body = client.request("POST", "/api/trips", body={}, headers={"Content-Type": "text/plain"})
    assert status == 400 and "Content-Type" in body["error"]["message"]

    old_cookie = client.cookie
    assert client.request("DELETE", "/api/sessions/current")[0] == 204
    client.cookie = old_cookie
    assert client.request("GET", "/api/users/me")[0] == 401

    attacker = Client(port)
    for _ in range(LOGIN_MAX_FAILURES):
        assert attacker.request("POST", "/api/sessions", body={"username": "api_user", "password": "wrong-pass"})[0] == 401
    status, _, body = attacker.request("POST", "/api/sessions", body={"username": "api_user", "password": "pass-1234"})
    assert status == 429 and body["error"]["code"] == "TOO_MANY_REQUESTS"
    assert attacker.request("POST", "/api/sessions", body={"username": "someone", "password": "wrong-pass"})[0] == 401


if __name__ == "__main__":
    main()
