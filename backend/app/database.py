import json
import sqlite3
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
DATABASE_PATH = DATA_DIR / "tanap.db"


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

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                organization TEXT NOT NULL DEFAULT '',
                region TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT,
                name TEXT NOT NULL,
                region TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS fields (
                id TEXT PRIMARY KEY NOT NULL,
                user_id TEXT,
                profile_id TEXT NOT NULL DEFAULT 'profile-akmola-agro',
                name TEXT NOT NULL,
                crop_type TEXT NOT NULL,
                area_ha REAL NOT NULL,
                perimeter_km REAL NOT NULL DEFAULT 0.0,
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

        # Migrations — add new columns to existing tables if missing
        field_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(fields)").fetchall()
        }
        if "profile_id" not in field_columns:
            connection.execute(
                "ALTER TABLE fields ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'profile-akmola-agro'"
            )
        if "perimeter_km" not in field_columns:
            connection.execute(
                "ALTER TABLE fields ADD COLUMN perimeter_km REAL NOT NULL DEFAULT 0.0"
            )
        if "user_id" not in field_columns:
            connection.execute("ALTER TABLE fields ADD COLUMN user_id TEXT")

        profile_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(profiles)").fetchall()
        }
        if "user_id" not in profile_columns:
            connection.execute("ALTER TABLE profiles ADD COLUMN user_id TEXT")

        # Убираем старые ОБЩИЕ (не привязанные к пользователю) профили и поля —
        # именно они раньше показывались всем сразу. Теперь данные строго
        # индивидуальны, и новые аккаунты создаются ПУСТЫМИ (без демо-данных).
        connection.execute("DELETE FROM fields WHERE user_id IS NULL")
        connection.execute("DELETE FROM profiles WHERE user_id IS NULL")

        # Разовая чистка ранее авто-созданных демо-данных (демо-поля и пустые
        # авто-профили «ТОО Акмола-Агро»/«Личный профиль»), чтобы у пользователей
        # не оставалось того, что раньше подставлялось автоматически.
        migration_version = connection.execute("PRAGMA user_version").fetchone()[0]
        if migration_version < 1:
            connection.execute("DELETE FROM fields WHERE is_demo = 1")
            connection.execute(
                """
                DELETE FROM profiles
                WHERE name IN ('ТОО «Акмола-Агро»', 'Личный профиль')
                  AND id NOT IN (SELECT DISTINCT profile_id FROM fields)
                """
            )
            connection.execute("PRAGMA user_version = 1")


def profile_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "region": row["region"],
        "createdAt": row["created_at"],
        "fieldCount": row["field_count"] if "field_count" in row.keys() else 0,
    }


def field_from_row(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {
        "id": row["id"],
        "profileId": row["profile_id"],
        "name": row["name"],
        "cropType": row["crop_type"],
        "areaHa": row["area_ha"],
        "perimeterKm": row["perimeter_km"] if "perimeter_km" in keys else 0.0,
        "boundary": json.loads(row["boundary_json"]),
        "isDemo": bool(row["is_demo"]),
        "inspectionCount": row["inspection_count"] if "inspection_count" in keys else 0,
    }


def user_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "organization": row["organization"],
        "region": row["region"],
        "createdAt": row["created_at"],
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
