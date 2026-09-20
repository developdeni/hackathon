"""Analytical field report built only from data available to Tanap AI."""

from __future__ import annotations

import io
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image as PILImage, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    HRFlowable,
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# ---------------------------------------------------------------------------
# Font Registration & Typography
# ---------------------------------------------------------------------------

_FONTS_INITIALIZED = False
FONT_REGULAR = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def _init_fonts() -> None:
    global _FONTS_INITIALIZED, FONT_REGULAR, FONT_BOLD
    if _FONTS_INITIALIZED:
        return

    regular_candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    bold_candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]

    reg_found = None
    for p in regular_candidates:
        if Path(p).exists():
            reg_found = p
            break

    bold_found = None
    for p in bold_candidates:
        if Path(p).exists():
            bold_found = p
            break

    if reg_found:
        try:
            pdfmetrics.registerFont(TTFont("TanapArial", reg_found))
            FONT_REGULAR = "TanapArial"
        except Exception:
            pass

    if bold_found:
        try:
            pdfmetrics.registerFont(TTFont("TanapArial-Bold", bold_found))
            FONT_BOLD = "TanapArial-Bold"
        except Exception:
            FONT_BOLD = FONT_REGULAR

    _FONTS_INITIALIZED = True


# ---------------------------------------------------------------------------
# Page Decoration Callbacks (Headers & Footers)
# ---------------------------------------------------------------------------

def _draw_page_decorations(canv: canvas.Canvas, doc: Any) -> None:
    canv.saveState()
    _init_fonts()

    # Верхняя акцентная планка
    canv.setFillColor(colors.HexColor("#1B5E20"))
    canv.rect(36, 806, 523, 3, fill=1, stroke=0)

    # Нижняя разделительная черта
    canv.setStrokeColor(colors.HexColor("#D1D1D6"))
    canv.setLineWidth(0.5)
    canv.line(36, 32, 559, 32)

    # Нижний колонтитул
    canv.setFont(FONT_REGULAR, 7.5)
    canv.setFillColor(colors.HexColor("#8E8E93"))
    footer_left = "Полевой аналитический отчёт Tanap AI · Sentinel-2 (Copernicus)"
    canv.drawString(36, 22, footer_left)

    page_num = doc.page if hasattr(doc, "page") else 1
    footer_right = f"Лист {page_num} из 2"
    canv.drawRightString(559, 22, footer_right)

    canv.restoreState()


# ---------------------------------------------------------------------------
# Geodetic & Cartographic Calculations
# ---------------------------------------------------------------------------

def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _to_dms(degrees: float, is_lat: bool) -> str:
    direction = ("N" if degrees >= 0 else "S") if is_lat else ("E" if degrees >= 0 else "W")
    deg_abs = abs(degrees)
    d = int(deg_abs)
    m = int((deg_abs - d) * 60)
    s = (deg_abs - d - m / 60) * 3600
    return f"{d}°{m:02d}'{s:04.1f}\"{direction}"


# ---------------------------------------------------------------------------
# Cartographic Map Rendering (Pillow Engine)
# ---------------------------------------------------------------------------

