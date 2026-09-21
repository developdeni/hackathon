from __future__ import annotations

import base64
import io
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from PIL import Image

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _parse_gemini_keys() -> list[str]:
    raw_keys = [
        os.getenv("GEMINI_API_KEY", ""),
        os.getenv("GEMINI_API_KEYS", ""),
    ]
    keys: list[str] = []
    for raw in raw_keys:
        for item in re.split(r"[\s,;]+", raw.strip()):
            key = item.strip()
            if key and key not in keys:
                keys.append(key)
    return keys


GEMINI_API_KEYS = _parse_gemini_keys()


def _gemini_model_urls(models: list[str]):
    for api_key in GEMINI_API_KEYS:
        for model_name in models:
            yield api_key, model_name, f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"


# Каскад моделей Google Gemini. ВАЖНО: быстрые и стабильные *-flash-lite идут
# ПЕРВЫМИ. Тяжёлые *-flash / *-flash-latest сейчас регулярно отдают 503 (overloaded)
# и отвечают 6-30 с — из-за этого чат «висел» и обрывался. Они оставлены только как
# резерв в самом конце каскада. lite-модели отвечают за ~1-4 с и не перегружены.
GEMINI_MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-flash-latest",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
]
# Фото-диагностика: тот же принцип — сначала быстрые/стабильные lite-модели,
# тяжёлые flash-модели в резерве, чтобы 503 на них не стопорил распознавание.
VISION_MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-flash-latest",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
]


def clean_agronomic_text(text: str) -> str:
    """
    Cleans agronomic text output:
    1. Removes triple dashes / horizontal rules (---, ———, – – –, ___).
    2. Strips markdown asterisks (*, **, ***) used for bold/italic/lists.
    3. Normalizes blank lines and list bullets.
    """
    if not text:
        return ""

    # Remove markdown dividers: lines that only contain ---, ***, ___, –––, ———
    text = re.sub(r"(?m)^[\s\t]*[-—–_*]{2,}[\s\t]*$", "", text)
    # Remove inline runs of 3 or more dashes/hyphens/em-dashes
    text = re.sub(r"[-—–]{3,}", "", text)

    # Remove bold/italic markdown asterisks: ***text*** -> text, **text** -> text, *text* -> text
    text = re.sub(r"\*{3}(.*?)\*{3}", r"\1", text)
    text = re.sub(r"\*{2}(.*?)\*{2}", r"\1", text)
    text = re.sub(r"(?<!\w)\*([^*\n]+)\*(?!\w)", r"\1", text)
    # If any list items start with "* ", replace with "• "
    text = re.sub(r"(?m)^[\s\t]*\*\s+", "• ", text)
    # Remove any remaining asterisks
    text = text.replace("*", "")

    # Collapse 3+ newlines into 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Agronomic Knowledge Base for Akmola Region, Kazakhstan
# ---------------------------------------------------------------------------

AGRONOMIC_DISEASES = [
    {
        "id": "yellow_rust",
        "name": "Жёлтая ржавчина пшеницы",
        "pathogen": "Puccinia striiformis Westend.",
        "crop": "Яровая пшеница",
        "severity": "high",
        "description": "Полосы лимонно-жёлтых пустул (урединий) вдоль жилок листа. Развивается при высокой влажности и прохладной погоде (10–18°C).",
        "action": "Срочная фунгицидная обработка очага и защитного периметра",
        "chemicals": "Тебуконазол (250 г/л) + Триадимефон (125 г/л) либо Пропиконазол + Ципроконазол",
        "rate": "0.5 – 0.6 л/га",
        "weather_limits": "Температура 12–23°C, скорость ветра не более 4 м/с, отсутствие осадков минимум 3 часа",
        "yield_loss": "До 30–45% при поражении флагового листа",
    },
    {
        "id": "septoria",
        "name": "Септориоз листьев",
        "pathogen": "Zymoseptoria tritici / Septoria nodorum",
        "crop": "Пшеница / Ячмень",
        "severity": "moderate",
        "description": "Светло-бурые продолговатые пятна с мелкими чёрными точками (пикнидами). Активно распространяется с каплями дождя.",
        "action": "Профилактическая и лечебная обработка триазолами со стробилуринами",
        "chemicals": "Азоксистробин (200 г/л) + Дифеноконазол (125 г/л)",
        "rate": "0.75 – 1.0 л/га",
        "weather_limits": "Обработка в фазу флагового листа – колошения (BBCH 37–51)",
        "yield_loss": "15–25% массы 1000 зёрен",
    },
    {
        "id": "nitrogen_deficiency",
        "name": "Азотный хлороз (дефицит N)",
        "pathogen": "Физиологическое расстройство питания",
        "crop": "Зерновые колосовые",
        "severity": "moderate",
        "description": "Равномерное пожелтение нижних листьев от кончика к основанию по V-образному контуру. Растение сбрасывает побеги кущения.",
        "action": "Листовая подкормка карбамидом или внесение КАС / аммиачной селитры",
        "chemicals": "Карбамид марки Б (водный раствор 8–10%) + сульфат магния (2–3 кг/га)",
        "rate": "15–20 кг/га физического веса по листу",
        "weather_limits": "Опрыскивание строго вечером или в пасмурную погоду (во избежание ожога)",
        "yield_loss": "Снижение протеина на 1.5–3.0% и урожайности на 3–5 ц/га",
    },
    {
        "id": "powdery_mildew",
        "name": "Мучнистая роса",
        "pathogen": "Blumeria graminis (DC.) Speer",
        "crop": "Яровая пшеница",
        "severity": "moderate",
        "description": "Белый паутинистый налёт на прикорневой части стебля и нижних листьях, со временем темнеющий до серого с клейстотециями.",
        "action": "Обработка системным фунгицидом",
        "chemicals": "Метконазол (60 г/л) или Спироксамин (500 г/л)",
        "rate": "0.6 – 0.8 л/га",
        "weather_limits": "В утренние или вечерние часы при температуре до 24°C",
        "yield_loss": "10–20%",
    },
    {
        "id": "phoma_rapeseed",
        "name": "Фомоз (сухая гниль) рапса",
        "pathogen": "Plenodomus lingam (Phoma lingam)",
        "crop": "Яровой рапс",
        "severity": "high",
        "description": "Сероватые пятна на листьях с многочисленными тёмными пикнидами. На стеблях — язвы с фиолетово-бурым окаймлением.",
        "action": "Обработка фунгицидом с росторегулирующим эффектом",
        "chemicals": "Тебуконазол (250 г/л) + Протиоконазол (175 г/л)",
        "rate": "0.8 – 1.0 л/га",
        "weather_limits": "Фаза 4–6 листьев рапса, влажность воздуха > 60%",
        "yield_loss": "До 30–50% за счёт полегания и перелома стеблей",
    },
    {
        "id": "healthy",
        "name": "Здоровое вегетирующее растение",
        "pathogen": "Патогены не обнаружены",
        "crop": "Зерновые / Масличные",
        "severity": "low",
        "description": "Равномерная хлорофилльная окраска листовой пластинки, тургор в норме, признаки некрозов и урединий отсутствуют.",
        "action": "Продолжать плановый спутниковый мониторинг NDVI/NDMI",
        "chemicals": "Химическая защита в данный момент не требуется",
        "rate": "—",
        "weather_limits": "Благоприятный прогноз вегетации",
        "yield_loss": "0%",
    },
]

# ---------------------------------------------------------------------------
# Computer Vision & Gemini Multimodal Diagnostic Engine
# ---------------------------------------------------------------------------

