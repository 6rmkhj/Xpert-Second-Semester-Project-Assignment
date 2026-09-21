# EcoRoute API 명세서

## 공통 규칙

| 항목 | 내용 |
|---|---|
| Base URL | `/api` |
| 형식 | 요청·응답 모두 `application/json; charset=utf-8`. 본문이 있는 요청에 다른 `Content-Type`을 보내면 400 |
| 인증 | 로그인 시 `session_id` 쿠키 발급 (`HttpOnly`, `SameSite=Lax`, HTTPS 배포 시 환경변수 `ECOROUTE_SECURE_COOKIE=1`로 `Secure` 추가) |
| 필드 이름 | `snake_case` |
| 시간 | ISO 8601 UTC (`2026-09-21T08:30:00+00:00`), 날짜는 `YYYY-MM-DD` |
| CSRF | `GET`이 아닌 요청에 다른 사이트의 `Origin` 헤더가 붙어 있으면 403 |
| 보안 헤더 | 모든 응답에 `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` |

### 상태 코드

| 코드 | 의미 |
|---|---|
| 200 OK | 조회·수정 성공 |
| 201 Created | 생성 성공 (`Location` 헤더에 새 리소스 경로) |
| 204 No Content | 삭제 성공 (본문 없음) |
| 400 Bad Request | 입력값 검증 실패 |
| 401 Unauthorized | 로그인 필요 / 세션 만료 |
| 403 Forbidden | 다른 사용자의 리소스 접근 / 허용되지 않은 `Origin` |
| 404 Not Found | 리소스 없음 |
| 409 Conflict | 중복 (이미 있는 아이디 등) |
| 405 Method Not Allowed | 경로는 맞지만 지원하지 않는 메서드 |
| 429 Too Many Requests | 로그인 실패 5회 후 10분간 차단 |
| 500 Internal Server Error | 서버 오류 |

