import json
import secrets
import sqlite3
from pathlib import Path
from typing import Any


# Алфавит без похожих символов (0/O, 1/I) — читаемый ID для человека.
_PUBLIC_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_public_id(existing: set[str] | None = None) -> str:
    """Короткий отображаемый ID вида TA-XXXXXX (уникальный в пределах existing)."""
    existing = existing or set()
    while True:
        code = "TA-" + "".join(secrets.choice(_PUBLIC_ID_ALPHABET) for _ in range(6))
        if code not in existing:
            return code


BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
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

            CREATE TABLE IF NOT EXISTS yield_history (
                id TEXT PRIMARY KEY NOT NULL,
                field_id TEXT NOT NULL,
                season_year INTEGER NOT NULL,
                crop_type TEXT NOT NULL,
                yield_t_ha REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'farm_record',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(field_id, season_year),
                FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_yield_history_field_year
            ON yield_history(field_id, season_year DESC);
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

        # Telegram account linking: which Telegram user id an app account is bound to.
        user_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(users)").fetchall()
        }
        if "telegram_id" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN telegram_id TEXT")

        # Подтверждён ли email пользователя (0/1). Существующие аккаунты — 0.
        if "email_verified" not in user_columns:
            connection.execute(
                "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"
            )

        # Short-lived one-time codes that bind a Telegram user to an app account.
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_link_codes (
                code TEXT PRIMARY KEY NOT NULL,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )

        # Коды подтверждения email (смена адреса или верификация текущего).
        # Один активный код на пользователя (user_id — первичный ключ).
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS email_change_codes (
                user_id TEXT PRIMARY KEY NOT NULL,
                new_email TEXT NOT NULL,
                code TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )

        # Отображаемый короткий ID пользователя (для приглашений в команду).
        if "public_id" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN public_id TEXT")
        # Бэкфилл для существующих аккаунтов без public_id.
        existing_ids = {
            r["public_id"]
            for r in connection.execute(
                "SELECT public_id FROM users WHERE public_id IS NOT NULL"
            ).fetchall()
        }
        for r in connection.execute("SELECT id FROM users WHERE public_id IS NULL").fetchall():
            new_pid = generate_public_id(existing_ids)
            existing_ids.add(new_pid)
            connection.execute("UPDATE users SET public_id = ? WHERE id = ?", (new_pid, r["id"]))
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id)"
        )

        # Командный доступ: владелец профиля делится им с другим пользователем.
        # status: pending (приглашение) / active (принято) / declined / revoked.
        # permissions — JSON-массив флагов из {view, ai, edit, inspect}.
        # field_scope: 'all' | 'selected'; field_ids — JSON-массив id участков.
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS profile_shares (
                id TEXT PRIMARY KEY NOT NULL,
                profile_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                grantee_id TEXT NOT NULL,
                permissions_json TEXT NOT NULL DEFAULT '[]',
                field_scope TEXT NOT NULL DEFAULT 'all',
                field_ids_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(profile_id, grantee_id)
            );
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_profile_shares_grantee ON profile_shares(grantee_id, status)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_profile_shares_profile ON profile_shares(profile_id, status)"
        )

        # Реестр верификации отчётов и агропаспортов полей.
        # Хранит криптографические контрольные суммы (SHA-256) и метаданные
        # для публичной проверки подлинности по QR-коду.
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS report_verifications (
                id TEXT PRIMARY KEY NOT NULL,
                field_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                report_num TEXT NOT NULL,
                file_sha256 TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                pdf_path TEXT NOT NULL,
                meta_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_report_verifications_field ON report_verifications(field_id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_report_verifications_num ON report_verifications(report_num)"
        )

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
    keys = row.keys()
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "organization": row["organization"],
        "region": row["region"],
        "createdAt": row["created_at"],
        "telegramLinked": bool(row["telegram_id"]) if "telegram_id" in keys else False,
        "emailVerified": bool(row["email_verified"]) if "email_verified" in keys else False,
        "publicId": row["public_id"] if "public_id" in keys else None,
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


def yield_history_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "fieldId": row["field_id"],
        "seasonYear": row["season_year"],
        "cropType": row["crop_type"],
        "yieldTPerHa": row["yield_t_ha"],
        "source": row["source"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
    }


def report_verification_from_row(row: sqlite3.Row) -> dict[str, Any]:
    meta = {}
    try:
        meta = json.loads(row["meta_json"]) if row["meta_json"] else {}
    except Exception:
        meta = {}
    return {
        "id": row["id"],
        "fieldId": row["field_id"],
        "userId": row["user_id"],
        "reportNum": row["report_num"],
        "fileSha256": row["file_sha256"],
        "payloadSha256": row["payload_sha256"],
        "pdfPath": row["pdf_path"],
        "metadata": meta,
        "createdAt": row["created_at"],
    }


def save_report_verification(
    connection: sqlite3.Connection,
    report_id: str,
    field_id: str,
    user_id: str,
    report_num: str,
    file_sha256: str,
    payload_sha256: str,
    pdf_path: str,
    metadata: dict[str, Any],
    created_at: str,
) -> None:
    meta_json = json.dumps(metadata, ensure_ascii=False)
    connection.execute(
        """
        INSERT INTO report_verifications (
            id, field_id, user_id, report_num, file_sha256, payload_sha256, pdf_path, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            file_sha256 = excluded.file_sha256,
            payload_sha256 = excluded.payload_sha256,
            pdf_path = excluded.pdf_path,
            meta_json = excluded.meta_json,
            created_at = excluded.created_at
        """,
        (
            report_id,
            field_id,
            user_id,
            report_num,
            file_sha256,
            payload_sha256,
            pdf_path,
            meta_json,
            created_at,
        ),
    )


def get_report_verification(connection: sqlite3.Connection, identifier: str) -> dict[str, Any] | None:
    """Ищет запись верификации по id (report_id) или по реестровому номеру report_num."""
    ident = identifier.strip()
    row = connection.execute(
        "SELECT * FROM report_verifications WHERE id = ? OR report_num = ?",
        (ident, ident),
    ).fetchone()
    return report_verification_from_row(row) if row is not None else None

