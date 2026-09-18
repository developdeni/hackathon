import json
import sqlite3
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
DATABASE_PATH = DATA_DIR / "tanap.db"

DEMO_FIELDS = [
    {
        "id": "demo-field-wheat",
        "name": "Северное поле",
        "cropType": "Пшеница",
        "areaHa": 126.4,
        "boundary": [
            {"latitude": 53.303, "longitude": 69.385},
            {"latitude": 53.307, "longitude": 69.399},
            {"latitude": 53.299, "longitude": 69.405},
            {"latitude": 53.294, "longitude": 69.39},
        ],
    },
    {
        "id": "demo-field-rapeseed",
        "name": "У озера",
        "cropType": "Рапс",
        "areaHa": 84.7,
        "boundary": [
            {"latitude": 53.276, "longitude": 69.43},
            {"latitude": 53.282, "longitude": 69.443},
            {"latitude": 53.274, "longitude": 69.449},
            {"latitude": 53.269, "longitude": 69.436},
        ],
    },
    {
        "id": "demo-field-potato",
        "name": "Долинное поле",
        "cropType": "Картофель",
        "areaHa": 38.2,
        "boundary": [
            {"latitude": 53.326, "longitude": 69.344},
            {"latitude": 53.329, "longitude": 69.353},
            {"latitude": 53.323, "longitude": 69.358},
            {"latitude": 53.319, "longitude": 69.348},
        ],
    },
]


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    with connect() as connection:
        connection.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS fields (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                crop_type TEXT NOT NULL,
                area_ha REAL NOT NULL,
                boundary_json TEXT NOT NULL,
                is_demo INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inspections (
                id TEXT PRIMARY KEY NOT NULL,
                field_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                photo_path TEXT,
                latitude REAL,
                longitude REAL,
                status TEXT NOT NULL DEFAULT 'saved',
                FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE
            );
            """
        )
        for field in DEMO_FIELDS:
            connection.execute(
                """
                INSERT OR IGNORE INTO fields
                (id, name, crop_type, area_ha, boundary_json, is_demo, created_at)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    field["id"],
                    field["name"],
                    field["cropType"],
                    field["areaHa"],
                    json.dumps(field["boundary"], ensure_ascii=False),
                    "2026-09-17T00:00:00.000Z",
                ),
            )


def field_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "cropType": row["crop_type"],
        "areaHa": row["area_ha"],
        "boundary": json.loads(row["boundary_json"]),
        "isDemo": bool(row["is_demo"]),
        "inspectionCount": row["inspection_count"],
    }


def inspection_from_row(row: sqlite3.Row, base_url: str) -> dict[str, Any]:
    photo_path = row["photo_path"]
    return {
        "id": row["id"],
        "fieldId": row["field_id"],
        "createdAt": row["created_at"],
        "note": row["note"],
        "photoUrl": f"{base_url.rstrip('/')}{photo_path}" if photo_path else None,
        "latitude": row["latitude"],
        "longitude": row["longitude"],
        "status": row["status"],
    }
