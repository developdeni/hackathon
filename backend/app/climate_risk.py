"""
Задача 2.2 — Индекс риска засухи, суховея и раннего снега по декадам.

Считает по метеоданным Open-Meteo (без ключей) декадный (10-дневный) индекс риска
для поля: засуха, суховей, ранний снег/заморозок. Возвращает индекс по декадам,
ключевые факторы и уведомления для хозяйства. Акмолинская область — зона
рискованного земледелия, поэтому пороги настроены под степную богару.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

import httpx

# Русские названия месяцев для подписи декад
_MONTHS_RU = [
    "", "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def _decade_of_month(day: int) -> int:
    """Номер декады в месяце: 1 (1–10), 2 (11–20), 3 (21–конец)."""
    if day <= 10:
        return 1
    if day <= 20:
        return 2
    return 3


def _decade_key(d: date) -> tuple[int, int, int]:
    return (d.year, d.month, _decade_of_month(d.day))


def _decade_label(year: int, month: int, dec: int) -> str:
    names = {1: "1-я декада", 2: "2-я декада", 3: "3-я декада"}
    return f"{names[dec]} {_MONTHS_RU[month]}"


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _level(score: float) -> str:
    if score >= 60:
        return "high"
    if score >= 30:
        return "moderate"
    return "low"


def _mean(values: list[float]) -> float:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else 0.0


def _score_drought(precip_sum: float, et0_sum: float, mean_tmax: float, dry_days: int, n_days: int) -> tuple[float, list[str]]:
    """Индекс засухи по декаде + факторы."""
    score = 0.0
    factors: list[str] = []

    # Нормируем на 10 дней, если декада неполная
    scale = 10.0 / max(n_days, 1)
    precip_norm = precip_sum * scale

    if precip_norm < 5:
        score += 40
        factors.append(f"осадков всего {precip_sum:.0f} мм")
    elif precip_norm < 10:
        score += 25
        factors.append(f"мало осадков ({precip_sum:.0f} мм)")
    elif precip_norm < 15:
        score += 10

    water_balance = precip_sum - et0_sum
    if water_balance < -30:
        score += 30
        factors.append(f"дефицит влаги {water_balance:.0f} мм (осадки − испаряемость)")
    elif water_balance < -15:
        score += 15
        factors.append(f"отрицательный водный баланс {water_balance:.0f} мм")

    if mean_tmax > 30:
        score += 20
        factors.append(f"жара до {mean_tmax:.0f}°C днём")
    elif mean_tmax > 27:
        score += 10

    if dry_days >= 8:
        score += 15
        factors.append(f"{dry_days} дней без дождя")
    elif dry_days >= 6:
        score += 8

    return _clamp(score), factors


def _score_sukhovey(hard_days: int, soft_days: int) -> tuple[float, list[str]]:
    """Индекс суховея (жаркий сухой ветер) по декаде + факторы."""
    score = min(hard_days * 30.0, 90.0) + soft_days * 8.0
    factors: list[str] = []
    if hard_days > 0:
        factors.append(f"{hard_days} дн. суховея (жара ≥28°C, влажность ≤30%, ветер ≥7 м/с)")
    elif soft_days > 0:
        factors.append(f"{soft_days} дн. с признаками суховея")
    return _clamp(score), factors


def _score_early_snow(min_tmin: float, snowfall_sum: float, month: int) -> tuple[float, list[str]]:
    """Индекс раннего снега/заморозка по декаде + факторы."""
    score = 0.0
    factors: list[str] = []

    if snowfall_sum > 0:
        score += 55
        factors.append(f"прогнозируется снег ({snowfall_sum:.0f} см)")

    if min_tmin <= -2:
        score += 40
        factors.append(f"мороз до {min_tmin:.0f}°C")
    elif min_tmin <= 0:
        score += 25
        factors.append(f"заморозок до {min_tmin:.0f}°C")
    elif min_tmin <= 2:
        score += 10
        factors.append(f"близко к заморозку ({min_tmin:.0f}°C)")

    # Ранний снег особенно опасен в конце лета — начале осени (до уборки)
    if month in (8, 9, 10) and (snowfall_sum > 0 or min_tmin <= 0):
        score += 10
        factors.append("аномально рано для сезона — угроза неубранному урожаю")

    return _clamp(score), factors


async def _fetch_open_meteo(latitude: float, longitude: float) -> dict[str, Any] | None:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "daily": ",".join([
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "snowfall_sum",
            "wind_speed_10m_max",
            "relative_humidity_2m_mean",
            "et0_fao_evapotranspiration",
        ]),
        "timezone": "Asia/Almaty",
        "past_days": 10,
        "forecast_days": 16,
        "wind_speed_unit": "ms",
    }
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        return None
    return None


async def get_field_climate_risk(latitude: float, longitude: float) -> dict[str, Any]:
    """
    Возвращает декадный индекс риска (засуха/суховей/ранний снег) для поля.
    """
    data = await _fetch_open_meteo(latitude, longitude)
    if not data:
        return {
            "available": False,
            "source": "Open-Meteo (нет связи)",
            "decades": [],
            "alerts": [],
            "summary": "Не удалось получить метеоданные. Проверьте подключение и повторите.",
        }

    daily = data.get("daily", {})
    times: list[str] = daily.get("time", []) or []
    tmax = daily.get("temperature_2m_max", []) or []
    tmin = daily.get("temperature_2m_min", []) or []
    precip = daily.get("precipitation_sum", []) or []
    snow = daily.get("snowfall_sum", []) or []
    wind = daily.get("wind_speed_10m_max", []) or []
    rh = daily.get("relative_humidity_2m_mean", []) or []
    et0 = daily.get("et0_fao_evapotranspiration", []) or []

    today = datetime.now().date()

    # Группируем дни по декадам
    buckets: dict[tuple[int, int, int], dict[str, Any]] = {}
    order: list[tuple[int, int, int]] = []
    for i, t in enumerate(times):
        try:
            d = date.fromisoformat(t)
        except Exception:
            continue
        key = _decade_key(d)
        if key not in buckets:
            buckets[key] = {"days": [], "dates": []}
            order.append(key)
        buckets[key]["days"].append(i)
        buckets[key]["dates"].append(d)

    decades_out: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []

    for key in order:
        year, month, dec = key
        idxs = buckets[key]["days"]
        dates = buckets[key]["dates"]
        # Missing provider values cannot be treated as dry days or mild weather.
        idxs = [i for i in idxs if all(i < len(values) and isinstance(values[i], (int, float)) for values in (tmax, tmin, precip, snow, wind, rh, et0))]
        n = len(idxs)
        if n == 0 or n != len(dates):
            continue

        precip_vals = [float(precip[i]) for i in idxs]
        snow_vals = [float(snow[i]) for i in idxs]
        et0_vals = [float(et0[i]) for i in idxs]
        tmax_vals = [float(tmax[i]) for i in idxs]
        tmin_vals = [float(tmin[i]) for i in idxs]
        wind_vals = [float(wind[i]) for i in idxs]
        rh_vals = [float(rh[i]) for i in idxs]
        precip_sum = sum(precip_vals)
        snow_sum = sum(snow_vals)
        et0_sum = sum(et0_vals)
        mean_tmax = _mean(tmax_vals)
        min_tmin = min(tmin_vals)
        dry_days = sum(1 for value in precip_vals if value < 1.0)

        hard_days = sum(
            1 for j in range(n)
            if tmax_vals[j] >= 28 and rh_vals[j] <= 30 and wind_vals[j] >= 7
        )
        soft_days = sum(
            1 for j in range(n)
            if tmax_vals[j] >= 25 and rh_vals[j] <= 35 and wind_vals[j] >= 5
        ) - hard_days
        soft_days = max(soft_days, 0)

        drought, f_dr = _score_drought(precip_sum, et0_sum, mean_tmax, dry_days, n)
        sukhovey, f_su = _score_sukhovey(hard_days, soft_days)
        early_snow, f_sn = _score_early_snow(min_tmin, snow_sum, month)

        overall = max(drought, sukhovey, early_snow)
        # если два риска умеренные — общий чуть выше
        second = sorted([drought, sukhovey, early_snow], reverse=True)[1]
        if second >= 30:
            overall = _clamp(overall + second * 0.15)

        is_past = dates[-1] < today
        label = _decade_label(year, month, dec)
        period = f"{dates[0].day}–{dates[-1].day} {_MONTHS_RU[month]}"

        # факторы: соберём топ по риску
        risks = [
            ("Засуха", drought, f_dr),
            ("Суховей", sukhovey, f_su),
            ("Ранний снег / заморозок", early_snow, f_sn),
        ]
        factors: list[str] = []
        for _name, sc, fs in sorted(risks, key=lambda r: r[1], reverse=True):
            if sc >= 30:
                factors.extend(fs)
        if not factors:
            factors.append("метеоусловия в пределах нормы")

        decade = {
            "label": label,
            "period": period,
            "is_past": is_past,
            "days_count": n,
            "overall_index": round(overall),
            "overall_level": _level(overall),
            "drought_index": round(drought),
            "sukhovey_index": round(sukhovey),
            "early_snow_index": round(early_snow),
            "mean_tmax": round(mean_tmax, 1),
            "min_tmin": round(min_tmin, 1),
            "precip_sum": round(precip_sum, 1),
            "factors": factors[:4],
        }
        decades_out.append(decade)

        # Уведомления только для будущих/текущих декад с высоким риском
        if not is_past and overall >= 55:
            dominant = max(risks, key=lambda r: r[1])
            alerts.append({
                "type": (
                    "drought" if dominant[0] == "Засуха"
                    else "sukhovey" if dominant[0] == "Суховей"
                    else "early_snow"
                ),
                "level": "critical" if overall >= 72 else "warning",
                "title": f"{dominant[0]}: {label}",
                "description": f"{period}: индекс риска {round(overall)}/100. " + "; ".join(dominant[2][:2] or ["повышенный риск"]) + ".",
            })

    # Итог сезона по будущим декадам
    future = [d for d in decades_out if not d["is_past"]]
    if future:
        worst = max(future, key=lambda d: d["overall_index"])
        if worst["overall_index"] >= 60:
            summary = f"Повышенный риск в период «{worst['label']}» (индекс {worst['overall_index']}/100). Планируйте агромероприятия с запасом."
        elif worst["overall_index"] >= 30:
            summary = f"Умеренные риски в ближайшие декады (макс. индекс {worst['overall_index']}/100). Держите поле под наблюдением."
        else:
            summary = "Ближайшие декады — без выраженных агроклиматических рисков."
    else:
        summary = "Недостаточно данных прогноза для оценки будущих декад."

    return {
        "available": True,
        "source": "Open-Meteo · модельные метеоданные; индекс 0–100 по пороговым правилам, не вероятность",
        "generated_at": datetime.now().isoformat(timespec="minutes"),
        "decades": decades_out,
        "alerts": alerts,
        "summary": summary,
    }
