import copy
import io
import csv
import unittest
from datetime import date, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from shapely.geometry import Polygon
from shapely.ops import unary_union

from backend.app import ai_advisor, climate_risk, copernicus, field_operations, main, weather, yield_forecast
from backend.app.analytics import build_risk_zones, classify_land_use


def interval(mean=0.5, clear=0.8, cloudy=0.1):
    return {
        "interval": {"from": "2026-07-01T00:00:00Z", "to": "2026-07-11T00:00:00Z"},
        "outputs": {
            "ndvi": {"bands": {"B0": {"stats": {"mean": mean, "sampleCount": 1000, "noDataCount": 920, "percentiles": {"50.0": 0.48}}}}},
            "quality": {"bands": {"clear": {"stats": {"mean": clear}}, "cloud": {"stats": {"mean": cloudy}}}},
        },
    }


class QualityTests(unittest.TestCase):
    def test_satellite_maturity_requires_peak_and_decline(self):
        mature = field_operations.satellite_field_state([
            {"date": "2026-05-01", "ndviMean": 0.35, "reliability": "high"},
            {"date": "2026-07-01", "ndviMean": 0.72, "reliability": "high"},
            {"date": "2026-09-01", "ndviMean": 0.40, "reliability": "high"},
        ])
        self.assertEqual(mature["status"], "maturing")
        flat = field_operations.satellite_field_state([
            {"date": "2026-05-01", "ndviMean": 0.30, "reliability": "high"},
            {"date": "2026-07-01", "ndviMean": 0.45, "reliability": "high"},
            {"date": "2026-09-01", "ndviMean": 0.43, "reliability": "high"},
        ])
        self.assertEqual(flat["status"], "vegetating")

    def test_operations_weather_keeps_long_range_days_without_soil_values(self):
        raw = {
            "daily": {
                "time": ["2026-09-20", "2026-09-21"],
                "temperature_2m_max": [20, 21],
                "temperature_2m_min": [7, 8],
                "precipitation_sum": [0, 0],
                "precipitation_probability_max": [10, 10],
                "wind_speed_10m_max": [3, 3],
                "relative_humidity_2m_mean": [60, 62],
            },
            "hourly": {"time": [], "soil_temperature_6cm": [], "soil_moisture_1_to_3cm": [], "soil_moisture_3_to_9cm": []},
        }
        parsed = field_operations.parse_operations_weather(raw)
        self.assertEqual(len(parsed), 2)
        self.assertIsNone(parsed[0]["soilTemperature"])

    def test_yield_model_returns_bounded_interval_and_explainable_factors(self):
        rows = []
        for index, actual_yield in enumerate((1.8, 2.1, 2.5, 2.8, 3.0)):
            rows.append({
                "ndviPeak": 0.55 + index * 0.04,
                "ndmiMean": 0.05 + index * 0.025,
                "precipMm": 130 + index * 18,
                "gdd": 1050 + index * 35,
                "waterBalanceMm": -250 + index * 22,
                "yieldTPerHa": actual_yield,
            })
        current = {
            "ndviPeak": 0.69,
            "ndmiMean": 0.13,
            "precipMm": 185,
            "gdd": 1160,
            "waterBalanceMm": -180,
        }
        result = yield_forecast.fit_yield_model(rows, current)
        self.assertLess(result["low"], result["forecast"])
        self.assertGreater(result["high"], result["forecast"])
        self.assertEqual(len(result["factors"]), 5)
        self.assertTrue(all("contributionTPerHa" in factor for factor in result["factors"]))

    def test_quality_does_not_count_pixels_outside_field_as_clouds(self):
        result = copernicus.parse_statistical_response({"data": [interval()]})
        observation = result["observations"][0]
        self.assertEqual(observation["cloudCoveragePercent"], 10)
        self.assertEqual(observation["cloudStatus"], "10.0% · Рассеянная облачность")
        self.assertEqual(result["cloudFilter"], "leastCC (выборка наименее облачного снимка за 10 дней из каталога Sentinel-2)")
        self.assertEqual(observation["clearPixelPercent"], 80)
        self.assertEqual(observation["validPixelCount"], 80)
        self.assertEqual(observation["periodEnd"], "2026-07-11")
        self.assertIsNone(observation["ndmiMean"])

    def test_invalid_or_heavily_masked_periods_are_not_reported(self):
        for value in (float("nan"), "NaN", None, 2):
            self.assertIsNone(copernicus.parse_statistical_response({"data": [interval(mean=value)]}))
        self.assertIsNone(copernicus.parse_statistical_response({"data": [interval(clear=0.1)]}))

    def test_missing_quality_does_not_become_zero_clouds_or_high_confidence(self):
        item = interval()
        del item["outputs"]["quality"]
        del item["outputs"]["ndvi"]["bands"]["B0"]["stats"]["percentiles"]
        obs = copernicus.parse_statistical_response({"data": [item]})["observations"][0]
        self.assertIsNone(obs["cloudCoveragePercent"])
        self.assertIsNone(obs["ndviMedian"])
        self.assertEqual(obs["reliability"], "unknown")

    def test_no_weather_response_contains_no_invented_measurements(self):
        result = weather.fallback_weather_context(53, 69)
        self.assertIsNone(result["current"]["temperature"])
        self.assertIsNone(result["forecast7d"]["precipSum"])
        self.assertIsNone(result["updatedAt"])
        self.assertFalse(result["alerts"])
        parsed = weather.parse_open_meteo_response({"daily": {"time": ["2026-09-20"], "precipitation_sum": [None]}}, 53, 69)
        self.assertIsNone(parsed["forecast7d"]["precipSum"])

    def test_winter_values_cannot_prove_cultivation(self):
        result = classify_land_use([{"date": d, "ndviMean": v, "reliability": "high"} for d, v in [("2026-02-01", -0.2), ("2026-07-01", 0.7)]])
        self.assertEqual(result["status"], "unknown")

    def test_grid_is_clipped_to_concave_field(self):
        coords = [(69, 53), (69.02, 53), (69.02, 53.01), (69.01, 53.01), (69.01, 53.02), (69, 53.02)]
        boundary = [{"latitude": y, "longitude": x} for x, y in coords]
        field = Polygon(coords)
        cells = copernicus._build_grid_cells(boundary, 3, 3)
        pieces = [Polygon([(p["longitude"], p["latitude"]) for p in c["boundary"]]) for c in cells]
        self.assertTrue(all(field.covers(piece) for piece in pieces))
        self.assertAlmostEqual(unary_union(pieces).area, field.area, places=10)

    def test_stand_density_requires_user_calibrated_area(self):
        parsed = {
            "detected": True,
            "is_field": True,
            "plant_count": 250,
            "crop": "Яровая пшеница",
            "uniformity": "moderate",
        }
        unscaled = ai_advisor._normalize_stand_result(parsed)
        self.assertIsNone(unscaled["frame_area_m2"])
        self.assertIsNone(unscaled["density_per_m2"])
        self.assertEqual(unscaled["stand_rating"], "none")

        calibrated = ai_advisor._normalize_stand_result(parsed, calibrated_area_m2=2.0)
        self.assertEqual(calibrated["density_per_m2"], 125.0)
        self.assertEqual(calibrated["density_per_ha"], 1_250_000)
        self.assertEqual(calibrated["measurement_basis"], "user_calibrated_area")

    def test_missing_grain_metrics_stay_missing(self):
        result = ai_advisor._normalize_grain_result({"detected": True, "is_grain": True})
        self.assertIsNone(result["sound_percent"])
        self.assertIsNone(result["weed_impurity_percent"])
        self.assertFalse(result["laboratory_grade_available"])
        self.assertEqual(result["grade"], "Требуется лабораторный анализ")

    def test_model_confidence_is_not_reported_as_calibrated_probability(self):
        result = ai_advisor._normalize_livestock_result({
            "detected": True,
            "is_livestock": True,
            "confidence": 0.99,
            "animals": [{"name": "Корова", "name_en": "cattle"}],
        })
        self.assertIsNone(result["confidence"])
        self.assertEqual(result["total_count"], 1)
        self.assertEqual(result["count_method"], "enumerated")

    def test_missing_ndmi_is_not_reported_as_zero_deficit(self):
        grid = {
            "meanNdvi": 0.5,
            "meanNdmi": None,
            "gridSize": "1x2",
            "cellsInField": 2,
            "cells": [{
                "row": 0,
                "col": 0,
                "ndvi": 0.3,
                "ndmi": None,
                "centroid": {"latitude": 53.005, "longitude": 69.005},
                "boundary": [
                    {"latitude": 53.0, "longitude": 69.0},
                    {"latitude": 53.0, "longitude": 69.01},
                    {"latitude": 53.01, "longitude": 69.01},
                    {"latitude": 53.01, "longitude": 69.0},
                ],
            }],
        }
        result = build_risk_zones("field", "Field", 100, grid)
        self.assertEqual(len(result["zones"]), 1)
        self.assertIsNone(result["zones"][0]["ndmiDeficit"])
        self.assertIn("NDVI", result["zones"][0]["mainFactor"])


