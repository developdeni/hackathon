"""Weather-window recommendations for sowing and harvesting a field."""

from __future__ import annotations

import math
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx


OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
LOCAL_TZ = ZoneInfo("Asia/Almaty")


CROP_PROFILES: tuple[dict[str, Any], ...] = (
    {"keys": ("озим",), "label": "Озимая пшеница", "sow": ((8, 25), (9, 25)), "harvest": ((7, 15), (8, 25)), "soilMin": 5.0},
    {"keys": ("пшениц", "ячмен", "овес", "овёс"), "label": "Яровые зерновые", "sow": ((4, 20), (5, 25)), "harvest": ((8, 1), (9, 30)), "soilMin": 5.0},
    {"keys": ("рапс",), "label": "Яровой рапс", "sow": ((4, 25), (5, 20)), "harvest": ((8, 10), (9, 25)), "soilMin": 5.0},
    {"keys": ("лен", "лён"), "label": "Лён", "sow": ((4, 25), (5, 20)), "harvest": ((8, 15), (9, 30)), "soilMin": 6.0},
    {"keys": ("подсолнеч",), "label": "Подсолнечник", "sow": ((5, 1), (5, 25)), "harvest": ((9, 1), (10, 15)), "soilMin": 8.0},
    {"keys": ("кукуруз",), "label": "Кукуруза", "sow": ((5, 10), (6, 1)), "harvest": ((9, 15), (10, 20)), "soilMin": 10.0},
    {"keys": ("картоф",), "label": "Картофель", "sow": ((5, 1), (6, 5)), "harvest": ((8, 25), (10, 10)), "soilMin": 7.0},
)


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _crop_profile(crop_type: str) -> dict[str, Any] | None:
    crop = crop_type.casefold().replace("ё", "е")
    for profile in CROP_PROFILES:
        if any(key.replace("ё", "е") in crop for key in profile["keys"]):
            return profile
    return None


def _calendar_range(year: int, raw_range: tuple[tuple[int, int], tuple[int, int]]) -> tuple[date, date]:
    return date(year, *raw_range[0]), date(year, *raw_range[1])


def _format_range(start: date, end: date) -> str:
    return f"{start.strftime('%d.%m')}–{end.strftime('%d.%m')}"


async def fetch_operations_weather(latitude: float, longitude: float) -> dict[str, Any] | None:
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "daily": ",".join((
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "precipitation_probability_max",
            "wind_speed_10m_max",
            "relative_humidity_2m_mean",
        )),
        "hourly": "soil_temperature_6cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm",
        "timezone": "Asia/Almaty",
        "forecast_days": 16,
        "wind_speed_unit": "ms",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=6.0)) as client:
            response = await client.get(OPEN_METEO_URL, params=params)
            response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError, TypeError):
        return None


def parse_operations_weather(raw: dict[str, Any]) -> list[dict[str, Any]]:
    daily = raw.get("daily") or {}
    hourly = raw.get("hourly") or {}
    dates = daily.get("time") or []
    daily_names = (
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "precipitation_probability_max",
        "wind_speed_10m_max",
        "relative_humidity_2m_mean",
    )
    daily_series = {name: daily.get(name) or [] for name in daily_names}
    hourly_times = hourly.get("time") or []
    hourly_series = {
        name: hourly.get(name) or []
        for name in ("soil_temperature_6cm", "soil_moisture_1_to_3cm", "soil_moisture_3_to_9cm")
    }
    soil_by_day: dict[str, dict[str, list[float]]] = {}
    for index, timestamp in enumerate(hourly_times):
        day = str(timestamp)[:10]
        bucket = soil_by_day.setdefault(day, {name: [] for name in hourly_series})
        for name, values in hourly_series.items():
            value = _number(values[index]) if index < len(values) else None
            if value is not None:
                bucket[name].append(value)

    result: list[dict[str, Any]] = []
    for index, raw_day in enumerate(dates):
        values: dict[str, float] = {}
        complete = True
        for name, series in daily_series.items():
            value = _number(series[index]) if index < len(series) else None
            if value is None:
                complete = False
                break
            values[name] = value
        soil = soil_by_day.get(raw_day, {})
        soil_temp = soil.get("soil_temperature_6cm", [])
        moisture = soil.get("soil_moisture_3_to_9cm", []) or soil.get("soil_moisture_1_to_3cm", [])
        if not complete:
            continue
        result.append({
            "date": date.fromisoformat(raw_day),
            "tmax": values["temperature_2m_max"],
            "tmin": values["temperature_2m_min"],
            "precip": values["precipitation_sum"],
            "precipProbability": values["precipitation_probability_max"],
            "wind": values["wind_speed_10m_max"],
            "humidity": values["relative_humidity_2m_mean"],
            "soilTemperature": sum(soil_temp) / len(soil_temp) if soil_temp else None,
            "soilMoisture": sum(moisture) / len(moisture) if moisture else None,
        })
    return result


