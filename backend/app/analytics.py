from datetime import datetime, timezone
from typing import Any
import math

from .auth import compute_area_ha

ZONES_PENDING_MESSAGE = (
    "Ожидание данных Sentinel-2: подключите Copernicus credentials в backend/.env, "
    "либо снимок по этому контуру ещё не обработан. Очаги строятся только по реальным "
    "под-участковым данным, без выдуманных значений."
)

# Порог дефицита NDVI ячейки относительно среднего по полю, начиная с которого
# под-участок считается проблемным очагом.
_DEFICIT_MODERATE = 0.06
_DEFICIT_CRITICAL = 0.14


def classify_land_use(observations: list[dict[str, Any]]) -> dict[str, Any]:
    """Классификация поля по сезонной амплитуде NDVI: активный оборот или залежь."""
    seasonal = []
    for obs in observations:
        try:
            date = datetime.fromisoformat(obs["date"])
        except (KeyError, ValueError, TypeError):
            continue
        value = obs.get("ndviMean")
        if 4 <= date.month <= 9 and obs.get("reliability") == "high" and isinstance(value, (int, float)) and math.isfinite(value):
            seasonal.append((date, float(value)))
    year = max((date.year for date, _ in seasonal), default=0)
    seasonal = [(date, value) for date, value in seasonal if date.year == year]
    months = {date.month for date, _ in seasonal}
    valid = [value for _, value in seasonal]
    enough = len(valid) >= 6 and any(m in months for m in (4, 5)) and {6, 7, 8}.issubset(months)
    if not enough:
        return {
            "status": "unknown",
            "label": "Недостаточно снимков",
            "description": "Нужны минимум 6 качественных периодов одного сезона: весна и июнь–август. Двух снимков недостаточно для вывода об использовании земли.",
            "maxNdvi": None,
            "minNdvi": None,
            "amplitude": None,
            "rule": "max_ndvi - min_ndvi > 0.35 → в обороте; max_ndvi < 0.25 → залежь",
        }

    max_ndvi = max(valid)
    min_ndvi = min(valid)
    amplitude = max_ndvi - min_ndvi
    if amplitude > 0.35:
        status = "active"
        label = "Вероятно в обороте"
        description = "Сезонная динамика соответствует циклу роста. Это оценка по NDVI, а не подтверждение обработки земли."
    elif max_ndvi < 0.25:
        status = "fallow"
        label = "Возможное неиспользование"
        description = "Низкий NDVI в течение сезона. Возможны пар, засуха или отсутствие культуры; статус залежи подтверждается осмотром."
    else:
        status = "uncertain"
        label = "Требует проверки"
        description = "NDVI не даёт уверенного решения: нужен осмотр или больше снимков без облачности."

    return {
        "status": status,
        "label": label,
        "description": description,
        "maxNdvi": round(max_ndvi, 2),
        "minNdvi": round(min_ndvi, 2),
        "amplitude": round(amplitude, 2),
        "rule": "max_ndvi - min_ndvi > 0.35 → в обороте; max_ndvi < 0.25 → залежь",
    }


def _ndvi_color(ndvi: float) -> str:
    """Стандартная NDVI-палитра: красный (нет вегетации) → жёлтый → зелёный (густая биомасса)."""
    if ndvi < 0.15:
        return "rgba(189, 0, 38, 0.60)"
    if ndvi < 0.30:
        return "rgba(240, 59, 32, 0.55)"
    if ndvi < 0.45:
        return "rgba(253, 141, 60, 0.55)"
    if ndvi < 0.55:
        return "rgba(254, 217, 118, 0.60)"
    if ndvi < 0.70:
        return "rgba(120, 198, 121, 0.60)"
    return "rgba(35, 132, 67, 0.65)"


