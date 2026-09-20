import asyncio
import hashlib
import io
import json
import math
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import httpx
import numpy as np
from PIL import Image
from dotenv import load_dotenv
from shapely.geometry import Polygon, box
from .auth import compute_area_ha

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

COPERNICUS_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
SENTINEL_HUB_STAT_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics"
SENTINEL_HUB_PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

MISSION = "Sentinel-2 MSI Level-2A"
RESOLUTION_M = 10
CLOUD_MASK_METHOD = "SCL (Scene Classification Layer)"
PENDING_MESSAGE = "Ожидание снимка Sentinel-2: обработанные данные для этого поля пока недоступны."

_series_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_series_inflight: dict[str, asyncio.Task[dict[str, Any] | None]] = {}
# Sentinel-2 обновляется раз в ~5 дней, поэтому короткий TTL лишь плодит медленные
# холодные загрузки. 6 часов безопасно и держит открытие поля мгновенным в течение дня.
_SERIES_TTL_SECONDS = 6 * 3600

# Cached OAuth token: (expires_at_ts, token). The Copernicus token lives ~10 min,
# so re-fetching it on every satellite request wasted ~3.4s per cold field load.
_token_cache: tuple[float, str] | None = None
_token_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Disk-persistent cache. Keeps satellite/grid results across backend restarts
# (and --reload), so even a phone with an empty local cache gets an instant
# server response instead of paying the ~14s Copernicus round-trip.
# ---------------------------------------------------------------------------
_DISK_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "sat_cache"
try:
    _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass


def _disk_cache_path(kind: str, key: str) -> Path:
    digest = hashlib.sha1(("quality-v3|" + key).encode("utf-8")).hexdigest()
    return _DISK_CACHE_DIR / f"{kind}_{digest}.json"


def _disk_cache_read(kind: str, key: str, ttl_seconds: float) -> dict[str, Any] | None:
    try:
        path = _disk_cache_path(kind, key)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - float(payload.get("ts", 0)) < ttl_seconds:
            return payload.get("data")
    except Exception:
        return None
    return None


def _disk_cache_write(kind: str, key: str, data: dict[str, Any]) -> None:
    try:
        tmp = _disk_cache_path(kind, key).with_suffix(".tmp")
        tmp.write_text(json.dumps({"ts": time.time(), "data": data}), encoding="utf-8")
        tmp.replace(_disk_cache_path(kind, key))
    except Exception:
        pass


# Shared HTTP client with keep-alive + connection pooling. Reusing one client
# avoids a fresh TLS handshake on every Copernicus call — the single biggest
# saving on a high-latency ("bad") network, where each handshake is several RTTs.
_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=6.0),
            limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=300.0),
            http2=False,
        )
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
    _http_client = None


async def get_copernicus_token() -> str | None:
    """Получение токена доступа через Copernicus OAuth (кэшируется до истечения срока)."""
    global _token_cache

    client_id = os.getenv("COPERNICUS_CLIENT_ID")
    client_secret = os.getenv("COPERNICUS_CLIENT_SECRET")

    if not client_id or not client_secret:
        return None

    now_ts = time.time()
    cached = _token_cache
    if cached and now_ts < cached[0]:
        return cached[1]

    async with _token_lock:
        # Re-check inside the lock in case another request just refreshed it.
        cached = _token_cache
        if cached and time.time() < cached[0]:
            return cached[1]
        try:
            resp = await _get_http_client().post(
                COPERNICUS_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=httpx.Timeout(6.0, connect=6.0),
            )
            if resp.status_code == 200:
                data = resp.json()
                token = data.get("access_token")
                if token:
                    # Refresh 60s before real expiry; default 600s if not provided.
                    expires_in = float(data.get("expires_in", 600))
                    _token_cache = (time.time() + max(expires_in - 60, 30), token)
                    return token
        except Exception:
            pass
    return None


def _pending_response(field_id: str) -> dict[str, Any]:
    """Честный ответ, когда обработанного снимка Sentinel-2 нет — без придуманных чисел."""
    return {
        "fieldId": field_id,
        "status": "pending",
        "message": PENDING_MESSAGE,
        "source": "Copernicus Data Space Ecosystem",
        "mission": MISSION,
        "spatialResolutionMeters": RESOLUTION_M,
        "cloudMaskingMethod": CLOUD_MASK_METHOD,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "observations": [],
    }


