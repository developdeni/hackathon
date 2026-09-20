import hashlib
import hmac
import json
import unittest
from urllib.parse import parse_qsl, urlencode

from backend.app.telegram_auth import validate_telegram_init_data


BOT_TOKEN = "123456:test-token"
NOW = 1_800_000_000


def signed_init_data(*, user_id: int = 42, auth_date: int = NOW) -> str:
    values = {
        "auth_date": str(auth_date),
        "query_id": "AAEAAAE",
        "user": json.dumps(
            {"id": user_id, "first_name": "Айдар", "username": "aidar"},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }
    data_check_string = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(values)


class TelegramInitDataTests(unittest.TestCase):
    def test_valid_signed_user_is_returned(self):
        user = validate_telegram_init_data(signed_init_data(), BOT_TOKEN, now=NOW)
        self.assertEqual(user["id"], 42)
        self.assertEqual(user["username"], "aidar")

    def test_tampered_user_is_rejected(self):
        values = dict(parse_qsl(signed_init_data()))
        user = json.loads(values["user"])
        user["id"] = 99
        values["user"] = json.dumps(user, ensure_ascii=False, separators=(",", ":"))
        payload = urlencode(values)
        with self.assertRaisesRegex(ValueError, "[Пп]одпись"):
            validate_telegram_init_data(payload, BOT_TOKEN, now=NOW)

    def test_expired_payload_is_rejected(self):
        payload = signed_init_data(auth_date=NOW - 86_401)
        with self.assertRaisesRegex(ValueError, "устарела"):
            validate_telegram_init_data(payload, BOT_TOKEN, now=NOW)
