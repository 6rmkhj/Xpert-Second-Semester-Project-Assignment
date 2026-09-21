from __future__ import annotations

import hashlib
import hmac
import math
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    nickname      TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
    memo                TEXT    NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
    driven_on           TEXT    NOT NULL,
    region              TEXT    NOT NULL,
    hour                INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    weekday             INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    vehicle             TEXT    NOT NULL,
    start_lat           REAL    NOT NULL,
    start_lon           REAL    NOT NULL,
    start_label         TEXT    NOT NULL DEFAULT '',
    destination_lat     REAL    NOT NULL,
    destination_lon     REAL    NOT NULL,
    destination_label   TEXT    NOT NULL DEFAULT '',
    route_label         TEXT    NOT NULL,
    distance_km         REAL    NOT NULL CHECK (distance_km > 0),
    baseline_energy_kwh REAL    NOT NULL CHECK (baseline_energy_kwh > 0),
    chosen_energy_kwh   REAL    NOT NULL CHECK (chosen_energy_kwh > 0),
    baseline_co2_kg     REAL    NOT NULL CHECK (baseline_co2_kg > 0),
    chosen_co2_kg       REAL    NOT NULL CHECK (chosen_co2_kg > 0),
    reduction_percent   REAL    NOT NULL,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_user_driven_on ON trips (user_id, driven_on);