### 에러 응답

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "출발시간은 0시부터 23시 사이여야 합니다.",
    "field": "hour"
  }
}
```

`code` 값: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `DUPLICATE`, `METHOD_NOT_ALLOWED`, `TOO_MANY_REQUESTS`, `INTERNAL_ERROR`
`field`는 특정 입력값 때문에 실패한 경우에만 포함.

### 목록 응답 (페이지네이션)

```json
{
  "items": [ ... ],
  "page": 1,
  "size": 10,
  "total": 23,
  "total_pages": 3
}
```

---

## 엔드포인트 요약

구현 상태: 아래 엔드포인트 전부 구현됨. 존재하지 않는 `/api/*` 경로는 JSON 404를 반환.

| 메서드 | 경로 | 설명 | 인증 |
|---|---|---|---|
| **지역 / 경로 계산** ||||
| GET | `/api/regions` | 지역 목록 | - |
| GET | `/api/regions/{region_key}` | 지역 상세 (지도 노드, 차종) | - |
| POST | `/api/route-calculations` | 친환경 경로 계산 | - |
| **사용자** ||||
| POST | `/api/users` | 회원가입 | - |
| GET | `/api/users/me` | 내 정보 | 필요 |
| PATCH | `/api/users/me` | 내 정보 수정 | 필요 |
| DELETE | `/api/users/me` | 회원 탈퇴 | 필요 |
| **세션** ||||
| POST | `/api/sessions` | 로그인 | - |
| DELETE | `/api/sessions/current` | 로그아웃 | 필요 |
| **주행 기록 (CRUD)** ||||
| GET | `/api/trips` | 내 주행 기록 목록 (검색·정렬·필터·페이지) | 필요 |
| POST | `/api/trips` | 주행 기록 저장 | 필요 |
| GET | `/api/trips/{trip_id}` | 주행 기록 상세 | 필요 |
| PATCH | `/api/trips/{trip_id}` | 주행 기록 수정 | 필요 |
| DELETE | `/api/trips/{trip_id}` | 주행 기록 삭제 | 필요 |

> 주간 리포트는 별도 API 없이 `GET /api/trips?from=이번주월요일&to=이번주일요일`로 받아 프런트에서 요일별 최신 기록을 집계한다.

---

## 1. 지역 / 경로 계산

### GET `/api/regions`

지역 목록. 지역 선택 드롭다운에 사용.

**200**
```json
{
  "items": [
    { "key": "ann_arbor", "label": "Ann Arbor", "short_label": "Ann Arbor", "is_default": true },
    { "key": "washtenaw_county", "label": "Washtenaw County", "short_label": "Washtenaw", "is_default": false }
  ]
}
```

### GET `/api/regions/{region_key}`

지역 상세. 지도 초기화에 필요한 데이터.

**200**
```json
{
  "region": "ann_arbor",
  "region_label": "Ann Arbor",
  "regions": [
    { "key": "ann_arbor", "label": "Ann Arbor", "short_label": "Ann Arbor" },
    { "key": "washtenaw_county", "label": "Washtenaw County", "short_label": "Washtenaw" }
  ],
  "center": { "lat": 42.273, "lon": -83.739 },
  "selectable_bounds": { "south": 42.2203, "west": -83.8046, "north": 42.3257, "east": -83.6740 },
  "selectable_node_spacing_m": 400,
  "original_graph_node_count": 12000,
  "selectable_node_count": 362,
  "nodes": [
    { "id": "61234567", "lat": 42.2808, "lon": -83.7430, "place_label": "Main St", "place_kind": "street", "place_distance_m": 12.5 }
  ],
  "vehicles": {
    "midsize": { "label": "중형차", "weight_kg": 1587.57, "engine_l": 2.5, "description": "EcoRoute 기본 비교 차량" }
  }
}
```

**404** 없는 `region_key`

### POST `/api/route-calculations`

출발지·목적지·출발 시각·차종으로 후보 경로와 예상 에너지를 계산. 결과는 DB에 저장하지 않음 (저장은 `POST /api/trips`).

**Request**
```json
{
  "region": "ann_arbor",
  "start": { "node_id": "61234567", "lat": 42.2808, "lon": -83.7430 },
  "destination": { "node_id": "61239999", "lat": 42.2950, "lon": -83.7100 },
  "hour": 8,
  "weekday": 0,
  "vehicle": "midsize"
}
```

| 필드 | 타입 | 필수 | 검증 |
|---|---|---|---|
| region | string | - | 지원 지역 key (기본값: 기본 지역) |
| start, destination | object | O | 지역 범위 안의 좌표, 서로 다른 노드 |
| hour | int | - | 0–23 (기본 8) |
| weekday | int | - | 0(월)–6(일) (기본 0) |
| vehicle | string | - | `vehicles`의 key (기본 `midsize`) |

**200**
```json
{
  "region": "ann_arbor",
  "region_label": "Ann Arbor",
  "hour": 8,
  "weekday": 0,
  "vehicle": { "key": "midsize", "label": "중형차", "weight_kg": 1587.57, "engine_l": 2.5, "description": "EcoRoute 기본 비교 차량" },
  "start": { "lat": 42.2808, "lon": -83.7430 },
  "destination": { "lat": 42.2950, "lon": -83.7100 },
  "routes": [
    { "route_id": 0, "is_fastest_route": true, "is_greenest_route": false, "distance_km": 5.2, "traffic_travel_time_min": 11.3, "total_energy_kwh": 3.1, "total_co2_kg": 0.82 }
  ],
  "geojson": { "type": "FeatureCollection", "features": [] },
  "carbon_scope": "tank-to-wheel"
}
```

**400** 검증 실패 · **500** 계산 실패

---

## 2. 사용자

### POST `/api/users`

회원가입. 성공하면 바로 로그인 상태가 되도록 `session_id` 쿠키도 발급.

**Request**
```json
{ "username": "eco_driver", "password": "s3cure-pass!", "nickname": "에코드라이버" }
```

| 필드 | 검증 |
|---|---|
| username | 4–20자, 영문 소문자·숫자·`_` |
| password | 8–64자 |
| nickname | 1–20자 |

**201** (`Location: /api/users/me`, `Set-Cookie: session_id=...`)
```json
{ "id": 1, "username": "eco_driver", "nickname": "에코드라이버", "created_at": "2026-09-21T10:00:00+09:00" }
```

**400** 검증 실패 · **409** 이미 있는 username

> 비밀번호는 `pbkdf2_hmac` + 사용자별 salt로 해싱해서 저장. 응답에 절대 포함하지 않음.

### GET `/api/users/me`

**200** 위와 같은 사용자 객체 · **401**

### PATCH `/api/users/me`

보낸 필드만 수정. 비밀번호를 바꾸려면 `current_password` 필수.

**Request**
```json
{ "nickname": "새닉네임", "current_password": "s3cure-pass!", "new_password": "new-pass-123" }
```

**200** 수정된 사용자 객체 · **400** · **401** (`current_password` 불일치 포함)

### DELETE `/api/users/me`

**Request**
```json
{ "password": "s3cure-pass!" }
```

**204** 탈퇴 완료 (주행 기록과 세션도 함께 삭제, 쿠키 만료) · **401**

---

## 3. 세션 (로그인 / 로그아웃)

### POST `/api/sessions`

**Request**
```json
{ "username": "eco_driver", "password": "s3cure-pass!" }
```

**201** (`Set-Cookie: session_id=...; HttpOnly; SameSite=Lax; Max-Age=604800`)
```json
{ "user": { "id": 1, "username": "eco_driver", "nickname": "에코드라이버" }, "expires_at": "2026-09-28T10:00:00+09:00" }
```

**401** 아이디 또는 비밀번호 불일치 (어느 쪽이 틀렸는지는 알려주지 않음)
**429** 같은 IP·아이디로 5회 연속 실패 시 10분간 차단 (성공하면 초기화)

### DELETE `/api/sessions/current`

**204** 서버에서 세션 삭제 + 쿠키 만료 · **401**

---

## 4. 주행 기록 (Trips) CRUD

경로 계산 결과 중 사용자가 고른 경로를 저장한 기록. 모든 요청은 본인 기록만 대상.

### Trip 객체

```json
{
  "id": 12,
  "name": "출근길",
  "memo": "학교 앞 공사 구간 피함",
  "driven_on": "2026-09-21",
  "region": "ann_arbor",
  "hour": 8,
  "weekday": 0,
  "vehicle": "midsize",
  "start": { "lat": 42.2808, "lon": -83.7430, "label": "Main St" },
  "destination": { "lat": 42.2950, "lon": -83.7100, "label": "North Campus" },
  "route_label": "친환경 경로",
  "distance_km": 5.8,
  "baseline_energy_kwh": 3.10,
  "chosen_energy_kwh": 2.64,
  "baseline_co2_kg": 0.82,
  "chosen_co2_kg": 0.70,
  "reduction_percent": 14.8,
  "created_at": "2026-09-21T08:40:00+09:00",
  "updated_at": "2026-09-21T08:40:00+09:00"
}
```

- `baseline_*`: 최단 시간 경로 기준값, `chosen_*`: 사용자가 선택한 경로 값
- `reduction_percent`는 서버에서 계산 (`(baseline - chosen) / baseline × 100`), 클라이언트가 보내지 않음

### GET `/api/trips`

| 쿼리 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| q | string | - | `name`, `memo`에서 검색 (부분 일치) |
| region | string | - | 지역 필터 |
| vehicle | string | - | 차종 필터 |
| from, to | date | - | `driven_on` 기간 필터 (포함) |
| sort | string | `driven_on` | `driven_on` \| `created_at` \| `distance_km` \| `chosen_energy_kwh` \| `reduction_percent` |
| order | string | `desc` | `asc` \| `desc` |
| page | int | 1 | 1 이상 |
| size | int | 10 | 1–50 |

예: `GET /api/trips?q=출근&sort=reduction_percent&order=desc&page=1&size=10`

**200** 목록 응답 형식, `items`는 Trip 객체 배열 · **400** 허용되지 않은 `sort`/`order` 값 · **401**

> `sort`, `order`는 허용 목록(화이트리스트)으로만 받아서 SQL에 넣음. 나머지 값은 모두 `?` 플레이스홀더로 바인딩.

### POST `/api/trips`

**Request**
```json
{
  "name": "출근길",
  "memo": "학교 앞 공사 구간 피함",
  "driven_on": "2026-09-21",
  "region": "ann_arbor",
  "hour": 8,
  "weekday": 0,
  "vehicle": "midsize",
  "start": { "lat": 42.2808, "lon": -83.7430, "label": "Main St" },
  "destination": { "lat": 42.2950, "lon": -83.7100, "label": "North Campus" },
  "route_label": "친환경 경로",
  "distance_km": 5.8,
  "baseline_energy_kwh": 3.10,
  "chosen_energy_kwh": 2.64,
  "baseline_co2_kg": 0.82,
  "chosen_co2_kg": 0.70
}
```

| 필드 | 필수 | 검증 |
|---|---|---|
| name | O | 1–50자 |
| memo | - | 0–500자 |
| driven_on | - | 날짜, 기본값 오늘 |
| region, vehicle | O | 지원하는 key |
| hour / weekday | O | 0–23 / 0–6 |
| start, destination | O | 지역 범위 안 좌표, `label` 0–100자 |
| route_label | O | 1–30자 |
| distance_km, *_energy_kwh, *_co2_kg | O | 0 초과 숫자 |

**201** (`Location: /api/trips/12`) Trip 객체 · **400** · **401**

### GET `/api/trips/{trip_id}`

**200** Trip 객체 · **401** · **403** 다른 사용자 기록 · **404**

### PATCH `/api/trips/{trip_id}`

사용자가 직접 입력하는 필드만 수정 가능. 계산 결과(에너지·CO₂·거리 등)는 수정 불가.

**Request** (보낸 필드만 반영)
```json
{ "name": "월요일 출근길", "memo": "8시 10분 출발이 더 빠름", "driven_on": "2026-09-22" }
```

**200** 수정된 Trip 객체 (`updated_at` 갱신) · **400** 수정 불가 필드 포함 / 검증 실패 · **401** · **403** · **404**

### DELETE `/api/trips/{trip_id}`

**204** · **401** · **403** · **404**