def satellite_field_state(observations: list[dict[str, Any]]) -> dict[str, Any]:
    usable = []
    for item in observations:
        value = _number(item.get("ndviMedian") if item.get("ndviMedian") is not None else item.get("ndviMean"))
        if value is not None and item.get("reliability") in (None, "high", "medium"):
            usable.append((item.get("date", ""), value))
    usable.sort(key=lambda row: row[0])
    if len(usable) < 3:
        return {
            "status": "unknown",
            "label": "Фаза не подтверждена",
            "message": "Недостаточно качественных периодов Sentinel-2 для оценки готовности к уборке.",
            "latestNdvi": usable[-1][1] if usable else None,
            "peakNdvi": max((row[1] for row in usable), default=None),
            "declineFromPeak": None,
            "observationDate": usable[-1][0] if usable else None,
        }
    peak = max(value for _, value in usable)
    latest_date, latest = usable[-1]
    decline = peak - latest
    if peak >= 0.5 and decline >= 0.20 and latest <= 0.48:
        status, label = "maturing", "Вероятное созревание"
        message = "NDVI заметно снизился после сезонного пика. Это совместимо с созреванием или уборкой, но требует проверки на поле."
    elif peak >= 0.45 and decline >= 0.10:
        status, label = "approaching", "Приближение к созреванию"
        message = "NDVI снижается после пика; контролируйте влажность зерна и состояние посева на поле."
    else:
        status, label = "vegetating", "Активная вегетация"
        message = "Спутниковая динамика пока не подтверждает выраженное завершение вегетации."
    return {
        "status": status,
        "label": label,
        "message": message,
        "latestNdvi": round(latest, 3),
        "peakNdvi": round(peak, 3),
        "declineFromPeak": round(decline, 3),
        "observationDate": latest_date,
    }


def _sowing_windows(days: list[dict[str, Any]], profile: dict[str, Any], today: date) -> list[dict[str, Any]]:
    calendar_start, calendar_end = _calendar_range(today.year, profile["sow"])
    candidates: list[dict[str, Any]] = []
    for index in range(len(days) - 1):
        window = days[index:index + 2]
        if not all(calendar_start <= item["date"] <= calendar_end for item in window):
            continue
        if any(item["soilTemperature"] is None or item["soilMoisture"] is None for item in window):
            continue
        min_soil = min(item["soilTemperature"] for item in window)
        min_air = min(item["tmin"] for item in window)
        rain = sum(item["precip"] for item in window)
        moisture = sum(item["soilMoisture"] for item in window) / len(window)
        wind = max(item["wind"] for item in window)
        score = 100.0
        factors: list[str] = []
        risks: list[str] = []
        if min_soil >= profile["soilMin"]:
            factors.append(f"почва {min_soil:.1f}°C на 6 см")
        else:
            score -= min(45, (profile["soilMin"] - min_soil) * 12)
            risks.append(f"почва холоднее {profile['soilMin']:.0f}°C")
        if min_air < -1:
            score -= 35
            risks.append(f"заморозок до {min_air:.1f}°C")
        elif min_air < 2:
            score -= 12
            risks.append(f"холодные ночи до {min_air:.1f}°C")
        if rain > 12:
            score -= 35
            risks.append(f"осадки {rain:.1f} мм")
        elif 1 <= rain <= 8:
            factors.append(f"умеренные осадки {rain:.1f} мм")
        if moisture < 0.12:
            score -= 25
            risks.append(f"сухой верхний слой {moisture:.2f} м³/м³")
        elif moisture > 0.36:
            score -= 25
            risks.append(f"переувлажнение {moisture:.2f} м³/м³")
        else:
            factors.append(f"влажность почвы {moisture:.2f} м³/м³")
        if wind > 9:
            score -= 10
            risks.append(f"ветер до {wind:.1f} м/с")
        candidates.append(_window_payload(window, score, factors, risks, today))
    return sorted((item for item in candidates if item["score"] >= 45), key=lambda item: (-item["score"], item["start"]))[:3]


def _harvest_windows(days: list[dict[str, Any]], profile: dict[str, Any], today: date) -> list[dict[str, Any]]:
    calendar_start, calendar_end = _calendar_range(today.year, profile["harvest"])
    candidates: list[dict[str, Any]] = []
    for index in range(len(days) - 2):
        window = days[index:index + 3]
        if not all(calendar_start <= item["date"] <= calendar_end for item in window):
            continue
        rain = sum(item["precip"] for item in window)
        probability = max(item["precipProbability"] for item in window)
        humidity = sum(item["humidity"] for item in window) / len(window)
        wind = max(item["wind"] for item in window)
        min_air = min(item["tmin"] for item in window)
        score = 100.0
        factors: list[str] = []
        risks: list[str] = []
        if rain <= 1.0 and probability <= 30:
            factors.append(f"сухое окно, осадки {rain:.1f} мм")
        else:
            score -= min(55, rain * 7 + max(0, probability - 30) * 0.45)
            risks.append(f"осадки {rain:.1f} мм, вероятность до {probability:.0f}%")
        if humidity <= 75:
            factors.append(f"средняя влажность воздуха {humidity:.0f}%")
        else:
            score -= min(25, (humidity - 75) * 1.3)
            risks.append(f"влажность воздуха {humidity:.0f}%")
        if wind > 11:
            score -= 30
            risks.append(f"ветер до {wind:.1f} м/с")
        elif wind <= 8:
            factors.append(f"ветер не выше {wind:.1f} м/с")
        if min_air <= 0:
            score -= 18
            risks.append(f"заморозок до {min_air:.1f}°C")
        candidates.append(_window_payload(window, score, factors, risks, today))
    return sorted((item for item in candidates if item["score"] >= 45), key=lambda item: (-item["score"], item["start"]))[:3]