def _query_gemini_vision(image_bytes: bytes) -> dict[str, Any] | None:
    """
    Sends the leaf/field photo to Google Gemini Multimodal Vision API
    with automatic model fallback (gemini-flash-latest -> gemini-3.6-flash -> gemini-3.5-flash).
    """
    if not GEMINI_API_KEYS:
        return None

    try:
        # Resize thumbnail to max 1024x1024 to ensure fast upload and sub-2s inference
        im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        im.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85)
        b64_data = base64.b64encode(buf.getvalue()).decode("utf-8")

        prompt = (
            "Ты — ведущий эксперт-агроном Tanap AI, специализированный строго на сельском хозяйстве "
            "Акмолинской области (Республика Казахстан). Проведи предварительную визуальную интерпретацию фото "
            "с учётом почвенно-климатических условий степной зоны Акмолинской области.\n\n"
            "КРИТИЧЕСКОЕ ПРАВИЛО 1 (ОПРЕДЕЛЕНИЕ ОБЪЕКТА):\n"
            "Сначала определи, действительно ли на фото живое растение, лист, колос, сорняк, поле или вредитель.\n"
            "Если на фото экран монитора/компьютера, скриншот, интерьер, комната, человек, автомобиль, бытовой предмет, "
            "или любой объект, НЕ являющийся живым растением/полем/вредителем, ты ОБЯЗАН вернуть:\n"
            "category = \"none\", detected = false!\n\n"
            "КРИТИЧЕСКОЕ ПРАВИЛО 2 (ДИНАМИЧЕСКИЙ АНАЛИЗ БЕЗ ОГРАНИЧЕНИЙ):\n"
            "Формируй гипотезу по наблюдаемым визуальным признакам на снимке, НЕ ограничиваясь шаблонами.\n"
            "Это не лабораторное измерение, не калиброванная вероятность и не подтверждённый диагноз. "
            "Не называй проценты точностью, уверенностью или вероятностью; affected_area_percent — только видимая доля признаков в кадре.\n"
            "Определяй ЛЮБУЮ культуру региона (яровая пшеница, озимая пшеница, ячмень, яровой рапс, подсолнечник, лен масличный, овес, чечевица, горох, соя, кукуруза, картофель и др.).\n"
            "Диагностируй ЛЮБЫЕ патологии: листовые и стеблевые ржавчины (желтая, бурая, стеблевая), пятнистости (септориоз, гельминтоспориоз, темно-бурая, сетчатая), фузариоз колоса, альтернариоз, мучнистая роса, бактериозы, хлорозы, дефициты макро- и микроэлементов (N, P, K, Mg, S, Fe, Zn), гербицидный токсикоз.\n"
            "Идентифицируй любых вредителей (злаковая тля, хлебный жук, пьявица, трипсы, совка, саранча, клоп-черепашка, блошки) или сорные растения (осот розовый и желтый, вьюнок, овсюг, марь белая, щетинник, гречишка татарская, щирица).\n\n"
            "КРИТИЧЕСКОЕ ПРАВИЛО 3 (ФОРМАТИРОВАНИЕ И СТИЛЬ ДЛЯ АКМОЛИНСКОЙ ОБЛАСТИ):\n"
            "Все рекомендации по СЗР, дозировкам и агроприёмам должны соответствовать специфике Акмолинской области и Государственному реестру пестицидов РК.\n"
            "КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать звёздочки ('*', '**', '***') и разделители из трёх тире ('---', '———') в тексте. Пиши чистым обычным текстом.\n\n"
            "Категории (поле category):\n"
            "  • \"disease\" — болезнь или дефицит питания живого растения;\n"
            "  • \"pest\" — вредитель или характерные повреждения от него;\n"
            "  • \"weed\" — сорное растение;\n"
            "  • \"healthy\" — здоровое культурное растение без признаков поражения;\n"
            "  • \"none\" — на фото НЕТ живых растений/поля (экран компьютера, интерьер, техника, люди, предметы).\n\n"
            "Верни ответ СТРОГО валидным JSON:\n"
            "{\n"
            '  "detected": true,\n'
            '  "category": "disease | pest | weed | healthy | none",\n'
            '  "crop": "Вероятная культура или \'—\' если сорняк/не растение",\n'
            '  "object_name": "Конкретное наименование объекта (напр. \'Сетчатая пятнистость ячменя\', \'Злаковая тля\', \'Осот желтый полевой\', \'Экран монитора / интерьер\')",\n'
            '  "diagnosis": "Диагноз или экспертный вывод по снимку для Акмолинской области",\n'
            '  "pathogen": "Латинское название возбудителя/вида или физиологическая причина (или \'—\')",\n'
            '  "severity": "low | moderate | high",\n'
            '  "affected_area_percent": 15.0,\n'
            '  "description": "Описание наблюдаемых визуальных признаков на органе растения и возможных альтернатив",\n'
            '  "recommendation": "Агрономический план действий",\n'
            '  "chemicals": "Рекомендуемые действующие вещества препаратов под обнаруженный объект из реестра РК (или \'—\')",\n'
            '  "rate": "Норма расхода препарата (или \'—\')",\n'
            '  "weather_limits": "Агрометеорологическое окно обработки для степной зоны (температура, ветер, осадки)",\n'
            '  "yield_loss": "Не рассчитывается по одному фото; нужна полевая оценка распространённости и развития"\n'
            "}\n"
        )

        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inlineData": {"mimeType": "image/jpeg", "data": b64_data}},
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json",
            },
        }

        # Мультимодальные модели Gemini для фото-диагностики
        for _api_key, model_name, url in _gemini_model_urls(VISION_MODELS):
            try:
                with httpx.Client(timeout=httpx.Timeout(20.0, connect=5.0)) as client:
                    resp = client.post(url, json=payload)
                    if resp.status_code == 200:
                        raw_json = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                        parsed = json.loads(raw_json)
                        category = str(parsed.get("category") or "").lower().strip()
                        detected = bool(parsed.get("detected", True))
                        if category not in ["disease", "pest", "weed", "healthy", "none"]:
                            category = "disease" if detected else "none"

                        if category == "none" or not detected:
                            return {
                                "detected": False,
                                "category": "none",
                                "object_name": clean_agronomic_text(str(parsed.get("object_name") or "Не растение")),
                                "crop": "—",
                                "diagnosis": clean_agronomic_text(str(parsed.get("diagnosis") or "Растение на снимке не обнаружено")),
                                "pathogen": "—",
                                "severity": "low",
                                "confidence": None,
                                "affected_area_percent": None,
                                "metric_basis": "visual_model_interpretation",
                                "description": clean_agronomic_text(str(parsed.get("description") or "На снимке не обнаружено сельскохозяйственных растений.")),
                                "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "Сделайте чёткий снимок листа, колоса или сорняка крупным планом при хорошем освещении.")),
                                "chemicals": "—",
                                "rate": "—",
                                "weather_limits": "—",
                                "yield_loss": "Не рассчитывается по одному фото",
                            }

                        severity = parsed.get("severity", "low")
                        if severity not in ["low", "moderate", "high"]:
                            severity = "moderate" if "mod" in str(severity).lower() else ("high" if "high" in str(severity).lower() else "low")

                        return {
                            "detected": True,
                            "category": category,
                            "object_name": clean_agronomic_text(str(parsed.get("object_name") or parsed.get("diagnosis") or "Сельхозкультура")),
                            "crop": clean_agronomic_text(str(parsed.get("crop") or "Сельхозкультура")),
                            "diagnosis": clean_agronomic_text(str(parsed.get("diagnosis") or "Агрономический осмотр")),
                            "pathogen": clean_agronomic_text(str(parsed.get("pathogen") or "—")),
                            "severity": severity,
                            "confidence": None,
                            "affected_area_percent": _pct(parsed.get("affected_area_percent")),
                            "metric_basis": "visual_model_interpretation",
                            "description": clean_agronomic_text(str(parsed.get("description") or "")),
                            "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "")),
                            "chemicals": clean_agronomic_text(str(parsed.get("chemicals") or "—")),
                            "rate": clean_agronomic_text(str(parsed.get("rate") or "—")),
                            "weather_limits": clean_agronomic_text(str(parsed.get("weather_limits") or "—")),
                            "yield_loss": "Не рассчитывается по одному фото; нужна полевая оценка распространённости и развития болезни",
                        }
            except Exception:
                continue
    except Exception:
        pass

    return None


def analyze_crop_image_bytes(image_bytes: bytes, filename: str = "leaf.jpg") -> dict[str, Any]:
    """
    Interprets an agronomic photograph with Gemini and returns no diagnosis when
    the model is unavailable. Colour heuristics are intentionally not used.
    """
    # 1. Primary: High-accuracy multimodal Gemini vision model
    gemini_diag = _query_gemini_vision(image_bytes)
    if gemini_diag is not None:
        return gemini_diag

    # A colour-ratio heuristic cannot distinguish disease, lighting and soil background
    # reliably enough to support treatment decisions. Fail honestly when vision is offline.
    return {
        "detected": False,
        "category": "none",
        "object_name": "Анализ недоступен",
        "crop": "—",
        "diagnosis": "Модель визуальной диагностики временно недоступна",
        "pathogen": "—",
        "severity": "low",
        "confidence": None,
        "affected_area_percent": None,
        "metric_basis": "unavailable",
        "description": "Снимок не анализировался: локальная цветовая эвристика отключена, потому что она не является достоверной диагностикой.",
        "recommendation": "Повторите запрос позже или подтвердите симптомы полевым осмотром агронома.",
        "chemicals": "—",
        "rate": "—",
        "weather_limits": "—",
        "yield_loss": "Не рассчитывается по одному фото",
    }


# ---------------------------------------------------------------------------
# Задача 3.2 — Оценка густоты стояния и подсчёт всходов по фото (в т.ч. с дрона)
# ---------------------------------------------------------------------------

# Агрономические нормы оптимальной густоты стояния (растений/м²) по культурам,
# Северный Казахстан, богарное земледелие.
STAND_NORMS = {
    "яровая пшеница": (250, 350),
    "озимая пшеница": (300, 450),
    "ячмень": (250, 300),
    "овес": (300, 400),
    "рапс": (60, 100),
    "подсолнечник": (4, 6),
    "кукуруза": (6, 9),
    "лен": (400, 600),
    "горох": (80, 120),
    "чечевица": (100, 130),
    "соя": (30, 45),
    "картофель": (4, 6),
    "гречиха": (150, 250),
    "просо": (150, 250),
}