async def fetch_field_satellite_series(field_id: str, boundary: list[dict[str, float]]) -> dict[str, Any]:
    """
    Получение временного ряда Sentinel-2 L2A (NDVI, NDMI, облачность) через Sentinel Hub
    Statistical API. Без сконфигурированных Copernicus credentials честно сообщает,
    что обработанный снимок ещё не получен — без подстановки придуманных значений.
    """
    if not boundary:
        return _pending_response(field_id)

    cache_key = field_id + "|" + ";".join(
        f"{point['latitude']:.7f},{point['longitude']:.7f}" for point in boundary
    )
    now_ts = time.time()

    # 1. Hot in-memory cache.
    cached = _series_cache.get(cache_key)
    if cached and now_ts - cached[0] < _SERIES_TTL_SECONDS:
        return cached[1]

    # 2. Warm disk cache (survives restarts) — instant even for a phone with no local cache.
    disk_fresh = _disk_cache_read("series", cache_key, _SERIES_TTL_SECONDS)
    if disk_fresh:
        _series_cache[cache_key] = (now_ts, disk_fresh)
        return disk_fresh

    # 3. Fetch live from Copernicus (the slow ~10s path), de-duplicated across callers.
    token = await get_copernicus_token()
    if token:
        try:
            task = _series_inflight.get(cache_key)
            if task is None:
                task = asyncio.create_task(query_sentinel_hub_statistical(token, boundary))
                _series_inflight[cache_key] = task
            live_data = await asyncio.shield(task)
            if live_data:
                live_data["fieldId"] = field_id
                _series_cache[cache_key] = (now_ts, live_data)
                _disk_cache_write("series", cache_key, live_data)
                return live_data
        except Exception:
            pass
        finally:
            task = _series_inflight.get(cache_key)
            if task is not None and task.done():
                _series_inflight.pop(cache_key, None)

    # 4. Network failed — return the last real data we ever saw (any age) rather than
    #    an empty "pending" response, so a bad connection still shows actual figures.
    stale = _disk_cache_read("series", cache_key, float("inf"))
    if stale:
        return {**stale, "stale": True, "message": "Обновление недоступно: показаны ранее полученные спутниковые данные."}

    return _pending_response(field_id)


async def fetch_field_satellite_period(
    boundary: list[dict[str, float]],
    date_from: date,
    date_to: date,
) -> dict[str, Any] | None:
    """Fetch a real field series for an explicit historical growing-season window."""
    if not boundary or date_to <= date_from:
        return None
    boundary_key = ";".join(
        f"{point['latitude']:.7f},{point['longitude']:.7f}" for point in boundary
    )
    cache_key = f"{boundary_key}|{date_from.isoformat()}|{date_to.isoformat()}"
    cached = _disk_cache_read("season", cache_key, 30 * 24 * 3600)
    if cached:
        return cached
    token = await get_copernicus_token()
    if not token:
        return None
    try:
        result = await query_sentinel_hub_statistical(token, boundary, date_from, date_to)
    except Exception:
        result = None
    if result:
        _disk_cache_write("season", cache_key, result)
        return result
    return _disk_cache_read("season", cache_key, float("inf"))


async def query_sentinel_hub_statistical(
    token: str,
    boundary: list[dict[str, float]],
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any] | None:
    """Запрос в Sentinel Hub Statistical API и разбор реальной статистики NDVI/NDMI."""
    coordinates = [[p["longitude"], p["latitude"]] for p in boundary]
    if coordinates and coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])

    now = datetime.now(timezone.utc)
    season_start = date_from or (now - timedelta(days=210)).date()
    season_end = date_to or now.date()
    payload = {
        "input": {
            "bounds": {
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [coordinates],
                }
            },
            "data": [
                {
                    "type": "sentinel-2-l2a",
                    "dataFilter": {
                        "mosaickingOrder": "leastCC",
                        "maxCloudCoverage": 40,
                    },
                }
            ],
        },
        "aggregation": {
            "resx": RESOLUTION_M / (111320 * math.cos(math.radians(boundary[0]["latitude"]))),
            "resy": RESOLUTION_M / 111320,
            "timeRange": {
                "from": season_start.strftime("%Y-%m-%dT00:00:00Z"),
                "to": season_end.strftime("%Y-%m-%dT00:00:00Z"),
            },
            "aggregationInterval": {"of": "P10D", "lastIntervalBehavior": "SHORTEN"},
            "evalscript": """
            //VERSION=3
            function setup() {
              return {
                input: [{ bands: ["B04", "B08", "B11", "SCL", "dataMask"] }],
                output: [
                  { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
                  { id: "ndmi", bands: 1, sampleType: "FLOAT32" },
                  { id: "quality", bands: ["clear", "cloud"], sampleType: "FLOAT32" },
                  { id: "dataMask", bands: ["ndvi", "ndmi", "quality"] }
                ]
              };
            }
            function evaluatePixel(samples) {
              // Пиксельная маска облаков по SCL: исключаем no-data(0), saturated(1),
              // cloud shadow(3), cloud medium(8), cloud high(9), cirrus(10), snow/ice(11).
              // Оставляем dark(2), vegetation(4), bare soil(5), water(6), unclassified(7).
              var scl = samples.SCL;
              var cloudy = (scl == 0) || (scl == 1) || (scl == 3) ||
                           (scl == 8) || (scl == 9) || (scl == 10) || (scl == 11);
              var valid = (samples.dataMask == 1 && !cloudy) ? 1 : 0;
              var dV = samples.B08 + samples.B04;
              var dM = samples.B08 + samples.B11;
              var ndvi = dV != 0 ? (samples.B08 - samples.B04) / dV : 0;
              var ndmi = dM != 0 ? (samples.B08 - samples.B11) / dM : 0;
              // dataMask=0 у облачных пикселей — они исключаются из статистики (чистое среднее)
              var cloud = (scl == 8 || scl == 9 || scl == 10) ? 1 : 0;
              return { ndvi: [ndvi], ndmi: [ndmi], quality: [valid, cloud], dataMask: [valid, valid, samples.dataMask] };
            }
            """,
        },
        # Реальные перцентили (робастная медиана p50 + разброс p10..p90) вместо среднего по мутным пикселям
        "calculations": {
            "ndvi": {"statistics": {"default": {"percentiles": {"k": [10, 50, 90]}}}},
        },
    }

    resp = await _get_http_client().post(
        SENTINEL_HUB_STAT_URL,
        json=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=httpx.Timeout(14.0, connect=6.0),
    )
    if resp.status_code == 200:
        return parse_statistical_response(resp.json())
    return None


