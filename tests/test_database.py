import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ecoroute.database import ApiError, Database


BOUNDS = {"ann_arbor": {"south": 42.0, "north": 43.0, "west": -84.0, "east": -83.0}}


def trip(**overrides):
    payload = {
        "name": "출근길", "memo": "공사 구간", "driven_on": "2026-09-21",
        "region": "ann_arbor", "hour": 8, "weekday": 0, "vehicle": "midsize",
        "start": {"lat": 42.28, "lon": -83.74, "label": "Main St"},
        "destination": {"lat": 42.29, "lon": -83.71},
        "route_label": "친환경 경로", "distance_km": 5.8,
        "baseline_energy_kwh": 4.0, "chosen_energy_kwh": 3.0,
        "baseline_co2_kg": 0.8, "chosen_co2_kg": 0.6,
    }
    payload.update(overrides)
    return payload


def expect_error(status, fn, *args):
    try:
        fn(*args)
    except ApiError as error:
        assert error.status == status, (error.status, error.message)
        return error
    raise AssertionError("expected ApiError")


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        db = Database(Path(tmp) / "t.db", BOUNDS, {"midsize"})

        user = db.create_user({"username": "eco_driver", "password": "pass-1234", "nickname": "에코"})
        assert set(user) == {"id", "username", "nickname", "created_at"}
        assert expect_error(409, db.create_user, {"username": "eco_driver", "password": "pass-1234", "nickname": "x"}).field == "username"
        assert expect_error(400, db.create_user, {"username": "Eco!", "password": "pass-1234", "nickname": "x"}).field == "username"
        assert expect_error(400, db.create_user, {"username": "abcd", "password": "short", "nickname": "x"}).field == "password"
        with sqlite3.connect(db.path) as conn:
            stored = conn.execute("SELECT password_hash FROM users").fetchone()[0]
        assert stored.startswith("pbkdf2_sha256$") and "pass-1234" not in stored

        me = db.authenticate({"username": "eco_driver", "password": "pass-1234"})["id"]
        wrong = expect_error(401, db.authenticate, {"username": "eco_driver", "password": "nope-nope"})
        unknown = expect_error(401, db.authenticate, {"username": "ghost_user", "password": "nope-nope"})
        assert wrong.message == unknown.message

        token, _ = db.create_session(me)
        assert db.user_id_for_session(token) == me
        with sqlite3.connect(db.path) as conn:
            assert conn.execute("SELECT COUNT(*) FROM sessions WHERE id = ?", (token,)).fetchone()[0] == 0
        other_device, _ = db.create_session(me)
        db.delete_session(other_device)
        assert db.user_id_for_session(other_device) is None
        assert db.user_id_for_session("forged-token") is None

        other_device, _ = db.create_session(me)
        expect_error(401, db.update_user, me, {"current_password": "bad-pass!", "new_password": "new-pass-1"}, token)
        db.update_user(me, {"current_password": "pass-1234", "new_password": "new-pass-1"}, token)
        assert db.user_id_for_session(token) == me
        assert db.user_id_for_session(other_device) is None
        db.authenticate({"username": "eco_driver", "password": "new-pass-1"})
        assert db.update_user(me, {"nickname": "새닉"}, token)["nickname"] == "새닉"

        other = db.create_user({"username": "other_user", "password": "pass-5678", "nickname": "남"})["id"]

        created = db.create_trip(me, trip())
        assert created["reduction_percent"] == 25.0
        assert created["start"] == {"lat": 42.28, "lon": -83.74, "label": "Main St"}
        assert "user_id" not in created

        assert expect_error(400, db.create_trip, me, trip(hour=24)).field == "hour"
        assert expect_error(400, db.create_trip, me, trip(start={"lat": 10, "lon": 10})).field == "start"
        assert expect_error(400, db.create_trip, me, trip(distance_km=True)).field == "distance_km"
        assert expect_error(400, db.create_trip, me, trip(name=" ")).field == "name"

        db.create_trip(me, trip(name="퇴근길", memo="", chosen_energy_kwh=2.0, driven_on="2026-09-22"))
        db.create_trip(me, trip(name="100%_할인", memo="", chosen_energy_kwh=3.5, driven_on="2026-09-23"))
        db.create_trip(other, trip(name="남의 출근길"))
        assert db.get_trip(me, created["id"])["name"] == "출근길"
        listed = db.list_trips(me, {"sort": "reduction_percent", "order": "desc", "size": "2"})
        assert listed["total"] == 3 and listed["total_pages"] == 2
        assert [t["name"] for t in listed["items"]] == ["퇴근길", "출근길"]
        assert [t["name"] for t in db.list_trips(me, {"q": "출근"})["items"]] == ["출근길"]
        assert [t["name"] for t in db.list_trips(me, {"q": "%_"})["items"]] == ["100%_할인"]
        assert db.list_trips(me, {"from": "2026-09-22", "to": "2026-09-22"})["total"] == 1
        expect_error(400, db.list_trips, me, {"sort": "name; DROP TABLE trips"})
        expect_error(400, db.list_trips, me, {"size": "51"})

        updated = db.update_trip(me, created["id"], {"memo": "  수정됨 ", "driven_on": "2026-09-24"})
        assert updated["memo"] == "수정됨" and updated["driven_on"] == "2026-09-24"
        expect_error(400, db.update_trip, me, created["id"], {"distance_km": 1})
        expect_error(400, db.update_trip, me, created["id"], {})

        foreign = db.list_trips(other, {})["items"][0]["id"]
        expect_error(403, db.get_trip, me, foreign)
        expect_error(403, db.delete_trip, me, foreign)
        db.delete_trip(me, created["id"])
        expect_error(404, db.get_trip, me, created["id"])

        expect_error(401, db.delete_user, other, {"password": "wrong-pass"})
        other_token, _ = db.create_session(other)
        db.delete_user(other, {"password": "pass-5678"})
        assert db.user_id_for_session(other_token) is None
        with sqlite3.connect(db.path) as conn:
            assert conn.execute("SELECT COUNT(*) FROM trips WHERE user_id = ?", (other,)).fetchone()[0] == 0
    print("database: all checks passed")


if __name__ == "__main__":
    main()
