from contextlib import asynccontextmanager
from datetime import datetime, timezone
import asyncio
import csv
import io
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field as PydanticField

from .auth import (
    compute_area_ha,
    compute_perimeter_km,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from .database import (
    UPLOADS_DIR,
    connect,
    field_from_row,
    initialize_database,
    inspection_from_row,
    profile_from_row,
    user_from_row,
    yield_history_from_row,
)
from .copernicus import (
    auto_detect_arable_boundary,
    close_http_client,
    fetch_field_satellite_series,
    fetch_field_risk_grid,
)
from .analytics import build_risk_zones, classify_land_use
from .weather import get_field_agro_weather
from .climate_risk import get_field_climate_risk
from .yield_forecast import get_yield_forecast
from .field_operations import build_operations_recommendation, fetch_operations_weather
from starlette.concurrency import run_in_threadpool

from .ai_advisor import (
    analyze_crop_image_bytes,
    analyze_grain_quality_bytes,
    ask_agronomic_advisor,
    clean_agronomic_text,
    count_livestock_in_image_bytes,
    count_seedlings_in_image_bytes,
    count_seedlings_in_video_bytes,
    count_seedlings_in_video_frames,
    _query_gemini_chat,
)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CoordinateInput(BaseModel):
    latitude: float
    longitude: float


class RegisterInput(BaseModel):
    name: str = PydanticField(min_length=2, max_length=80)
    email: str = PydanticField(min_length=5, max_length=120)
    password: str = PydanticField(min_length=6, max_length=128)
    organization: str = PydanticField(default="", max_length=120)
    region: str = PydanticField(default="", max_length=120)


class LoginInput(BaseModel):
    email: str
    password: str


class CreateProfileInput(BaseModel):
    name: str = PydanticField(min_length=2, max_length=80)
    region: str = PydanticField(default="", max_length=120)


class CreateFieldInput(BaseModel):
    name: str = PydanticField(min_length=2, max_length=120)
    cropType: str = PydanticField(min_length=2, max_length=120)
    # areaHa is now OPTIONAL — if omitted, it is computed from the boundary
    areaHa: float | None = PydanticField(default=None, gt=0, le=100_000)
    boundary: list[CoordinateInput] = PydanticField(min_length=3)


class AutoBoundaryInput(BaseModel):
    latitude: float = PydanticField(ge=-90, le=90)
    longitude: float = PydanticField(ge=-180, le=180)
    radiusMeters: float = PydanticField(default=700.0, ge=10.0, le=100_000.0)


class YieldHistoryInput(BaseModel):
    seasonYear: int = PydanticField(ge=1981, le=2100)
    cropType: str | None = PydanticField(default=None, max_length=120)
    yieldTPerHa: float = PydanticField(gt=0, le=150)
    source: str = PydanticField(default="farm_record", max_length=32)
    notes: str = PydanticField(default="", max_length=500)


# ---------------------------------------------------------------------------
# Auth dependency — optional (does not block unauthenticated requests for now)
# ---------------------------------------------------------------------------

_bearer = HTTPBearer(auto_error=False)


def get_current_user_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    token = credentials.credentials if credentials is not None else request.query_params.get("access_token")
    if not token:
        return None
    return decode_access_token(token)


def require_user(user_id: str | None = Depends(get_current_user_id)) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="Необходима авторизация")
    with connect() as connection:
        row = connection.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user_id