def _smooth_raster(values: np.ndarray, passes: int = 2) -> np.ndarray:
    """Small dependency-free blur that suppresses single Sentinel pixels."""
    result = values.astype(np.float32, copy=True)
    for _ in range(passes):
        padded = np.pad(result, 1, mode="edge")
        result = sum(
            padded[dy:dy + result.shape[0], dx:dx + result.shape[1]]
            for dy in range(3)
            for dx in range(3)
        ) / 9.0
    return result


def _binary_dilate(mask: np.ndarray, passes: int = 1) -> np.ndarray:
    result = mask.astype(bool, copy=True)
    for _ in range(passes):
        padded = np.pad(result, 1, mode="constant", constant_values=False)
        result = np.logical_or.reduce([
            padded[dy:dy + result.shape[0], dx:dx + result.shape[1]]
            for dy in range(3)
            for dx in range(3)
        ])
    return result


def _binary_erode(mask: np.ndarray, passes: int = 1) -> np.ndarray:
    result = mask.astype(bool, copy=True)
    for _ in range(passes):
        padded = np.pad(result, 1, mode="constant", constant_values=False)
        result = np.logical_and.reduce([
            padded[dy:dy + result.shape[0], dx:dx + result.shape[1]]
            for dy in range(3)
            for dx in range(3)
        ])
    return result


def _regularize_component(component: np.ndarray, seed_y: int, seed_x: int) -> np.ndarray:
    """Close narrow raster gaps while keeping only the region attached to the click."""
    closed = _binary_erode(_binary_dilate(component, passes=2), passes=2)
    closed[seed_y, seed_x] = True
    regularized = _connected_component(closed, seed_y, seed_x)
    return regularized if int(regularized.sum()) >= int(component.sum()) * 0.65 else component


def _component_quality(
    component: np.ndarray,
    edge_strength: np.ndarray,
    edge_limit: float,
) -> tuple[float, float]:
    """Return shape compactness and spectral-edge support for one candidate."""
    pixel_count = int(component.sum())
    if pixel_count == 0:
        return 0.0, 0.0

    padded = np.pad(component, 1, mode="constant", constant_values=False)
    interior = (
        padded[1:-1, 1:-1]
        & padded[:-2, 1:-1]
        & padded[2:, 1:-1]
        & padded[1:-1, :-2]
        & padded[1:-1, 2:]
    )
    perimeter = component & ~interior
    perimeter_pixels = max(int(perimeter.sum()), 1)
    compactness = min(1.0, 4 * math.pi * pixel_count / (perimeter_pixels ** 2))
    edge_support = (
        min(float(np.mean(edge_strength[perimeter])) / (edge_limit * 1.5), 1.0)
        if perimeter.any()
        else 0.0
    )
    return compactness, edge_support


def _field_candidate_tier(
    pixel_count: int,
    area_ha: float,
    compactness: float,
    area_ratio: float,
    touching_edges: int,
) -> str | None:
    if (
        pixel_count >= 35
        and area_ha >= 1.5
        and compactness >= 0.10
        and area_ratio <= 0.85
        and touching_edges <= 3
    ):
        return "confident"
    if (
        pixel_count >= 15
        and area_ha >= 0.4
        and compactness >= 0.04
        and area_ratio <= 0.90
        and touching_edges <= 3
    ):
        return "review"
    return None



def _nearest_valid_seed(valid: np.ndarray, center_y: int, center_x: int, max_radius: int = 18) -> tuple[int, int] | None:
    if valid[center_y, center_x]:
        return center_y, center_x
    height, width = valid.shape
    for radius in range(1, max_radius + 1):
        y0, y1 = max(0, center_y - radius), min(height, center_y + radius + 1)
        x0, x1 = max(0, center_x - radius), min(width, center_x + radius + 1)
        ys, xs = np.where(valid[y0:y1, x0:x1])
        if len(xs):
            distances = (ys + y0 - center_y) ** 2 + (xs + x0 - center_x) ** 2
            index = int(np.argmin(distances))
            return int(ys[index] + y0), int(xs[index] + x0)
    return None