"""

SESSION_LIFETIME = timedelta(days=7)
PASSWORD_ITERATIONS = 600_000
USERNAME_PATTERN = re.compile(r"[a-z0-9_]{4,20}")
SORT_COLUMNS = {"driven_on", "created_at", "distance_km", "chosen_energy_kwh", "reduction_percent"}
EDITABLE_FIELDS = {"name", "memo", "driven_on"}
MEASURED_FIELDS = (
    "distance_km",
    "baseline_energy_kwh",
    "chosen_energy_kwh",
    "baseline_co2_kg",
    "chosen_co2_kg",
)


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field

    def payload(self) -> dict:
        error = {"code": self.code, "message": self.message}
        if self.field:
            error["field"] = self.field
        return {"error": error}


def validation_error(field: str | None, message: str) -> ApiError:
    return ApiError(HTTPStatus.BAD_REQUEST, "VALIDATION_ERROR", message, field)


def unauthorized() -> ApiError:
    return ApiError(HTTPStatus.UNAUTHORIZED, "UNAUTHORIZED", "로그인이 필요합니다.")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(
        self,
        path: Path,
        region_bounds: dict[str, dict[str, float]],
        vehicles: set[str],
    ) -> None:
        self.path = path
        self.region_bounds = region_bounds
        self.vehicles = vehicles
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._transaction() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()


    def create_user(self, payload: dict) -> dict:
        username = payload.get("username")
        if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username):
            raise validation_error("username", "username은 4–20자의 영문 소문자, 숫자, _만 쓸 수 있습니다.")
        password = _password(payload, "password")
        nickname = _text(payload, "nickname", 1, 20)
        try:
            with self._transaction() as conn:
                user_id = conn.execute(
                    "INSERT INTO users (username, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)",
                    (username, hash_password(password), nickname, now_iso()),
                ).lastrowid
        except sqlite3.IntegrityError as error:
            raise ApiError(HTTPStatus.CONFLICT, "DUPLICATE", "이미 사용 중인 username입니다.", "username") from error
        return self.get_user(user_id)

    def authenticate(self, payload: dict) -> dict:
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise validation_error(None, "username과 password를 입력해 주세요.")
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        password_ok = verify_password(password, row["password_hash"] if row else DUMMY_PASSWORD_HASH)
        if row is None or not password_ok:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "UNAUTHORIZED", "아이디 또는 비밀번호가 올바르지 않습니다.")
        return _user_payload(row)

    def get_user(self, user_id: int) -> dict:
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise unauthorized()
        return _user_payload(row)

    def update_user(self, user_id: int, payload: dict, current_token: str) -> dict:
        unknown = set(payload) - {"nickname", "current_password", "new_password"}
        if unknown:
            raise validation_error(sorted(unknown)[0], f"수정할 수 없는 필드입니다: {', '.join(sorted(unknown))}")
        if "nickname" not in payload and "new_password" not in payload:
            raise validation_error(None, "수정할 필드를 하나 이상 보내 주세요.")
        values: dict[str, object] = {}
        if "nickname" in payload:
            values["nickname"] = _text(payload, "nickname", 1, 20)
        if "new_password" in payload:
            new_password = _password(payload, "new_password")
            self._check_password(user_id, payload.get("current_password"), "current_password")
            values["password_hash"] = hash_password(new_password)
        assignments = ", ".join(f"{column} = ?" for column in values)
        with self._transaction() as conn:
            conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", [*values.values(), user_id])
            if "password_hash" in values:
                conn.execute(
                    "DELETE FROM sessions WHERE user_id = ? AND id != ?",
                    (user_id, _session_key(current_token)),
                )
        return self.get_user(user_id)

    def delete_user(self, user_id: int, payload: dict) -> None:
        self._check_password(user_id, payload.get("password"), "password")
        with self._transaction() as conn:
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def create_session(self, user_id: int) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        created = datetime.now(timezone.utc)
        expires_at = (created + SESSION_LIFETIME).isoformat(timespec="seconds")
        with self._transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso(),))
            conn.execute(
                "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (_session_key(token), user_id, created.isoformat(timespec="seconds"), expires_at),
            )
        return token, expires_at

    def user_id_for_session(self, token: str) -> int | None:
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?",
                (_session_key(token), now_iso()),
            ).fetchone()
        return row["user_id"] if row else None

    def delete_session(self, token: str) -> None:
        with self._transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (_session_key(token),))

    def _check_password(self, user_id: int, password: object, field: str) -> None:
        with self._transaction() as conn:
            row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None or not isinstance(password, str) or not verify_password(password, row["password_hash"]):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "UNAUTHORIZED", "비밀번호가 올바르지 않습니다.", field)


    def list_trips(self, user_id: int, query: dict[str, str]) -> dict:
        where = ["user_id = ?"]
        params: list[object] = [user_id]
        keyword = query.get("q", "").strip()
        if keyword:
            escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("(name LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\')")
            params += [f"%{escaped}%", f"%{escaped}%"]
        for field in ("region", "vehicle"):
            if query.get(field):
                where.append(f"{field} = ?")
                params.append(query[field])
        if query.get("from"):
            where.append("driven_on >= ?")
            params.append(_parse_date(query["from"], "from"))
        if query.get("to"):
            where.append("driven_on <= ?")
            params.append(_parse_date(query["to"], "to"))

        sort = query.get("sort", "driven_on")
        if sort not in SORT_COLUMNS:
            raise validation_error("sort", f"sort는 {', '.join(sorted(SORT_COLUMNS))} 중 하나여야 합니다.")
        order = query.get("order", "desc").lower()
        if order not in ("asc", "desc"):
            raise validation_error("order", "order는 asc 또는 desc여야 합니다.")
        page = _parse_int(query.get("page", "1"), "page", 1, 1_000_000)
        size = _parse_int(query.get("size", "10"), "size", 1, 50)

        where_sql = " AND ".join(where)
        with self._transaction() as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM trips WHERE {where_sql}", params).fetchone()[0]
            rows = conn.execute(
                f"SELECT * FROM trips WHERE {where_sql} ORDER BY {sort} {order}, id {order} LIMIT ? OFFSET ?",
                [*params, size, (page - 1) * size],
            ).fetchall()
        return {
            "items": [_trip_payload(row) for row in rows],
            "page": page,
            "size": size,
            "total": total,
            "total_pages": math.ceil(total / size),
        }

    def create_trip(self, user_id: int, payload: dict) -> dict:
        values = self._validate_new_trip(payload)
        timestamp = now_iso()
        values.update(user_id=user_id, created_at=timestamp, updated_at=timestamp)
        columns = ", ".join(values)
        placeholders = ", ".join("?" for _ in values)
        with self._transaction() as conn:
            trip_id = conn.execute(
                f"INSERT INTO trips ({columns}) VALUES ({placeholders})", list(values.values())
            ).lastrowid
        return self.get_trip(user_id, trip_id)

    def get_trip(self, user_id: int, trip_id: int) -> dict:
        with self._transaction() as conn:
            return _trip_payload(_owned_trip(conn, user_id, trip_id))

    def update_trip(self, user_id: int, trip_id: int, payload: dict) -> dict:
        unknown = set(payload) - EDITABLE_FIELDS
        if unknown:
            raise validation_error(
                sorted(unknown)[0], f"수정할 수 없는 필드입니다: {', '.join(sorted(unknown))}"
            )
        if not payload:
            raise validation_error(None, "수정할 필드를 하나 이상 보내 주세요.")
        values: dict[str, object] = {}
        if "name" in payload:
            values["name"] = _text(payload, "name", 1, 50)
        if "memo" in payload:
            values["memo"] = _text(payload, "memo", 0, 500)
        if "driven_on" in payload:
            values["driven_on"] = _parse_date(payload["driven_on"], "driven_on")
        values["updated_at"] = now_iso()
        assignments = ", ".join(f"{column} = ?" for column in values)
        with self._transaction() as conn:
            _owned_trip(conn, user_id, trip_id)
            conn.execute(f"UPDATE trips SET {assignments} WHERE id = ?", [*values.values(), trip_id])
        return self.get_trip(user_id, trip_id)

    def delete_trip(self, user_id: int, trip_id: int) -> None:
        with self._transaction() as conn:
            _owned_trip(conn, user_id, trip_id)
            conn.execute("DELETE FROM trips WHERE id = ?", (trip_id,))

    def _validate_new_trip(self, payload: dict) -> dict[str, object]:
        region = payload.get("region")
        if region not in self.region_bounds:
            raise validation_error("region", "지원하지 않는 지역입니다.")
        if payload.get("vehicle") not in self.vehicles:
            raise validation_error("vehicle", "지원하지 않는 차종입니다.")
        values: dict[str, object] = {
            "name": _text(payload, "name", 1, 50),
            "memo": _text(payload, "memo", 0, 500) if "memo" in payload else "",
            "driven_on": (
                _parse_date(payload["driven_on"], "driven_on")
                if payload.get("driven_on")
                else date.today().isoformat()
            ),
            "region": region,
            "hour": _integer(payload, "hour", 0, 23),
            "weekday": _integer(payload, "weekday", 0, 6),
            "vehicle": payload["vehicle"],
            "route_label": _text(payload, "route_label", 1, 30),
        }
        bounds = self.region_bounds[region]
        for point in ("start", "destination"):
            value = payload.get(point)
            if not isinstance(value, dict):
                raise validation_error(point, f"{point} 좌표가 필요합니다.")
            lat = _number(value, "lat", point)
            lon = _number(value, "lon", point)
            if not (bounds["south"] <= lat <= bounds["north"] and bounds["west"] <= lon <= bounds["east"]):
                raise validation_error(point, f"{point} 좌표가 지역 범위를 벗어났습니다.")
            values[f"{point}_lat"] = lat
            values[f"{point}_lon"] = lon
            values[f"{point}_label"] = _text(value, "label", 0, 100) if "label" in value else ""
        for field in MEASURED_FIELDS:
            number = _number(payload, field, field)
            if number <= 0:
                raise validation_error(field, f"{field}는 0보다 커야 합니다.")
            values[field] = number
        baseline = values["baseline_energy_kwh"]
        values["reduction_percent"] = round((baseline - values["chosen_energy_kwh"]) / baseline * 100, 2)
        return values


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt, expected = stored.split("$")
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
    return hmac.compare_digest(digest.hex(), expected)


DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


def _session_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _user_payload(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in ("id", "username", "nickname", "created_at")}


def _password(payload: dict, field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not 8 <= len(value) <= 64:
        raise validation_error(field, f"{field}는 8–64자여야 합니다.")
    return value


def _owned_trip(conn: sqlite3.Connection, user_id: int, trip_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "NOT_FOUND", "주행 기록을 찾을 수 없습니다.")
    if row["user_id"] != user_id:
        raise ApiError(HTTPStatus.FORBIDDEN, "FORBIDDEN", "다른 사용자의 주행 기록입니다.")
    return row


def _trip_payload(row: sqlite3.Row) -> dict:
    trip = {key: row[key] for key in row.keys() if key != "user_id"}
    for point in ("start", "destination"):
        trip[point] = {
            "lat": trip.pop(f"{point}_lat"),
            "lon": trip.pop(f"{point}_lon"),
            "label": trip.pop(f"{point}_label"),
        }
    return trip


def _text(payload: dict, field: str, minimum: int, maximum: int) -> str:
    value = payload.get(field)
    if not isinstance(value, str):
        raise validation_error(field, f"{field}는 문자열이어야 합니다.")
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise validation_error(field, f"{field}는 {minimum}–{maximum}자여야 합니다.")
    return value


def _integer(payload: dict, field: str, minimum: int, maximum: int) -> int:
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise validation_error(field, f"{field}는 {minimum}–{maximum} 사이 정수여야 합니다.")
    return value


def _number(payload: dict, key: str, field: str) -> float:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise validation_error(field, f"{field} 값이 올바른 숫자가 아닙니다.")
    return float(value)


def _parse_int(value: str, field: str, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except ValueError:
        number = minimum - 1
    if not minimum <= number <= maximum:
        raise validation_error(field, f"{field}는 {minimum}–{maximum} 사이 정수여야 합니다.")
    return number


def _parse_date(value: object, field: str) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError as error:
        raise validation_error(field, f"{field}는 YYYY-MM-DD 형식이어야 합니다.") from error