_STAND_PROMPT = (
    "Ты — эксперт по агроскаутингу и дистанционной оценке посевов Tanap AI "
    "для Акмолинской области (Северный Казахстан, богарное земледелие, зона южных чернозёмов и темно-каштановых почв). "
    "Тебе дан материал посева: наземное фото рядков, "
    "макро-кадр, ортоснимок/кадр с квадрокоптера (вид сверху) ЛИБО видео облёта поля дроном.\n\n"
    "ЗАДАЧА: посчитать видимые всходы. Если это ВИДЕО — рассматривай наиболее чёткие "
    "репрезентативные кадры и верни типичное число видимых растений в одном кадре.\n\n"
    "ПРАВИЛО 1 (валидация): если на материале НЕ посев/поле/всходы (экран, интерьер, человек, техника, "
    "один лист крупным планом без возможности счёта рядков) — верни detected=false, is_field=false.\n\n"
    "ПРАВИЛО 2 (подсчёт): перечисли и посчитай только различимые всходы/растения в типичном кадре. "
    "Это визуальная оценка модели, а не лабораторный или калиброванный полевой замер. "
    "Оцени тип съёмки (shot_type): \"ground\" или \"drone\". Не угадывай площадь кадра, плотность "
    "на м²/га, процент пропусков или вероятность точности: без масштаба эти величины не измеримы.\n\n"
    "ПРАВИЛО 3 (агрооценка): определи вероятную культуру (crop) и только категориально оцени "
    "равномерность видимых рядков (uniformity: low|moderate|high).\n\n"
    "ПРАВИЛО 4 (форматирование): КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать звёздочки ('*', '**', '***') "
    "и разделители из трёх тире ('---', '———') в тексте. Пиши обычным чистым текстом.\n\n"
    "Верни СТРОГО валидный JSON:\n"
    "{\n"
    '  "detected": true,\n'
    '  "is_field": true,\n'
    '  "shot_type": "ground | drone",\n'
    '  "crop": "Название культуры или \'—\'",\n'
    '  "plant_count": 128,\n'
    '  "uniformity": "low | moderate | high",\n'
    '  "assessment": "Краткий вывод только по видимым растениям и равномерности кадра в условиях Акмолинской области",\n'
    '  "recommendation": "Как повторить учёт на нескольких калиброванных площадках"\n'
    "}\n"
)


def _stand_unavailable(message: str) -> dict[str, Any]:
    return {
        "detected": False,
        "is_field": False,
        "shot_type": "—",
        "crop": "—",
        "plant_count": 0,
        "frame_area_m2": None,
        "density_per_m2": None,
        "density_per_ha": None,
        "optimal_range_m2": "—",
        "stand_rating": "none",
        "uniformity": "—",
        "gap_percent": None,
        "confidence": None,
        "measurement_basis": "unavailable",
        "assessment": clean_agronomic_text(message),
        "recommendation": "—",
    }


def _normalize_stand_result(
    parsed: dict[str, Any], calibrated_area_m2: float | None = None
) -> dict[str, Any]:
    """Приводит сырой JSON Gemini к стабильной схеме результата густоты стояния."""
    detected = bool(parsed.get("detected", True))
    is_field = bool(parsed.get("is_field", detected))
    if not detected or not is_field:
        return {
            "detected": False,
            "is_field": False,
            "shot_type": "—",
            "crop": "—",
            "plant_count": 0,
            "frame_area_m2": calibrated_area_m2,
            "density_per_m2": None,
            "density_per_ha": None,
            "optimal_range_m2": "—",
            "stand_rating": "none",
            "uniformity": "—",
            "gap_percent": None,
            "confidence": None,
            "measurement_basis": "user_calibrated_area" if calibrated_area_m2 else "visual_count_unscaled",
            "assessment": clean_agronomic_text(str(parsed.get("assessment") or "На материале не обнаружено посева/всходов.")),
            "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "Снимите рядки всходов крупным планом или сделайте облёт участка дроном при дневном свете.")),
        }

    shot_type = str(parsed.get("shot_type") or "ground").lower().strip()
    if shot_type not in ["ground", "drone"]:
        shot_type = "drone" if "drone" in shot_type or "air" in shot_type else "ground"

    plant_count = int(round(float(parsed.get("plant_count", 0) or 0)))
    frame_area = round(calibrated_area_m2, 3) if calibrated_area_m2 else None
    density = round(plant_count / frame_area, 1) if frame_area else None
    density_ha = int(round(density * 10000)) if density is not None else None

    crop = clean_agronomic_text(str(parsed.get("crop") or "—").strip())
    crop_key = crop.lower()
    norm = None
    for key, rng in STAND_NORMS.items():
        if key in crop_key:
            norm = rng
            break
    optimal_range = str(parsed.get("optimal_range_m2") or "").strip()
    if not optimal_range and norm:
        optimal_range = f"{norm[0]}–{norm[1]}"
    optimal_range = optimal_range or "—"

    stand_rating = "none"
    if norm and density is not None:
        if density < norm[0]:
            stand_rating = "sparse"
        elif density > norm[1]:
            stand_rating = "dense"
        else:
            stand_rating = "optimal"

    uniformity = str(parsed.get("uniformity") or "moderate").lower().strip()
    if uniformity not in ["low", "moderate", "high"]:
        uniformity = "moderate"

    return {
        "detected": True,
        "is_field": True,
        "shot_type": shot_type,
        "crop": crop or "Сельхозкультура",
        "plant_count": max(plant_count, 0),
        "frame_area_m2": frame_area,
        "density_per_m2": density,
        "density_per_ha": density_ha,
        "optimal_range_m2": optimal_range,
        "stand_rating": stand_rating,
        "uniformity": uniformity,
        "gap_percent": None,
        "confidence": None,
        "measurement_basis": "user_calibrated_area" if frame_area else "visual_count_unscaled",
        "assessment": clean_agronomic_text(str(parsed.get("assessment") or "Оценка густоты стояния выполнена.")),
        "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "—")),
    }


def _call_gemini_stand(
    media_part: dict[str, Any] | list[dict[str, Any]],
    timeout: float = 25.0,
    calibrated_area_m2: float | None = None,
) -> dict[str, Any] | None:
    """Send stand-count media with one total deadline across the model cascade."""
    media_parts = media_part if isinstance(media_part, list) else [media_part]
    payload = {
        "contents": [{"parts": [{"text": _STAND_PROMPT}, *media_parts]}],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }
    deadline = time.monotonic() + timeout
    for _api_key, model_name, url in _gemini_model_urls(VISION_MODELS):
        remaining = deadline - time.monotonic()
        if remaining <= 1.0:
            break
        try:
            request_timeout = min(remaining, 14.0)
            with httpx.Client(timeout=httpx.Timeout(request_timeout, connect=min(5.0, request_timeout))) as client:
                resp = client.post(url, json=payload)
                if resp.status_code != 200:
                    continue
                raw_json = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                return _normalize_stand_result(json.loads(raw_json), calibrated_area_m2)
        except Exception:
            continue
    return None


def _query_gemini_stand_count(
    image_bytes: bytes, calibrated_area_m2: float | None = None
) -> dict[str, Any] | None:
    """Подсчёт всходов и густоты стояния по фото поля / кадру с дрона (inline image)."""
    if not GEMINI_API_KEYS:
        return None
    try:
        im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        im.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=88)
        b64_data = base64.b64encode(buf.getvalue()).decode("utf-8")
        return _call_gemini_stand(
            {"inlineData": {"mimeType": "image/jpeg", "data": b64_data}},
            calibrated_area_m2=calibrated_area_m2,
        )
    except Exception:
        return None


def _query_gemini_stand_count_frames(
    frame_bytes: list[bytes], calibrated_area_m2: float | None = None
) -> dict[str, Any] | None:
    """
    Быстрый путь: анализ нескольких репрезентативных кадров, извлечённых на телефоне,
    без загрузки всего видео (в разы быстрее по слабому интернету).
    """
    if not GEMINI_API_KEYS or not frame_bytes:
        return None

    media_parts: list[dict[str, Any]] = []
    try:
        for raw_frame in frame_bytes[:4]:
            image = Image.open(io.BytesIO(raw_frame)).convert("RGB")
            image.thumbnail((960, 960), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=82, optimize=True)
            media_parts.append({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": base64.b64encode(buffer.getvalue()).decode("utf-8"),
                }
            })
    except Exception:
        return None

    if not media_parts:
        return None
    return _call_gemini_stand(
        media_parts, timeout=30.0, calibrated_area_m2=calibrated_area_m2
    )


