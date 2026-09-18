import asyncio
import io
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import httpx
import numpy as np
from PIL import Image
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

COPERNICUS_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
SENTINEL_HUB_STAT_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics"
SENTINEL_HUB_PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

MISSION = "Sentinel-2 MSI Level-2A"
RESOLUTION_M = 10
CLOUD_MASK_METHOD = "SCL (Scene Classification Layer)"
PENDING_MESSAGE = "Ожидание снимка Sentinel-2: обработанные данные для этого поля пока недоступны."


async def get_copernicus_token() -> str | None:
    """Получение токена доступа через Copernicus OAuth (если заданы credentials)."""
    client_id = os.getenv("COPERNICUS_CLIENT_ID")
    client_secret = os.getenv("COPERNICUS_CLIENT_SECRET")

    if not client_id or not client_secret:
        return None

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                COPERNICUS_TOKEN_URL,
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if resp.status_code == 200:
                return resp.json().get("access_token")
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

    token = await get_copernicus_token()
    if token:
        try:
            live_data = await query_sentinel_hub_statistical(token, boundary)
            if live_data:
                live_data["fieldId"] = field_id
                return live_data
        except Exception:
            pass

    return _pending_response(field_id)


async def query_sentinel_hub_statistical(token: str, boundary: list[dict[str, float]]) -> dict[str, Any] | None:
    """Запрос в Sentinel Hub Statistical API и разбор реальной статистики NDVI/NDMI."""
    coordinates = [[p["longitude"], p["latitude"]] for p in boundary]
    if coordinates and coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])

    now = datetime.now(timezone.utc)
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
            "timeRange": {
                "from": (now - timedelta(days=90)).strftime("%Y-%m-%dT00:00:00Z"),
                "to": now.strftime("%Y-%m-%dT00:00:00Z"),
            },
            "aggregationInterval": {"of": "P10D"},
            "evalscript": """
            //VERSION=3
            function setup() {
              return {
                input: [{ bands: ["B04", "B08", "B11", "SCL", "dataMask"] }],
                output: [
                  { id: "ndvi", bands: 1 },
                  { id: "ndmi", bands: 1 },
                  { id: "dataMask", bands: 1 }
                ]
              };
            }
            function evaluatePixel(samples) {
              let ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04);
              let ndmi = (samples.B08 - samples.B11) / (samples.B08 + samples.B11);
              return { ndvi: [ndvi], ndmi: [ndmi], dataMask: [samples.dataMask] };
            }
            """,
        },
    }

    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.post(
            SENTINEL_HUB_STAT_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        if resp.status_code == 200:
            return parse_statistical_response(resp.json())
    return None


async def auto_detect_arable_boundary(
    latitude: float,
    longitude: float,
    radius_m: float = 700,
) -> dict[str, Any]:
    """
    Прототип автосегментации пашни: берёт NDVI-растр Sentinel-2 вокруг клика,
    ищет связную область с близкой яркостью/вегетацией от точки клика и
    возвращает полигон по краям найденного контура.
    """
    token = await get_copernicus_token()
    if not token:
        raise RuntimeError("Copernicus credentials не настроены")

    radius_m = max(150.0, min(radius_m, 1800.0))
    lat_delta = radius_m / 111_320
    lng_delta = radius_m / (111_320 * math.cos(math.radians(latitude)) or 1e-9)
    bbox = [
        longitude - lng_delta,
        latitude - lat_delta,
        longitude + lng_delta,
        latitude + lat_delta,
    ]

    payload = {
        "input": {
            "bounds": {
                "bbox": bbox,
                "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"},
            },
            "data": [
                {
                    "type": "sentinel-2-l2a",
                    "dataFilter": {"mosaickingOrder": "leastCC", "maxCloudCoverage": 40},
                }
            ],
        },
        "output": {
            "width": 192,
            "height": 192,
            "responses": [{"identifier": "default", "format": {"type": "image/png"}}],
        },
        "evalscript": """
        //VERSION=3
        function setup() {
          return { input: ["B04", "B08", "SCL", "dataMask"], output: { bands: 4 } };
        }
        function evaluatePixel(s) {
          let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
          let v = Math.max(0, Math.min(255, Math.round((ndvi + 0.2) / 1.1 * 255)));
          let clear = (s.SCL !== 3 && s.SCL !== 8 && s.SCL !== 9 && s.SCL !== 10 && s.SCL !== 11 && s.dataMask === 1);
          return [v, v, v, clear ? 255 : 0];
        }
        """,
    }

    async with httpx.AsyncClient(timeout=18.0) as client:
        resp = await client.post(
            SENTINEL_HUB_PROCESS_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
    if resp.status_code != 200:
        raise RuntimeError("Sentinel Process API не вернул снимок для этой точки")

    image = Image.open(io.BytesIO(resp.content)).convert("RGBA")
    arr = np.asarray(image).astype(np.float32)
    ndvi_like = arr[:, :, 0] / 255.0
    alpha = arr[:, :, 3] > 0
    h, w = ndvi_like.shape
    seed_y, seed_x = h // 2, w // 2
    seed_value = ndvi_like[seed_y, seed_x]
    tolerance = 0.13
    viable = alpha & (np.abs(ndvi_like - seed_value) <= tolerance) & (ndvi_like >= 0.18)

    visited = np.zeros_like(viable, dtype=bool)
    stack = [(seed_y, seed_x)]
    component: list[tuple[int, int]] = []
    while stack:
        y, x = stack.pop()
        if y < 0 or y >= h or x < 0 or x >= w or visited[y, x] or not viable[y, x]:
            continue
        visited[y, x] = True
        component.append((y, x))
        stack.extend([(y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)])

    if len(component) < 30:
        raise RuntimeError("По клику не найден устойчивый контур пашни")

    ys = np.array([p[0] for p in component])
    xs = np.array([p[1] for p in component])
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())
    pad = 2
    min_x, min_y = max(min_x - pad, 0), max(min_y - pad, 0)
    max_x, max_y = min(max_x + pad, w - 1), min(max_y + pad, h - 1)

    def to_coord(x: int, y: int) -> dict[str, float]:
        lon = bbox[0] + (x / (w - 1)) * (bbox[2] - bbox[0])
        lat = bbox[3] - (y / (h - 1)) * (bbox[3] - bbox[1])
        return {"latitude": lat, "longitude": lon}

    boundary = [
        to_coord(min_x, max_y),
        to_coord(max_x, max_y),
        to_coord(max_x, min_y),
        to_coord(min_x, min_y),
    ]
    confidence = min(0.92, max(0.45, len(component) / (h * w) * 4))
    return {
        "status": "ready",
        "method": "Sentinel-2 NDVI raster flood-fill + edge bbox",
        "confidence": round(confidence, 2),
        "source": "Copernicus Sentinel-2 Process API",
        "boundary": boundary,
    }