class ExportTests(unittest.IsolatedAsyncioTestCase):
    async def test_complete_field_history_produces_yield_forecast(self):
        today = date.today()
        history = [
            {
                "seasonYear": today.year - offset,
                "cropType": "Пшеница",
                "yieldTPerHa": 2.0 + offset * 0.12,
                "source": "farm_record",
            }
            for offset in range(1, 5)
        ]
        field = {
            "id": "field-yield-test",
            "cropType": "Пшеница",
            "boundary": [
                {"latitude": 53.30, "longitude": 69.38},
                {"latitude": 53.31, "longitude": 69.38},
                {"latitude": 53.31, "longitude": 69.40},
            ],
        }
        satellite = {
            "observations": [
                {"ndviMedian": 0.55, "ndmiMean": 0.10, "reliability": "high"},
                {"ndviMedian": 0.71, "ndmiMean": 0.16, "reliability": "high"},
            ]
        }
        nasa = {}
        era5 = {}
        for year in [item["seasonYear"] for item in history] + [today.year]:
            day = date(year, 4, 1)
            end = date(year, min(max(today.month, 4), 9), min(today.day, 28))
            if today.month > 9:
                end = date(year, 9, 30)
            while day <= end:
                nasa[day.isoformat()] = {"T2M_MAX": 24.0, "T2M_MIN": 10.0, "PRECTOTCORR": 1.2}
                era5[day.isoformat()] = {"precipitation_sum": 1.1, "et0_fao_evapotranspiration": 2.4}
                day += timedelta(days=1)
        with patch.object(yield_forecast, "_forecast_cache", {}), patch.object(
            yield_forecast, "fetch_field_satellite_period", AsyncMock(return_value=satellite)
        ), patch.object(
            yield_forecast, "_fetch_nasa_daily", AsyncMock(return_value=nasa)
        ), patch.object(
            yield_forecast, "_fetch_era5_daily", AsyncMock(return_value=era5)
        ):
            result = await yield_forecast.get_yield_forecast(field, history)
        self.assertEqual(result["status"], "ready")
        self.assertIsNotNone(result["interval80"])
        self.assertEqual(result["historyCount"], 4)

    async def test_climate_risk_skips_incomplete_provider_days(self):
        daily = {
            "time": ["2026-09-20"],
            "temperature_2m_max": [28.0],
            "temperature_2m_min": [10.0],
            "precipitation_sum": [0.0],
            "snowfall_sum": [0.0],
            "wind_speed_10m_max": [6.0],
            "relative_humidity_2m_mean": [None],
            "et0_fao_evapotranspiration": [3.0],
        }
        with patch.object(climate_risk, "_fetch_open_meteo", AsyncMock(return_value={"daily": daily})):
            result = await climate_risk.get_field_climate_risk(53, 69)
        self.assertEqual(result["decades"], [])
        self.assertIn("Недостаточно данных", result["summary"])

    async def test_csv_does_not_attach_current_weather_to_historical_satellite_dates(self):
        field = {"id": "field-test", "name": "Test"}
        satellite = {"observations": [{"date": "2026-07-01", "ndviMean": 0.4}], "source": "Sentinel-2"}
        meteo = weather.fallback_weather_context(53, 69)
        meteo["current"]["temperature"] = 12
        meteo["observedAt"] = "2026-09-20T12:00"
        with (
            patch.object(main, "_load_accessible_field", return_value=({"id": "field-test"}, True, ["inspect"])),
            patch.object(main, "_load_analysis_bundle", AsyncMock(return_value=(field, satellite, {}, meteo))),
        ):
            response = await main.export_field_csv("field-test", "user-test")
        rows = list(csv.DictReader(io.StringIO(response.body.decode())))
        self.assertEqual(rows[0]["temperature_c"], "")
        self.assertEqual(rows[1]["temperature_c"], "12")
        self.assertEqual(rows[1]["record_type"], "weather_model_snapshot")

    async def test_grid_does_not_mix_observation_dates(self):
        cells = [{"row": 0, "col": i, "areaHa": 10, "boundary": [], "centroid": {}} for i in range(3)]
        series = [
            {"observations": [{"date": date, "periodEnd": date, "ndviMean": ndvi, "reliability": "high"}]}
            for date, ndvi in [("2026-07-01", 0.8), ("2026-09-01", 0.2), ("2026-09-01", 0.3)]
        ]
        boundary = [{"latitude": 53, "longitude": 69}, {"latitude": 54, "longitude": 69}, {"latitude": 54, "longitude": 70}]
        with patch.object(copernicus, "_grid_cache", {}), patch.object(copernicus, "_disk_cache_read", return_value=None), patch.object(copernicus, "_disk_cache_write"), patch.object(copernicus, "get_copernicus_token", AsyncMock(return_value="test")), patch.object(copernicus, "_build_grid_cells", return_value=copy.deepcopy(cells)), patch.object(copernicus, "query_sentinel_hub_statistical", AsyncMock(side_effect=series)):
            result = await copernicus.fetch_field_risk_grid(boundary)
        self.assertEqual(result["observationDate"], "2026-09-01")
        self.assertEqual(result["meanNdvi"], 0.25)
        self.assertEqual(len(result["cells"]), 2)
        self.assertAlmostEqual(result["coveragePercent"], 66.7)

    async def test_grid_does_not_cache_empty_copernicus_responses(self):
        cells = [{"row": 0, "col": i, "areaHa": 10, "boundary": [], "centroid": {}} for i in range(3)]
        boundary = [{"latitude": 53, "longitude": 69}, {"latitude": 54, "longitude": 69}, {"latitude": 54, "longitude": 70}]
        cache_write = MagicMock()
        with patch.object(copernicus, "_grid_cache", {}), patch.object(
            copernicus, "_disk_cache_read", return_value=None
        ), patch.object(copernicus, "_disk_cache_write", cache_write), patch.object(
            copernicus, "get_copernicus_token", AsyncMock(return_value="test")
        ), patch.object(copernicus, "_build_grid_cells", return_value=copy.deepcopy(cells)), patch.object(
            copernicus, "query_sentinel_hub_statistical", AsyncMock(return_value=None)
        ):
            result = await copernicus.fetch_field_risk_grid(boundary)
        self.assertIsNone(result)
        cache_write.assert_not_called()

    def test_gemini_fallback_is_strictly_sequential(self):
        active_requests = 0
        max_active_requests = 0
        requested_urls = []

        class FakeResponse:
            def __init__(self, status_code, text=None):
                self.status_code = status_code
                self._text = text

            def json(self):
                return {"candidates": [{"content": {"parts": [{"text": self._text}]}}]}

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def post(self, url, json):
                nonlocal active_requests, max_active_requests
                active_requests += 1
                max_active_requests = max(max_active_requests, active_requests)
                requested_urls.append(url)
                active_requests -= 1
                return FakeResponse(503 if len(requested_urls) == 1 else 200, "Готовый ответ")

        with patch.object(ai_advisor.httpx, "Client", FakeClient):
            result = ai_advisor._sequential_gemini_text({}, ["primary", "backup"], total_timeout=5)

        self.assertEqual(result, "Готовый ответ")
        self.assertEqual(requested_urls, ["primary", "backup"])
        self.assertEqual(max_active_requests, 1)

    def test_clean_agronomic_text_strips_asterisks_and_triple_dashes(self):
        raw = "--- \n**Рекомендация:**\n* Внести карбамид\n---\n*Норма:* 15 кг/га"
        cleaned = ai_advisor.clean_agronomic_text(raw)
        self.assertNotIn("---", cleaned)
        self.assertNotIn("*", cleaned)
        self.assertIn("• Внести карбамид", cleaned)
        self.assertIn("Норма: 15 кг/га", cleaned)

    def test_format_hidden_farm_context_includes_coordinates_and_weather(self):
        ctx = {
            "farmName": "Бараев Агро",
            "coordinates": {"latitude": 51.65, "longitude": 71.30},
            "fields": [
                {
                    "name": "Поле №1",
                    "cropType": "Яровая пшеница",
                    "areaHa": 250.0,
                    "coordinates": {"latitude": 51.648, "longitude": 71.295},
                }
            ],
            "weather": {
                "current": {"temperature": 18.5, "humidity": 55, "windSpeed": 3.2},
                "forecast7d": {"maxTemp": 22.0, "minTemp": 5.0, "precipSum": 1.2, "waterBalance": -15.4},
            },
        }
        hidden = ai_advisor.format_hidden_farm_context(ctx)
        self.assertIn("51.6500°N, 71.3000°E", hidden)
        self.assertIn("Поле №1", hidden)
        self.assertIn("температура +18.5°C", hidden)
        self.assertIn("баланс влаги -15.4 мм", hidden)

    async def test_ai_agronomic_chat_enriches_missing_weather_and_coordinates(self):
        input_data = main.AiChatInput(
            question="Хватит ли влаги на посев?",
            farm_context={"farmName": "Тест"},
        )
        fake_weather = {
            "status": "ok",
            "current": {"temperature": 15.0, "humidity": 60, "windSpeed": 2.5},
            "forecast7d": {"maxTemp": 20.0, "minTemp": 4.0, "precipSum": 0.5, "waterBalance": -14.0},
        }
        with patch.object(main, "get_field_agro_weather", AsyncMock(return_value=fake_weather)):
            with patch.object(main, "ask_agronomic_advisor", return_value="Ответ агронома по влаге") as mock_ask:
                res = await main.ai_agronomic_chat(input_data)
                self.assertEqual(res["question"], "Хватит ли влаги на посев?")
                self.assertEqual(res["answer"], "Ответ агронома по влаге")
                # Verify that farm_context was automatically enriched with Akmola coordinates and live weather
                passed_ctx = mock_ask.call_args[0][2]
                self.assertEqual(passed_ctx["coordinates"]["latitude"], 51.65)
                self.assertEqual(passed_ctx["coordinates"]["longitude"], 71.30)
                self.assertEqual(passed_ctx["weather"], fake_weather)

    def test_build_gemini_contents_sanitizes_multiturn_dialogue_and_removes_duplicates(self):
        raw_history = [
            {"role": "model", "text": "Здравствуйте! Я цифровой агроном Tanap AI..."},
            {"role": "user", "text": "Моё хозяйство 500 га яровой пшеницы"},
            {"role": "model", "text": "Принято! 500 га пшеницы в Акмолинской области."},
            {"role": "user", "text": "Сколько у меня гектар?"},  # duplicate already in history
        ]
        current_question = "Сколько у меня гектар?"
        contents = ai_advisor.build_gemini_contents(current_question, raw_history)

        # 1. Dialogue must start with user turn (welcome greeting dropped)
        self.assertEqual(contents[0]["role"], "user")
        self.assertEqual(contents[0]["parts"][0]["text"], "Моё хозяйство 500 га яровой пшеницы")

        # 2. Dialogue must alternate strictly user -> model -> user
        self.assertEqual(contents[1]["role"], "model")
        self.assertEqual(contents[2]["role"], "user")
        self.assertEqual(contents[2]["parts"][0]["text"], "Сколько у меня гектар?")

        # 3. No duplicate consecutive user turns at the end
        self.assertEqual(len(contents), 3)

    def test_parse_statistical_response_sets_cloud_status_labels(self):
        raw_clear = {"data": [interval(mean=0.6, clear=0.98, cloudy=0.0)]}
        obs_clear = copernicus.parse_statistical_response(raw_clear)
        self.assertEqual(obs_clear["observations"][0]["cloudStatus"], "0% · Ясно над полем")

        raw_shadows = {"data": [interval(mean=0.55, clear=0.96, cloudy=0.035)]}
        obs_shadows = copernicus.parse_statistical_response(raw_shadows)
        self.assertEqual(obs_shadows["observations"][0]["cloudStatus"], "3.5% · Тени/дымка")

        raw_partly = {"data": [interval(mean=0.45, clear=0.85, cloudy=0.15)]}
        obs_partly = copernicus.parse_statistical_response(raw_partly)
        self.assertEqual(obs_partly["observations"][0]["cloudStatus"], "15.0% · Рассеянная облачность")

        raw_cloudy = {"data": [interval(mean=0.35, clear=0.70, cloudy=0.25)]}
        obs_cloudy = copernicus.parse_statistical_response(raw_cloudy)
        self.assertEqual(obs_cloudy["observations"][0]["cloudStatus"], "25.0% · Облачно")

    async def test_grid_supports_peak_and_latest_periods(self):
        cells = [{"row": 0, "col": i, "areaHa": 10, "boundary": [], "centroid": {}} for i in range(2)]
        obs_mock = [
            {"date": "2026-07-15", "periodEnd": "2026-07-25", "ndviMean": 0.75, "reliability": "high"},
            {"date": "2026-09-01", "periodEnd": "2026-09-10", "ndviMean": 0.22, "reliability": "high"},
        ]
        series = [{"observations": obs_mock}, {"observations": obs_mock}]
        boundary = [{"latitude": 53, "longitude": 69}, {"latitude": 54, "longitude": 69}, {"latitude": 54, "longitude": 70}]
        with (
            patch.object(copernicus, "_grid_cache", {}),
            patch.object(copernicus, "_disk_cache_read", return_value=None),
            patch.object(copernicus, "_disk_cache_write"),
            patch.object(copernicus, "get_copernicus_token", AsyncMock(return_value="test")),
            patch.object(copernicus, "_build_grid_cells", return_value=copy.deepcopy(cells)),
            patch.object(copernicus, "query_sentinel_hub_statistical", AsyncMock(side_effect=series)),
        ):
            res_latest = await copernicus.fetch_field_risk_grid(boundary, target_date="latest")
            self.assertEqual(res_latest["observationDate"], "2026-09-01")
            self.assertEqual(res_latest["meanNdvi"], 0.22)
            self.assertTrue(res_latest["isPostHarvest"])
            self.assertEqual(res_latest["peakDate"], "2026-07-15")
            self.assertEqual(res_latest["peakNdvi"], 0.75)
            self.assertEqual(res_latest["latestDate"], "2026-09-01")
            self.assertEqual(res_latest["latestNdvi"], 0.22)
            self.assertGreaterEqual(len(res_latest["availablePeriods"]), 2)

        with (
            patch.object(copernicus, "_grid_cache", {}),
            patch.object(copernicus, "_disk_cache_read", return_value=None),
            patch.object(copernicus, "_disk_cache_write"),
            patch.object(copernicus, "get_copernicus_token", AsyncMock(return_value="test")),
            patch.object(copernicus, "_build_grid_cells", return_value=copy.deepcopy(cells)),
            patch.object(copernicus, "query_sentinel_hub_statistical", AsyncMock(side_effect=series)),
        ):
            res_peak = await copernicus.fetch_field_risk_grid(boundary, target_date="peak")
            self.assertEqual(res_peak["observationDate"], "2026-07-15")
            self.assertEqual(res_peak["meanNdvi"], 0.75)
            self.assertEqual(res_peak["periodMode"], "peak")
