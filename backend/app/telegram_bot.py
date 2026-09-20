import asyncio
import logging
import os
import httpx

logger = logging.getLogger("telegram_bot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8885044592:AAEAXGQKCrNnQqC__eduZ8iSDYGtHsArEsA")
MINI_APP_URL = os.getenv("MINI_APP_URL", "https://lamps-sat-increases-pencil.trycloudflare.com/tma/")

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"


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
        "• 📄 <b>Агрономический паспорт</b>: официальный PDF в 1 клик для АО «АКК» и банков\n"
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
                        "text": "📋 Мои поля и кадастр",
                        "web_app": {"url": MINI_APP_URL},
                    }
                ],
            ]
        },
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(f"{API_BASE}/sendMessage", json=payload)


async def poll_telegram_updates():
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
                        if chat_id:
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
