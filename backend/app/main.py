from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .database import (
    UPLOADS_DIR,
    connect,
    field_from_row,
    initialize_database,
    inspection_from_row,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="Tanap AI Local API",
    version="0.1.0",
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


@app.get("/health")
def health() -> dict[str, str]:
    with connect() as connection:
        connection.execute("SELECT 1").fetchone()
    return {
        "status": "ok",
        "database": "connected",
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/dashboard")
def dashboard() -> dict[str, int]:
    with connect() as connection:
        fields = connection.execute("SELECT COUNT(*) AS count FROM fields").fetchone()["count"]
        inspections = connection.execute("SELECT COUNT(*) AS count FROM inspections").fetchone()["count"]
    return {"fieldCount": fields, "inspectionCount": inspections}


@app.get("/api/fields")
def list_fields() -> list[dict]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT f.*, COUNT(i.id) AS inspection_count
            FROM fields f
            LEFT JOIN inspections i ON i.field_id = f.id
            GROUP BY f.id
            ORDER BY f.name
            """
        ).fetchall()
    return [field_from_row(row) for row in rows]


@app.get("/api/fields/{field_id}")
def get_field(field_id: str) -> dict:
    with connect() as connection:
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
    if row is None:
        raise HTTPException(status_code=404, detail="Поле не найдено")
    return field_from_row(row)


@app.get("/api/fields/{field_id}/inspections")
def list_inspections(field_id: str, request: Request) -> list[dict]:
    with connect() as connection:
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
    note: str = Form(default=""),
    latitude: float | None = Form(default=None),
    longitude: float | None = Form(default=None),
    photo: UploadFile | None = File(default=None),
) -> dict:
    with connect() as connection:
        field_exists = connection.execute("SELECT 1 FROM fields WHERE id = ?", (field_id,)).fetchone()
    if field_exists is None:
        raise HTTPException(status_code=404, detail="Поле не найдено")
    if not note.strip() and photo is None:
        raise HTTPException(status_code=422, detail="Добавьте заметку или фотографию")

    inspection_id = f"inspection-{uuid4()}"
    photo_path: str | None = None
    if photo is not None:
        suffix = Path(photo.filename or "photo.jpg").suffix.lower() or ".jpg"
        if suffix not in {".jpg", ".jpeg", ".png", ".heic", ".webp"}:
            suffix = ".jpg"
        filename = f"{inspection_id}{suffix}"
        destination = UPLOADS_DIR / filename
        destination.write_bytes(await photo.read())
        photo_path = f"/uploads/{filename}"

    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO inspections
            (id, field_id, created_at, note, photo_path, latitude, longitude, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'saved')
            """,
            (inspection_id, field_id, created_at, note.strip(), photo_path, latitude, longitude),
        )
        row = connection.execute("SELECT * FROM inspections WHERE id = ?", (inspection_id,)).fetchone()

    return inspection_from_row(row, str(request.base_url))


@app.get("/api/inspections/{inspection_id}")
def get_inspection(inspection_id: str, request: Request) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT * FROM inspections WHERE id = ?", (inspection_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Осмотр не найден")
    return inspection_from_row(row, str(request.base_url))
