import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app import database, main


class InspectionDeleteTests(unittest.TestCase):
    def test_delete_removes_database_record_and_uploaded_photo(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            uploads = root / "uploads"
            uploads.mkdir()
            photo = uploads / "inspection-test.jpg"
            photo.write_bytes(b"photo")

            with (
                patch.object(database, "DATABASE_PATH", root / "tanap.db"),
                patch.object(main, "UPLOADS_DIR", uploads),
            ):
                database.initialize_database()
                with database.connect() as connection:
                    connection.execute(
                        "INSERT INTO users (id, name, email, password_hash, organization, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        ("user-1", "Owner", "owner@example.test", "hash", "Farm", "Region", "2026-09-21"),
                    )
                    connection.execute(
                        "INSERT INTO profiles (id, user_id, name, region, created_at) VALUES (?, ?, ?, ?, ?)",
                        ("profile-1", "user-1", "Farm", "Region", "2026-09-21"),
                    )
                    connection.execute(
                        "INSERT INTO fields (id, user_id, profile_id, name, crop_type, area_ha, perimeter_km, boundary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        ("field-1", "user-1", "profile-1", "Field", "Wheat", 10, 1, "[]", "2026-09-21"),
                    )
                    connection.execute(
                        "INSERT INTO inspections (id, field_id, created_at, note, photo_path, status) VALUES (?, ?, ?, ?, ?, ?)",
                        ("inspection-1", "field-1", "2026-09-21", "Note", "/uploads/inspection-test.jpg", "saved"),
                    )

                main.delete_inspection("inspection-1", "user-1")

                with database.connect() as connection:
                    row = connection.execute(
                        "SELECT id FROM inspections WHERE id = ?", ("inspection-1",)
                    ).fetchone()
                self.assertIsNone(row)
                self.assertFalse(photo.exists())


if __name__ == "__main__":
    unittest.main()
