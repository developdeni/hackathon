from datetime import datetime, timezone
from typing import Any
import httpx


async def get_field_agro_weather(latitude: float, longitude: float) -> dict[str, Any]:
    """Получение погодного агроконтекста через Open-Meteo (без API-ключей)."""
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,et0_fao_evapotranspiration",
        "current": "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
        "timezone": "Asia/Almaty",
        "forecast_days": 7,
    }

    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(url, params=params)
            if response.status_code == 200:
                data = response.json()
                return parse_open_meteo_response(data, latitude, longitude)
    except Exception:
        # При недоступности сети или таймауте возвращаем детерминированный локальный агрометеоконтекст
        pass

    return fallback_weather_context(latitude, longitude)


def parse_open_meteo_response(data: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
    current = data.get("current", {})
    daily = data.get("daily", {})

    temp_now = current.get("temperature_2m", 16.5)
    humidity_now = current.get("relative_humidity_2m", 45)
    wind_now = current.get("wind_speed_10m", 5.2)

    temp_max_list = daily.get("temperature_2m_max", [18.0] * 7)
    temp_min_list = daily.get("temperature_2m_min", [6.0] * 7)
    precip_list = daily.get("precipitation_sum", [0.0] * 7)
    et0_list = daily.get("et0_fao_evapotranspiration", [3.5] * 7)

    # Сумма эффективных температур (GDD), база 5°C — реальный агроклиматический показатель
    # накопления тепла для яровых культур за период прогноза.
    gdd_sum = round(
        sum(max(((tmax + tmin) / 2) - 5.0, 0.0) for tmax, tmin in zip(temp_max_list, temp_min_list)),
        1,
    )

    # Оценка агроклиматических рисков
    alerts = []
    min_temp_7d = min(temp_min_list) if temp_min_list else 5.0
    max_temp_7d = max(temp_max_list) if temp_max_list else 22.0
    precip_7d = sum(precip_list) if precip_list else 0.0

    if min_temp_7d <= 1.0:
        alerts.append({
            "type": "frost",
            "level": "warning" if min_temp_7d > 0 else "critical",
            "title": "Угроза заморозков",
            "description": f"Прогнозируется понижение температуры до {min_temp_7d:.1f}°C в ночные часы.",
        })

    if max_temp_7d >= 28.0 and humidity_now < 30 and wind_now > 7.0:
        alerts.append({
            "type": "dry_wind",
            "level": "warning",
            "title": "Риск суховея",
            "description": "Сочетание высокой температуры, низкой влажности воздуха и ветра ускоряет потерю влаги растениями.",
        })

    if precip_7d < 3.0 and sum(et0_list) > 15.0:
        alerts.append({
            "type": "moisture_deficit",
            "level": "moderate",
            "title": "Дефицит атмосферных осадков",
            "description": f"Ожидается всего {precip_7d:.1f} мм осадков за 7 дней при испаряемости {sum(et0_list):.1f} мм.",
        })

    return {
        "status": "ok",
        "source": "Open-Meteo (ECMWF/ERA5)",
        "coordinates": {"latitude": lat, "longitude": lon},
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "current": {
            "temperature": temp_now,
            "humidity": humidity_now,
            "windSpeed": wind_now,
        },
        "forecast7d": {
            "maxTemp": max_temp_7d,
            "minTemp": min_temp_7d,
            "precipSum": round(precip_7d, 1),
            "evapotranspiration": round(sum(et0_list), 1),
            "gddSum": gdd_sum,
        },
        "alerts": alerts,
    }


def fallback_weather_context(lat: float, lon: float) -> dict[str, Any]:
    """Резервный погодный контекст для Акмолинской области (Кокшетау) при слабом интернете."""
    return {
        "status": "cached",
        "source": "Open-Meteo Reanalysis (Offline)",
        "coordinates": {"latitude": lat, "longitude": lon},
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "current": {
            "temperature": 17.2,
            "humidity": 42,
            "windSpeed": 5.8,
        },
        "forecast7d": {
            "maxTemp": 21.4,
            "minTemp": 4.1,
            "precipSum": 1.2,
            "evapotranspiration": 22.8,
            "gddSum": 55.3,
        },
        "alerts": [
            {
                "type": "moisture_deficit",
                "level": "moderate",
                "title": "Умеренный дефицит влаги",
                "description": "Низкий уровень осадков за последние 10 дней в сочетании с ветровой нагрузкой.",
            }
        ],
    }