def _gemini_upload_video_file(video_bytes: bytes, mime_type: str) -> str | None:
    """
    Загружает видео через Files API (resumable) и ждёт состояния ACTIVE.
    Возвращает file_uri для ссылки в generateContent или None при сбое.
    """
    try:
        size = len(video_bytes)
        for api_key in GEMINI_API_KEYS:
            with httpx.Client(timeout=httpx.Timeout(60.0, connect=6.0)) as client:
                start = client.post(
                    f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}",
                    headers={
                        "X-Goog-Upload-Protocol": "resumable",
                        "X-Goog-Upload-Command": "start",
                        "X-Goog-Upload-Header-Content-Length": str(size),
                        "X-Goog-Upload-Header-Content-Type": mime_type,
                        "Content-Type": "application/json",
                    },
                    json={"file": {"display_name": "stand_video"}},
                )
                upload_url = start.headers.get("x-goog-upload-url") or start.headers.get("X-Goog-Upload-URL")
                if not upload_url:
                    continue

                up = client.post(
                    upload_url,
                    headers={
                        "Content-Length": str(size),
                        "X-Goog-Upload-Offset": "0",
                        "X-Goog-Upload-Command": "upload, finalize",
                    },
                    content=video_bytes,
                )
                info = up.json().get("file", {})
                name = info.get("name")
                file_uri = info.get("uri")
                state = info.get("state")
                if not name or not file_uri:
                    continue

                # Опрос состояния до ACTIVE (видео обрабатывается несколько секунд)
                for _ in range(20):
                    if state == "ACTIVE":
                        return file_uri
                    if state == "FAILED":
                        break
                    time.sleep(1.0)
                    poll = client.get(
                        f"https://generativelanguage.googleapis.com/v1beta/{name}?key={api_key}"
                    )
                    pj = poll.json()
                    state = pj.get("state")
                    file_uri = pj.get("uri", file_uri)
                if state == "ACTIVE":
                    return file_uri
        return None
    except Exception:
        return None


def _query_gemini_stand_count_video(video_bytes: bytes, mime_type: str = "video/mp4") -> dict[str, Any] | None:
    """
    Подсчёт всходов и густоты по ВИДЕО (в т.ч. облёт дроном).
    Малые ролики — inline; крупные — через Files API. Кадрирование fps=1, первые 15с.
    """
    if not GEMINI_API_KEYS:
        return None
    if not mime_type or not mime_type.startswith("video/"):
        mime_type = "video/mp4"

    # Метаданные видео: 1 кадр/с, первые 15с — ограничивает объём и держит отклик быстрым
    video_meta = {"fps": 1, "start_offset": "0s", "end_offset": "15s"}
    try:
        # Inline допустим только при суммарном размере запроса < 20 МБ (base64 +33%).
        if len(video_bytes) < 14_000_000:
            b64_data = base64.b64encode(video_bytes).decode("utf-8")
            part = {
                "inlineData": {"mimeType": mime_type, "data": b64_data},
                "videoMetadata": video_meta,
            }
            result = _call_gemini_stand(part, timeout=32.0)
            if result is not None:
                return result
            # если inline не прошёл (напр. великоват) — пробуем Files API

        # Крупные ролики (облёт дроном) — через Files API
        file_uri = _gemini_upload_video_file(video_bytes, mime_type)
        if not file_uri:
            return None
        part = {
            "fileData": {"mimeType": mime_type, "fileUri": file_uri},
            "videoMetadata": video_meta,
        }
        return _call_gemini_stand(part, timeout=40.0)
    except Exception:
        return None


def count_seedlings_in_image_bytes(
    image_bytes: bytes,
    filename: str = "field.jpg",
    calibrated_area_m2: float | None = None,
) -> dict[str, Any]:
    """
    Задача 3.2: подсчёт всходов и оценка густоты стояния по ФОТО/кадру с дрона.
    Строго Gemini Vision; при недоступности модели — честный отказ (без выдуманных чисел).
    """
    result = _query_gemini_stand_count(image_bytes, calibrated_area_m2)
    if result is not None:
        return result
    return _stand_unavailable("Модель Gemini временно недоступна (превышен лимит запросов). Повторите через минуту.")


def count_seedlings_in_video_bytes(
    video_bytes: bytes, mime_type: str = "video/mp4", filename: str = "field.mp4"
) -> dict[str, Any]:
    """
    Задача 3.2 (видео): подсчёт всходов и густоты по видеоролику, включая облёт квадрокоптером.
    Строго Gemini (нативный анализ видео); при недоступности — честный отказ.
    """
    result = _query_gemini_stand_count_video(video_bytes, mime_type)
    if result is not None:
        return result
    return _stand_unavailable("Не удалось проанализировать видео (модель Gemini недоступна или ролик слишком большой). Попробуйте короткий ролик или повторите позже.")


def count_seedlings_in_video_frames(
    frame_bytes: list[bytes],
    filename: str = "field.mp4",
    calibrated_area_m2: float | None = None,
) -> dict[str, Any]:
    """Задача 3.2 (видео, быстрый путь): подсчёт по кадрам, извлечённым на устройстве."""
    result = _query_gemini_stand_count_frames(frame_bytes, calibrated_area_m2)
    if result is not None:
        return result
    return _stand_unavailable(
        "Не удалось проанализировать кадры видео (модель Gemini недоступна). Повторите через минуту при хорошем освещении."
    )


# ---------------------------------------------------------------------------
# Задача 3.3 — Контроль качества зерна по фото пробы
# (сорная и зерновая примесь, битое и повреждённое зерно)
# ---------------------------------------------------------------------------

_GRAIN_PROMPT = (
    "Ты — система предварительного визуального разбора фото зерновой пробы Tanap AI "
    "для хозяйств Акмолинской области (Республика Казахстан). "
    "Тебе дано фото зерновой пробы (россыпь зерна на ровной поверхности).\n\n"
    "ЗАДАЧА: оценить только видимый состав объектов в кадре. Это не лабораторный анализ по ГОСТ: "
    "по фото нельзя определить массовую долю, влажность, белок, клейковину или класс зерна.\n\n"
    "ПРАВИЛО 1 (валидация): если на фото НЕ зерновая проба (экран, интерьер, человек, растение в поле, "
    "техника, посторонний предмет) — верни detected=false, is_grain=false.\n\n"
    "ПРАВИЛО 2 (анализ): определи культуру (crop: пшеница мягкая яровая, пшеница твердая, ячмень, овёс, рожь, рапс яровой, подсолнечник, лён масличный, "
    "гречиха, просо, горох, чечевица и др.). Оцени приблизительные визуальные доли по числу/видимой площади "
    "объектов в этом кадре (не по массе; сумма ≈ 100):\n"
    "  • sound_percent — чистое доброкачественное (основное) зерно без дефектов;\n"
    "  • weed_impurity_percent — СОРНАЯ примесь: минеральная (земля, камешки, песок), органическая "
    "(частицы стеблей, плёнки, ости), семена сорняков степной зоны, испорченное/гнилое зерно;\n"
    "  • grain_impurity_percent — ЗЕРНОВАЯ примесь: щуплое, проросшее, недозрелое, давленое, зёрна других "
    "культур, изъеденное зерно;\n"
    "  • broken_percent — БИТОЕ/дроблёное зерно (механически расколотые, половинки);\n"
    "  • damaged_percent — ПОВРЕЖДЁННОЕ зерно: клопом-черепашкой, плесенью, головнёй, самосогреванием "
    "(потемневшее), морозобойное.\n\n"
    "ПРАВИЛО 3 (оценка): оцени примерное число зёрен в кадре (grain_count) и только визуальное "
    "состояние (quality_rating): \"good\" (визуально чистая), \"acceptable\" (смешанная), "
    "\"poor\" (много видимых примесей/повреждений). Не присваивай класс зерна.\n\n"
    "ПРАВИЛО 4 (форматирование): КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать звёздочки ('*', '**', '***') "
    "и разделители из трёх тире ('---', '———') в тексте. Пиши обычным чистым текстом.\n\n"
    "Верни СТРОГО валидный JSON:\n"
    "{\n"
    '  "detected": true,\n'
    '  "is_grain": true,\n'
    '  "crop": "Пшеница яровая",\n'
    '  "grain_count": 240,\n'
    '  "sound_percent": 92.0,\n'
    '  "weed_impurity_percent": 2.0,\n'
    '  "grain_impurity_percent": 3.5,\n'
    '  "broken_percent": 1.5,\n'
    '  "damaged_percent": 1.0,\n'
    '  "grade": "Требуется лабораторный анализ",\n'
    '  "quality_rating": "good | acceptable | poor",\n'
    '  "assessment": "Краткий вывод по чистоте и повреждениям пробы в Акмолинской области",\n'
    '  "recommendation": "Рекомендация (доработка на решётах, сушка, сепарация, условия хранения)"\n'
    "}\n"
)