def _window_payload(
    window: list[dict[str, Any]],
    score: float,
    factors: list[str],
    risks: list[str],
    today: date,
) -> dict[str, Any]:
    start, end = window[0]["date"], window[-1]["date"]
    lead = (start - today).days
    soil_temperatures = [item["soilTemperature"] for item in window if item["soilTemperature"] is not None]
    soil_moistures = [item["soilMoisture"] for item in window if item["soilMoisture"] is not None]
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "score": round(max(0, min(100, score))),
        "confidence": "higher" if lead <= 5 else "medium" if lead <= 10 else "lower",
        "factors": factors[:3],
        "risks": risks[:3],
        "metrics": {
            "precipSum": round(sum(item["precip"] for item in window), 1),
            "minTemperature": round(min(item["tmin"] for item in window), 1),
            "maxWind": round(max(item["wind"] for item in window), 1),
            "soilTemperature": round(sum(soil_temperatures) / len(soil_temperatures), 1) if soil_temperatures else None,
            "soilMoisture": round(sum(soil_moistures) / len(soil_moistures), 3) if soil_moistures else None,
        },
    }


def build_operations_recommendation(
    field: dict[str, Any],
    satellite: dict[str, Any],
    raw_weather: dict[str, Any] | None,
) -> dict[str, Any]:
    today = datetime.now(LOCAL_TZ).date()
    profile = _crop_profile(field["cropType"])
    state = satellite_field_state(satellite.get("observations", []))
    if raw_weather is None:
        return {
            "status": "unavailable",
            "fieldId": field["id"],
            "cropType": field["cropType"],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "horizonStart": None,
            "horizonEnd": None,
            "fieldState": state,
            "operations": [],
            "source": "Open-Meteo + Copernicus Sentinel-2",
            "message": "Не удалось получить 16-дневный прогноз. Сроки работ не рассчитаны.",
        }
    days = parse_operations_weather(raw_weather)
    if not days or profile is None:
        reason = "Культура пока не имеет проверенного календарного профиля." if profile is None else "Прогноз содержит неполные данные почвы или погоды."
        return {
            "status": "unavailable",
            "fieldId": field["id"],
            "cropType": field["cropType"],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "horizonStart": days[0]["date"].isoformat() if days else None,
            "horizonEnd": days[-1]["date"].isoformat() if days else None,
            "fieldState": state,
            "operations": [],
            "source": "Open-Meteo + Copernicus Sentinel-2",
            "message": reason,
        }

    sow_calendar = _calendar_range(today.year, profile["sow"])
    harvest_calendar = _calendar_range(today.year, profile["harvest"])
    sow_windows = _sowing_windows(days, profile, today)
    harvest_windows = _harvest_windows(days, profile, today)

    def operation(kind: str, calendar: tuple[date, date], windows: list[dict[str, Any]]) -> dict[str, Any]:
        horizon_overlaps = days[0]["date"] <= calendar[1] and days[-1]["date"] >= calendar[0]
        if not horizon_overlaps:
            status = "out_of_season"
            summary = f"Агрономический ориентир сезона: {_format_range(*calendar)}. Он вне горизонта текущего прогноза."
        elif not windows:
            status = "no_window"
            summary = "В горизонте прогноза нет устойчивого окна, проходящего погодные пороги."
        elif kind == "harvest" and state["status"] == "vegetating":
            status = "watch"
            summary = "Погодное окно есть, но Sentinel-2 пока не подтверждает завершение вегетации."
        elif kind == "harvest" and state["status"] == "unknown":
            status = "verify_field"
            summary = "Погодное окно есть; готовность культуры нужно подтвердить полевым осмотром и влажностью продукции."
        else:
            status = "recommended"
            summary = "Лучшее доступное окно выбрано по погоде и состоянию поля."
        return {
            "type": kind,
            "title": "Сев / посадка" if kind == "sowing" else "Уборка",
            "status": status,
            "calendar": _format_range(*calendar),
            "summary": summary,
            "windows": windows,
        }

    return {
        "status": "ready",
        "fieldId": field["id"],
        "cropType": field["cropType"],
        "cropProfile": profile["label"],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "horizonStart": days[0]["date"].isoformat(),
        "horizonEnd": days[-1]["date"].isoformat(),
        "fieldState": state,
        "operations": [
            operation("sowing", sow_calendar, sow_windows),
            operation("harvest", harvest_calendar, harvest_windows),
        ],
        "source": "Open-Meteo 16-дневный best_match + Copernicus Sentinel-2 L2A",
        "message": "Рекомендация является плановым ориентиром. Фактическую влажность почвы и продукции подтвердите на поле.",
    }
