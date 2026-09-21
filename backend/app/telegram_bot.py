import asyncio
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import sys
from uuid import uuid4
import httpx

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from .database import UPLOADS_DIR, connect
    from .main import get_accessible_fields_for_user
    from . import ai_advisor
except (ImportError, ValueError):
    from app.database import UPLOADS_DIR, connect
    from app.main import get_accessible_fields_for_user
    from app import ai_advisor


logger = logging.getLogger("telegram_bot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "8885044592:AAEAXGQKCrNnQqC__eduZ8iSDYGtHsArEsA").strip()
MINI_APP_URL = os.getenv("MINI_APP_URL", "https://lamps-sat-increases-pencil.trycloudflare.com/tma/")
LOCAL_API_BASE = os.getenv("LOCAL_API_BASE", "http://127.0.0.1:8000")

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# In-memory session states for inspection recording:
# { telegram_id: { "step": "WAITING_VOICE"|"WAITING_PHOTO", "field_id": ..., "field_name": ..., "crop_type": ..., "area_ha": ..., "summary": ... } }
USER_INSPECTION_STATES: dict[int, dict] = {}


async def send_text(chat_id: int, text: str, reply_markup: dict | None = None) -> None:
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(f"{API_BASE}/sendMessage", json=payload)
    except Exception as exc:
        logger.error("send_text error: %s", exc)


async def send_chat_action(chat_id: int, action: str = "typing") -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{API_BASE}/sendChatAction", json={"chat_id": chat_id, "action": action})
    except Exception:
        pass


async def answer_callback_query(callback_query_id: str, text: str | None = None) -> None:
    payload = {"callback_query_id": callback_query_id}
    if text:
        payload["text"] = text
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{API_BASE}/answerCallbackQuery", json=payload)
    except Exception:
        pass


async def download_telegram_file(file_id: str) -> bytes:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{API_BASE}/getFile", json={"file_id": file_id})
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to getFile: {resp.text}")
        file_path = resp.json().get("result", {}).get("file_path")
        if not file_path:
            raise RuntimeError("Missing file_path in getFile response")
        download_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
        file_resp = await client.get(download_url)
        if file_resp.status_code != 200:
            raise RuntimeError(f"Failed to download file: {file_resp.status_code}")
        return file_resp.content


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
                "Теперь вы можете записывать голосовые осмотры полей командой /report "
                "или открывать приложение кнопкой меню 🌾.",
                reply_markup={
                    "inline_keyboard": [
                        [{"text": "🎙️ Записать осмотр поля", "callback_data": "insp:start"}],
                        [{"text": "🌾 Запустить Tanap AI", "web_app": {"url": MINI_APP_URL}}],
                    ]
                },
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


async def start_inspection_flow(chat_id: int, from_user: dict) -> None:
    """Starts the interactive field inspection flow."""
    tg_id = from_user.get("id")
    tg_id_str = str(tg_id) if tg_id is not None else ""
    with connect() as conn:
        user_row = conn.execute(
            "SELECT id, name, organization FROM users WHERE telegram_id = ? OR telegram_id = ?",
            (tg_id_str, tg_id),
        ).fetchone()
        if not user_row:
            await send_text(
                chat_id,
                "🌾 <b>Аккаунт не привязан</b>\n\n"
                "Чтобы записывать голосовые отчёты по вашим участкам, откройте Tanap AI по кнопке ниже — "
                "вход произойдёт мгновенно, и бот подключится к вашему хозяйству:",
                reply_markup={
                    "inline_keyboard": [
                        [{"text": "🚀 Войти в Tanap AI (1 клик)", "web_app": {"url": MINI_APP_URL}}]
                    ]
                },
            )
            return

        fields = get_accessible_fields_for_user(conn, user_row["id"])

    if not fields:
        await send_text(
            chat_id,
            f"🌾 <b>У вас пока нет участков, {user_row['name']}</b>\n\n"
            "Добавьте первое поле хозяйства на спутниковой карте в Tanap AI:",
            reply_markup={
                "inline_keyboard": [
                    [{"text": "🌾 Добавить поле в Tanap AI", "web_app": {"url": MINI_APP_URL}}]
                ]
            },
        )
        return

    buttons = []
    for f in fields[:12]:
        crop = f.get("cropType") or f.get("crop_type") or "Поле"
        area = f.get("areaHa") or f.get("area_ha")
        area_str = f", {float(area):.1f} га" if area else ""
        btn_text = f"🌾 {f['name']} ({crop}{area_str})"
        buttons.append([{"text": btn_text, "callback_data": f"insp:f:{f['id']}"}])

    buttons.append([{"text": "❌ Отмена", "callback_data": "insp:cancel"}])

    USER_INSPECTION_STATES[tg_id] = {"step": "SELECT_FIELD"}

    await send_text(
        chat_id,
        "📋 <b>Выберите поле для фиксации осмотра:</b>\n\n"
        "Нажмите на нужное поле из вашего хозяйства:",
        reply_markup={"inline_keyboard": buttons},
    )


async def handle_callback_query(callback_query: dict) -> None:
    cb_id = callback_query.get("id")
    data = callback_query.get("data") or ""
    from_user = callback_query.get("from", {})
    tg_id = from_user.get("id")
    message = callback_query.get("message", {})
    chat_id = message.get("chat", {}).get("id")

    await answer_callback_query(cb_id)

    if not chat_id:
        return

    if data == "insp:cancel":
        USER_INSPECTION_STATES.pop(tg_id, None)
        await send_text(chat_id, "❌ Запись осмотра отменена.")
        return

    if data == "insp:start":
        await start_inspection_flow(chat_id, from_user)
        return

    if data.startswith("insp:f:"):
        field_id = data.split("insp:f:")[1]
        with connect() as conn:
            row = conn.execute("SELECT * FROM fields WHERE id = ?", (field_id,)).fetchone()
        if not row:
            await send_text(chat_id, "⚠️ Участок не найден. Повторите выбор /report.")
            return

        crop_name = row["crop_type"] or "Культура"
        area_val = row["area_ha"] or 0
        USER_INSPECTION_STATES[tg_id] = {
            "step": "WAITING_VOICE",
            "field_id": field_id,
            "field_name": row["name"],
            "crop_type": crop_name,
            "area_ha": area_val,
        }

        await send_text(
            chat_id,
            f"🌾 <b>Выбрано поле: {row['name']}</b> ({crop_name}, {area_val:.1f} га)\n\n"
            "🎤 <b>Запишите голосовое сообщение</b> с описанием ситуации на участке (или отправьте текст):\n\n"
            "<i>Расскажите о всходах, фазе развития, сорняках, вредителях, влажности почвы или нужных обработках.\n"
            "AI-агроном Tanap AI прослушает запись и составит структурированный акт осмотра.</i>\n\n"
            "<i>(Для отмены отправьте /cancel)</i>",
        )


async def handle_voice_message(chat_id: int, from_user: dict, voice_obj: dict) -> None:
    tg_id = from_user.get("id")
    state = USER_INSPECTION_STATES.get(tg_id)
    if not state or state.get("step") != "WAITING_VOICE":
        await send_welcome_message(chat_id, from_user.get("first_name", "Агроном"))
        return

    await send_chat_action(chat_id, "record_voice")
    await send_text(chat_id, "⏳ <i>AI-агроном Tanap AI слушает и анализирует вашу голосовую запись...</i>")

    try:
        file_id = voice_obj.get("file_id")
        audio_bytes = await download_telegram_file(file_id)
        summary = ai_advisor.process_agronomic_voice_report(
            audio_bytes=audio_bytes,
            mime_type="audio/ogg",
            field_context={
                "name": state["field_name"],
                "cropType": state["crop_type"],
                "areaHa": state["area_ha"],
            },
        )
    except Exception as exc:
        logger.error("Error processing voice: %s", exc)
        summary = "Зафиксирован голосовой осмотр поля агрономом."

    state["step"] = "WAITING_PHOTO"
    state["summary"] = summary

    await send_text(
        chat_id,
        f"📋 <b>AI сформировал отчёт осмотра:</b>\n\n"
        f"{summary}\n\n"
        "📸 <b>Теперь прикрепите фото поля или культуры</b>\n"
        "<i>(или отправьте /skip_photo для сохранения акта без фото):</i>",
    )


async def handle_inspection_photo(chat_id: int, from_user: dict, photo_obj: list | None) -> None:
    tg_id = from_user.get("id")
    state = USER_INSPECTION_STATES.get(tg_id)
    if not state or state.get("step") != "WAITING_PHOTO":
        return

    photo_path = None
    if photo_obj:
        try:
            largest = photo_obj[-1]
            photo_bytes = await download_telegram_file(largest["file_id"])
            photo_filename = f"inspection-tg-{uuid4().hex[:12]}.jpg"
            UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            (UPLOADS_DIR / photo_filename).write_bytes(photo_bytes)
            photo_path = f"/uploads/{photo_filename}"
        except Exception as exc:
            logger.error("Error downloading photo: %s", exc)

    # Save to DB
    insp_id = f"inspection-{uuid4()}"
    with connect() as conn:
        conn.execute(
            "INSERT INTO inspections (id, field_id, created_at, note, photo_path, status) VALUES (?, ?, ?, ?, ?, ?)",
            (
                insp_id,
                state["field_id"],
                datetime.now(timezone.utc).isoformat(),
                state["summary"],
                photo_path,
                "saved",
            ),
        )

    field_name = state["field_name"]
    summary = state["summary"]
    USER_INSPECTION_STATES.pop(tg_id, None)

    await send_text(
        chat_id,
        f"✅ <b>Акт осмотра успешно сохранён в Tanap AI!</b>\n\n"
        f"🌾 <b>Поле:</b> {field_name}\n\n"
        f"{summary}\n\n"
        "<i>Данные зафиксированы в постоянном журнале хозяйства и доступны в карточке поля и Агропаспорте.</i>",
        reply_markup={
            "inline_keyboard": [
                [{"text": "🌾 Открыть карточку поля в Mini App", "web_app": {"url": MINI_APP_URL}}],
                [{"text": "🎙️ Записать ещё один осмотр", "callback_data": "insp:start"}],
            ]
        },
    )


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
                {"command": "start", "description": "🚀 Запустить Tanap AI"},
                {"command": "report", "description": "🎙️ Записать голосовой осмотр поля"},
                {"command": "app", "description": "🌾 Открыть агрономическую платформу"},
                {"command": "help", "description": "ℹ️ Возможности платформы"},
                {"command": "cancel", "description": "❌ Отменить текущий осмотр"},
            ]
        }
        resp = await client.post(f"{API_BASE}/setMyCommands", json=commands_payload)
        logger.info("setMyCommands: %s", resp.text)


