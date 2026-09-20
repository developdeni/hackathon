from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any
from urllib.parse import parse_qsl


DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60


def validate_telegram_init_data(
    init_data: str,
    bot_token: str,
    *,
    max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
    now: int | None = None,
) -> dict[str, Any]:
    """Validate Telegram Mini App initData and return its signed user object."""
    if not init_data:
        raise ValueError("Telegram initData отсутствует")
    if not bot_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN не настроен")

    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    values: dict[str, str] = {}
    for key, value in pairs:
        if key in values:
            raise ValueError("Telegram initData содержит повторяющиеся параметры")
        values[key] = value

    received_hash = values.pop("hash", "")
    if not received_hash:
        raise ValueError("Telegram initData не содержит подпись")

    data_check_string = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected_hash = hmac.new(
        secret_key,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_hash, received_hash):
        raise ValueError("Подпись Telegram initData недействительна")

    try:
        auth_date = int(values["auth_date"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Telegram initData не содержит корректную дату авторизации") from exc

    current_time = int(time.time()) if now is None else now
    if auth_date > current_time + 300:
        raise ValueError("Дата Telegram initData находится в будущем")
    if current_time - auth_date > max_age_seconds:
        raise ValueError("Telegram initData устарела, откройте Mini App заново")

    try:
        user = json.loads(values["user"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("Telegram initData не содержит пользователя") from exc
    if not isinstance(user, dict) or not user.get("id"):
        raise ValueError("Telegram initData содержит некорректного пользователя")
    return user