def _render_field_map_image(boundary: list[dict[str, float]], field_name: str, area_ha: float) -> bytes:
    """
    Генерирует профессиональную картосхему поля высокого разрешения:
    - топографическая сетка с координатами
    - полигон пашни с акцентной рамкой
    - пронумерованные вершины
    - центроид
    - роза ветров и масштабная шкала
    """
    width, height = 1100, 560
    im = PILImage.new("RGB", (width, height), (247, 249, 252))
    draw = ImageDraw.Draw(im)

    if not boundary or len(boundary) < 3:
        draw.text((width // 2 - 120, height // 2), "Контур поля не задан", fill=(120, 120, 120))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()

    lats = [p["latitude"] for p in boundary]
    lons = [p["longitude"] for p in boundary]

    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    lat_span = max(max_lat - min_lat, 0.0008)
    lon_span = max(max_lon - min_lon, 0.0008)

    # Поля с отступом 14%
    margin_x = 90
    margin_y = 65
    plot_w = width - 2 * margin_x
    plot_h = height - 2 * margin_y

    def project(lat: float, lon: float) -> tuple[float, float]:
        px = margin_x + ((lon - min_lon) / lon_span) * plot_w
        py = height - (margin_y + ((lat - min_lat) / lat_span) * plot_h)
        return (px, py)

    # 1. Тонкая топографическая сетка
    grid_color = (222, 227, 235)
    for i in range(1, 6):
        gx = margin_x + (plot_w * i) / 6
        draw.line([(gx, 35), (gx, height - 35)], fill=grid_color, width=1)
    for i in range(1, 5):
        gy = margin_y + (plot_h * i) / 5
        draw.line([(45, gy), (width - 45), gy], fill=grid_color, width=1)

    # 2. Полигон поля (заливка + контур)
    poly_pts = [project(p["latitude"], p["longitude"]) for p in boundary]

    # Полупрозрачная заливка через слой
    poly_layer = PILImage.new("RGBA", (width, height), (0, 0, 0, 0))
    poly_draw = ImageDraw.Draw(poly_layer)
    poly_draw.polygon(poly_pts, fill=(46, 125, 50, 65))
    im.paste(poly_layer, (0, 0), poly_layer)

    # Контурная граница
    draw.polygon(poly_pts, outline=(27, 94, 32), width=4)

    # 3. Вершины полигона с номерами
    for idx, (px, py) in enumerate(poly_pts):
        r = 13
        # Тень
        draw.ellipse([px - r + 1, py - r + 1, px + r + 1, py + r + 1], fill=(200, 205, 215))
        # Круг точки
        draw.ellipse([px - r, py - r, px + r, py + r], fill=(27, 94, 32), outline=(255, 255, 255), width=2)
        # Номер точки
        lbl = str(idx + 1)
        draw.text((px - (4 if len(lbl) == 1 else 7), py - 7), lbl, fill=(255, 255, 255))

    # 4. Центроид
    c_lat = sum(lats) / len(lats)
    c_lon = sum(lons) / len(lons)
    cx, cy = project(c_lat, c_lon)
    cr = 6
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(198, 40, 40), outline=(255, 255, 255), width=2)
    draw.line([(cx - 12, cy), (cx + 12, cy)], fill=(198, 40, 40), width=1)
    draw.line([(cx, cy - 12), (cx, cy + 12)], fill=(198, 40, 40), width=1)
    draw.text((cx + 8, cy - 14), f"Центр ({c_lat:.4f}°, {c_lon:.4f}°)", fill=(198, 40, 40))

    # 5. Роза ветров (North Arrow) в правом верхнем углу
    nx, ny = width - 60, 50
    draw.line([(nx, ny + 25), (nx, ny - 20)], fill=(33, 33, 33), width=2)
    draw.polygon([(nx, ny - 28), (nx - 7, ny - 12), (nx + 7, ny - 12)], fill=(27, 94, 32))
    draw.text((nx - 4, ny - 42), "N", fill=(27, 94, 32))

    # 6. Масштабная шкала в левом нижнем углу
    p1 = (min_lat, min_lon)
    p2 = (min_lat, min_lon + lon_span * 0.25)
    scale_meters = _haversine_meters(p1[0], p1[1], p2[0], p2[1])
    scale_label = f"{int(scale_meters)} м" if scale_meters < 1000 else f"{scale_meters/1000:.1f} км"
    sx1 = margin_x
    sx2 = sx1 + int(plot_w * 0.25)
    sy = height - 28
    draw.line([(sx1, sy), (sx2, sy)], fill=(55, 71, 79), width=3)
    draw.line([(sx1, sy - 5), (sx1, sy + 5)], fill=(55, 71, 79), width=2)
    draw.line([(sx2, sy - 5), (sx2, sy + 5)], fill=(55, 71, 79), width=2)
    draw.text((sx1 + 8, sy - 18), f"Масштаб: ~{scale_label}", fill=(55, 71, 79))

    # 7. Информационная плашка сверху слева
    info_txt = f"КАРТОСХЕМА: {field_name} · Площадь: {area_ha:.1f} га · Вершин: {len(boundary)} · WGS-84"
    draw.rectangle([margin_x - 10, 16, margin_x + len(info_txt) * 7.5, 36], fill=(255, 255, 255), outline=(200, 205, 215))
    draw.text((margin_x, 20), info_txt, fill=(33, 33, 33))

    buf = io.BytesIO()
    im.save(buf, format="PNG", dpi=(200, 200))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# PDF Generation Core
# ---------------------------------------------------------------------------

def generate_agropassport_pdf(
    field: dict[str, Any],
    satellite: dict[str, Any],
    zones: dict[str, Any],
    weather: dict[str, Any],
    classification: dict[str, Any],
    yield_history: list[dict[str, Any]] | None = None,
    yield_forecast: dict[str, Any] | None = None,
    user: dict[str, Any] | None = None,
    farm_profile: dict[str, Any] | None = None,
) -> bytes:
    """Generate a two-page analytical report without legal or cadastral claims."""
    _init_fonts()
    buffer = io.BytesIO()

    # Поля страницы А4: 595.27 x 841.89 pt. Отступы: 36 pt (0.5 дюйма) слева/справа, 32 pt сверху/снизу
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=32,
        bottomMargin=36,
    )

    styles = getSampleStyleSheet()

    # Стили шрифтов
    style_doc_title = ParagraphStyle(
        "DocTitle",
        fontName=FONT_BOLD,
        fontSize=15,
        leading=18,
        textColor=colors.HexColor("#1B5E20"),
        alignment=1,  # Center
    )
    style_doc_subtitle = ParagraphStyle(
        "DocSubtitle",
        fontName=FONT_REGULAR,
        fontSize=8,
        leading=11,
        textColor=colors.HexColor("#3C3C43"),
        alignment=1,
    )
    style_h2 = ParagraphStyle(
        "SectionH2",
        fontName=FONT_BOLD,
        fontSize=10.5,
        leading=13,
        textColor=colors.HexColor("#1B5E20"),
        spaceBefore=7,
        spaceAfter=4,
    )
    style_th = ParagraphStyle(
        "TableHead",
        fontName=FONT_BOLD,
        fontSize=7.5,
        leading=9.5,
        textColor=colors.white,
        alignment=1,
    )
    style_td = ParagraphStyle(
        "TableCell",
        fontName=FONT_REGULAR,
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#1C1C1E"),
    )
    style_td_center = ParagraphStyle(
        "TableCellCenter",
        fontName=FONT_REGULAR,
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#1C1C1E"),
        alignment=1,
    )
    style_td_bold = ParagraphStyle(
        "TableCellBold",
        fontName=FONT_BOLD,
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#1C1C1E"),
    )
    style_legal = ParagraphStyle(
        "LegalText",
        fontName=FONT_REGULAR,
        fontSize=7.5,
        leading=10,
        textColor=colors.HexColor("#2C3E50"),
    )
    style_badge_text = ParagraphStyle(
        "BadgeText",
        fontName=FONT_BOLD,
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#0D5302"),
        alignment=1,
    )

    boundary = field.get("boundary", [])
    lats = [p["latitude"] for p in boundary] if boundary else [51.62]
    lons = [p["longitude"] for p in boundary] if boundary else [71.39]
    center_lat = sum(lats) / len(lats)
    center_lon = sum(lons) / len(lons)

    field_name = str(field.get("name") or "Поле №1")
    area_ha = float(field.get("areaHa", 0.0))
    perimeter_m = float(field.get("perimeterKm", 0.0)) * 1000.0 or 0.0
    crop_type = str(field.get("cropType") or "Яровая пшеница")

    report_id = f"TANAP-{str(field.get('id', 'FIELD')).replace('field-', '')[:12].upper()}"
    doc_date = datetime.now(timezone.utc).strftime("%d.%m.%Y")

    farm_name = (
        (farm_profile.get("name") if farm_profile else None)
        or (user.get("organization") if user else None)
        or "Не указано"
    )
    user_fio = (user.get("name") if user else None) or "Не указано"
    region = (
        (farm_profile.get("region") if farm_profile else None)
        or (user.get("region") if user else None)
        or "Не указан"
    )

    story: list[Any] = []

    # =========================================================================
    # СТРАНИЦА 1
    # =========================================================================

    # 1. Шапка документа
    header_data = [
        [
            Paragraph("TANAP AI · СПУТНИКОВЫЙ И ПОЛЕВОЙ МОНИТОРИНГ", style_doc_subtitle),
        ],
        [
            Paragraph("ПОЛЕВОЙ АНАЛИТИЧЕСКИЙ ОТЧЁТ", style_doc_title),
        ],
        [
            Paragraph(
                f"<b>ID отчёта:</b> {report_id} · <b>Сформирован:</b> {doc_date}<br/>"
                "<i>Аналитический материал. Не является кадастровым документом, юридическим заключением или банковской оценкой.</i>",
                style_doc_subtitle,
            ),
        ],
    ]
    t_header = Table(header_data, colWidths=[523])
    t_header.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING", (0, 0), (-1, -1), 1),
    ]))
    story.append(t_header)
    story.append(Spacer(1, 6))

    # 2. Блок I: сведения из учётной записи и пользовательского контура
    story.append(Paragraph("РАЗДЕЛ I. СВЕДЕНИЯ О ПОЛЕ", style_h2))

    info_data = [
        [
            Paragraph("<b>Землепользователь:</b>", style_td),
            Paragraph(f"{farm_name} (Руководитель: {user_fio})", style_td),
            Paragraph("<b>Внутренний ID поля:</b>", style_td),
            Paragraph(str(field.get("id") or "Не указан"), style_td_bold),
        ],
        [
            Paragraph("<b>Наименование участка:</b>", style_td),
            Paragraph(field_name, style_td),
            Paragraph("<b>Источник границы:</b>", style_td),
            Paragraph("Контур, сохранённый пользователем", style_td),
        ],
        [
            Paragraph("<b>Расчётная площадь:</b>", style_td),
            Paragraph(f"<b>{area_ha:.1f} га</b>", style_td_bold),
            Paragraph("<b>Периметр участка:</b>", style_td),
            Paragraph(f"{perimeter_m:,.0f} м".replace(",", " "), style_td),
        ],
        [
            Paragraph("<b>Координаты центра:</b>", style_td),
            Paragraph(f"{center_lat:.5f}° N, {center_lon:.5f}° E ({_to_dms(center_lat, True)}, {_to_dms(center_lon, False)})", style_td),
            Paragraph("<b>Текущая культура:</b>", style_td),
            Paragraph(f"<b>{crop_type}</b> (сезон {datetime.now().year})", style_td),
        ],
        [
            Paragraph("<b>Регион расположения:</b>", style_td),
            Paragraph(str(region), style_td),
            Paragraph("<b>Система координат:</b>", style_td),
            Paragraph("WGS-84", style_td),
        ],
    ]
    t_info = Table(info_data, colWidths=[110, 160, 110, 143])
    t_info.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8F9FA")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D1D6")),
        ("PADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(t_info)
    story.append(Spacer(1, 7))

    # 3. Блок II: аналитическая классификация по доступному ряду NDVI
    story.append(Paragraph("РАЗДЕЛ II. СПУТНИКОВАЯ КЛАССИФИКАЦИЯ ИСПОЛЬЗОВАНИЯ", style_h2))

    class_label = classification.get("label") or "Недостаточно данных"
    amplitude = classification.get("amplitude")
    amplitude_text = f"{amplitude:.2f}" if isinstance(amplitude, (int, float)) else "нет данных"
    badge_title = f"СПУТНИКОВАЯ КЛАССИФИКАЦИЯ: {str(class_label).upper()}"
    verdict_text = (
        f"Классификация рассчитана по доступным наблюдениям Sentinel-2. "
        f"Сезонная амплитуда NDVI: <b>{amplitude_text}</b>. "
        f"{classification.get('description') or 'Наблюдений недостаточно для устойчивой классификации.'} "
        "Результат является дистанционной аналитической оценкой и требует проверки на поле; он не подтверждает "
        "правовой статус или соблюдение требований земельного законодательства."
    )

    verdict_box = [
        [Paragraph(badge_title, style_badge_text)],
        [Paragraph(verdict_text, style_legal)],
    ]
    t_verdict = Table(verdict_box, colWidths=[523])
    t_verdict.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F5E9")),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#F1F8E9")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#2E7D32")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#81C784")),
        ("PADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(t_verdict)
    story.append(Spacer(1, 7))

    # 4. Блок III: картосхема и координаты пользовательского контура
    story.append(Paragraph("РАЗДЕЛ III. КАРТОСХЕМА И КООРДИНАТЫ КОНТУРА", style_h2))

    # Генерируем картосхему поля через Pillow
    map_png_bytes = _render_field_map_image(boundary, field_name, area_ha)
    map_flowable = Image(io.BytesIO(map_png_bytes), width=285, height=145)

    # Формируем таблицу поворотных точек (до 7 точек на страницу 1)
    pts_rows = [
        [
            Paragraph("№", style_th),
            Paragraph("Широта (B)", style_th),
            Paragraph("Долгота (L)", style_th),
            Paragraph("Длина, м", style_th),
        ]
    ]

    for idx, p in enumerate(boundary[:6]):
        next_p = boundary[(idx + 1) % len(boundary)]
        dist = _haversine_meters(p["latitude"], p["longitude"], next_p["latitude"], next_p["longitude"])
        pts_rows.append([
            Paragraph(f"T-{idx+1}", style_td_center),
            Paragraph(f"{p['latitude']:.5f}°", style_td_center),
            Paragraph(f"{p['longitude']:.5f}°", style_td_center),
            Paragraph(f"{dist:.0f} м", style_td_center),
        ])

    if len(boundary) > 6:
        pts_rows.append([
            Paragraph("...", style_td_center),
            Paragraph(f"Ещё {len(boundary)-6} точек", style_td_center),
            Paragraph("—", style_td_center),
            Paragraph("см. ГИС", style_td_center),
        ])

    t_points = Table(pts_rows, colWidths=[28, 70, 70, 56])
    t_points.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1B5E20")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D1D6")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING", (0, 0), (-1, -1), 3),
    ]))

    map_and_pts = [
        [map_flowable, t_points]
    ]
    t_map_block = Table(map_and_pts, colWidths=[293, 230])
    t_map_block.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(t_map_block)

    # Переход на страницу 2
    story.append(PageBreak())

    # =========================================================================
    # СТРАНИЦА 2
    # =========================================================================

    # Шапка листа 2
    p2_header = Table([
        [
            Paragraph("<b>ТЕХНИЧЕСКАЯ И АНАЛИТИЧЕСКАЯ ЧАСТЬ</b>", style_doc_subtitle),
            Paragraph(f"<b>Отчёт:</b> {report_id}", ParagraphStyle("Right", parent=style_doc_subtitle, alignment=2)),
        ]
    ], colWidths=[360, 163])
    p2_header.setStyle(TableStyle([("PADDING", (0, 0), (-1, -1), 0)]))
    story.append(p2_header)
    story.append(Spacer(1, 4))
    story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#D1D1D6"), spaceBefore=2, spaceAfter=6))

    # 5. Блок IV: фактические наблюдения Sentinel-2
    story.append(Paragraph("РАЗДЕЛ IV. ДОСТУПНЫЕ НАБЛЮДЕНИЯ SENTINEL-2 L2A", style_h2))
    history_data = [
        [
            Paragraph("Дата", style_th),
            Paragraph("NDVI", style_th),
            Paragraph("NDMI", style_th),
            Paragraph("Ясные пиксели", style_th),
            Paragraph("Надёжность", style_th),
            Paragraph("Источник", style_th),
        ],
    ]
    observations = satellite.get("observations") or []
    for obs in observations[-3:]:
        ndvi = obs.get("ndviMedian") if obs.get("ndviMedian") is not None else obs.get("ndviMean")
        ndmi = obs.get("ndmiMean")
        clear = obs.get("clearPixelPercent")
        history_data.append([
            Paragraph(str(obs.get("date") or "Нет даты"), style_td_center),
            Paragraph(f"{ndvi:.3f}" if isinstance(ndvi, (int, float)) else "Нет данных", style_td_center),
            Paragraph(f"{ndmi:.3f}" if isinstance(ndmi, (int, float)) else "Нет данных", style_td_center),
            Paragraph(f"{clear:.0f}%" if isinstance(clear, (int, float)) else "Нет данных", style_td_center),
            Paragraph(str(obs.get("reliability") or "Не оценена"), style_td_center),
            Paragraph(str(satellite.get("source") or "Copernicus Sentinel-2"), style_td),
        ])
    if not observations:
        history_data.append([
            Paragraph("Нет данных", style_td_center),
            Paragraph("—", style_td_center),
            Paragraph("—", style_td_center),
            Paragraph("—", style_td_center),
            Paragraph("—", style_td_center),
            Paragraph(str(satellite.get("message") or "Наблюдения недоступны"), style_td),
        ])
    t_history = Table(history_data, colWidths=[72, 62, 62, 90, 85, 152])
    t_history.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1B5E20")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D1D6")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8F9FA")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING", (0, 0), (-1, -1), 3.5),
    ]))
    story.append(t_history)
    story.append(Spacer(1, 6))

    # 6. Блок V: фактическая погода и модельный прогноз урожайности
    story.append(Paragraph("РАЗДЕЛ V. ПОГОДА И ПРОГНОЗ УРОЖАЙНОСТИ", style_h2))

    forecast_data = yield_forecast or {}
    forecast_value = forecast_data.get("forecastTPerHa")
    interval = forecast_data.get("interval80") or {}
    forecast_text = "Нет данных"
    gross_text = "Нет данных"
    if isinstance(forecast_value, (int, float)):
        forecast_text = f"{forecast_value:.2f} т/га"
        if isinstance(interval.get("low"), (int, float)) and isinstance(interval.get("high"), (int, float)):
            forecast_text += f" (80% ДИ {interval['low']:.2f}–{interval['high']:.2f})"
        gross_text = f"{forecast_value * area_ha:,.1f} т".replace(",", " ")

    current_w = weather.get("current", {})
    forecast_w = weather.get("forecast7d", {})

    agro_data = [
        [
            Paragraph("<b>Текущая температура:</b>", style_td),
            Paragraph(f"{current_w['temperature']:.1f}°C" if isinstance(current_w.get("temperature"), (int, float)) else "Нет данных", style_td),
            Paragraph("<b>Модельный прогноз урожая:</b>", style_td),
            Paragraph(f"<b>{forecast_text}</b>", style_td_bold),
        ],
        [
            Paragraph("<b>Осадки 7-дневный прогноз:</b>", style_td),
            Paragraph(f"{forecast_w['precipSum']:.1f} мм" if isinstance(forecast_w.get("precipSum"), (int, float)) else "Нет данных", style_td),
            Paragraph("<b>Ожидаемый валовой сбор:</b>", style_td),
            Paragraph(f"<b>{gross_text}</b>", style_td_bold),
        ],
        [
            Paragraph("<b>Текущая темп. и влажность:</b>", style_td),
            Paragraph(f"{current_w['humidity']:.0f}%" if isinstance(current_w.get("humidity"), (int, float)) else "Нет данных", style_td),
            Paragraph("<b>История урожайности:</b>", style_td),
            Paragraph(f"{len(yield_history or [])} записей хозяйства", style_td),
        ],
        [
            Paragraph("<b>Источник погоды:</b>", style_td),
            Paragraph(str(weather.get("source") or "Нет данных"), style_td),
            Paragraph("<b>Качество модели:</b>", style_td),
            Paragraph(str(forecast_data.get("modelQuality") or forecast_data.get("message") or "Нет данных"), style_td),
        ],
    ]
    t_agro = Table(agro_data, colWidths=[130, 140, 120, 133])
    t_agro.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8F9FA")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D1D6")),
        ("PADDING", (0, 0), (-1, -1), 3.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(t_agro)
    story.append(Spacer(1, 6))

    # 7. Блок VI: спектральная неоднородность, не диагноз заболевания
    story.append(Paragraph("РАЗДЕЛ VI. СПЕКТРАЛЬНЫЕ ЗОНЫ РИСКА", style_h2))

    zones_list = zones.get("zones", [])
    zones_cnt = len(zones_list)

    if zones_cnt == 0:
        phyto_text = (
            "По доступной пиксельной сетке Sentinel-2 значимые зоны спектральной неоднородности не выделены. "
            "Это не исключает болезни, вредителей или сорняки: спутниковые индексы не устанавливают причину без осмотра."
        )
    else:
        top_zone = zones_list[0]
        suspect_area = zones.get("totalSuspectAreaHa")
        zone_area = top_zone.get("areaHa")
        ndvi_deficit = top_zone.get("ndviDeficit")
        suspect_area_text = f"{suspect_area:.1f} га" if isinstance(suspect_area, (int, float)) else "площадь не рассчитана"
        zone_area_text = f"{zone_area:.1f} га" if isinstance(zone_area, (int, float)) else "площадь не рассчитана"
        deficit_text = f"{ndvi_deficit:.2f}" if isinstance(ndvi_deficit, (int, float)) else "нет данных"
        phyto_text = (
            f"Выявлено {zones_cnt} локальных очага неоднородности развития биомассы общей площадью "
            f"{suspect_area_text}. Приоритетный очаг: {top_zone.get('title') or 'Без названия'} "
            f"({zone_area_text}, ΔNDVI = {deficit_text}). "
            f"Фактор: {top_zone.get('mainFactor') or 'не определён'}. "
            f"Рекомендация: {top_zone.get('recommendation') or 'выполнить контрольный осмотр'}."
        )

    t_phyto = Table([[Paragraph(phyto_text, style_legal)]], colWidths=[523])
    t_phyto.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFFDE7")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#FBC02D")),
        ("PADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(t_phyto)
    story.append(Spacer(1, 8))

    # 8. Блок VII: происхождение и ограничения данных
    story.append(Paragraph("РАЗДЕЛ VII. ИСТОЧНИКИ И ОГРАНИЧЕНИЯ", style_h2))
    source_text = (
        f"<b>ID отчёта:</b> {report_id}<br/>"
        f"<b>Спутниковые данные:</b> {satellite.get('source') or 'Нет данных'}<br/>"
        f"<b>Погодные данные:</b> {weather.get('source') or 'Нет данных'}<br/>"
        f"<b>Сформировано:</b> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}<br/>"
        "<i>Площадь и периметр вычислены по сохранённому пользовательскому контуру. Документ не содержит "
        "кадастровой проверки, электронной цифровой подписи или подтверждения государственных органов. "
        "Спутниковые и модельные результаты требуют полевой верификации.</i>"
    )

    cert_box = [[Paragraph(source_text, style_legal)]]
    t_cert = Table(cert_box, colWidths=[523])
    t_cert.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F8F9FA")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#1B5E20")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t_cert)

    # Собираем документ со стандартными колонтитулами
    doc.build(story, onFirstPage=_draw_page_decorations, onLaterPages=_draw_page_decorations)
    return buffer.getvalue()