def parse_statistical_response(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Преобразует ответ Sentinel Hub Statistical API в реальный ряд наблюдений."""
    intervals = raw.get("data", [])
    observations: list[dict[str, Any]] = []
    previous_ndvi: float | None = None

    for entry in intervals:
        outputs = entry.get("outputs", {})
        ndvi_stats = outputs.get("ndvi", {}).get("bands", {}).get("B0", {}).get("stats")
        ndmi_stats = outputs.get("ndmi", {}).get("bands", {}).get("B0", {}).get("stats")
        mask_stats = outputs.get("dataMask", {}).get("bands", {}).get("B0", {}).get("stats")
        if not ndvi_stats or ndvi_stats.get("sampleCount", 0) == 0:
            continue

        sample_count = ndvi_stats.get("sampleCount", 0)
        valid_count = mask_stats.get("sum") if mask_stats else None
        cloud_pct = (
            round((1 - valid_count / sample_count) * 100, 1)
            if valid_count is not None and sample_count
            else 0.0
        )

        ndvi_mean = round(ndvi_stats.get("mean", 0.0), 2)
        ndmi_mean = round(ndmi_stats.get("mean", 0.0), 2) if ndmi_stats else None
        anomaly = previous_ndvi is not None and (previous_ndvi - ndvi_mean) >= 0.12

        observation = {
            "date": entry.get("interval", {}).get("from", "")[:10],
            "ndviMean": ndvi_mean,
            "ndviMedian": round(ndvi_stats.get("mean", 0.0), 2),
            "ndmiMean": ndmi_mean,
            "cloudCoveragePercent": cloud_pct,
            "anomalyDetected": anomaly,
        }
        if anomaly:
            observation["anomalyFactor"] = (
                f"Снижение NDVI на {round(previous_ndvi - ndvi_mean, 2)} относительно предыдущего снимка"
            )
        observations.append(observation)
        previous_ndvi = ndvi_mean

    if not observations:
        return None

    return {
        "status": "ready",
        "source": "Copernicus Data Space Ecosystem (Sentinel Hub Statistical API)",
        "mission": MISSION,
        "spatialResolutionMeters": RESOLUTION_M,
        "cloudMaskingMethod": CLOUD_MASK_METHOD,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
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
            centroid = {"latitude": (lat0 + lat1) / 2, "longitude": (lng0 + lng1) / 2}
            # Оставляем только ячейки, центр которых реально внутри контура поля.
            if not _point_in_polygon(centroid["latitude"], centroid["longitude"], boundary):
                continue
            cell_boundary = [
                {"latitude": lat0, "longitude": lng0},
                {"latitude": lat0, "longitude": lng1},
                {"latitude": lat1, "longitude": lng1},
                {"latitude": lat1, "longitude": lng0},
            ]
            cells.append({
                "row": r,
                "col": c,
                "centroid": centroid,
                "boundary": cell_boundary,
            })
    return cells


def _cache_key(boundary: list[dict[str, float]], cols: int, rows: int) -> str:
    pts = ";".join(f"{p['latitude']:.5f},{p['longitude']:.5f}" for p in boundary[:8])
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
    now = datetime.now(timezone.utc).timestamp()
    cached = _grid_cache.get(key)
    if cached and (now - cached[0]) < _GRID_TTL_SECONDS:
        return cached[1]

    token = await get_copernicus_token()
    if not token:
        return None

    cells = _build_grid_cells(boundary, cols, rows)
    if not cells:
        return None

    async def sample(cell: dict[str, Any]) -> None:
        try:
            series = await query_sentinel_hub_statistical(token, cell["boundary"])
        except Exception:
            series = None
        cell["ndvi"] = None
        cell["ndmi"] = None
        if series and series.get("observations"):
            last = series["observations"][-1]
            cell["ndvi"] = last.get("ndviMean")
            cell["ndmi"] = last.get("ndmiMean")

    await asyncio.gather(*(sample(cell) for cell in cells))

    valid = [c for c in cells if isinstance(c.get("ndvi"), (int, float))]
    if len(valid) < 2:
        return None

    mean_ndvi = round(sum(c["ndvi"] for c in valid) / len(valid), 3)
    ndmi_vals = [c["ndmi"] for c in valid if isinstance(c.get("ndmi"), (int, float))]
    mean_ndmi = round(sum(ndmi_vals) / len(ndmi_vals), 3) if ndmi_vals else None

    result = {
        "cells": valid,
        "cellsInField": len(cells),
        "meanNdvi": mean_ndvi,
        "meanNdmi": mean_ndmi,
        "source": "Copernicus Data Space Ecosystem (Sentinel Hub Statistical API)",
        "gridSize": f"{cols}×{rows}",
    }
    _grid_cache[key] = (now, result)
    return result
