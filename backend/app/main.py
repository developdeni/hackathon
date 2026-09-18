from contextlib import asynccontextmanager
from datetime import datetime, timezone
import csv
import io
import json
from pathlib import Path
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
)
from .copernicus import auto_detect_arable_boundary, fetch_field_satellite_series, fetch_field_risk_grid
from .analytics import build_risk_zones, classify_land_use
from .weather import get_field_agro_weather


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
    satellite = await fetch_field_satellite_series(field_id, field["boundary"])
    grid = await fetch_field_risk_grid(field["boundary"])
    zones = build_risk_zones(field_id, field["name"], field["areaHa"], grid)
    center_lat, center_lng = _field_center(field)
    weather = await get_field_agro_weather(center_lat, center_lng)
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
        ["NDVI", f"{latest.get('ndviMean', '—')}", "NDMI", f"{latest.get('ndmiMean', '—')}"],
        ["Облачность", f"{latest.get('cloudCoveragePercent', '—')}%", "Очаги", str(zones.get("zonesCount", 0))],
        ["Амплитуда NDVI", f"{classification.get('amplitude') or '—'}", "Осадки 7д", f"{weather['forecast7d']['precipSum']:.1f} мм"],
    ]
    summary = Table(summary_data, colWidths=[92, 116, 92, 116])
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
        zone_rows.append(["—", "0 га", "—", "Очаги не выделены", "Плановый мониторинг"])
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
    story.append(Paragraph(f"Источник: {satellite.get('source')} · {weather.get('source')} · сформировано {datetime.now(timezone.utc).date().isoformat()}", styles["Italic"]))
    doc.build(story)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


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
# Satellite, Zones, Weather
# ---------------------------------------------------------------------------

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
                weather["current"]["temperature"],
                weather["current"]["humidity"],
                weather["current"]["windSpeed"],
                weather["forecast7d"]["precipSum"],
            ])
    else:
        writer.writerow([
            field["id"],
            field["name"],
            "",
            "",
            "",
            "",
            weather["current"]["temperature"],
            weather["current"]["humidity"],
            weather["current"]["windSpeed"],
            weather["forecast7d"]["precipSum"],
        ])
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers=_attachment_headers(f"tanap-{field_id}.csv"),
    )


@app.get("/api/fields/{field_id}/export/pdf")
async def export_field_pdf(field_id: str, user_id: str = Depends(require_user)) -> Response:
    field, satellite, zones, weather = await _load_analysis_bundle(field_id, user_id)
    classification = classify_land_use(satellite.get("observations", []))
    pdf = _build_pdf_report(field, satellite, zones, weather, classification)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers=_attachment_headers(f"tanap-{field_id}.pdf"),
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