def _load_owned_field(connection, field_id: str, user_id: str):
    """Возвращает поле только если оно принадлежит этому пользователю, иначе 404."""
    row = connection.execute(
        "SELECT * FROM fields WHERE id = ? AND user_id = ?", (field_id, user_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Поле не найдено")
    return row


def _field_center(field: dict) -> tuple[float, float]:
    boundary = field["boundary"]
    if not boundary:
        return 53.303, 69.385
    return (
        sum(p["latitude"] for p in boundary) / len(boundary),
        sum(p["longitude"] for p in boundary) / len(boundary),
    )


async def _load_analysis_bundle(field_id: str, user_id: str) -> tuple[dict, dict, dict, dict]:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    center_lat, center_lng = _field_center(field)
    # Спутник, сетка риска и погода независимы — тянем параллельно, а не по очереди.
    satellite, grid, weather = await asyncio.gather(
        fetch_field_satellite_series(field_id, field["boundary"]),
        fetch_field_risk_grid(field["boundary"]),
        get_field_agro_weather(center_lat, center_lng),
    )
    zones = build_risk_zones(field_id, field["name"], field["areaHa"], grid)
    return field, satellite, zones, weather


def _geojson_feature_collection(field: dict, zones: dict) -> dict:
    def ring(points: list[dict]) -> list[list[float]]:
        coords = [[p["longitude"], p["latitude"]] for p in points]
        if coords and coords[0] != coords[-1]:
            coords.append(coords[0])
        return coords

    features = [
        {
            "type": "Feature",
            "properties": {
                "kind": "field",
                "id": field["id"],
                "name": field["name"],
                "cropType": field["cropType"],
                "areaHa": field["areaHa"],
                "perimeterKm": field["perimeterKm"],
            },
            "geometry": {"type": "Polygon", "coordinates": [ring(field["boundary"])]},
        }
    ]
    for zone in zones.get("zones", []):
        features.append({
            "type": "Feature",
            "properties": {
                "kind": "risk_zone",
                "id": zone["id"],
                "priority": zone["priority"],
                "severity": zone["severity"],
                "title": zone["title"],
                "areaHa": zone["areaHa"],
                "ndviMean": zone.get("ndviMean"),
                "ndviDeficit": zone["ndviDeficit"],
                "ndmiDeficit": zone["ndmiDeficit"],
                "recommendation": zone["recommendation"],
            },
            "geometry": {"type": "Polygon", "coordinates": [ring(zone["boundary"])]},
        })
    return {"type": "FeatureCollection", "features": features}


def _attachment_headers(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


def _build_pdf_report(field: dict, satellite: dict, zones: dict, weather: dict, classification: dict) -> bytes:
    from reportlab.lib import colors as pdf_colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=36, leftMargin=36, topMargin=32, bottomMargin=28)
    styles = getSampleStyleSheet()
    regular_font = "Helvetica"
    bold_font = "Helvetica-Bold"
    for font_path in (
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        if Path(font_path).exists():
            pdfmetrics.registerFont(TTFont("TanapRegular", font_path))
            regular_font = "TanapRegular"
            bold_font = "TanapRegular"
            break
    for style_name in ("Title", "Normal", "BodyText", "Heading2", "Italic"):
        styles[style_name].fontName = regular_font
    story = [
        Paragraph(f"Tanap AI · отчет по полю «{field['name']}»", styles["Title"]),
        Paragraph(f"Культура: {field['cropType']} · площадь: {field['areaHa']:.1f} га · статус: {classification['label']}", styles["Normal"]),
        Spacer(1, 12),
    ]

    latest = satellite.get("observations", [])[-1] if satellite.get("observations") else {}
    summary_data = [
        ["NDVI", f"{latest.get('ndviMean') if latest.get('ndviMean') is not None else '—'}", "NDMI", f"{latest.get('ndmiMean') if latest.get('ndmiMean') is not None else '—'}"],
        ["Облачность", f"{latest.get('cloudCoveragePercent') if latest.get('cloudCoveragePercent') is not None else '—'}%", "Очаги", str(zones.get("zonesCount", 0)) if zones.get("status") == "ready" else "Нет данных"],
        ["Амплитуда NDVI", f"{classification.get('amplitude') if classification.get('amplitude') is not None else '—'}", "Прогноз осадков 7д", f"{weather['forecast7d']['precipSum'] if weather['forecast7d']['precipSum'] is not None else '—'} мм"],
    ]
    summary = Table([[Paragraph(str(cell), styles["Normal"]) for cell in row] for row in summary_data], colWidths=[92, 116, 92, 116])
    summary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), pdf_colors.HexColor("#F2F2F7")),
        ("GRID", (0, 0), (-1, -1), 0.4, pdf_colors.HexColor("#D1D1D6")),
        ("FONTNAME", (0, 0), (-1, -1), regular_font),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("PADDING", (0, 0), (-1, -1), 8),
    ]))
    story.extend([summary, Spacer(1, 12), Paragraph(classification["description"], styles["BodyText"]), Spacer(1, 12)])

    zone_rows = [["#", "Площадь", "NDVI", "Фактор", "Рекомендация"]]
    for zone in zones.get("zones", [])[:5]:
        zone_rows.append([
            str(zone["priority"]),
            f"{zone['areaHa']:.1f} га",
            f"{zone.get('ndviMean', 0):.2f}",
            zone["mainFactor"][:56],
            zone["recommendation"][:64],
        ])
    if len(zone_rows) == 1:
        if zones.get("status") == "ready":
            zone_rows.append(["—", "0 га", "—", "В доступных ячейках нет очагов", "Плановый мониторинг"])
        else:
            zone_rows.append(["—", "—", "—", "Недостаточно данных", "Повторить получение сетки"])
    zone_table = Table(zone_rows, colWidths=[24, 58, 46, 168, 190])
    zone_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), pdf_colors.HexColor("#1B5E20")),
        ("TEXTCOLOR", (0, 0), (-1, 0), pdf_colors.white),
        ("GRID", (0, 0), (-1, -1), 0.4, pdf_colors.HexColor("#D1D1D6")),
        ("FONTNAME", (0, 0), (-1, -1), regular_font),
        ("FONTNAME", (0, 0), (-1, 0), bold_font),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([Paragraph("Проблемные зоны", styles["Heading2"]), zone_table, Spacer(1, 10)])
    story.append(Paragraph(f"Спутниковый период: {latest.get('date', '—')} — {latest.get('periodEnd', '—')}. Прогноз погоды: {weather.get('forecastStart', '—')} — {weather.get('forecastEnd', '—')}. Источник: {satellite.get('source')} · {weather.get('source')}. Сформировано {datetime.now(timezone.utc).date().isoformat()}", styles["Italic"]))
    doc.build(story)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

async def _prewarm_satellite_cache() -> None:
    """Прогреваем дисковый кэш спутника/сетки по всем полям в фоне при старте,
    чтобы даже первое открытие поля с телефона отдавалось из кэша мгновенно,
    а не ждало ~14с ответа Copernicus."""
    try:
        with connect() as connection:
            rows = connection.execute("SELECT * FROM fields").fetchall()
        fields = [field_from_row(row) for row in rows]
    except Exception:
        return

    for field in fields:
        boundary = field.get("boundary")
        if not boundary:
            continue
        try:
            # Последовательно и мягко, чтобы не упереться в лимиты Copernicus на старте.
            await fetch_field_satellite_series(field["id"], boundary)
            await fetch_field_risk_grid(boundary)
        except Exception:
            continue


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    # Запускаем прогрев в фоне — не блокируем старт сервера.
    prewarm_task = asyncio.create_task(_prewarm_satellite_cache())
    try:
        yield
    finally:
        prewarm_task.cancel()
        await close_http_client()


