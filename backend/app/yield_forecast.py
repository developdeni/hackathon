"""Field-level yield forecast from measured history, weather and Sentinel-2 features."""

from __future__ import annotations

import asyncio
import math
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import numpy as np

from .copernicus import fetch_field_satellite_period


NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
MIN_HISTORY_SEASONS = 4
MAX_HISTORY_SEASONS = 8
RIDGE_ALPHA = 2.0

FEATURES = (
    ("ndviPeak", "Пик NDVI", "вегетация"),
    ("ndmiMean", "Средний NDMI", "влага в растениях"),
    ("precipMm", "Осадки", "влагообеспеченность"),
    ("gdd", "Сумма активных температур", "развитие культуры"),
    ("waterBalanceMm", "Водный баланс", "осадки минус ET₀"),
)

_forecast_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_SECONDS = 6 * 3600


def _crop_key(value: str) -> str:
    return " ".join(value.casefold().replace("ё", "е").split())


def _finite(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _source_registry(history: list[dict[str, Any]], statuses: dict[str, str]) -> list[dict[str, str]]:
    partner_count = sum(item.get("source") == "partner" for item in history)
    return [
        {
            "id": "sentinel2",
            "name": "Copernicus Sentinel-2 L2A",
            "status": statuses.get("sentinel2", "unavailable"),
            "role": "NDVI и NDMI по контуру поля",
        },
        {
            "id": "nasa_power",
            "name": "NASA POWER Daily API",
            "status": statuses.get("nasa_power", "unavailable"),
            "role": "осадки и температура по сезонам",
        },
        {
            "id": "era5",
            "name": "ERA5 (Copernicus CDS через Open-Meteo)",
            "status": statuses.get("era5", "unavailable"),
            "role": "ET₀ и независимый метеоряд",
        },
        {
            "id": "open_stats",
            "name": "Открытая статистика Бюро нацстатистики РК",
            "status": "reference_only",
            "role": "региональный ориентир; не подмешивается без привязки к району и культуре",
        },
        {
            "id": "partner_data",
            "name": "Данные хозяйства и партнёров",
            "status": "connected" if partner_count else "farm_records_only",
            "role": f"фактическая урожайность: {len(history)} сез.; партнёрских: {partner_count}",
        },
    ]


def _empty_forecast(
    field: dict[str, Any],
    history: list[dict[str, Any]],
    status: str,
    message: str,
    missing: list[str],
    source_statuses: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "fieldId": field["id"],
        "cropType": field["cropType"],
        "seasonYear": date.today().year,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "forecastTPerHa": None,
        "interval80": None,
        "confidenceLevel": 0.8,
        "modelQuality": "unavailable",
        "historyCount": len(history),
        "requiredHistoryCount": MIN_HISTORY_SEASONS,
        "method": "ridge regression + leave-one-season-out conformal interval",
        "message": message,
        "missingData": missing,
        "factors": [],
        "inputs": None,
        "sources": _source_registry(history, source_statuses or {}),
    }


async def _fetch_nasa_daily(latitude: float, longitude: float, start: date, end: date) -> dict[str, dict[str, float]]:
    params = {
        "parameters": "T2M_MAX,T2M_MIN,PRECTOTCORR",
        "community": "AG",
        "longitude": longitude,
        "latitude": latitude,
        "start": start.strftime("%Y%m%d"),
        "end": end.strftime("%Y%m%d"),
        "format": "JSON",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0)) as client:
        response = await client.get(NASA_POWER_URL, params=params)
        response.raise_for_status()
    parameters = response.json().get("properties", {}).get("parameter", {})
    result: dict[str, dict[str, float]] = {}
    for key, values in parameters.items():
        if not isinstance(values, dict):
            continue
        for raw_day, value in values.items():
            number = _finite(value)
            if number is not None and number > -900:
                iso_day = f"{raw_day[:4]}-{raw_day[4:6]}-{raw_day[6:8]}"
                result.setdefault(iso_day, {})[key] = number
    return result


async def _fetch_era5_daily(latitude: float, longitude: float, start: date, end: date) -> dict[str, dict[str, float]]:
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
        "models": "era5",
        "timezone": "auto",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=8.0)) as client:
        response = await client.get(OPEN_METEO_ARCHIVE_URL, params=params)
        response.raise_for_status()
    daily = response.json().get("daily", {})
    days = daily.get("time", [])
    result: dict[str, dict[str, float]] = {}
    for index, iso_day in enumerate(days):
        values: dict[str, float] = {}
        for key in ("temperature_2m_max", "temperature_2m_min", "precipitation_sum", "et0_fao_evapotranspiration"):
            series = daily.get(key, [])
            value = _finite(series[index]) if index < len(series) else None
            if value is not None:
                values[key] = value
        if values:
            result[iso_day] = values
    return result