def _grain_unavailable(message: str) -> dict[str, Any]:
    return {
        "detected": False,
        "is_grain": False,
        "crop": "—",
        "grain_count": 0,
        "sound_percent": 0.0,
        "weed_impurity_percent": 0.0,
        "grain_impurity_percent": 0.0,
        "broken_percent": 0.0,
        "damaged_percent": 0.0,
        "grade": "—",
        "quality_rating": "none",
        "confidence": None,
        "measurement_basis": "unavailable",
        "laboratory_grade_available": False,
        "assessment": clean_agronomic_text(message),
        "recommendation": "—",
    }


def _pct(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return round(max(0.0, min(100.0, float(value))), 1)
    except Exception:
        return None


def _normalize_grain_result(parsed: dict[str, Any]) -> dict[str, Any]:
    detected = bool(parsed.get("detected", True))
    is_grain = bool(parsed.get("is_grain", detected))
    if not detected or not is_grain:
        return {
            "detected": False,
            "is_grain": False,
            "crop": "—",
            "grain_count": 0,
            "sound_percent": 0.0,
            "weed_impurity_percent": 0.0,
            "grain_impurity_percent": 0.0,
            "broken_percent": 0.0,
            "damaged_percent": 0.0,
            "grade": "—",
            "quality_rating": "none",
            "confidence": None,
            "measurement_basis": "visual_area_estimate",
            "laboratory_grade_available": False,
            "assessment": clean_agronomic_text(str(parsed.get("assessment") or "На фото не обнаружено зерновой пробы.")),
            "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "Рассыпьте зерно тонким слоем на ровной однотонной поверхности и сфотографируйте крупным планом при дневном свете.")),
        }

    weed = _pct(parsed.get("weed_impurity_percent"))
    grain_imp = _pct(parsed.get("grain_impurity_percent"))
    broken = _pct(parsed.get("broken_percent"))
    damaged = _pct(parsed.get("damaged_percent"))
    sound = _pct(parsed.get("sound_percent"))
    defects = [weed, grain_imp, broken, damaged]
    if sound is None and all(value is not None for value in defects):
        sound = _pct(100.0 - sum(value for value in defects if value is not None))

    rating = str(parsed.get("quality_rating") or "").lower().strip()
    if rating not in ["good", "acceptable", "poor"]:
        total_defect = sum(value for value in defects if value is not None)
        if len([value for value in defects if value is not None]) < 4:
            rating = "none"
        elif total_defect <= 5:
            rating = "good"
        elif total_defect <= 15:
            rating = "acceptable"
        else:
            rating = "poor"

    return {
        "detected": True,
        "is_grain": True,
        "crop": clean_agronomic_text(str(parsed.get("crop") or "Зерновая культура").strip() or "Зерновая культура"),
        "grain_count": max(int(round(float(parsed.get("grain_count", 0) or 0))), 0),
        "sound_percent": sound,
        "weed_impurity_percent": weed,
        "grain_impurity_percent": grain_imp,
        "broken_percent": broken,
        "damaged_percent": damaged,
        "grade": "Требуется лабораторный анализ",
        "quality_rating": rating,
        "confidence": None,
        "measurement_basis": "visual_area_estimate",
        "laboratory_grade_available": False,
        "assessment": clean_agronomic_text(str(parsed.get("assessment") or "Оценка качества зерна выполнена.")),
        "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "—")),
    }


def _query_gemini_grain_quality(image_bytes: bytes) -> dict[str, Any] | None:
    """Контроль качества зерна по фото пробы через Gemini Vision (каскад моделей)."""
    if not GEMINI_API_KEYS:
        return None
    try:
        im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        im.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        b64_data = base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception:
        return None

    payload = {
        "contents": [{"parts": [
            {"text": _GRAIN_PROMPT},
            {"inlineData": {"mimeType": "image/jpeg", "data": b64_data}},
        ]}],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }
    for _api_key, model_name, url in _gemini_model_urls(VISION_MODELS):
        try:
            with httpx.Client(timeout=httpx.Timeout(25.0, connect=5.0)) as client:
                resp = client.post(url, json=payload)
                if resp.status_code != 200:
                    continue
                raw_json = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                return _normalize_grain_result(json.loads(raw_json))
        except Exception:
            continue
    return None


def analyze_grain_quality_bytes(image_bytes: bytes, filename: str = "grain.jpg") -> dict[str, Any]:
    """
    Задача 3.3: контроль качества зерна по фото пробы (сорная/зерновая примесь, битое, повреждённое).
    Строго Gemini Vision; при недоступности — честный отказ (без выдуманных чисел).
    """
    result = _query_gemini_grain_quality(image_bytes)
    if result is not None:
        return result
    return _grain_unavailable("Модель Gemini временно недоступна (превышен лимит запросов). Повторите через минуту.")


# ---------------------------------------------------------------------------
# Задача 3.4 — Идентификация и подсчёт поголовья скота по изображению
# (визуальная оценка: систематический счёт по сетке)
# ---------------------------------------------------------------------------

_LIVESTOCK_PROMPT = (
    "Ты — система предварительного визуального подсчёта поголовья Tanap AI для хозяйств Акмолинской области по фото (в т.ч. с дрона). "
    "Главное — аккуратно оценить число видимых животных: не пропустить настоящих и не пересчитать одно "
    "животное дважды и не принимать посторонние объекты за скот).\n\n"
    "Это визуальная оценка по изображению, не калиброванная вероятность и не инвентаризационная ведомость.\n\n"
    "ПРАВИЛО 1 (валидация): если на фото НЕТ животных (пустое поле, экран, интерьер, техника, только люди) — "
    "верни detected=false, is_livestock=false, animals=[], total_count=0.\n\n"
    "ПРАВИЛО 2 (ГЛАВНАЯ МЕТОДИКА — ПОШТУЧНОЕ ПЕРЕЧИСЛЕНИЕ):\n"
    "  Не называй число «на глаз». Вместо этого составь СПИСОК каждого отдельного животного (массив animals). "
    "Для каждого животного — один элемент: {id, name (рус.), name_en, location (где оно в кадре: "
    "'слева спереди', 'центр, лежит', 'вдали справа' и т.п.)}.\n"
    "  Правила списка:\n"
    "   • Одно РЕАЛЬНОЕ животное = РОВНО ОДИН элемент. Считай по головам/телам.\n"
    "   • Включай частично перекрытых, лежащих, стоящих спиной, на самом краю кадра, мелких и далёких.\n"
    "   • НЕ добавляй элемент для: тени, отражения в воде, пятна на земле, куста, камня, столба, "
    "человека, собаки-пастуха, техники. Если объект СОМНИТЕЛЕН (не уверен, что это животное) — НЕ добавляй.\n"
    "   • НЕ дублируй: если одно животное частично видно за другим — это всё равно ОДНО животное, один элемент. "
    "Различай перекрывающихся животных по отдельным головам/ногам, но не удваивай одно и то же тело.\n\n"
    "ПРАВИЛО 3 (САМОПРОВЕРКА — обязательно перед ответом):\n"
    "  Перечитай свой список animals и проверь: (а) нет ли двух элементов на одно и то же животное (дубли) — "
    "удали дубли; (б) нет ли элементов на тень/человека/собаку/предмет — удали их; (в) не пропущено ли явно "
    "видимое животное — добавь. total_count ДОЛЖЕН строго равняться числу элементов в animals.\n\n"
    "ПРАВИЛО 4 (очень плотное стадо, >60 голов): если поштучно перечислить физически невозможно, перечисли "
    "сколько сможешь по краям, а для плотной массы оцени числом по рядам×колонкам; в count_range укажи "
    "реалистичный диапазон.\n\n"
    "ПРАВИЛО 5 (форматирование): КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать звёздочки ('*', '**', '***') "
    "и разделители из трёх тире ('---', '———') в тексте. Пиши обычным чистым текстом.\n\n"
    "Возможные виды (name_en): cattle (КРС), sheep (овцы), goat (козы), horse (лошади), pig (свиньи), "
    "camel (верблюды), poultry (птица), buffalo (буйволы/яки).\n\n"
    "Верни СТРОГО валидный JSON:\n"
    "{\n"
    '  "detected": true,\n'
    '  "is_livestock": true,\n'
    '  "shot_type": "ground | drone",\n'
    '  "animals": [\n'
    '    {"id": 1, "name": "Корова", "name_en": "cattle", "location": "слева, стоит боком"},\n'
    '    {"id": 2, "name": "Корова", "name_en": "cattle", "location": "центр, лежит"}\n'
    "  ],\n"
    '  "total_count": 2,\n'
    '  "crowding": "low | moderate | high",\n'
    '  "count_range": "7–7",\n'
    '  "assessment": "Краткий вывод: сколько и каких животных, что могло влиять на визуальный подсчёт",\n'
    '  "recommendation": "Совет для более точного подсчёта, если нужно"\n'
    "}\n"
)

_SPECIES_EN = ["cattle", "sheep", "goat", "horse", "pig", "camel", "poultry", "buffalo", "other"]


def _livestock_unavailable(message: str) -> dict[str, Any]:
    return {
        "detected": False,
        "is_livestock": False,
        "shot_type": "—",
        "total_count": 0,
        "species": [],
        "dominant_species": "—",
        "crowding": "—",
        "confidence": None,
        "measurement_basis": "unavailable",
        "count_method": "unavailable",
        "count_range": "—",
        "assessment": clean_agronomic_text(message),
        "recommendation": "—",
    }


def _normalize_livestock_result(parsed: dict[str, Any]) -> dict[str, Any]:
    detected = bool(parsed.get("detected", True))
    is_livestock = bool(parsed.get("is_livestock", detected))
    if not detected or not is_livestock:
        return {
            "detected": False,
            "is_livestock": False,
            "shot_type": "—",
            "total_count": 0,
            "species": [],
            "dominant_species": "—",
            "crowding": "—",
            "confidence": None,
            "measurement_basis": "visual_model_count",
            "count_method": "enumerated",
            "count_range": "—",
            "assessment": clean_agronomic_text(str(parsed.get("assessment") or "На фото не обнаружено скота.")),
            "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "Сфотографируйте стадо целиком при хорошем освещении или снимите сверху с дрона.")),
        }

    # Канонические русские названия видов по name_en
    species_ru = {
        "cattle": "Крупный рогатый скот",
        "sheep": "Овцы",
        "goat": "Козы",
        "horse": "Лошади",
        "pig": "Свиньи",
        "camel": "Верблюды",
        "poultry": "Птица",
        "buffalo": "Буйволы / яки",
        "other": "Другие животные",
    }

    def _norm_species_en(raw: Any) -> str:
        s = str(raw or "").lower().strip()
        return s if s in _SPECIES_EN else "other"

    species_out: list[dict[str, Any]] = []
    total = 0

    # ГЛАВНЫЙ путь: поштучный список animals — total = число элементов, виды агрегируем из списка
    raw_animals = parsed.get("animals")
    if isinstance(raw_animals, list) and raw_animals:
        counts: dict[str, int] = {}
        display_name: dict[str, str] = {}
        for item in raw_animals:
            if not isinstance(item, dict):
                continue
            name_en = _norm_species_en(item.get("name_en"))
            counts[name_en] = counts.get(name_en, 0) + 1
            if name_en not in display_name:
                nm = str(item.get("name") or "").strip()
                display_name[name_en] = nm or species_ru.get(name_en, "Животное")
            total += 1
        # Порядок по убыванию количества
        for name_en, cnt in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
            species_out.append({
                "name": species_ru.get(name_en, display_name.get(name_en, "Животное")),
                "name_en": name_en,
                "count": cnt,
            })
    else:
        # Резервный путь (очень плотное стадо): агрегированные виды + total_count
        raw_species = parsed.get("species")
        if isinstance(raw_species, list):
            for item in raw_species:
                if not isinstance(item, dict):
                    continue
                name_en = _norm_species_en(item.get("name_en"))
                name = str(item.get("name") or species_ru.get(name_en, "")).strip()
                if not name:
                    continue
                try:
                    count = max(int(round(float(item.get("count", 0) or 0))), 0)
                except Exception:
                    count = 0
                species_out.append({"name": name, "name_en": name_en, "count": count})
        species_sum = sum(s["count"] for s in species_out)
        try:
            total = int(round(float(parsed.get("total_count", 0) or 0)))
        except Exception:
            total = 0
        if species_sum > 0 and (total <= 0 or abs(total - species_sum) > max(2, int(species_sum * 0.1))):
            total = species_sum
        total = max(total, species_sum, 0)

    shot_type = str(parsed.get("shot_type") or "ground").lower().strip()
    if shot_type not in ["ground", "drone"]:
        shot_type = "drone" if "drone" in shot_type or "air" in shot_type else "ground"

    crowding = str(parsed.get("crowding") or "moderate").lower().strip()
    if crowding not in ["low", "moderate", "high"]:
        crowding = "moderate"

    dominant = str(parsed.get("dominant_species") or "").strip()
    if not dominant and species_out:
        dominant = max(species_out, key=lambda s: s["count"])["name"]
    dominant = dominant or "—"

    return {
        "detected": True,
        "is_livestock": True,
        "shot_type": shot_type,
        "total_count": total,
        "species": species_out,
        "dominant_species": dominant,
        "crowding": crowding,
        "confidence": None,
        "measurement_basis": "visual_model_count",
        "count_method": "enumerated" if isinstance(raw_animals, list) and raw_animals else "dense_estimate",
        "count_range": str(parsed.get("count_range") or "").strip() or "—",
        "assessment": clean_agronomic_text(str(parsed.get("assessment") or "Подсчёт поголовья выполнен.")),
        "recommendation": clean_agronomic_text(str(parsed.get("recommendation") or "—")),
    }


def _query_gemini_livestock(image_bytes: bytes) -> dict[str, Any] | None:
    """
    Предварительный визуальный подсчёт поголовья скота через Gemini Vision.
    Высокое разрешение (видно далёких/мелких животных) + систематический счёт по сетке.
    """
    if not GEMINI_API_KEYS:
        return None
    try:
        im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        # Высокое разрешение критично для подсчёта: мелкие/далёкие животные должны остаться различимы
        im.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=92)
        b64_data = base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception:
        return None

    payload = {
        "contents": [{"parts": [
            {"text": _LIVESTOCK_PROMPT},
            {"inlineData": {"mimeType": "image/jpeg", "data": b64_data}},
        ]}],
        # temperature 0 reduces answer variance; it does not calibrate accuracy.
        "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"},
    }
    for _api_key, model_name, url in _gemini_model_urls(VISION_MODELS):
        try:
            with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
                resp = client.post(url, json=payload)
                if resp.status_code != 200:
                    continue
                raw_json = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                return _normalize_livestock_result(json.loads(raw_json))
        except Exception:
            continue
    return None


