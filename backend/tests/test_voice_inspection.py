import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.app import ai_advisor, database, main, telegram_bot


class VoiceInspectionTests(unittest.IsolatedAsyncioTestCase):
    def test_process_agronomic_voice_report(self):
        dummy_audio = b"fake-ogg-audio-data"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "🌾 Состояние: Всходы равномерные\n⚠️ Проблемы: Единичные сорняки"}
                        ]
                    }
                }
            ]
        }

        with (
            patch.object(ai_advisor, "GEMINI_API_KEYS", ["test-key"]),
            patch("httpx.Client.post", return_value=mock_response),
        ):
            result = ai_advisor.process_agronomic_voice_report(
                audio_bytes=dummy_audio,
                mime_type="audio/ogg",
                field_context={"name": "Поле 1", "cropType": "Пшеница", "areaHa": 100},
            )

        self.assertIn("Состояние: Всходы равномерные", result)
        self.assertIn("Проблемы: Единичные сорняки", result)

    def test_process_agronomic_text_report(self):
        with patch.object(ai_advisor, "ask_agronomic_advisor", return_value="🌾 Фаза кущения. 💡 Обработка не требуется."):
            result = ai_advisor.process_agronomic_text_report("Осмотрел пшеницу, всё хорошо")
            self.assertIn("Фаза кущения", result)

    async def test_voice_inspection_summary_endpoint(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(database, "DATABASE_PATH", root / "tanap.db"):
                database.initialize_database()
                with database.connect() as conn:
                    conn.execute(
                        "INSERT INTO users (id, name, email, password_hash, organization, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        ("user-1", "Agro", "agro@example.com", "hash", "Farm", "Akmola", "2026-09-21"),
                    )
                    conn.execute(
                        "INSERT INTO profiles (id, user_id, name, region, created_at) VALUES (?, ?, ?, ?, ?)",
                        ("prof-1", "user-1", "Farm", "Akmola", "2026-09-21"),
                    )
                    conn.execute(
                        "INSERT INTO fields (id, user_id, profile_id, name, crop_type, area_ha, perimeter_km, boundary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        ("f-1", "user-1", "prof-1", "Северное", "Ячмень", 50, 2, "[]", "2026-09-21"),
                    )

                dummy_b64 = base64.b64encode(b"audio-bytes").decode("utf-8")
                from unittest.mock import AsyncMock
                req = MagicMock()
                req.headers = {"content-type": "application/json"}
                req.json = AsyncMock(return_value={"audioBase64": dummy_b64, "mimeType": "audio/webm"})

                with patch.object(ai_advisor, "process_agronomic_voice_report", return_value="Сформирован акт осмотра"):
                    res = await main.summarize_voice_inspection(
                        field_id="f-1",
                        request=req,
                        user_id="user-1",
                    )
                    self.assertTrue(res.get("success"))
                    self.assertEqual(res.get("fieldId"), "f-1")
                    self.assertEqual(res.get("summary"), "Сформирован акт осмотра")

    async def test_telegram_bot_voice_inspection_flow(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with (
                patch.object(database, "DATABASE_PATH", root / "tanap.db"),
                patch.object(telegram_bot, "UPLOADS_DIR", root / "uploads"),
            ):
                database.initialize_database()
                with database.connect() as conn:
                    conn.execute(
                        "INSERT INTO users (id, name, email, password_hash, organization, region, telegram_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        ("user-1", "Agro", "agro@example.com", "hash", "Farm", "Akmola", 999111, "2026-09-21"),
                    )
                    conn.execute(
                        "INSERT INTO profiles (id, user_id, name, region, created_at) VALUES (?, ?, ?, ?, ?)",
                        ("prof-1", "user-1", "Farm", "Akmola", "2026-09-21"),
                    )
                    conn.execute(
                        "INSERT INTO fields (id, user_id, profile_id, name, crop_type, area_ha, perimeter_km, boundary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        ("f-1", "user-1", "prof-1", "Клетка 4", "Пшеница", 80, 3, "[]", "2026-09-21"),
                    )

                from unittest.mock import AsyncMock
                # 1. Test start_inspection_flow lists fields
                with patch.object(telegram_bot, "send_text", AsyncMock()) as mock_send:
                    await telegram_bot.start_inspection_flow(12345, {"id": 999111})
                    mock_send.assert_awaited_once()
                    args = mock_send.await_args
                    self.assertIn("Клетка 4", str(args))

                # 2. Test callback query selects field
                cb = {
                    "id": "cb1",
                    "data": "insp:f:f-1",
                    "from": {"id": 999111},
                    "message": {"chat": {"id": 12345}},
                }
                with patch.object(telegram_bot, "send_text", AsyncMock()), patch.object(telegram_bot, "answer_callback_query", AsyncMock()):
                    await telegram_bot.handle_callback_query(cb)
                    self.assertEqual(telegram_bot.USER_INSPECTION_STATES[999111]["step"], "WAITING_VOICE")
                    self.assertEqual(telegram_bot.USER_INSPECTION_STATES[999111]["field_id"], "f-1")

                # 3. Test voice message handling
                voice = {"file_id": "file-voice-1"}
                with (
                    patch.object(telegram_bot, "download_telegram_file", AsyncMock(return_value=b"voice-ogg")),
                    patch.object(ai_advisor, "process_agronomic_voice_report", return_value="🌾 Всходы дружные, сорняков нет"),
                    patch.object(telegram_bot, "send_text", AsyncMock()),
                    patch.object(telegram_bot, "send_chat_action", AsyncMock()),
                ):
                    await telegram_bot.handle_voice_message(12345, {"id": 999111}, voice)
                    self.assertEqual(telegram_bot.USER_INSPECTION_STATES[999111]["step"], "WAITING_PHOTO")
                    self.assertIn("Всходы дружные", telegram_bot.USER_INSPECTION_STATES[999111]["summary"])

                # 4. Test photo handling saves inspection in DB
                photo = [{"file_id": "photo-thumb"}, {"file_id": "photo-large"}]
                with (
                    patch.object(telegram_bot, "download_telegram_file", AsyncMock(return_value=b"fake-photo")),
                    patch.object(telegram_bot, "send_text", AsyncMock()),
                ):
                    await telegram_bot.handle_inspection_photo(12345, {"id": 999111}, photo)
                    self.assertNotIn(999111, telegram_bot.USER_INSPECTION_STATES)

                    with database.connect() as conn:
                        insp = conn.execute("SELECT * FROM inspections WHERE field_id = 'f-1'").fetchone()
                    self.assertIsNotNone(insp)
                    self.assertIn("Всходы дружные", insp["note"])
                    self.assertTrue(insp["photo_path"].startswith("/uploads/inspection-tg-"))


if __name__ == "__main__":
    unittest.main()