def _connected_component(mask: np.ndarray, seed_y: int, seed_x: int) -> np.ndarray:
    height, width = mask.shape
    component = np.zeros_like(mask, dtype=bool)
    stack = [(seed_y, seed_x)]
    while stack:
        y, x = stack.pop()
        if y < 0 or y >= height or x < 0 or x >= width or component[y, x] or not mask[y, x]:
            continue
        component[y, x] = True
        stack.extend((
            (y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1),
        ))
    return component


def _convex_hull(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Andrew monotonic hull. Coordinates are (x, y) image pixels."""
    unique = sorted(set(points))
    if len(unique) <= 3:
        return unique

    def cross(origin: tuple[int, int], a: tuple[int, int], b: tuple[int, int]) -> int:
        return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])

    lower: list[tuple[int, int]] = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[int, int]] = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _simplify_hull(points: list[tuple[int, int]], max_points: int = 14) -> list[tuple[int, int]]:
    """Remove the least significant hull corners while preserving the field shape."""
    simplified = list(points)
    while len(simplified) > max_points:
        scores: list[float] = []
        for index, point in enumerate(simplified):
            prev = simplified[index - 1]
            nxt = simplified[(index + 1) % len(simplified)]
            scores.append(abs((point[0] - prev[0]) * (nxt[1] - prev[1]) - (point[1] - prev[1]) * (nxt[0] - prev[0])))
        simplified.pop(int(np.argmin(scores)))
    return simplified


def _mask_outer_contour(mask: np.ndarray) -> list[tuple[float, float]]:
    """Trace the largest ordered pixel-edge loop without turning it into a convex hull."""
    height, width = mask.shape
    edges: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    ys, xs = np.where(mask)
    for y, x in zip(ys, xs):
        left, right = 2 * int(x) - 1, 2 * int(x) + 1
        top, bottom = 2 * int(y) - 1, 2 * int(y) + 1
        if y == 0 or not mask[y - 1, x]:
            edges.add(((left, top), (right, top)))
        if x == width - 1 or not mask[y, x + 1]:
            edges.add(((right, top), (right, bottom)))
        if y == height - 1 or not mask[y + 1, x]:
            edges.add(((right, bottom), (left, bottom)))
        if x == 0 or not mask[y, x - 1]:
            edges.add(((left, bottom), (left, top)))

    outgoing: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for start, end in edges:
        outgoing.setdefault(start, []).append(end)
    for ends in outgoing.values():
        ends.sort()

    loops: list[list[tuple[int, int]]] = []
    remaining = set(edges)
    while remaining:
        start_edge = min(remaining)
        remaining.remove(start_edge)
        start, current = start_edge
        loop = [start, current]
        while current != start:
            options = [end for end in outgoing.get(current, []) if (current, end) in remaining]
            if not options:
                break
            next_end = options[0]
            remaining.remove((current, next_end))
            current = next_end
            loop.append(current)
        if len(loop) >= 5 and loop[-1] == start:
            loops.append(loop[:-1])

    if not loops:
        return []

    def polygon_area(loop: list[tuple[int, int]]) -> float:
        return abs(sum(
            loop[index][0] * loop[(index + 1) % len(loop)][1]
            - loop[(index + 1) % len(loop)][0] * loop[index][1]
            for index in range(len(loop))
        )) / 2

    outer = max(loops, key=polygon_area)
    return [(x / 2.0, y / 2.0) for x, y in outer]


def _touching_edges(component: np.ndarray) -> int:
    return sum((
        bool(component[0, :].any()),
        bool(component[-1, :].any()),
        bool(component[:, 0].any()),
        bool(component[:, -1].any()),
    ))


async def auto_detect_arable_boundary(
    latitude: float,
    longitude: float,
    radius_m: float = 700,
) -> dict[str, Any]:
    """Detect a field around the click using multispectral similarity and edges."""
    token = await get_copernicus_token()
    if not token:
        raise RuntimeError("Copernicus credentials не настроены")

    radius_m = max(250.0, min(radius_m, 2500.0))
    lat_delta = radius_m / 111_320
    lng_delta = radius_m / (111_320 * math.cos(math.radians(latitude)) or 1e-9)
    bbox = [
        longitude - lng_delta,
        latitude - lat_delta,
        longitude + lng_delta,
        latitude + lat_delta,
    ]

    now = datetime.now(timezone.utc)
    analysis_from = now - timedelta(days=180)
    payload = {
        "input": {
            "bounds": {
                "bbox": bbox,
                "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"},
            },
            "data": [
                {
                    "type": "sentinel-2-l2a",
                    "dataFilter": {
                        "timeRange": {
                            "from": analysis_from.strftime("%Y-%m-%dT00:00:00Z"),
                            "to": now.strftime("%Y-%m-%dT23:59:59Z"),
                        },
                        "mosaickingOrder": "leastCC",
                        "maxCloudCoverage": 35,
                    },
                }
            ],
        },
        "output": {
            "width": 256,
            "height": 256,
            "responses": [{"identifier": "default", "format": {"type": "image/png"}}],
        },
        "evalscript": """
        //VERSION=3
        function setup() {
          return { input: ["B04", "B08", "B11", "SCL", "dataMask"], output: { bands: 4 } };
        }
        function evaluatePixel(s) {
          let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
          let ndmi = (s.B08 - s.B11) / (s.B08 + s.B11);
          let ndviEncoded = Math.max(0, Math.min(1, (ndvi + 0.35) / 1.35));
          let ndmiEncoded = Math.max(0, Math.min(1, (ndmi + 0.55) / 1.35));
          let brightness = Math.max(0, Math.min(1, (s.B08 + s.B04) * 1.8));
          let clear = (s.SCL !== 3 && s.SCL !== 8 && s.SCL !== 9 && s.SCL !== 10 && s.SCL !== 11 && s.dataMask === 1);
          return [ndviEncoded, ndmiEncoded, brightness, clear ? 1 : 0];
        }
        """,
    }

    resp = await _get_http_client().post(
        SENTINEL_HUB_PROCESS_URL,
        json=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=httpx.Timeout(18.0, connect=6.0),
    )
    if resp.status_code != 200:
        raise RuntimeError("Sentinel Process API не вернул снимок для этой точки")

    image = Image.open(io.BytesIO(resp.content)).convert("RGBA")
    arr = np.asarray(image).astype(np.float32) / 255.0
    features = np.stack([
        _smooth_raster(arr[:, :, 0]),
        _smooth_raster(arr[:, :, 1]),
        _smooth_raster(arr[:, :, 2]),
    ], axis=2)
    valid = arr[:, :, 3] > 0.5
    h, w = valid.shape
    raw_seed = _nearest_valid_seed(valid, h // 2, w // 2)
    if raw_seed is None:
        raise RuntimeError("Точка закрыта облаками или вне доступного снимка Sentinel-2")
    raw_y, raw_x = raw_seed

    # Feature gradients for edge map
    gy0, gx0 = np.gradient(features[:, :, 0])
    gy2, gx2 = np.gradient(features[:, :, 2])
    edge_strength = np.hypot(gx0, gy0) + np.hypot(gx2, gy2)
    edge_limit = max(float(np.percentile(edge_strength[valid], 72)), 0.012)

    # Refine seed to interior of field (lowest local gradient in 11x11 window)
    win_grad = edge_strength[max(0, raw_y - 5):min(h, raw_y + 6), max(0, raw_x - 5):min(w, raw_x + 6)]
    min_idx = np.unravel_index(np.argmin(win_grad), win_grad.shape)
    seed_y = max(0, raw_y - 5) + int(min_idx[0])
    seed_x = max(0, raw_x - 5) + int(min_idx[1])
    if not valid[seed_y, seed_x]:
        seed_y, seed_x = raw_y, raw_x

    patch = features[max(0, seed_y - 2):seed_y + 3, max(0, seed_x - 2):seed_x + 3]
    patch_valid = valid[max(0, seed_y - 2):seed_y + 3, max(0, seed_x - 2):seed_x + 3]
    seed_vector = np.median(patch[patch_valid], axis=0) if patch_valid.any() else features[seed_y, seed_x]
    valid_features = features[valid]
    scales = np.maximum(
        np.percentile(valid_features, 75, axis=0) - np.percentile(valid_features, 25, axis=0),
        [0.05, 0.05, 0.04],
    )
    distance = np.sqrt(np.sum(((features - seed_vector) / scales) ** 2, axis=2))

    candidates: list[tuple[float, np.ndarray, float]] = []
    relaxed_candidates: list[tuple[float, np.ndarray, float]] = []
    all_viable: list[tuple[float, np.ndarray, float]] = []
    scene_area_ha = ((radius_m * 2) ** 2) / 10_000

    for threshold in (0.45, 0.65, 0.85, 1.10, 1.40, 1.75, 2.10):
        viable = valid & (distance <= threshold)
        viable[seed_y, seed_x] = True
        component = _connected_component(viable, seed_y, seed_x)
        pixel_count = int(component.sum())
        if pixel_count < 10:
            continue
        ratio = pixel_count / float(h * w)
        if ratio > 0.94:
            continue
        edges = _touching_edges(component)
        compactness, edge_support = _component_quality(component, edge_strength, edge_limit)
        candidate_area_ha = ratio * scene_area_ha
        score = (
            compactness * 0.50
            + edge_support * 0.35
            + min(candidate_area_ha / 20.0, 1.0) * 0.15
            - edges * 0.05
        )
        tier = _field_candidate_tier(pixel_count, candidate_area_ha, compactness, ratio, edges)
        all_viable.append((score, component, threshold))
        if tier == "confident":
            candidates.append((score, component, threshold))
        elif tier == "review":
            relaxed_candidates.append((score, component, threshold))

    needs_review = False
    warning: str | None = None
    if candidates:
        _score, component, used_threshold = max(candidates, key=lambda item: item[0])
    elif relaxed_candidates:
        _score, component, used_threshold = max(relaxed_candidates, key=lambda item: item[0])
        needs_review = True
        warning = "Поле небольшое или неоднородное. Получен предварительный контур — проверьте и поправьте вершины."
    elif all_viable:
        _score, component, used_threshold = max(all_viable, key=lambda item: item[0])
        needs_review = True
        warning = "Граница поля выделена приблизительно — проверьте вершины."
    else:
        component = np.zeros_like(valid, dtype=bool)
        component[max(0, seed_y - 6):min(h, seed_y + 7), max(0, seed_x - 6):min(w, seed_x + 7)] = True
        used_threshold = 0.0
        needs_review = True
        warning = "Точка не похожа на однородное сельхозполе. Нажмите внутри пашни, подальше от края и лесополосы, либо поправьте черновик вручную."

    component = _regularize_component(component, seed_y, seed_x)
    padded = np.pad(component, 1, mode="constant", constant_values=False)
    interior = (
        padded[1:-1, 1:-1]
        & padded[:-2, 1:-1]
        & padded[2:, 1:-1]
        & padded[1:-1, :-2]
        & padded[1:-1, 2:]
    )
    edge_pixels = component & ~interior
    traced_contour = _mask_outer_contour(component)
    if len(traced_contour) >= 4:
        contour = _simplify_hull(traced_contour, max_points=12)
    else:
        ys, xs = np.where(component)
        pts = list(zip(xs.tolist(), ys.tolist()))
        hull = _convex_hull(pts) if len(pts) >= 4 else []
        contour = _simplify_hull(hull, max_points=12) if len(hull) >= 4 else []

    if len(contour) < 4:
        r = 12
        angles = np.linspace(0, 2 * math.pi, 8, endpoint=False)
        contour = [
            (
                float(np.clip(seed_x + r * math.cos(a), 1, w - 2)),
                float(np.clip(seed_y + r * math.sin(a), 1, h - 2)),
            )
            for a in angles
        ]
        needs_review = True
        warning = "Создан черновой контур вокруг точки — уточните вершины вручную."


    def to_coord(x: float, y: float) -> dict[str, float]:
        lon = bbox[0] + (x / (w - 1)) * (bbox[2] - bbox[0])
        lat = bbox[3] - (y / (h - 1)) * (bbox[3] - bbox[1])
        return {"latitude": lat, "longitude": lon}

    boundary = [to_coord(x, y) for x, y in contour]
    pixel_count = int(component.sum())
    area_ratio = pixel_count / float(h * w)
    detected_area_ha = area_ratio * ((radius_m * 2) ** 2) / 10_000
    if detected_area_ha < 2.0:
        needs_review = True
        warning = "Объект меньше рекомендуемых 3–5 га для Sentinel-2. Контур приблизительный, проверьте вершины."
    perimeter_mask = edge_pixels & valid
    perimeter_pixels = max(int(edge_pixels.sum()), 1)
    compactness = min(1.0, 4 * math.pi * pixel_count / (perimeter_pixels ** 2))
    if compactness < 0.22:
        needs_review = True
        warning = "Граница неоднородная и рваная. Контур построен как черновик — проверьте вершины по спутниковой карте."
    edge_quality = min(float(np.mean(edge_strength[perimeter_mask])) / (edge_limit * 1.5), 1.0) if perimeter_mask.any() else 0.0
    quality_score = max(0.32, min(0.93, 0.5 + edge_quality * 0.18 + compactness * 0.18 - _touching_edges(component) * 0.06))
    if needs_review:
        quality_score = min(quality_score, 0.49)
    seed_ndvi = float(seed_vector[0] * 1.35 - 0.35)
    return {
        "status": "ready",
        "method": "Sentinel-2 crop-field region growing + ordered edge contour",
        "qualityScore": round(quality_score, 2),
        "qualityScoreBasis": "spectral edge support + shape compactness; not a probability",
        "source": "Copernicus Sentinel-2 Process API",
        "spatialResolutionMeters": RESOLUTION_M,
        "analysisWindowDays": 180,
        "seedNdvi": round(seed_ndvi, 2),
        "coveragePercent": round(area_ratio * 100, 1),
        "estimatedAreaHa": round(detected_area_ha, 1),
        "compactness": round(compactness, 2),
        "pointCount": len(boundary),
        "threshold": used_threshold,
        "needsReview": needs_review,
        "warning": warning,
        "boundary": boundary,
    }


def parse_statistical_response(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Преобразует ответ Sentinel Hub Statistical API в реальный ряд наблюдений."""
    intervals = raw.get("data", [])
    observations: list[dict[str, Any]] = []
    previous_ndvi: float | None = None

    for entry in sorted(intervals, key=lambda item: item.get("interval", {}).get("from", "")):
        outputs = entry.get("outputs", {})
        ndvi_band = outputs.get("ndvi", {}).get("bands", {}).get("B0", {})
        ndvi_stats = ndvi_band.get("stats")
        ndmi_stats = outputs.get("ndmi", {}).get("bands", {}).get("B0", {}).get("stats")
        if not ndvi_stats or ndvi_stats.get("sampleCount", 0) == 0:
            continue

        clear_count = ndvi_stats.get("sampleCount", 0) - ndvi_stats.get("noDataCount", 0)
        # sampleCount includes the bounding box outside the polygon. Only the
        # geometry count is a valid denominator for field coverage.
        geometry_count = entry.get("geometryPixelCount", raw.get("geometryPixelCount"))
        clear_fraction = min(clear_count / geometry_count, 1.0) if isinstance(geometry_count, (int, float)) and geometry_count > 0 else None
        quality = outputs.get("quality", {}).get("bands", {})
        clear_mean = quality.get("clear", {}).get("stats", {}).get("mean")
        cloud_mean = quality.get("cloud", {}).get("stats", {}).get("mean")
        if isinstance(clear_mean, (int, float)) and math.isfinite(clear_mean):
            clear_fraction = max(0.0, min(clear_mean, 1.0))
        mean = ndvi_stats.get("mean")
        if clear_count < 8 or not isinstance(mean, (int, float)) or not math.isfinite(mean) or not -1 <= mean <= 1:
            continue
        if clear_fraction is not None and clear_fraction < 0.3:
            continue

        # Реальная медиана (p50) устойчивее среднего к остаточным облакам/смешанным пикселям.
        pcts = ndvi_stats.get("percentiles", {}) or {}
        p50 = pcts.get("50.0")
        p10 = pcts.get("10.0")
        p90 = pcts.get("90.0")

        ndvi_mean = round(mean, 3)
        ndvi_median = round(p50, 3) if isinstance(p50, (int, float)) and math.isfinite(p50) and -1 <= p50 <= 1 else None
        ndmi_value = ndmi_stats.get("mean") if ndmi_stats else None
        ndmi_mean = round(ndmi_value, 3) if isinstance(ndmi_value, (int, float)) and math.isfinite(ndmi_value) and -1 <= ndmi_value <= 1 else None
        # Разброс p10..p90 — индикатор неоднородности поля / достоверности
        spread = round(p90 - p10, 3) if isinstance(p10, (int, float)) and isinstance(p90, (int, float)) else None
        reliability = "unknown" if clear_fraction is None else "high" if clear_fraction >= 0.6 else "medium"

        # Аномалию оцениваем по устойчивой медиане, а не по среднему
        value = ndvi_median if ndvi_median is not None else ndvi_mean
        anomaly = reliability == "high" and previous_ndvi is not None and (previous_ndvi - value) >= 0.12

        observation = {
            "date": entry.get("interval", {}).get("from", "")[:10],
            "periodEnd": entry.get("interval", {}).get("to", "")[:10],
            "ndviMean": ndvi_mean,
            "ndviMedian": ndvi_median,
            "ndmiMean": ndmi_mean,
            "cloudCoveragePercent": round(cloud_mean * 100, 1) if isinstance(cloud_mean, (int, float)) and math.isfinite(cloud_mean) else None,
            "clearPixelPercent": round(clear_fraction * 100, 1) if clear_fraction is not None else None,
            "validPixelCount": clear_count,
            "reliability": reliability,
            "ndviSpread": spread,
            "anomalyDetected": anomaly,
        }
        if anomaly:
            observation["anomalyFactor"] = (
                f"NDVI снизился на {round(previous_ndvi - value, 2)} между периодами. Возможны уборка, созревание или стресс; причина требует проверки."
            )
        observations.append(observation)
        previous_ndvi = value if reliability == "high" else None

    if not observations:
        return None

    return {
        "status": "ready",
        "stale": False,
        "aggregationDays": 10,
        "qualityVersion": 2,
        "source": "Copernicus Data Space Ecosystem (Sentinel Hub Statistical API)",
        "mission": MISSION,
        "spatialResolutionMeters": RESOLUTION_M,
        "cloudMaskingMethod": CLOUD_MASK_METHOD,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "periodStart": observations[0]["date"],
        "periodEnd": observations[-1]["periodEnd"],
        "observationCount": len(observations),
        "observations": observations,
    }


# ---------------------------------------------------------------------------
# Сеточная выборка внутри поля: реальные под-участковые NDVI/NDMI для
# построения очагов риска с настоящей геометрией (не выдуманные полигоны).
# ---------------------------------------------------------------------------

_grid_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_GRID_TTL_SECONDS = 6 * 3600


def _point_in_polygon(lat: float, lng: float, poly: list[dict[str, float]]) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        yi, xi = poly[i]["latitude"], poly[i]["longitude"]
        yj, xj = poly[j]["latitude"], poly[j]["longitude"]
        if ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _build_grid_cells(boundary: list[dict[str, float]], cols: int, rows: int) -> list[dict[str, Any]]:
    field_polygon = Polygon([(p["longitude"], p["latitude"]) for p in boundary])
    if not field_polygon.is_valid or field_polygon.is_empty:
        return []
    lats = [p["latitude"] for p in boundary]
    lngs = [p["longitude"] for p in boundary]
    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)
    d_lat = (max_lat - min_lat) / rows
    d_lng = (max_lng - min_lng) / cols

    cells: list[dict[str, Any]] = []
    for r in range(rows):
        for c in range(cols):
            lat0 = min_lat + d_lat * r
            lat1 = min_lat + d_lat * (r + 1)
            lng0 = min_lng + d_lng * c
            lng1 = min_lng + d_lng * (c + 1)
            clipped = field_polygon.intersection(box(lng0, lat0, lng1, lat1))
            parts = [clipped] if clipped.geom_type == "Polygon" else getattr(clipped, "geoms", [])
            for part_index, part in enumerate(parts):
                if part.is_empty or part.geom_type != "Polygon" or part.interiors:
                    continue
                cell_boundary = [{"latitude": y, "longitude": x} for x, y in list(part.exterior.coords)[:-1]]
                point = part.representative_point()
                cells.append({
                    "row": r, "col": f"{c}-{part_index}",
                    "areaHa": compute_area_ha(cell_boundary),
                    "centroid": {"latitude": point.y, "longitude": point.x},
                    "boundary": cell_boundary,
                })
    return cells