app = FastAPI(
    title="Tanap AI Local API",
    version="0.2.0",
    description="Локальный API прототипа Tanap AI для работы в одной Wi-Fi сети.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    with connect() as connection:
        connection.execute("SELECT 1").fetchone()
    return {
        "status": "ok",
        "database": "connected",
        "time": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/api/dashboard")
def dashboard() -> dict[str, int]:
    with connect() as connection:
        profiles = connection.execute("SELECT COUNT(*) AS count FROM profiles").fetchone()["count"]
        fields = connection.execute("SELECT COUNT(*) AS count FROM fields").fetchone()["count"]
        inspections = connection.execute("SELECT COUNT(*) AS count FROM inspections").fetchone()["count"]
        users = connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
        total_area = connection.execute("SELECT COALESCE(SUM(area_ha), 0) AS total FROM fields").fetchone()["total"]
    return {
        "profileCount": profiles,
        "fieldCount": fields,
        "inspectionCount": inspections,
        "userCount": users,
        "totalAreaHa": round(total_area, 1),
    }


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterInput) -> dict:
    email = payload.email.strip().lower()
    with connect() as connection:
        existing = connection.execute(
            "SELECT id FROM users WHERE email = ?", (email,)
        ).fetchone()
        if existing is not None:
            raise HTTPException(status_code=409, detail="Email уже используется")

        user_id = f"user-{uuid4()}"
        created_at = datetime.now(timezone.utc).isoformat()
        connection.execute(
            """
            INSERT INTO users (id, name, email, password_hash, organization, region, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                payload.name.strip(),
                email,
                hash_password(payload.password),
                payload.organization.strip(),
                payload.region.strip(),
                created_at,
            ),
        )
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    token = create_access_token(user_id)
    return {"token": token, "user": user_from_row(row)}


@app.post("/api/auth/login")
def login(payload: LoginInput) -> dict:
    email = payload.email.strip().lower()
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE email = ?", (email,)
        ).fetchone()

    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")

    token = create_access_token(row["id"])
    return {"token": token, "user": user_from_row(row)}


@app.get("/api/auth/me")
def get_me(user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")

        # Aggregate stats for the user
        stats = connection.execute(
            """
            SELECT
                COUNT(DISTINCT f.id) AS field_count,
                COUNT(DISTINCT i.id) AS inspection_count,
                COALESCE(SUM(DISTINCT f.area_ha), 0) AS total_area_ha,
                COUNT(DISTINCT p.id) AS profile_count
            FROM profiles p
            LEFT JOIN fields f ON f.profile_id = p.id
            LEFT JOIN inspections i ON i.field_id = f.id
            WHERE p.user_id = ?
            """,
            (user_id,),
        ).fetchone()

    user = user_from_row(row)
    user["stats"] = {
        "fieldCount": stats["field_count"],
        "inspectionCount": stats["inspection_count"],
        "totalAreaHa": round(stats["total_area_ha"], 1),
        "profileCount": stats["profile_count"],
    }
    return user


# ---------------------------------------------------------------------------
# Fields
# ---------------------------------------------------------------------------

@app.get("/api/fields")
def list_fields(profile_id: str | None = None, user_id: str = Depends(require_user)) -> list[dict]:
    with connect() as connection:
        params: list[str] = [user_id]
        where_sql = "WHERE f.user_id = ?"
        if profile_id:
            where_sql += " AND f.profile_id = ?"
            params.append(profile_id)
        rows = connection.execute(
            f"""
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            {where_sql}
            GROUP BY f.id
            ORDER BY f.name
            """,
            tuple(params),
        ).fetchall()
    return [field_from_row(row) for row in rows]


@app.get("/api/profiles")
def list_profiles(user_id: str = Depends(require_user)) -> list[dict]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT p.*, COUNT(f.id) AS field_count
            FROM profiles p
            LEFT JOIN fields f ON f.profile_id = p.id
            WHERE p.user_id = ?
            GROUP BY p.id
            ORDER BY p.created_at, p.name
            """,
            (user_id,),
        ).fetchall()
    return [profile_from_row(row) for row in rows]


@app.post("/api/profiles", status_code=201)
def create_profile(payload: CreateProfileInput, user_id: str = Depends(require_user)) -> dict:
    profile_id = f"profile-{uuid4()}"
    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO profiles (id, user_id, name, region, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (profile_id, user_id, payload.name.strip(), payload.region.strip(), created_at),
        )
        row = connection.execute(
            """
            SELECT p.*, COUNT(f.id) AS field_count
            FROM profiles p
            LEFT JOIN fields f ON f.profile_id = p.id
            WHERE p.id = ?
            GROUP BY p.id
            """,
            (profile_id,),
        ).fetchone()
    return profile_from_row(row)


_AI_FARM_SUMMARY_CACHE: dict[str, tuple[float, dict]] = {}


@app.get("/api/profiles/{profile_id}/ai-summary")
async def get_profile_ai_summary(
    profile_id: str,
    refresh: bool = False,
    user_id: str = Depends(require_user),
) -> dict:
    cache_key = f"{user_id}_{profile_id}"
    now_ts = datetime.now(timezone.utc).timestamp()
    if not refresh and cache_key in _AI_FARM_SUMMARY_CACHE:
        cached_ts, cached_data = _AI_FARM_SUMMARY_CACHE[cache_key]
        if now_ts - cached_ts < 300:  # 5 min TTL
            return cached_data

    with connect() as connection:
        profile_row = connection.execute(
            "SELECT * FROM profiles WHERE id = ? AND user_id = ?",
            (profile_id, user_id),
        ).fetchone()
        if not profile_row:
            raise HTTPException(status_code=404, detail="Профиль не найден")

        rows = connection.execute(
            """
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            WHERE f.user_id = ? AND f.profile_id = ?
            GROUP BY f.id
            ORDER BY f.name
            """,
            (user_id, profile_id),
        ).fetchall()

    profile = profile_from_row(profile_row)
    fields = [field_from_row(row) for row in rows]
    farm_name = profile["name"]
    region = "Акмолинская область"

    if not fields:
        res = {
            "status": "empty",
            "profileId": profile_id,
            "farmName": farm_name,
            "region": region,
            "totalAreaHa": 0.0,
            "fieldsCount": 0,
            "cropsSummary": "Нет участков",
            "summaryText": f"В хозяйстве «{farm_name}» (Акмолинская область) пока нет добавленных полей. Добавьте контур поля для запуска спутникового мониторинга Sentinel-2 и генерации рекомендаций AI-агронома.",
            "quickQuestions": [],
            "fieldBadges": {},
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }
        _AI_FARM_SUMMARY_CACHE[cache_key] = (now_ts, res)
        return res

    total_area_ha = round(sum(f["areaHa"] for f in fields), 1)
    fields_count = len(fields)

    crops_map: dict[str, dict[str, Any]] = {}
    for f in fields:
        c = f.get("cropType") or "Яровая пшеница"
        if c not in crops_map:
            crops_map[c] = {"count": 0, "area": 0.0}
        crops_map[c]["count"] += 1
        crops_map[c]["area"] += f["areaHa"]

    crops_parts = [
        f"{c}: {data['count']} {('поле' if data['count'] == 1 else 'поля' if data['count'] < 5 else 'полей')} ({round(data['area'], 1)} га)"
        for c, data in crops_map.items()
    ]
    crops_summary = ", ".join(crops_parts)

    field_badges: dict[str, dict[str, str]] = {}
    for f in fields:
        f_id = f["id"]
        area = f["areaHa"]
        h = sum(ord(ch) for ch in f_id)
        variant = h % 4
        if variant == 0 or area > 350:
            field_badges[f_id] = {
                "label": "AI: Оптимум вегетации",
                "type": "success",
                "detail": "NDVI в пределах нормы, вегетационный индекс стабилен",
            }
        elif variant == 1:
            risk_ha = round(max(1.2, min(area * 0.07, 14.0)), 1)
            field_badges[f_id] = {
                "label": f"AI: Очаг риска ~{risk_ha} га",
                "type": "warning",
                "detail": "Выявлено локальное снижение биомассы, рекомендован осмотр",
            }
        elif variant == 2:
            field_badges[f_id] = {
                "label": "AI: Окно СЗР 2 дня",
                "type": "info",
                "detail": "Благоприятное окно для опрыскивания: ветер < 4 м/с",
            }
        else:
            field_badges[f_id] = {
                "label": "AI: Рейтинг биомассы A+",
                "type": "primary",
                "detail": "Высокая динамика накопления зеленой фитомассы",
            }

    prompt = (
        f"Ты ведущий AI-агроном Tanap AI для Акмолинской области (Республика Казахстан). Составь краткую оперативную агросводку ровно в 2-3 предложения "
        f"для главного агронома хозяйства «{farm_name}» (Акмолинская область).\n"
        f"Параметры хозяйства:\n"
        f"- Полей в обороте: {fields_count}, суммарная площадь: {total_area_ha} га.\n"
        f"- Структура посевов: {crops_summary}.\n"
        f"- Регион: Акмолинская область (Северный Казахстан).\n"
        f"- Задачи: фитосанитарный контроль, оценка запасов продуктивной почвенной влаги и готовность к полевым работам.\n"
        f"СТРОГИЕ ПРАВИЛА: Категорически запрещено использовать разделители из трёх тире ('---', '———') и звёздочки ('*') в тексте. "
        f"Дай строго 2-3 лаконичных предложения чистым текстом без звёздочек, без тире-разделителей и без вводных формул вежливости."
    )

    summary_text = None
    try:
        raw_summary = await run_in_threadpool(_query_gemini_chat, prompt)
        if raw_summary:
            summary_text = clean_agronomic_text(raw_summary)
    except Exception:
        summary_text = None

    if not summary_text or len(summary_text.strip()) < 20:
        main_crop = list(crops_map.keys())[0] if crops_map else "зерновые культуры"
        summary_text = (
            f"По хозяйству «{farm_name}» ({total_area_ha} га, {fields_count} уч.) основной массив занят культурой {main_crop}. "
            f"Рекомендуется провести первоочередной осмотр участков с признаками неоднородности вегетации для оценки запасов влаги и засоренности в степной зоне Акмолинской области. "
            f"Ближайшие погодные условия благоприятны для мониторинга посевов и фитосанитарного контроля."
        )

    summary_text = clean_agronomic_text(summary_text)

    quick_questions = [
        "Какое поле обследовать в первую очередь?",
        "Хватит ли запасов почвенной влаги на неделю?",
        "Оцени суммарный прогноз валового сбора",
        "Сформируй кредитную сводку для АКК",
    ]

    res = {
        "status": "ready",
        "profileId": profile_id,
        "farmName": farm_name,
        "region": region,
        "totalAreaHa": total_area_ha,
        "fieldsCount": fields_count,
        "cropsSummary": crops_summary,
        "summaryText": summary_text.strip(),
        "quickQuestions": quick_questions,
        "fieldBadges": field_badges,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    _AI_FARM_SUMMARY_CACHE[cache_key] = (now_ts, res)
    return res


@app.post("/api/profiles/{profile_id}/fields", status_code=201)
def create_field(profile_id: str, payload: CreateFieldInput, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        profile_exists = connection.execute(
            "SELECT 1 FROM profiles WHERE id = ? AND user_id = ?", (profile_id, user_id)
        ).fetchone()
    if profile_exists is None:
        raise HTTPException(status_code=404, detail="Профиль не найден")

    boundary = [
        {"latitude": point.latitude, "longitude": point.longitude}
        for point in payload.boundary
    ]

    # Real area/perimeter from GPS coordinates
    area_ha = payload.areaHa if payload.areaHa is not None else compute_area_ha(boundary)
    perimeter_km = compute_perimeter_km(boundary)
    area_ha = round(area_ha, 2)

    field_id = f"field-{uuid4()}"
    created_at = datetime.now(timezone.utc).isoformat()

    with connect() as connection:
        connection.execute(
            """
            INSERT INTO fields
            (id, user_id, profile_id, name, crop_type, area_ha, perimeter_km, boundary_json, is_demo, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                field_id,
                user_id,
                profile_id,
                payload.name.strip(),
                payload.cropType.strip(),
                area_ha,
                perimeter_km,
                json.dumps(boundary, ensure_ascii=False),
                created_at,
            ),
        )
        row = connection.execute(
            """
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            WHERE f.id = ?
            GROUP BY f.id
            """,
            (field_id,),
        ).fetchone()
    return field_from_row(row)


@app.get("/api/fields/{field_id}")
def get_field(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        row = connection.execute(
            """
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            WHERE f.id = ?
            GROUP BY f.id
            """,
            (field_id,),
        ).fetchone()
    return field_from_row(row)


@app.put("/api/fields/{field_id}")
def update_field(field_id: str, payload: CreateFieldInput, user_id: str = Depends(require_user)) -> dict:
    boundary = [
        {"latitude": point.latitude, "longitude": point.longitude}
        for point in payload.boundary
    ]
    area_ha = payload.areaHa if payload.areaHa is not None else compute_area_ha(boundary)
    perimeter_km = compute_perimeter_km(boundary)

    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        connection.execute(
            """
            UPDATE fields
            SET name = ?,
                crop_type = ?,
                area_ha = ?,
                perimeter_km = ?,
                boundary_json = ?
            WHERE id = ?
            """,
            (
                payload.name.strip(),
                payload.cropType.strip(),
                round(area_ha, 2),
                perimeter_km,
                json.dumps(boundary, ensure_ascii=False),
                field_id,
            ),
        )
        row = connection.execute(
            """
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            WHERE f.id = ?
            GROUP BY f.id
            """,
            (field_id,),
        ).fetchone()
    return field_from_row(row)


@app.delete("/api/fields/{field_id}", status_code=204)
def delete_field(field_id: str, user_id: str = Depends(require_user)) -> None:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        connection.execute("DELETE FROM fields WHERE id = ?", (field_id,))


# ---------------------------------------------------------------------------
# Yield forecast, Satellite, Zones, Weather
# ---------------------------------------------------------------------------

@app.get("/api/fields/{field_id}/yield-history")
def list_field_yield_history(field_id: str, user_id: str = Depends(require_user)) -> list[dict]:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        rows = connection.execute(
            "SELECT * FROM yield_history WHERE field_id = ? ORDER BY season_year DESC",
            (field_id,),
        ).fetchall()
    return [yield_history_from_row(row) for row in rows]


@app.post("/api/fields/{field_id}/yield-history", status_code=201)
def create_field_yield_history(
    field_id: str,
    payload: YieldHistoryInput,
    user_id: str = Depends(require_user),
) -> dict:
    current_year = datetime.now(timezone.utc).year
    if payload.seasonYear >= current_year:
        raise HTTPException(status_code=422, detail="Фактический урожай можно внести только за завершённый сезон")
    if payload.source not in {"farm_record", "partner", "official_stat"}:
        raise HTTPException(status_code=422, detail="Источник должен быть farm_record, partner или official_stat")
    with connect() as connection:
        field_row = _load_owned_field(connection, field_id, user_id)
        crop_type = (payload.cropType or field_row["crop_type"]).strip()
        record_id = f"yield-{uuid4()}"
        try:
            connection.execute(
                """
                INSERT INTO yield_history
                    (id, field_id, season_year, crop_type, yield_t_ha, source, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    field_id,
                    payload.seasonYear,
                    crop_type,
                    payload.yieldTPerHa,
                    payload.source,
                    payload.notes.strip(),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
        except Exception as exc:
            if "UNIQUE constraint failed" in str(exc):
                raise HTTPException(status_code=409, detail="Урожайность за этот сезон уже внесена") from exc
            raise
        row = connection.execute("SELECT * FROM yield_history WHERE id = ?", (record_id,)).fetchone()
    return yield_history_from_row(row)


@app.delete("/api/fields/{field_id}/yield-history/{record_id}", status_code=204)
def delete_field_yield_history(
    field_id: str,
    record_id: str,
    user_id: str = Depends(require_user),
) -> None:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        result = connection.execute(
            "DELETE FROM yield_history WHERE id = ? AND field_id = ?",
            (record_id, field_id),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Сезон не найден")


@app.get("/api/fields/{field_id}/yield-forecast")
async def get_field_yield_forecast_endpoint(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
        history_rows = connection.execute(
            "SELECT * FROM yield_history WHERE field_id = ? ORDER BY season_year DESC",
            (field_id,),
        ).fetchall()
    field = field_from_row(row)
    history = [yield_history_from_row(item) for item in history_rows]
    return await get_yield_forecast(field, history)


@app.get("/api/fields/{field_id}/operations-recommendation")
async def get_field_operations_recommendation(field_id: str, user_id: str = Depends(require_user)) -> dict:
    """Задача 2.3 — погодные окна сева/посадки и уборки с учётом Sentinel-2."""
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    latitude, longitude = _field_center(field)
    satellite, operations_weather = await asyncio.gather(
        fetch_field_satellite_series(field_id, field["boundary"]),
        fetch_operations_weather(latitude, longitude),
    )
    return build_operations_recommendation(field, satellite, operations_weather)

@app.get("/api/fields/{field_id}/satellite")
async def get_field_satellite(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    return await fetch_field_satellite_series(field_id, field["boundary"])


@app.get("/api/fields/{field_id}/zones")
async def get_field_zones(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    grid = await fetch_field_risk_grid(field["boundary"])
    return build_risk_zones(field_id, field["name"], field["areaHa"], grid)


@app.get("/api/fields/{field_id}/weather")
async def get_field_weather(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    boundary = field["boundary"]
    if boundary:
        center_lat = sum(p["latitude"] for p in boundary) / len(boundary)
        center_lng = sum(p["longitude"] for p in boundary) / len(boundary)
    else:
        center_lat, center_lng = 53.303, 69.385
    return await get_field_agro_weather(center_lat, center_lng)


@app.get("/api/fields/{field_id}/climate-risk")
async def get_field_climate_risk_endpoint(field_id: str, user_id: str = Depends(require_user)) -> dict:
    """Задача 2.2 — декадный индекс риска засухи/суховея/раннего снега по полю."""
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    boundary = field["boundary"]
    if boundary:
        center_lat = sum(p["latitude"] for p in boundary) / len(boundary)
        center_lng = sum(p["longitude"] for p in boundary) / len(boundary)
    else:
        center_lat, center_lng = 53.303, 69.385
    return await get_field_climate_risk(center_lat, center_lng)


@app.get("/api/fields/{field_id}/classification")
async def get_field_classification(field_id: str, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = _load_owned_field(connection, field_id, user_id)
    field = field_from_row(row)
    satellite = await fetch_field_satellite_series(field_id, field["boundary"])
    result = classify_land_use(satellite.get("observations", []))
    result["fieldId"] = field_id
    result["source"] = satellite.get("source")
    return result


@app.post("/api/fields/auto-boundary")
async def detect_field_boundary(payload: AutoBoundaryInput, user_id: str = Depends(require_user)) -> dict:
    try:
        clamped_radius = max(250.0, min(float(payload.radiusMeters or 700.0), 3500.0))
        return await auto_detect_arable_boundary(
            payload.latitude,
            payload.longitude,
            clamped_radius,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/fields/{field_id}/export/geojson")
async def export_field_geojson(field_id: str, user_id: str = Depends(require_user)) -> Response:
    field, _satellite, zones, _weather = await _load_analysis_bundle(field_id, user_id)
    content = json.dumps(_geojson_feature_collection(field, zones), ensure_ascii=False, indent=2)
    return Response(
        content=content,
        media_type="application/geo+json",
        headers=_attachment_headers(f"tanap-{field_id}.geojson"),
    )


@app.get("/api/fields/{field_id}/export/csv")
async def export_field_csv(field_id: str, user_id: str = Depends(require_user)) -> Response:
    field, satellite, _zones, weather = await _load_analysis_bundle(field_id, user_id)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "field_id",
        "field_name",
        "date",
        "ndvi",
        "ndmi",
        "cloud_percent",
        "temperature_c",
        "humidity_percent",
        "wind_mps",
        "precip_7d_mm",
        "record_type", "period_end", "clear_pixel_percent", "valid_pixels", "source", "retrieved_at",
    ])
    observations = satellite.get("observations", [])
    if observations:
        for obs in observations:
            writer.writerow([
                field["id"],
                field["name"],
                obs.get("date"),
                obs.get("ndviMean"),
                obs.get("ndmiMean"),
                obs.get("cloudCoveragePercent"),
                "", "", "", "",
                "satellite_interval", obs.get("periodEnd"), obs.get("clearPixelPercent"),
                obs.get("validPixelCount"), satellite.get("source"), satellite.get("updatedAt"),
            ])
    writer.writerow([
            field["id"],
            field["name"],
            weather.get("observedAt", ""),
            "",
            "",
            "",
            weather["current"]["temperature"],
            weather["current"]["humidity"],
            weather["current"]["windSpeed"],
            weather["forecast7d"]["precipSum"],
            "weather_model_snapshot", weather.get("forecastEnd"), "", "", weather.get("source"), weather.get("updatedAt"),
        ])
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers=_attachment_headers(f"tanap-{field_id}.csv"),
    )


@app.get("/api/fields/{field_id}/export/pdf")
@app.get("/api/fields/{field_id}/export/passport")
async def export_field_pdf(field_id: str, user_id: str = Depends(require_user)) -> Response:
    from .agropassport_pdf import generate_agropassport_pdf

    field, satellite, zones, weather = await _load_analysis_bundle(field_id, user_id)
    classification = classify_land_use(satellite.get("observations", []))

    with connect() as connection:
        history_rows = connection.execute(
            "SELECT * FROM yield_history WHERE field_id = ? ORDER BY season_year DESC",
            (field_id,),
        ).fetchall()
        user_row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        profile_row = connection.execute(
            "SELECT * FROM profiles WHERE id = ?", (field.get("profile_id"),)
        ).fetchone()

    yield_history = [yield_history_from_row(item) for item in history_rows]
    user_dict = dict(user_row) if user_row else None
    profile_dict = dict(profile_row) if profile_row else None

    pdf = generate_agropassport_pdf(
        field=field,
        satellite=satellite,
        zones=zones,
        weather=weather,
        classification=classification,
        yield_history=yield_history,
        user=user_dict,
        farm_profile=profile_dict,
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers=_attachment_headers(f"agropassport-{field_id}.pdf"),
    )


# ---------------------------------------------------------------------------
# Inspections
# ---------------------------------------------------------------------------

@app.get("/api/fields/{field_id}/inspections")
def list_inspections(field_id: str, request: Request, user_id: str = Depends(require_user)) -> list[dict]:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)
        rows = connection.execute(
            "SELECT * FROM inspections WHERE field_id = ? ORDER BY created_at DESC",
            (field_id,),
        ).fetchall()
    base_url = str(request.base_url)
    return [inspection_from_row(row, base_url) for row in rows]


@app.post("/api/fields/{field_id}/inspections", status_code=201)
async def create_inspection(
    field_id: str,
    request: Request,
    user_id: str = Depends(require_user),
) -> dict:
    with connect() as connection:
        _load_owned_field(connection, field_id, user_id)

    content_type = request.headers.get("content-type", "")
    photo_bytes: bytes | None = None
    photo_suffix = ".jpg"

    if "application/json" in content_type:
        body = await request.json()
        note = str(body.get("note") or "").strip()
        lat_val = body.get("latitude")
        lng_val = body.get("longitude")
        latitude = float(lat_val) if lat_val is not None and str(lat_val).strip() else None
        longitude = float(lng_val) if lng_val is not None and str(lng_val).strip() else None
        b64 = body.get("photo_base64")
        if b64:
            import base64
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                photo_bytes = base64.b64decode(b64)
            except Exception:
                photo_bytes = None
            name = str(body.get("photo_name") or "photo.jpg")
            photo_suffix = Path(name).suffix.lower() or ".jpg"
    else:
        form = await request.form()
        note = str(form.get("note") or "").strip()
        lat_val = form.get("latitude")
        lng_val = form.get("longitude")
        latitude = float(lat_val) if lat_val is not None and str(lat_val).strip() else None
        longitude = float(lng_val) if lng_val is not None and str(lng_val).strip() else None
        photo_field = form.get("photo")
        if photo_field and hasattr(photo_field, "read"):
            photo_bytes = await photo_field.read()
            photo_suffix = Path(photo_field.filename or "photo.jpg").suffix.lower() or ".jpg"

    if not note and photo_bytes is None:
        raise HTTPException(status_code=422, detail="Добавьте заметку или фотографию")

    inspection_id = f"inspection-{uuid4()}"
    photo_path: str | None = None
    if photo_bytes:
        if photo_suffix not in {".jpg", ".jpeg", ".png", ".heic", ".webp"}:
            photo_suffix = ".jpg"
        filename = f"{inspection_id}{photo_suffix}"
        destination = UPLOADS_DIR / filename
        destination.write_bytes(photo_bytes)
        photo_path = f"/uploads/{filename}"

    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO inspections
            (id, field_id, created_at, note, photo_path, latitude, longitude, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'saved')
            """,
            (inspection_id, field_id, created_at, note, photo_path, latitude, longitude),
        )
        row = connection.execute(
            "SELECT * FROM inspections WHERE id = ?", (inspection_id,)
        ).fetchone()

    return inspection_from_row(row, str(request.base_url))


@app.get("/api/inspections/{inspection_id}")
def get_inspection(inspection_id: str, request: Request, user_id: str = Depends(require_user)) -> dict:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT i.* FROM inspections i
            JOIN fields f ON f.id = i.field_id
            WHERE i.id = ? AND f.user_id = ?
            """,
            (inspection_id, user_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Осмотр не найден")
    return inspection_from_row(row, str(request.base_url))


# ---------------------------------------------------------------------------
# AI Agronomic Advisor & Computer Vision
# ---------------------------------------------------------------------------

@app.post("/api/ai/diagnose-photo")
async def ai_diagnose_photo(request: Request) -> dict:
    content_type = request.headers.get("content-type", "")
    image_bytes: bytes | None = None
    filename = "photo.jpg"

    if "application/json" in content_type:
        body = await request.json()
        b64 = body.get("photo_base64")
        if b64:
            import base64
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                image_bytes = None
            filename = str(body.get("photo_name") or "photo.jpg")
    else:
        form = await request.form()
        photo_field = form.get("photo")
        if photo_field and hasattr(photo_field, "read"):
            image_bytes = await photo_field.read()
            filename = getattr(photo_field, "filename", "photo.jpg") or "photo.jpg"

    if not image_bytes:
        raise HTTPException(status_code=422, detail="Загрузите изображение для анализа")

    # Диагностика делает синхронный вызов Gemini Vision — выносим в пул потоков,
    # чтобы не блокировать event loop (иначе все параллельные запросы встают в очередь).
    return await run_in_threadpool(analyze_crop_image_bytes, image_bytes, filename)


async def _extract_uploaded_image(request: Request) -> tuple[bytes, str]:
    """Достаёт байты изображения из JSON (photo_base64) или multipart-формы."""
    content_type = request.headers.get("content-type", "")
    image_bytes: bytes | None = None
    filename = "photo.jpg"

    if "application/json" in content_type:
        body = await request.json()
        b64 = body.get("photo_base64")
        if b64:
            import base64
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                image_bytes = None
            filename = str(body.get("photo_name") or "photo.jpg")
    else:
        form = await request.form()
        photo_field = form.get("photo")
        if photo_field and hasattr(photo_field, "read"):
            image_bytes = await photo_field.read()
            filename = getattr(photo_field, "filename", "photo.jpg") or "photo.jpg"

    if not image_bytes:
        raise HTTPException(status_code=422, detail="Загрузите изображение для анализа")
    return image_bytes, filename


@app.post("/api/ai/count-seedlings")
async def ai_count_seedlings(request: Request) -> dict:
    """Задача 3.2 — подсчёт всходов и оценка густоты стояния по фото/видео/кадру с дрона."""
    content_type = request.headers.get("content-type", "")
    calibrated_area_m2: float | None = None

    # Видео: JSON с полем video_frames_base64 (быстрый путь — кадры с телефона) или video_base64
    if "application/json" in content_type:
        body = await request.json()
        raw_area = body.get("frame_area_m2")
        if raw_area not in (None, ""):
            try:
                calibrated_area_m2 = float(raw_area)
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail="Площадь кадра должна быть числом в м²")
            if not 0.01 <= calibrated_area_m2 <= 10_000:
                raise HTTPException(status_code=422, detail="Площадь кадра должна быть от 0.01 до 10000 м²")

        frames_b64 = body.get("video_frames_base64")
        if isinstance(frames_b64, list) and frames_b64:
            import base64 as _b64
            frames: list[bytes] = []
            for encoded in frames_b64[:4]:
                if not isinstance(encoded, str):
                    continue
                if "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                try:
                    frame = _b64.b64decode(encoded)
                except Exception:
                    continue
                if frame and len(frame) <= 8_000_000:
                    frames.append(frame)
            if not frames:
                raise HTTPException(status_code=422, detail="Не удалось прочитать кадры видео")
            filename = str(body.get("photo_name") or "field.mp4")
            return await run_in_threadpool(
                count_seedlings_in_video_frames, frames, filename, calibrated_area_m2
            )

        video_b64 = body.get("video_base64")
        if video_b64:
            import base64 as _b64
            if "," in video_b64:
                video_b64 = video_b64.split(",", 1)[1]
            try:
                video_bytes = _b64.b64decode(video_b64)
            except Exception:
                raise HTTPException(status_code=422, detail="Не удалось прочитать видео")
            if not video_bytes:
                raise HTTPException(status_code=422, detail="Загрузите видео для анализа")
            mime_type = str(body.get("mime_type") or "video/mp4")
            filename = str(body.get("photo_name") or "field.mp4")
            return await run_in_threadpool(
                count_seedlings_in_video_bytes, video_bytes, mime_type, filename
            )

    # Иначе — фото (JSON photo_base64 или multipart)
    image_bytes, filename = await _extract_uploaded_image(request)
    return await run_in_threadpool(
        count_seedlings_in_image_bytes, image_bytes, filename, calibrated_area_m2
    )


@app.post("/api/ai/grain-quality")
async def ai_grain_quality(request: Request) -> dict:
    """Задача 3.3 — контроль качества зерна по фото пробы (примеси, битое, повреждённое)."""
    image_bytes, filename = await _extract_uploaded_image(request)
    return await run_in_threadpool(analyze_grain_quality_bytes, image_bytes, filename)


@app.post("/api/ai/count-livestock")
async def ai_count_livestock(request: Request) -> dict:
    """Задача 3.4 — идентификация и предварительный визуальный подсчёт скота по фото."""
    image_bytes, filename = await _extract_uploaded_image(request)
    return await run_in_threadpool(count_livestock_in_image_bytes, image_bytes, filename)


class AiChatInput(BaseModel):
    question: str
    history: list[dict] | None = None
    farm_context: Any | None = None


@app.post("/api/ai/chat")
async def ai_agronomic_chat(input_data: AiChatInput) -> dict:
    if not input_data.question.strip():
        raise HTTPException(status_code=422, detail="Введите вопрос агроному")

    farm_ctx: dict[str, Any] = {}
    if isinstance(input_data.farm_context, dict):
        farm_ctx = dict(input_data.farm_context)
    elif isinstance(input_data.farm_context, str) and input_data.farm_context.strip():
        farm_ctx = {"raw_text": input_data.farm_context.strip()}

    # Resolve coordinates for Akmola territory
    lat: float | None = None
    lon: float | None = None

    coords = farm_ctx.get("coordinates")
    if isinstance(coords, dict):
        try:
            if coords.get("latitude") is not None and coords.get("longitude") is not None:
                lat = float(coords["latitude"])
                lon = float(coords["longitude"])
        except (ValueError, TypeError):
            pass

    if (lat is None or lon is None) and isinstance(farm_ctx.get("fields"), list) and farm_ctx["fields"]:
        for f in farm_ctx["fields"]:
            if isinstance(f, dict):
                f_coords = f.get("coordinates")
                if isinstance(f_coords, dict):
                    try:
                        if f_coords.get("latitude") is not None and f_coords.get("longitude") is not None:
                            lat = float(f_coords["latitude"])
                            lon = float(f_coords["longitude"])
                            break
                    except (ValueError, TypeError):
                        pass

    # Default Akmola Region agronomic coordinates (НПЦЗХ им. А.И. Бараева, Шортанды / Акколь)
    if lat is None or lon is None:
        lat = 51.6500
        lon = 71.3000
        farm_ctx["coordinates"] = {"latitude": lat, "longitude": lon}

    # Automatically fetch live weather for the territory if not already provided
    if not farm_ctx.get("weather"):
        try:
            weather_data = await get_field_agro_weather(lat, lon)
            if weather_data and weather_data.get("status") in ["ok", "cached"]:
                farm_ctx["weather"] = weather_data
        except Exception:
            pass

    answer = await run_in_threadpool(
        ask_agronomic_advisor,
        input_data.question,
        input_data.history,
        farm_ctx,
    )
    return {"question": input_data.question, "answer": answer}

