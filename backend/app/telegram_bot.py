import asyncio
import logging
import os
import httpx

logger = logging.getLogger("telegram_bot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
MINI_APP_URL = os.getenv("MINI_APP_URL", "https://lamps-sat-increases-pencil.trycloudflare.com/tma/")
# Local Tanap AI backend (same host) — used to confirm account-link codes.
LOCAL_API_BASE = os.getenv("LOCAL_API_BASE", "http://127.0.0.1:8000")

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"


async def send_text(chat_id: int, text: str) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(
            f"{API_BASE}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
        )


async def handle_link_code(chat_id: int, from_user: dict, code: str) -> None:
    """Bind the Telegram user to the app account that generated `code`."""
    tg_id = from_user.get("id")
    tg_name = " ".join(
        p for p in [from_user.get("first_name"), from_user.get("last_name")] if p
    ) or from_user.get("username") or "Агроном"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{LOCAL_API_BASE}/api/auth/telegram-link-confirm",
                json={"code": code, "telegramId": tg_id, "telegramName": tg_name},
            )
        if resp.status_code == 200:
            data = resp.json()
            name = data.get("name", "")
            merged = data.get("merged")
            extra = " Ваши прежние данные из Telegram-входа объединены в один аккаунт." if merged else ""
            await send_text(
                chat_id,
                f"✅ <b>Telegram привязан к аккаунту «{name}».</b>{extra}\n\n"
                "Теперь вход через Telegram открывает этот же аккаунт. Откройте приложение кнопкой меню 🌾.",
            )
        else:
            try:
                detail = resp.json().get("detail", "Не удалось привязать аккаунт.")
            except Exception:
                detail = "Не удалось привязать аккаунт."
            await send_text(chat_id, f"⚠️ {detail}\n\nСгенерируйте новый код в приложении и повторите.")
    except Exception as exc:
        logger.error("link confirm error: %s", exc)
        await send_text(chat_id, "⚠️ Сервис привязки временно недоступен. Повторите позже.")


async def setup_bot_ui():
    """Configures the persistent menu button and commands in Telegram UI."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1. Set Chat Menu Button to WebApp
        menu_payload = {
            "menu_button": {
                "type": "web_app",
                "text": "🌾 Запустить Tanap AI",
                "web_app": {"url": MINI_APP_URL},
            }
        }
        resp = await client.post(f"{API_BASE}/setChatMenuButton", json=menu_payload)
        logger.info("setChatMenuButton: %s", resp.text)

        # 2. Set Bot Commands
        commands_payload = {
            "commands": [
                {"command": "start", "description": "🚀 Запустить Tanap AI Mini App"},
                {"command": "app", "description": "🌾 Открыть агрономическую платформу"},
                {"command": "help", "description": "ℹ️ Описание возможностей Tanap AI"},
            ]
        }
        resp = await client.post(f"{API_BASE}/setMyCommands", json=commands_payload)
        logger.info("setMyCommands: %s", resp.text)


async def send_welcome_message(chat_id: int, user_first_name: str = "Агроном"):
    """Sends a rich greeting card with Mini App launch button."""
    text = (
        f"🌾 <b>Добро пожаловать в Tanap AI, {user_first_name}!</b>\n\n"
        "<b>Tanap AI</b> — современная платформа спутникового мониторинга и агрономического анализа "
        "для хозяйств Казахстана (Акмолинская, Костанайская, СКО и другие регионы):\n\n"
        "• 🛰️ <b>Sentinel-2 L2A</b>: спектральный мониторинг полей, биомасса NDVI и влагообеспеченность NDMI\n"
        "• 🤖 <b>AI-Агроном Google Gemini</b>: расчёт норм высева, защита растений, листовые подкормки и баковые смеси\n"
        "• 📄 <b>Полевой отчёт</b>: спутниковая аналитика и данные хозяйства в PDF\n"
        "• ⚡ <b>Мгновенный доступ</b>: вход без пароля прямо через Telegram!\n\n"
        "<i>Нажмите кнопку ниже для запуска платформы:</i>"
    )
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": {
            "inline_keyboard": [
                [
                    {
                        "text": "🚀 Открыть Tanap AI",
                        "web_app": {"url": MINI_APP_URL},
                    }
                ],
                [
                    {
                        "text": "📋 Мои поля и отчёты",
                        "web_app": {"url": MINI_APP_URL},
                    }
                ],
            ]
        },
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(f"{API_BASE}/sendMessage", json=payload)


async def poll_telegram_updates():
    if not BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required")
    """Lightweight long-polling loop for the bot."""
    await setup_bot_ui()
    offset = 0
    logger.info("Telegram Bot @tanapai_aqmola_bot started polling...")

    async with httpx.AsyncClient(timeout=35.0) as client:
        while True:
            try:
                resp = await client.get(
                    f"{API_BASE}/getUpdates",
                    params={"offset": offset, "timeout": 25},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for update in data.get("result", []):
                        offset = update["update_id"] + 1
                        msg = update.get("message")
                        if not msg:
                            continue
                        chat_id = msg.get("chat", {}).get("id")
                        from_user = msg.get("from", {})
                        first_name = from_user.get("first_name", "Агроном")
                        text = (msg.get("text") or "").strip()
                        if not chat_id:
                            continue
                        # Deep-link account binding: `/start link<code>`
                        payload_arg = ""
                        if text.startswith("/start"):
                            parts = text.split(maxsplit=1)
                            if len(parts) > 1:
                                payload_arg = parts[1].strip()
                        if payload_arg.startswith("link") and len(payload_arg) > 4:
                            await handle_link_code(chat_id, from_user, payload_arg[4:])
                        else:
                            await send_welcome_message(chat_id, first_name)
                elif resp.status_code == 409:
                    logger.warning("Conflict with another instance, retrying...")
                    await asyncio.sleep(5)
                else:
                    await asyncio.sleep(2)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Error in bot polling: %s", exc)
                await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(poll_telegram_updates())