def _cache_key(boundary: list[dict[str, float]], cols: int, rows: int) -> str:
    pts = ";".join(f"{p['latitude']:.7f},{p['longitude']:.7f}" for p in boundary)
    return f"{cols}x{rows}|{pts}"


async def fetch_field_risk_grid(
    boundary: list[dict[str, float]],
    cols: int = 4,
    rows: int = 4,
) -> dict[str, Any] | None:
    """
    Реальная под-участковая выборка Sentinel-2 по регулярной сетке внутри поля.
    Каждая ячейка — отдельный запрос статистики NDVI/NDMI в Sentinel Hub.
    Возвращает реальные значения по ячейкам и средние по полю, либо None,
    если нет credentials / нет валидных данных (тогда очаги честно не строятся).
    """
    if not boundary or len(boundary) < 3:
        return None

    key = _cache_key(boundary, cols, rows)
    now = time.time()
    cached = _grid_cache.get(key)
    if cached and (now - cached[0]) < _GRID_TTL_SECONDS:
        return cached[1]

    disk_fresh = _disk_cache_read("grid", key, _GRID_TTL_SECONDS)
    if disk_fresh:
        _grid_cache[key] = (now, disk_fresh)
        return disk_fresh

    token = await get_copernicus_token()
    if not token:
        stale = _disk_cache_read("grid", key, float("inf"))
        return {**stale, "stale": True} if stale else None

    cells = _build_grid_cells(boundary, cols, rows)
    if not cells:
        return None

    semaphore = asyncio.Semaphore(4)

    async def sample(cell: dict[str, Any]) -> None:
        try:
            async with semaphore:
                series = await query_sentinel_hub_statistical(token, cell["boundary"])
        except Exception:
            series = None
        cell["ndvi"] = None
        cell["ndmi"] = None
        cell["observations"] = series.get("observations", []) if series else []

    await asyncio.gather(*(sample(cell) for cell in cells))

    # Compare cells from the same interval; never mix summer and autumn values.
    dates = sorted({o["date"] for c in cells for o in c["observations"]}, reverse=True)
    observation_date = None
    total_area = sum(c["areaHa"] for c in cells)
    for date in dates:
        covered = [c for c in cells if any(o["date"] == date and o.get("reliability") == "high" for o in c["observations"])]
        if len(covered) >= 2 and sum(c["areaHa"] for c in covered) >= total_area * 0.6:
            observation_date = date
            break
    for cell in cells:
        last = next((o for o in cell.pop("observations") if o["date"] == observation_date and o.get("reliability") == "high"), None)
        if last:
            cell["ndvi"] = last["ndviMedian"] if last.get("ndviMedian") is not None else last["ndviMean"]
            cell["ndmi"] = last.get("ndmiMean")
            cell["periodEnd"] = last.get("periodEnd")

    valid = [c for c in cells if isinstance(c.get("ndvi"), (int, float))]
    if len(valid) < 2:
        stale = _disk_cache_read("grid", key, float("inf"))
        return {**stale, "stale": True} if stale else None
    covered_area = sum(c["areaHa"] for c in valid)
    mean_ndvi = round(sum(c["ndvi"] * c["areaHa"] for c in valid) / covered_area, 3)
    ndmi_cells = [c for c in valid if isinstance(c.get("ndmi"), (int, float))]
    mean_ndmi = round(sum(c["ndmi"] * c["areaHa"] for c in ndmi_cells) / sum(c["areaHa"] for c in ndmi_cells), 3) if ndmi_cells else None

    result = {
        "qualityVersion": 2,
        "stale": False,
        "observationDate": observation_date,
        "periodEnd": valid[0].get("periodEnd"),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "coveragePercent": round(covered_area / total_area * 100, 1) if total_area else 0,
        "cells": valid,
        "cellsInField": len(cells),
        "meanNdvi": mean_ndvi,
        "meanNdmi": mean_ndmi,
        "source": "Copernicus Data Space Ecosystem (Sentinel Hub Statistical API)",
        "gridSize": f"{cols}×{rows}",
    }
    _grid_cache[key] = (now, result)
    _disk_cache_write("grid", key, result)
    return result