def _season_window(year: int, cutoff: date) -> tuple[date, date]:
    start = date(year, 4, 1)
    month, day = cutoff.month, cutoff.day
    if (month, day) < (4, 15):
        month, day = 4, 15
    if (month, day) > (9, 30):
        month, day = 9, 30
    return start, date(year, month, day)


def _weather_features(
    year: int,
    cutoff: date,
    nasa: dict[str, dict[str, float]],
    era5: dict[str, dict[str, float]],
) -> dict[str, float] | None:
    start, end = _season_window(year, cutoff)
    expected = (end - start).days + 1
    nasa_rows = [values for key, values in nasa.items() if start.isoformat() <= key <= end.isoformat()]
    era_rows = [values for key, values in era5.items() if start.isoformat() <= key <= end.isoformat()]
    nasa_complete = [row for row in nasa_rows if all(key in row for key in ("T2M_MAX", "T2M_MIN", "PRECTOTCORR"))]
    era_complete = [row for row in era_rows if all(key in row for key in ("precipitation_sum", "et0_fao_evapotranspiration"))]
    if len(nasa_complete) < expected * 0.75 or len(era_complete) < expected * 0.7:
        return None
    precip = sum(row["PRECTOTCORR"] for row in nasa_complete)
    gdd = sum(max(0.0, ((row["T2M_MAX"] + row["T2M_MIN"]) / 2) - 5.0) for row in nasa_complete)
    heat_days = sum(row["T2M_MAX"] >= 30.0 for row in nasa_complete)
    era_precip = sum(row["precipitation_sum"] for row in era_complete)
    et0 = sum(row["et0_fao_evapotranspiration"] for row in era_complete)
    return {
        "precipMm": precip,
        "gdd": gdd,
        "heatDays": float(heat_days),
        "waterBalanceMm": era_precip - et0,
        "weatherCoveragePercent": min(100.0, len(nasa_complete) / expected * 100),
    }


def _satellite_features(series: dict[str, Any] | None) -> dict[str, float] | None:
    observations = (series or {}).get("observations", [])
    ndvi = [
        _finite(item.get("ndviMedian") if item.get("ndviMedian") is not None else item.get("ndviMean"))
        for item in observations
        if item.get("reliability") in ("high", "medium")
    ]
    ndmi = [_finite(item.get("ndmiMean")) for item in observations if item.get("reliability") in ("high", "medium")]
    ndvi = [value for value in ndvi if value is not None]
    ndmi = [value for value in ndmi if value is not None]
    if len(ndvi) < 2 or len(ndmi) < 2:
        return None
    return {
        "ndviPeak": max(ndvi),
        "ndmiMean": float(np.mean(ndmi)),
        "satelliteObservationCount": float(len(ndvi)),
    }


def fit_yield_model(rows: list[dict[str, float]], current: dict[str, float]) -> dict[str, Any]:
    """Fit a regularized field model and derive an 80% LOO conformal interval."""
    feature_names = [item[0] for item in FEATURES]
    x = np.asarray([[row[name] for name in feature_names] for row in rows], dtype=float)
    y = np.asarray([row["yieldTPerHa"] for row in rows], dtype=float)
    current_x = np.asarray([current[name] for name in feature_names], dtype=float)

    means = x.mean(axis=0)
    scales = x.std(axis=0)
    scales[scales < 1e-8] = 1.0
    z = (x - means) / scales
    current_z = (current_x - means) / scales

    def fit(train_x: np.ndarray, train_y: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray]:
        beta = np.linalg.solve(
            train_x.T @ train_x + RIDGE_ALPHA * np.eye(train_x.shape[1]),
            train_x.T @ (train_y - train_y.mean()),
        )
        return float(train_y.mean() + target @ beta), beta

    prediction, beta = fit(z, y, current_z)
    lower_guard = max(0.05, float(y.min()) * 0.35)
    upper_guard = max(float(y.max()) * 1.65, lower_guard)
    prediction = min(max(prediction, lower_guard), upper_guard)

    residuals: list[float] = []
    for index in range(len(rows)):
        mask = np.arange(len(rows)) != index
        loo_prediction, _ = fit(z[mask], y[mask], z[index])
        residuals.append(abs(float(y[index]) - loo_prediction))
    conformal_rank = min(len(residuals) - 1, math.ceil((len(residuals) + 1) * 0.8) - 1)
    half_width = max(sorted(residuals)[conformal_rank], prediction * 0.08)

    contributions = beta * current_z
    factors = []
    for (name, label, detail), contribution, value in zip(FEATURES, contributions, current_x):
        factors.append({
            "id": name,
            "label": label,
            "detail": detail,
            "value": round(float(value), 2),
            "contributionTPerHa": round(float(contribution), 2),
            "direction": "positive" if contribution > 0.025 else "negative" if contribution < -0.025 else "neutral",
        })
    factors.sort(key=lambda item: abs(item["contributionTPerHa"]), reverse=True)
    return {
        "forecast": round(prediction, 2),
        "low": round(max(0.0, prediction - half_width), 2),
        "high": round(prediction + half_width, 2),
        "factors": factors,
        "validationMae": round(float(np.mean(residuals)), 2),
    }


