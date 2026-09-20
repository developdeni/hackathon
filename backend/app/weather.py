from copy import deepcopy
from datetime import datetime, timezone
import math
from typing import Any
import httpx

_cache: dict[tuple[float, float], dict[str, Any]] = {}


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


async def get_field_agro_weather(latitude: float, longitude: float) -> dict[str, Any]:
    key = (round(latitude, 5), round(longitude, 5))
    params = {
        "latitude": latitude, "longitude": longitude,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration",
        "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
        "timezone": "Asia/Almaty", "forecast_days": 7, "wind_speed_unit": "ms",
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
            response.raise_for_status()
            result = parse_open_meteo_response(response.json(), latitude, longitude)
            if result["status"] == "ok":
                _cache[key] = deepcopy(result)
                return result
    except (httpx.HTTPError, ValueError, TypeError):
        pass
    if key in _cache:
        return {**deepcopy(_cache[key]), "status": "cached", "message": "Сохранённый прогноз: обновление недоступно. Проверьте дату."}
    return fallback_weather_context(latitude, longitude)


def parse_open_meteo_response(data: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    current, daily = data.get("current") or {}, data.get("daily") or {}
    dates = daily.get("time") or []
    def values(name: str) -> list[float] | None:
        raw = daily.get(name) or []
        if not dates or len(raw) != len(dates) or any(_number(v) is None for v in raw):
            return None
        return list(map(float, raw))
    maxima, minima = values("temperature_2m_max"), values("temperature_2m_min")
    precipitation, evaporation = values("precipitation_sum"), values("et0_fao_evapotranspiration")
    total_rain = round(sum(precipitation), 1) if precipitation is not None else None
    total_et0 = round(sum(evaporation), 1) if evaporation is not None else None
    minimum = min(minima) if minima else None
    alerts = []
    if minimum is not None and minimum <= 1:
        alerts.append({"type": "frost", "level": "critical" if minimum <= 0 else "warning", "title": "Риск заморозков по прогнозу", "description": f"Минимум температуры в прогнозе: {minimum:.1f}°C."})
    if total_rain is not None and total_et0 is not None and total_rain < 3 and total_et0 > 15:
        alerts.append({"type": "moisture_deficit", "level": "moderate", "title": "Отрицательный прогнозный водный баланс", "description": f"Осадки {total_rain:.1f} мм, ET₀ {total_et0:.1f} мм. Это погодная оценка, не измерение влажности почвы."})
    temperature = _number(current.get("temperature_2m"))
    return {
        "status": "ok" if temperature is not None or maxima else "unavailable",
        "source": "Open-Meteo · модельный прогноз (best_match)",
        "coordinates": {"latitude": lat, "longitude": lon},
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "observedAt": current.get("time"), "timezone": data.get("timezone", "Asia/Almaty"),
        "forecastStart": dates[0] if dates else None, "forecastEnd": dates[-1] if dates else None,
        "current": {"temperature": temperature, "humidity": _number(current.get("relative_humidity_2m")), "windSpeed": _number(current.get("wind_speed_10m"))},
        "forecast7d": {
            "maxTemp": max(maxima) if maxima else None, "minTemp": minimum,
            "precipSum": total_rain, "evapotranspiration": total_et0,
            "waterBalance": round(total_rain - total_et0, 1) if total_rain is not None and total_et0 is not None else None,
            "gddSum": round(sum(max((hi + lo) / 2 - 5, 0) for hi, lo in zip(maxima, minima)), 1) if maxima and minima else None,
        },
        "alerts": alerts,
    }


def fallback_weather_context(lat: float, lon: float) -> dict[str, Any]:
    return {
        "status": "unavailable", "source": "Open-Meteo",
        "message": "Погода недоступна. Подтверждённого сохранённого прогноза для этого поля нет.",
        "coordinates": {"latitude": lat, "longitude": lon}, "updatedAt": None,
        "current": {"temperature": None, "humidity": None, "windSpeed": None},
        "forecast7d": {"maxTemp": None, "minTemp": None, "precipSum": None, "evapotranspiration": None, "gddSum": None, "waterBalance": None},
        "alerts": [],
    }
