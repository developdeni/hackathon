"""
Отправка почты (коды подтверждения email, уведомления).

Поддерживает несколько провайдеров — берётся ПЕРВЫЙ настроенный:
  1. Brevo  (HTTP API)  — BREVO_API_KEY  (+ BREVO_SENDER_EMAIL). Рекомендуется:
     бесплатно ~300 писем/день, шлёт на ЛЮБЫЕ адреса, домен не нужен — надо лишь
     один раз подтвердить e-mail отправителя в кабинете Brevo.
  2. Resend (HTTP API)  — RESEND_API_KEY (+ RESEND_FROM). Быстрый старт; на
     произвольные адреса нужен подтверждённый домен (иначе только на свой e-mail).
  3. SMTP               — SMTP_HOST/SMTP_USER/SMTP_PASSWORD (например Gmail App Password).

Полностью защищён от падений: функции НЕ бросают исключений, а возвращают False.
Если ничего не настроено — send_email вернёт False, а вызывающий код покажет код
прямо в приложении (devCode), так что поток подтверждения работает всегда.
"""
from __future__ import annotations

import logging
import os
import re
import smtplib
import ssl
from email.message import EmailMessage

import httpx

logger = logging.getLogger("tanapai.emailer")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(value: str) -> bool:
    return bool(value) and bool(_EMAIL_RE.match(value.strip()))


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _from_name() -> str:
    return _env("MAIL_FROM_NAME") or _env("SMTP_FROM_NAME") or "Tanap AI"


def _active_provider() -> str:
    """Возвращает имя активного провайдера или '' если ничего не настроено."""
    if _env("BREVO_API_KEY"):
        return "brevo"
    if _env("RESEND_API_KEY"):
        return "resend"
    if _env("SMTP_HOST") and _env("SMTP_USER") and _env("SMTP_PASSWORD"):
        return "smtp"
    return ""


def is_configured() -> bool:
    return bool(_active_provider())


# ---------------------------------------------------------------------------
# Провайдеры
# ---------------------------------------------------------------------------

def _send_via_brevo(to: str, subject: str, text: str, html: str | None) -> bool:
    api_key = _env("BREVO_API_KEY")
    sender_email = _env("BREVO_SENDER_EMAIL") or _env("SMTP_FROM") or "no-reply@tanap.ai"
    payload = {
        "sender": {"name": _from_name(), "email": sender_email},
        "to": [{"email": to}],
        "subject": subject,
        "textContent": text,
    }
    if html:
        payload["htmlContent"] = html
    resp = httpx.post(
        "https://api.brevo.com/v3/smtp/email",
        headers={"api-key": api_key, "accept": "application/json", "content-type": "application/json"},
        json=payload,
        timeout=15,
    )
    if resp.status_code in (200, 201):
        return True
    logger.warning("Brevo вернул %s: %s", resp.status_code, resp.text[:300])
    return False


def _send_via_resend(to: str, subject: str, text: str, html: str | None) -> bool:
    api_key = _env("RESEND_API_KEY")
    sender = _env("RESEND_FROM") or f"{_from_name()} <onboarding@resend.dev>"
    payload: dict = {"from": sender, "to": [to], "subject": subject, "text": text}
    if html:
        payload["html"] = html
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    if resp.status_code in (200, 201):
        return True
    logger.warning("Resend вернул %s: %s", resp.status_code, resp.text[:300])
    return False


def _send_via_smtp(to: str, subject: str, text: str, html: str | None) -> bool:
    host = _env("SMTP_HOST")
    user = _env("SMTP_USER")
    password = _env("SMTP_PASSWORD")
    sender = _env("SMTP_FROM") or user
    use_tls = _env("SMTP_USE_TLS", "true").lower() != "false"
    try:
        port = int(_env("SMTP_PORT", "587") or "587")
    except ValueError:
        port = 587

    msg = EmailMessage()
    msg["From"] = f"{_from_name()} <{sender}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as server:
            server.login(user, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=15) as server:
            if use_tls:
                server.starttls(context=context)
            server.login(user, password)
            server.send_message(msg)
    return True


_PROVIDERS = {
    "brevo": _send_via_brevo,
    "resend": _send_via_resend,
    "smtp": _send_via_smtp,
}


# ---------------------------------------------------------------------------
# Публичный API
# ---------------------------------------------------------------------------

def send_email(to: str, subject: str, body_text: str, body_html: str | None = None) -> bool:
    """Отправляет письмо активным провайдером. Возвращает True/False. Не бросает."""
    if not is_valid_email(to):
        logger.warning("Некорректный email получателя: %r", to)
        return False

    provider = _active_provider()
    if not provider:
        logger.warning("Провайдер почты не настроен — письмо '%s' на %s не отправлено.", subject, to)
        return False

    try:
        ok = _PROVIDERS[provider](to, subject, body_text, body_html)
        if ok:
            logger.info("Письмо '%s' отправлено на %s через %s", subject, to, provider)
        return ok
    except Exception:
        logger.exception("Ошибка отправки письма на %s через %s", to, provider)
        return False


def send_verification_code(to: str, code: str) -> bool:
    """Письмо с кодом подтверждения email."""
    subject = "Tanap AI — код подтверждения email"
    text = (
        f"Ваш код подтверждения адреса электронной почты в Tanap AI: {code}\n\n"
        f"Код действителен 15 минут. Если вы не запрашивали подтверждение — просто игнорируйте это письмо."
    )
    html = f"""
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;color:#1c1c1e">
      <h2 style="color:#2e7d32;margin:0 0 8px">Tanap AI</h2>
      <p style="margin:0 0 16px;font-size:15px">Код подтверждения адреса электронной почты:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#f1f8e9;
                  color:#2e7d32;padding:16px;text-align:center;border-radius:12px">{code}</div>
      <p style="margin:16px 0 0;font-size:13px;color:#6b6b6b">
        Код действителен 15 минут. Если вы не запрашивали подтверждение — проигнорируйте это письмо.
      </p>
    </div>
    """
    return send_email(to, subject, text, html)


def send_welcome(to: str, name: str) -> bool:
    """Приветственное письмо при регистрации (best-effort)."""
    subject = "Добро пожаловать в Tanap AI"
    text = (
        f"Здравствуйте, {name}!\n\n"
        f"Вы успешно зарегистрировались в Tanap AI — умном помощнике агронома "
        f"по Акмолинской области. Спутниковый мониторинг полей, AI-агроном, прогноз урожайности "
        f"и агропаспорт уже доступны в приложении."
    )
    return send_email(to, subject, text)