def count_livestock_in_image_bytes(image_bytes: bytes, filename: str = "herd.jpg") -> dict[str, Any]:
    """
    Задача 3.4: идентификация и предварительный визуальный подсчёт скота по фото.
    Строго Gemini Vision; при недоступности — честный отказ (без выдуманных чисел).
    """
    result = _query_gemini_livestock(image_bytes)
    if result is not None:
        return result
    return _livestock_unavailable("Модель Gemini временно недоступна (превышен лимит запросов). Повторите через минуту.")


# ---------------------------------------------------------------------------
# Agronomic Chat / Q&A Engine (Strictly Akmola Region, RK)
# ---------------------------------------------------------------------------

OFFLINE_KNOWLEDGE_FAQ = [
    (
        r"(ndvi|индекс|вегетаци|0\.[0-9]+|низк.*ndvi)",
        "Интерпретация индекса вегетации NDVI в Акмолинской области:\n\n"
        "• NDVI < 0.25 (Июнь–Июль): Критическое угнетение, изреженный стеблестой или сильная засуха/засоление.\n"
        "• NDVI 0.30 – 0.45: Среднее развитие для богарного земледелия Акмолинской области. Требуется проверка очагов сорной растительности или корневых гнилей.\n"
        "• NDVI 0.50 – 0.75: Оптимальное развитие биомассы яровой пшеницы в фазах колошения – налива зерна.\n"
        "• Резкий спад NDVI на 0.15+ за 10 дней: Маркер стресса (заморозок, вспышка ржавчины или дефицит влаги по NDMI < 0.10)."
    ),
    (
        r"(ржавчин|желт.*ржавчин|бурая|пустул)",
        "Регламент борьбы с ржавчиной (Puccinia spp.) в Акмолинской области:\n\n"
        "1. Экономический порог вредоносности (ЭПВ): 1–2 пустулы на 10% растений до колошения.\n"
        "2. Препараты первой линии: Триазолы длительного действия — Тебуконазол (250 г/л) 0.5 л/га или смесь Пропиконазол + Ципроконазол 0.4 л/га по каталогу СЗР РК.\n"
        "3. Сроки: Обработка по флаговому листу защищает колос и формирует до 40% урожайности.\n"
        "4. Условия: Температура не выше 22°C (утром или вечером), расход рабочей жидкости 150–200 л/га."
    ),
    (
        r"(септориоз|пятнистост|пикнид)",
        "Защита яровой пшеницы от септориоза в условиях Акмолинской области:\n\n"
        "• Причина: Повышенная влажность и туманы в фазы выхода в трубку – колошения.\n"
        "• Препараты: Комбинация стробилурина с триазолом (Азоксистробин + Дифеноконазол 0.75 л/га) либо Эпоксиконазол + Крезоксим-метил.\n"
        "• Рекомендация: При наличии пятен на 3-м сверху листе обработать всё поле, не дожидаясь перехода на флаговый лист."
    ),
    (
        r"(сорняк|осот|овсюг|вьюнок|гербицид)",
        "Гербицидная защита в степной зоне Акмолинской области:\n\n"
        "• Против злаковых (Овсюг, Щетинник, Просо): Граминициды на основе Клодинафоп-пропаргила (0.3–0.4 л/га) или Феноксапроп-П-этила в фазу 2–4 листьев сорняка.\n"
        "• Против двудольных (Осот, Вьюнок, Щирица): 2,4-Д эфир (0.6–0.8 л/га) или Метсульфурон-метил (8–10 г/га) до фазы второго узла пшеницы.\n"
        "• Баковые смеси: Всегда проверяйте совместимость по температуре (оптимум 15–22°C)."
    ),
    (
        r"(удобрен|азот|селитр|карбамид|фосфор|кас)",
        "Система минерального питания в Акмолинской области:\n\n"
        "• Основное внесение (при посеве): Сульфоаммофос NP(S) 20:20(14) или Аммофос в рядок 40–60 кг/га физического веса.\n"
        "• Листовая подкормка по вегетации: В фазу кущения – выхода в трубку раствором Карбамида (10–15 кг/га) совместно с гуматами или микроэлементами (Zn, Cu).\n"
        "• Флаг-лист: Некорневая азотная подкормка карбамидом (3–5% раствор) повышает содержание клейковины на 1.5–2.5%."
    ),
    (
        r"(норма|сроки.*посев|сев|когда сеять)",
        "Оптимальные сроки и нормы сева в Акмолинской области:\n\n"
        "• Сроки сева мягкой яровой пшеницы: 15–25 мая для среднеспелых сортов (Астана, Шортандинская, Шортандинская 95), 20–28 мая для раннеспелых.\n"
        "• Норма высева: 2.8 – 3.4 млн всхожих зёрен/га (около 110–135 кг/га в зависимости от массы 1000 семян).\n"
        "• Глубина заделки: 5–7 см (во влажный слой почвы с обязательным прикатыванием)."
    ),
]


OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:0.5b")

AGRONOMIST_SYSTEM_PROMPT = (
    "Ты — ведущий эксперт-агроном Tanap AI, специализированный строго на сельском хозяйстве "
    "Акмолинской области (Республика Казахстан).\n"
    "Все рекомендации, климатические коридоры, почвенные характеристики (южные чернозёмы, темно-каштановые, "
    "солонцеватые комплексы степной зоны), влагообеспеченность, сортовой состав (селекции НПЦЗХ им. А.И. Бараева: "
    "Астана, Шортандинская, Шортандинская 95, Акмола и др.), оптимальные сроки сева (15–28 мая), экономические пороги "
    "вредоносности (ЭПВ), степные сорные растения (овсюг, осот розовый и желтый, вьюнок полевой, гречишка татарская) "
    "и регламенты защиты растений должны опираться исключительно на специфику Акмолинской области "
    "и Государственный реестр пестицидов (СЗР), разрешенных к применению в Республике Казахстан.\n\n"
    "СТРОГИЕ ПРАВИЛА ФОРМАТИРОВАНИЯ И СТИЛЯ:\n"
    "1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать разделители из трёх и более тире или дефисов ('---', '———', '– – –') "
    "и горизонтальные черты.\n"
    "2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать звёздочки ('*', '**', '***') в тексте. Не выделяй жирным через **слово**, "
    "пиши обычным текстом без звёздочек. Для маркированных списков используй только дефис с пробелом ('- ') или '• ', "
    "для нумерованных — '1. ', '2. '.\n"
    "3. Отвечай подробно, профессионально, практично, опираясь на переданные параметры хозяйства и полей.\n"
    "4. Не придумывай непроверенные полевые замеры, урожайность или лабораторные показатели; четко отделяй "
    "фактические параметры хозяйства от экспертных рекомендаций.\n"
    "5. Регламенты СЗР и дозировки всегда привязывай к фазе культуры и официальной тарной этикетке зарегистрированного в РК препарата.\n"
    "6. СОХРАНЕНИЕ КОНТЕКСТА ДИАЛОГА: Ты обязан внимательно помнить и учитывать все предыдущие реплики пользователя и свои ответы в этом диалоге. Если пользователь задает уточняющие вопросы ('а какая норма для него?', 'сколько у меня га?', 'а если заморозки?', 'что делать дальше?'), отвечай строго в контексте ранее обсуждавшихся полей, культур, площадей и параметров. Не переспрашивай то, что пользователь уже сообщал в диалоге.\n"
    "7. КАЧЕСТВО И ЗАВЕРШЁННОСТЬ: Давай структурированный, конкретный и завершённый ответ — с чёткими пунктами, "
    "точными препаратами, нормами (л/га, кг/га), сроками и фазами. Всегда доводи мысль до конца и не обрывай ответ на "
    "полуслове. Если вопрос простой — отвечай кратко и по делу, без воды; если сложный — раскрывай по пунктам. "
    "Заканчивай практическим выводом или следующим шагом для фермера."
)


def query_local_ollama(prompt: str) -> str | None:
    """
    Sends the user query to the local neural LLM running on the Mac via Ollama.
    Includes guard against degenerative token repetition loops.
    """
    try:
        payload = {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "system": AGRONOMIST_SYSTEM_PROMPT,
            "stream": False,
            "options": {
                "temperature": 0.3,
                "repeat_penalty": 1.25,
                "num_predict": 450,
            },
        }
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(f"{OLLAMA_URL}/api/generate", json=payload)
            if resp.status_code == 200:
                data = resp.json()
                res_text = data.get("response", "").strip()
                # Guard against degenerate repetition loops (e.g. "1.1.1.1.1.1.1...")
                if len(res_text) > 15:
                    if "1.1.1.1" in res_text or "..." in res_text[:30] or res_text.count("1.") > 10:
                        return None
                    return clean_agronomic_text(res_text)
    except Exception:
        return None
    return None