async def get_yield_forecast(field: dict[str, Any], raw_history: list[dict[str, Any]]) -> dict[str, Any]:
    crop = _crop_key(field["cropType"])
    history = [item for item in raw_history if _crop_key(item["cropType"]) == crop]
    history = sorted(history, key=lambda item: item["seasonYear"], reverse=True)[:MAX_HISTORY_SEASONS]
    if len(history) < MIN_HISTORY_SEASONS:
        needed = MIN_HISTORY_SEASONS - len(history)
        return _empty_forecast(
            field,
            history,
            "insufficient_data",
            f"Нужно ещё {needed} факт. сезон(а) по культуре «{field['cropType']}».",
            [f"минимум {MIN_HISTORY_SEASONS} фактических урожаев той же культуры"],
        )

    today = date.today()
    if today < date(today.year, 4, 15):
        return _empty_forecast(field, history, "unavailable", "Вегетационный сезон ещё не начался.", ["данные текущего сезона"])

    years = [item["seasonYear"] for item in history] + [today.year]
    cache_key = f"{field['id']}|{field['cropType']}|" + ";".join(
        f"{item['seasonYear']}:{item['yieldTPerHa']}:{item['source']}" for item in history
    ) + f"|{today.isoformat()}"
    cached = _forecast_cache.get(cache_key)
    if cached and time.time() - cached[0] < _CACHE_SECONDS:
        return cached[1]

    boundary = field["boundary"]
    latitude = sum(point["latitude"] for point in boundary) / len(boundary)
    longitude = sum(point["longitude"] for point in boundary) / len(boundary)
    earliest = date(min(years), 4, 1)
    _, latest = _season_window(today.year, today)

    satellite_limit = asyncio.Semaphore(3)

    async def fetch_satellite(year: int) -> dict[str, Any] | None:
        season_start, season_end = _season_window(year, today)
        async with satellite_limit:
            return await fetch_field_satellite_period(boundary, season_start, season_end + timedelta(days=1))

    satellite_tasks = []
    for year in years:
        satellite_tasks.append(fetch_satellite(year))
    nasa_task = _fetch_nasa_daily(latitude, longitude, earliest, latest)
    era5_task = _fetch_era5_daily(latitude, longitude, earliest, latest)
    results = await asyncio.gather(*satellite_tasks, nasa_task, era5_task, return_exceptions=True)
    satellite_results = results[:len(years)]
    nasa = results[-2] if isinstance(results[-2], dict) else {}
    era5 = results[-1] if isinstance(results[-1], dict) else {}

    statuses = {
        "sentinel2": "connected" if any(isinstance(item, dict) for item in satellite_results) else "unavailable",
        "nasa_power": "connected" if nasa else "unavailable",
        "era5": "connected" if era5 else "unavailable",
    }
    feature_by_year: dict[int, dict[str, float]] = {}
    for year, series in zip(years, satellite_results):
        satellite_features = _satellite_features(series if isinstance(series, dict) else None)
        weather_features = _weather_features(year, today, nasa, era5)
        if satellite_features and weather_features:
            feature_by_year[year] = {**satellite_features, **weather_features}

    missing_years = [str(item["seasonYear"]) for item in history if item["seasonYear"] not in feature_by_year]
    if today.year not in feature_by_year:
        missing_years.append(str(today.year))
    if missing_years:
        return _empty_forecast(
            field,
            history,
            "unavailable",
            "Не удалось собрать полный набор реальных признаков для сопоставимых сезонов.",
            [f"спутниковые или метеоданные за: {', '.join(missing_years)}"],
            statuses,
        )

    rows = [{**feature_by_year[item["seasonYear"]], "yieldTPerHa": float(item["yieldTPerHa"])} for item in history]
    model = fit_yield_model(rows, feature_by_year[today.year])
    result = {
        "status": "ready",
        "fieldId": field["id"],
        "cropType": field["cropType"],
        "seasonYear": today.year,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "forecastTPerHa": model["forecast"],
        "interval80": {"low": model["low"], "high": model["high"]},
        "confidenceLevel": 0.8,
        "modelQuality": "high" if len(history) >= 7 else "medium" if len(history) >= 5 else "preliminary",
        "historyCount": len(history),
        "requiredHistoryCount": MIN_HISTORY_SEASONS,
        "method": "ridge regression + leave-one-season-out conformal interval",
        "message": "Прогноз откалиброван по фактическим сезонам этого поля и этой культуры.",
        "missingData": [],
        "validationMaeTPerHa": model["validationMae"],
        "factors": model["factors"],
        "inputs": {**feature_by_year[today.year], "seasonWindow": f"04-01 — {latest.strftime('%m-%d')}"},
        "sources": _source_registry(history, statuses),
    }
    _forecast_cache[cache_key] = (time.time(), result)
    return result