async def send_welcome_message(chat_id: int, user_first_name: str = "Агроном"):
    """Sends a rich greeting card with Mini App launch and Inspection buttons."""
    text = (
        f"🌾 <b>Добро пожаловать в Tanap AI, {user_first_name}!</b>\n\n"
        "<b>Tanap AI</b> — платформа спутникового мониторинга и агрономического анализа "
        "для хозяйств Казахстана:\n\n"
        "• 🛰️ <b>Sentinel-2 L2A</b>: спектральный мониторинг полей, биомасса NDVI и влагообеспеченность NDMI\n"
        "• 🎙️ <b>Голосовые осмотры</b>: запишите голосовое с поля — AI создаст акт осмотра и сохранит в журнал\n"
        "• 🤖 <b>AI-Агроном Google Gemini</b>: расчёт норм высева, защита растений, листовые подкормки\n"
        "• 📄 <b>Полевой отчёт</b>: спутниковая аналитика, картосхема и живая верификация по QR-коду\n\n"
        "<i>Выберите действие ниже:</i>"
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
                        "text": "🎙️ Записать осмотр поля (Голос / Фото)",
                        "callback_data": "insp:start",
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
    await setup_bot_ui()
    offset = 0
    logger.info("Telegram Bot @tanapai_aqmola_bot started polling with Voice Inspection support...")

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

                        # 1. Handle Inline Keyboards (callback_query)
                        cb = update.get("callback_query")
                        if cb:
                            await handle_callback_query(cb)
                            continue

                        # 2. Handle Messages
                        msg = update.get("message")
                        if not msg:
                            continue
                        chat_id = msg.get("chat", {}).get("id")
                        from_user = msg.get("from", {})
                        first_name = from_user.get("first_name", "Агроном")
                        tg_id = from_user.get("id")
                        text = (msg.get("text") or "").strip()
                        voice = msg.get("voice") or msg.get("audio")
                        photo = msg.get("photo")

                        if not chat_id:
                            continue

                        # Check if user wants to cancel
                        if text in ("/cancel", "Отмена", "отмена"):
                            USER_INSPECTION_STATES.pop(tg_id, None)
                            await send_text(chat_id, "❌ Запись осмотра отменена.")
                            continue

                        # Check if user is in WAITING_PHOTO step and sends /skip_photo
                        if text in ("/skip_photo", "/skip", "Пропустить", "пропустить"):
                            if tg_id in USER_INSPECTION_STATES and USER_INSPECTION_STATES[tg_id].get("step") == "WAITING_PHOTO":
                                await handle_inspection_photo(chat_id, from_user, None)
                                continue

                        # Photo received
                        if photo:
                            if tg_id in USER_INSPECTION_STATES and USER_INSPECTION_STATES[tg_id].get("step") == "WAITING_PHOTO":
                                await handle_inspection_photo(chat_id, from_user, photo)
                                continue

                        # Voice / Audio received
                        if voice:
                            await handle_voice_message(chat_id, from_user, voice)
                            continue

                        # If user is in WAITING_VOICE and writes text instead
                        if text and tg_id in USER_INSPECTION_STATES and USER_INSPECTION_STATES[tg_id].get("step") == "WAITING_VOICE":
                            state = USER_INSPECTION_STATES[tg_id]
                            await send_chat_action(chat_id, "typing")
                            summary = ai_advisor.process_agronomic_text_report(
                                text,
                                field_context={
                                    "name": state["field_name"],
                                    "cropType": state["crop_type"],
                                    "areaHa": state["area_ha"],
                                },
                            )
                            state["step"] = "WAITING_PHOTO"
                            state["summary"] = summary
                            await send_text(
                                chat_id,
                                f"📋 <b>AI структурировал акт осмотра:</b>\n\n"
                                f"{summary}\n\n"
                                "📸 <b>Прикрепите фото поля или культуры</b>\n"
                                "<i>(или отправьте /skip_photo для сохранения без фото):</i>",
                            )
                            continue

                        # Deep-link account binding: `/start link<code>`
                        payload_arg = ""
                        if text.startswith("/start"):
                            parts = text.split(maxsplit=1)
                            if len(parts) > 1:
                                payload_arg = parts[1].strip()
                        if payload_arg.startswith("link") and len(payload_arg) > 4:
                            await handle_link_code(chat_id, from_user, payload_arg[4:])
                        elif text in ("/report", "/inspect", "Осмотр", "осмотр", "Записать осмотр"):
                            await start_inspection_flow(chat_id, from_user)
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