def format_hidden_farm_context(farm_context: Any) -> str:
    """
    Formats complete farm territory parameters, field coordinates, and live Open-Meteo weather
    into a hidden background system context for Gemini. Never leaks into user message history.
    """
    if not farm_context:
        return ""
    if isinstance(farm_context, str):
        return farm_context.strip()
    if not isinstance(farm_context, dict):
        return ""

    lines = ["СВЕДЕНИЯ О ХОЗЯЙСТВЕ, КООРДИНАТАХ И ОПЕРАТИВНОЙ ПОГОДЕ (АКМОЛИНСКАЯ ОБЛАСТЬ):"]
    farm_name = farm_context.get("farmName")
    if farm_name:
        lines.append(f"- Наименование хозяйства: «{farm_name}»")
    lines.append("- Регион: Акмолинская область (Республика Казахстан)")

    coords = farm_context.get("coordinates")
    if coords and isinstance(coords, dict):
        lat = coords.get("latitude")
        lon = coords.get("longitude")
        if lat is not None and lon is not None:
            lines.append(f"- Географические координаты территории: {float(lat):.4f}°N, {float(lon):.4f}°E")

    if farm_context.get("totalAreaHa"):
        lines.append(f"- Суммарная площадь пашни: {farm_context['totalAreaHa']} га")
    if farm_context.get("fieldsCount"):
        lines.append(f"- Количество полей в обороте: {farm_context['fieldsCount']}")
    if farm_context.get("cropsSummary"):
        lines.append(f"- Структура посевов: {farm_context['cropsSummary']}")

    fields = farm_context.get("fields")
    if fields and isinstance(fields, list):
        lines.append("- Картотека участков и координат:")
        for f in fields:
            name = f.get("name", "Поле")
            crop = f.get("cropType", "не указана")
            area = f.get("areaHa", 0)
            c = f.get("coordinates")
            c_str = f" (центр: {c['latitude']:.4f}°N, {c['longitude']:.4f}°E)" if (isinstance(c, dict) and c.get("latitude") and c.get("longitude")) else ""
            badge = f.get("badge") or f.get("status") or ""
            badge_str = f" | статус: {badge}" if badge else ""
            insp = f.get("inspectionCount")
            insp_str = f" | осмотров: {insp}" if insp is not None else ""
            lines.append(f"  • {name}: {crop}, {area} га{c_str}{badge_str}{insp_str}")

    target_field = farm_context.get("targetField")
    if target_field and isinstance(target_field, dict):
        lines.append("- ЦЕЛЕВОЙ УЧАСТОК ДЛЯ ИНДИВИДУАЛЬНОГО АНАЛИЗА (ФОКУС ВОПРОСА):")
        tf_name = target_field.get("name") or "Участок"
        tf_crop = target_field.get("cropType") or "Культура не указана"
        tf_area = target_field.get("areaHa")
        lines.append(f"  • Название поля: «{tf_name}»")
        lines.append(f"  • Возделываемая культура: {tf_crop}")
        if tf_area:
            lines.append(f"  • Площадь участка: {tf_area} га")
        if target_field.get("perimeterKm"):
            lines.append(f"  • Периметр контура: {target_field['perimeterKm']} км")
        tf_coords = target_field.get("coordinates")
        if tf_coords and isinstance(tf_coords, dict):
            c_lat = tf_coords.get("latitude")
            c_lon = tf_coords.get("longitude")
            if c_lat is not None and c_lon is not None:
                lines.append(f"  • Центроид GPS поля: {float(c_lat):.4f}°N, {float(c_lon):.4f}°E")
        if target_field.get("inspectionCount") is not None:
            lines.append(f"  • Число полевых осмотров: {target_field['inspectionCount']}")
        if target_field.get("badge") or target_field.get("status"):
            lines.append(f"  • Оперативный статус: {target_field.get('badge') or target_field.get('status')}")

    weather = farm_context.get("weather")
    if weather and isinstance(weather, dict):
        lines.append("- Оперативный метеопрогноз Open-Meteo по координатам территории (Акмолинская область):")
        cur = weather.get("current")
        if cur and isinstance(cur, dict):
            t = cur.get("temperature")
            h = cur.get("humidity")
            w = cur.get("windSpeed")
            t_str = f"температура {t:+.1f}°C" if t is not None else ""
            h_str = f"влажность {h:.0f}%" if h is not None else ""
            w_str = f"ветер {w:.1f} м/с (окно для СЗР открыто при ветре < 4 м/с)" if w is not None else ""
            info_cur = ", ".join(filter(None, [t_str, h_str, w_str]))
            if info_cur:
                lines.append(f"  • Текущие условия: {info_cur}")
        fc = weather.get("forecast7d")
        if fc and isinstance(fc, dict):
            max_t = fc.get("maxTemp")
            min_t = fc.get("minTemp")
            precip = fc.get("precipSum")
            wb = fc.get("waterBalance")
            lines.append(f"  • Прогноз на 7 дней: дневные до {max_t:+.1f}°C, ночные минимумы {min_t:+.1f}°C, сумма осадков {precip:.1f} мм, баланс влаги {wb:+.1f} мм")
        alerts = weather.get("alerts")
        if alerts and isinstance(alerts, list):
            for a in alerts:
                if isinstance(a, dict) and a.get("title"):
                    lines.append(f"  • Метео-предупреждение: {a['title']} ({a.get('description', '')})")

    diag = farm_context.get("diagnosis")
    if diag and isinstance(diag, dict):
        lines.append("- Параметры фото-диагностики растения:")
        if diag.get("crop"):
            lines.append(f"  • Культура: {diag['crop']}")
        if diag.get("object_name"):
            lines.append(f"  • Выявленный объект: {diag['object_name']}")
        if diag.get("pathogen"):
            lines.append(f"  • Возбудитель/причина: {diag['pathogen']}")
        if diag.get("severity"):
            lines.append(f"  • Степень: {diag['severity']}")
        if diag.get("affected_area_percent") is not None:
            lines.append(f"  • Видимая доля признаков в кадре: {diag['affected_area_percent']}% (не лабораторная оценка распространённости)")
        if diag.get("chemicals"):
            lines.append(f"  • Рекомендуемые действующие вещества: {diag['chemicals']}")
        if diag.get("rate"):
            lines.append(f"  • Норма расхода: {diag['rate']}")
        if diag.get("weather_limits"):
            lines.append(f"  • Агрометеоокно: {diag['weather_limits']}")

    return "\n".join(lines)


def build_gemini_contents(question: str, history: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    Constructs a strictly compliant, multi-turn conversation payload for Google Gemini API:
    1. Removes welcome greetings from AI to ensure dialogue starts with a real user turn.
    2. Drops leading model turns so contents[0]["role"] == "user".
    3. Prevents duplicate consecutive user messages if the current question was already appended.
    4. Merges consecutive turns of the same role to satisfy Gemini alternating role requirements.
    5. Appends the current user question as the final turn.
    """
    clean_q = question.strip()
    raw_turns: list[dict[str, str]] = []

    if history and isinstance(history, list):
        for msg in history:
            if not isinstance(msg, dict):
                continue
            r = str(msg.get("role") or msg.get("sender") or "").lower().strip()
            role = "user" if r in ["user", "farmer"] else "model"
            text = str(msg.get("text") or msg.get("content") or "").strip()
            if not text:
                continue
            # Drop default welcome greetings from history so dialogue begins with genuine user input
            if "Здравствуйте! Я цифровой агроном" in text or "Я цифровой агроном Tanap AI" in text:
                continue
            raw_turns.append({"role": role, "text": text})

    # If the last item in history is identical to the current question, pop it to avoid duplicate user turn
    if raw_turns and raw_turns[-1]["role"] == "user" and raw_turns[-1]["text"] == clean_q:
        raw_turns.pop()

    # Drop leading model messages so that the conversation strictly starts with a user turn
    while raw_turns and raw_turns[0]["role"] != "user":
        raw_turns.pop(0)

    # Append current question
    raw_turns.append({"role": "user", "text": clean_q})

    # Merge consecutive turns of the same role (user + user -> user, model + model -> model)
    merged_turns: list[dict[str, str]] = []
    for turn in raw_turns:
        if merged_turns and merged_turns[-1]["role"] == turn["role"]:
            merged_turns[-1]["text"] += "\n\n" + turn["text"]
        else:
            merged_turns.append(turn)

    # Format for Gemini API
    gemini_contents: list[dict[str, Any]] = []
    for turn in merged_turns:
        gemini_contents.append({
            "role": turn["role"],
            "parts": [{"text": turn["text"]}],
        })

    return gemini_contents


def _query_gemini_chat(
    question: str,
    history: list[dict[str, Any]] | None = None,
    system_context: str | None = None,
) -> str | None:
    """
    Queries Google Gemini for expert agronomic advice with automatic model fallback.
    Injects territory coordinates, field catalog, and live weather secretly into systemInstruction.
    The user question and history remain completely clean without context clutter.
    """
    if not GEMINI_API_KEYS:
        return None

    try:
        contents = build_gemini_contents(question, history)

        system_instruction_text = AGRONOMIST_SYSTEM_PROMPT
        if system_context and system_context.strip():
            system_instruction_text += "\n\n" + system_context.strip()

        payload = {
            "contents": contents,
            "systemInstruction": {
                "parts": [{"text": system_instruction_text}]
            },
            "generationConfig": {
                "temperature": 0.3,
                # Больше бюджета вывода — чтобы экспертный ответ не обрывался на
                # полуслове (это и есть «качество»). Быстрая lite-модель уверенно
                # выдаёт полные ответы в 3000+ символов за ~5-7 с.
                "maxOutputTokens": 1400,
            },
        }

        # Общий дедлайн на весь каскад, чтобы чат никогда не «висел» 30 с и не
        # обрывался на клиенте. Быстрые lite-модели укладываются в ~1-4 с; если
        # какая-то модель тормозит или отдаёт 503 — быстро уходим к следующей.
        deadline = time.monotonic() + 20.0
        for _api_key, model_name, url in _gemini_model_urls(GEMINI_MODELS):
            remaining = deadline - time.monotonic()
            if remaining <= 1.0:
                break
            try:
                request_timeout = min(remaining, 14.0)
                with httpx.Client(
                    timeout=httpx.Timeout(request_timeout, connect=min(4.0, request_timeout))
                ) as client:
                    resp = client.post(url, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                        if len(text) > 10:
                            return clean_agronomic_text(text)
            except Exception:
                continue
    except Exception:
        pass

    return None


def ask_agronomic_advisor(
    question: str,
    history: list[dict[str, Any]] | None = None,
    farm_context: dict[str, Any] | str | None = None,
) -> str:
    """
    Returns an expert agronomic answer specialized strictly for Akmola region, Kazakhstan.
    Uses Google Gemini and cleans text from markdown dividers (---) and asterisks (*).
    Accepts full farm parameters (crops, areas, fields, statuses, coordinates, weather)
    and passes them hiddenly into systemInstruction without polluting user questions or chat SMS history.
    """
    hidden_system_context = format_hidden_farm_context(farm_context)

    # 1. Primary & Exclusive LLM: Google Gemini Cloud AI Cascade
    gemini_reply = _query_gemini_chat(question.strip(), history, hidden_system_context)
    if gemini_reply:
        return clean_agronomic_text(gemini_reply)

    # Check regional offline FAQ if Gemini failed
    q_lower = question.lower()
    for pattern, answer in OFFLINE_KNOWLEDGE_FAQ:
        if re.search(pattern, q_lower):
            return clean_agronomic_text(answer)

    return clean_agronomic_text(
        "AI-агроном сейчас недоступен. Я не буду подставлять заранее заготовленные нормы или диагнозы вместо ответа модели. "
        "Сохраните вопрос и повторите запрос позже. Срочное решение по защите культур в Акмолинской области "
        "подтвердите у агронома и сверьте с Государственным реестром пестицидов РК."
    )