def _build_ndvi_grid(grid: dict[str, Any]) -> list[dict[str, Any]]:
    """Полная NDVI-сетка поля для тепловой карты: каждая ячейка со своим реальным NDVI и цветом."""
    cells = []
    for cell in grid.get("cells", []):
        ndvi = cell.get("ndvi")
        if not isinstance(ndvi, (int, float)):
            continue
        cells.append({
            "id": f"cell-{cell['row']}-{cell['col']}",
            "ndvi": round(ndvi, 2),
            "ndmi": round(cell["ndmi"], 2) if isinstance(cell.get("ndmi"), (int, float)) else None,
            "boundary": cell["boundary"],
            "centroid": cell["centroid"],
            "color": _ndvi_color(ndvi),
        })
    return cells


def _pending(field_id: str, field_name: str, area_ha: float) -> dict[str, Any]:
    return {
        "fieldId": field_id,
        "fieldName": field_name,
        "totalFieldAreaHa": area_ha,
        "status": "pending",
        "message": ZONES_PENDING_MESSAGE,
        "analysisDate": datetime.now(timezone.utc).isoformat(),
        "satelliteMission": "Sentinel-2 MSI Level-2A (10 м)",
        "dataSource": None,
        "meanFieldNdvi": None,
        "meanFieldNdmi": None,
        "zonesCount": 0,
        "totalSuspectAreaHa": 0.0,
        "zones": [],
        "benchmark": None,
        "ndviGrid": [],
        "ndviRange": None,
        "peakDate": None,
        "peakNdvi": None,
        "latestDate": None,
        "latestNdvi": None,
        "growthPhase": None,
        "isPostHarvest": False,
        "postHarvestNotice": None,
        "periodMode": "latest",
        "availablePeriods": [],
    }


def build_risk_zones(
    field_id: str,
    field_name: str,
    area_ha: float,
    grid: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Строит очаги риска из РЕАЛЬНОЙ под-участковой сетки NDVI/NDMI Sentinel-2.
    Ячейки, чей NDVI заметно ниже среднего по полю, становятся очагами с настоящей
    геометрией и реальными дефицитами. Если сетки нет — честный статус ожидания.
    """
    if not grid or not grid.get("cells"):
        return _pending(field_id, field_name, area_ha)

    cells = grid["cells"]
    mean_ndvi = grid["meanNdvi"]
    mean_ndmi = grid.get("meanNdmi")
    cells_in_field = grid.get("cellsInField") or len(cells)
    # Оценка площади одной ячейки: поле поделено на равные ячейки сетки внутри контура.
    cell_area_ha = round(area_ha / cells_in_field, 2) if cells_in_field else 0.0

    flagged: list[dict[str, Any]] = []
    for cell in cells:
        deficit = round(mean_ndvi - cell["ndvi"], 3)
        if deficit < _DEFICIT_MODERATE:
            continue
        flagged.append({**cell, "ndviDeficit": deficit})

    flagged.sort(key=lambda c: c["ndviDeficit"], reverse=True)

    zones: list[dict[str, Any]] = []
    for idx, cell in enumerate(flagged):
        deficit = cell["ndviDeficit"]
        critical = deficit >= _DEFICIT_CRITICAL
        ndmi_deficit = (
            round(mean_ndmi - cell["ndmi"], 3)
            if mean_ndmi is not None and isinstance(cell.get("ndmi"), (int, float))
            else None
        )
        cell_area = round(compute_area_ha(cell["boundary"]), 1) or cell_area_ha

        # Основной фактор — по тому, что просело сильнее: влага (NDMI) или биомасса (NDVI).
        if ndmi_deficit is not None and ndmi_deficit >= 0.05 and ndmi_deficit >= deficit * 0.6:
            main_factor = "Дефицит влаги: NDMI ниже среднего по полю, вероятное пересыхание."
            recommendation = "Выезд для замера продуктивной влаги 0–30 см в этой части поля."
        else:
            main_factor = "Пониженная биомасса: NDVI ниже среднего, отставание в развитии."
            recommendation = "Осмотр на изреженность, вредителей и засорённость сорняками."

        zones.append({
            "id": f"{field_id}-z{idx + 1}",
            "priority": idx + 1,
            "severity": "critical" if critical else "moderate",
            "title": f"Очаг №{idx + 1}",
            "areaHa": cell_area,
            "percentOfField": round((cell_area / area_ha) * 100, 1) if area_ha else 0.0,
            "persistenceDays": 0,
            "persistenceStatus": "По одному периоду; устойчивость аномалии не подтверждена.",
            "ndviMean": round(cell["ndvi"], 2),
            "ndviDeficit": -abs(deficit),
            "ndmiDeficit": -abs(ndmi_deficit) if ndmi_deficit is not None else None,
            "mainFactor": main_factor,
            "recommendation": recommendation,
            "centroid": cell["centroid"],
            "boundary": cell["boundary"],
            "fillColor": "rgba(211, 47, 47, 0.34)" if critical else "rgba(217, 119, 6, 0.30)",
            "strokeColor": "#C62828" if critical else "#D97706",
        })

    ndvi_grid = _build_ndvi_grid(grid)
    all_ndvi = [c["ndvi"] for c in ndvi_grid]
    ndvi_range = {"min": min(all_ndvi), "max": max(all_ndvi)} if all_ndvi else None

    total_suspect_ha = round(sum(z["areaHa"] for z in zones), 1)
    saved_ha = round(max(area_ha - total_suspect_ha, 0.0), 1)

    benchmark = {
        "economicScouting": {
            "fieldAreaHa": area_ha,
            "targetInspectionHa": total_suspect_ha,
            "savedInspectionHa": saved_ha,
            "reductionPercent": round((saved_ha / area_ha) * 100, 1) if area_ha else 0.0,
            "estimatedSeasonSavingsKzt": None,
        },
    } if zones else None

    post_harvest_notice = None
    if grid.get("isPostHarvest"):
        if grid.get("periodMode") == "latest" or grid.get("observationDate") == grid.get("latestDate"):
            post_harvest_notice = (
                f"Снимок {grid.get('observationDate')} отражает послеуборочное состояние поля (стерня/почва, NDVI {mean_ndvi:.2f}). "
                f"Очаги дефицита биомассы в этот период не актуальны. Для анализа стресса культуры переключитесь на пик вегетации ({grid.get('peakDate')}, NDVI {grid.get('peakNdvi', 0.0):.2f})."
            )

    return {
        "fieldId": field_id,
        "fieldName": field_name,
        "totalFieldAreaHa": area_ha,
        "status": "ready",
        "qualityVersion": 2,
        "stale": grid.get("stale", False),
        "observationDate": grid.get("observationDate"),
        "periodEnd": grid.get("periodEnd"),
        "coveragePercent": grid.get("coveragePercent"),
        "message": None,
        "analysisDate": grid.get("updatedAt"),
        "satelliteMission": "Sentinel-2 MSI Level-2A (10 м)",
        "dataSource": f"Copernicus Sentinel-2 · сетка {grid.get('gridSize')}",
        "meanFieldNdvi": mean_ndvi,
        "meanFieldNdmi": mean_ndmi,
        "zonesCount": len(zones),
        "totalSuspectAreaHa": total_suspect_ha,
        "zones": zones,
        "benchmark": benchmark,
        "ndviGrid": ndvi_grid,
        "ndviRange": ndvi_range,
        "peakDate": grid.get("peakDate"),
        "peakNdvi": grid.get("peakNdvi"),
        "latestDate": grid.get("latestDate"),
        "latestNdvi": grid.get("latestNdvi"),
        "growthPhase": grid.get("growthPhase"),
        "isPostHarvest": grid.get("isPostHarvest", False),
        "postHarvestNotice": post_harvest_notice,
        "periodMode": grid.get("periodMode", "latest"),
        "availablePeriods": grid.get("availablePeriods", []),
    }
