"""
Public verification web page rendering for Tanap AI reports.
Provides an interactive, cryptographic verification portal for scanned QR codes.
"""

from __future__ import annotations

import html
from typing import Any


def render_verification_page(record: dict[str, Any]) -> str:
    meta = record.get("metadata") or {}
    report_num = html.escape(str(record.get("reportNum") or "KZ-TANAP-2026"))
    report_id = html.escape(str(record.get("id") or ""))
    file_sha256 = html.escape(str(record.get("fileSha256") or "").lower())
    payload_sha256 = html.escape(str(record.get("payloadSha256") or "").lower())
    created_at = html.escape(
        str(record.get("createdAt") or "").replace("T", " ").replace("+00:00", " UTC")
    )

    field_name = html.escape(str(meta.get("fieldName") or "Поле"))
    crop_type = html.escape(str(meta.get("cropType") or "Яровая культура"))
    area_ha = f"{float(meta.get('areaHa', 0.0)):.1f} га"
    farm_name = html.escape(str(meta.get("farmName") or "Не указано"))
    farmer_name = html.escape(str(meta.get("farmerName") or "Не указан"))
    region = html.escape(str(meta.get("region") or "Акмолинская область"))

    centroid = meta.get("centroid") or {}
    lat = centroid.get("lat")
    lon = centroid.get("lon")
    coords_text = (
        f"{lat:.5f}° N, {lon:.5f}° E"
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float))
        else "WGS-84"
    )

    satellite = meta.get("satellite") or {}
    sat_source = html.escape(str(satellite.get("source") or "Copernicus Sentinel-2 L2A"))
    sat_class = satellite.get("classification") or {}
    class_label = html.escape(str(sat_class.get("label") or "Пашня / Зерновые"))

    weather = meta.get("weather") or {}
    weather_source = html.escape(str(weather.get("source") or "Open-Meteo ECMWF"))
    temp = weather.get("temp")
    temp_text = f"{temp:.1f}°C" if isinstance(temp, (int, float)) else "—"

    forecast = meta.get("forecast") or {}
    forecast_val = forecast.get("forecastTPerHa")
    interval = forecast.get("interval80") or {}
    if isinstance(forecast_val, (int, float)):
        forecast_text = f"{forecast_val:.2f} т/га"
        if isinstance(interval.get("low"), (int, float)) and isinstance(
            interval.get("high"), (int, float)
        ):
            forecast_text += f" (80% ДИ {interval['low']:.2f}–{interval['high']:.2f})"
    else:
        forecast_text = "Модельный расчёт в оригинале отчёта"

    download_url = f"/verify/{report_id}/download"

    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Верификация отчёта {report_num} · Tanap AI</title>
  <meta name="description" content="Публичная проверка подлинности полевого аналитического отчёта Tanap AI">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌱</text></svg>">
  <style>
    :root {{
      --primary: #1B5E20;
      --primary-hover: #144617;
      --primary-light: #E8F5E9;
      --primary-border: #A5D6A7;
      --bg: #F8FAFC;
      --card-bg: #FFFFFF;
      --text: #0F172A;
      --text-muted: #64748B;
      --border: #E2E8F0;
      --success: #16A34A;
      --success-bg: #DCFCE7;
      --code-bg: #F1F5F9;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 24px 16px 48px;
    }}
    .container {{
      max-width: 680px;
      margin: 0 auto;
    }}
    .header-brand {{
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }}
    .brand-badge {{
      background: var(--primary);
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 999px;
    }}
    .brand-title {{
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }}
    .status-card {{
      background: var(--primary-light);
      border: 1.5px solid var(--primary-border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 20px;
    }}
    .status-icon {{
      width: 44px;
      height: 44px;
      background: var(--primary);
      color: #FFFFFF;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(27, 94, 32, 0.25);
    }}
    .status-title {{
      font-size: 18px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 4px;
    }}
    .status-desc {{
      font-size: 13px;
      color: #2E7D32;
      line-height: 1.4;
    }}
    .card {{
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    }}
    .card-title {{
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 16px;
    }}
    .info-grid {{
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px 20px;
    }}
    @media (max-width: 520px) {{
      .info-grid {{ grid-template-columns: 1fr; gap: 12px; }}
    }}
    .info-item {{
      display: flex;
      flex-direction: column;
      gap: 2px;
    }}
    .info-label {{
      font-size: 12px;
      color: var(--text-muted);
    }}
    .info-val {{
      font-size: 14.5px;
      font-weight: 600;
      color: var(--text);
    }}
    .hash-block {{
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }}
    .hash-block:first-child {{
      margin-top: 0;
      padding-top: 0;
      border-top: none;
    }}
    .hash-label-row {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }}
    .hash-label {{
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }}
    .copy-btn {{
      background: transparent;
      border: none;
      color: var(--primary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }}
    .copy-btn:hover {{ background: var(--primary-light); }}
    .hash-code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
      background: var(--code-bg);
      padding: 8px 10px;
      border-radius: 8px;
      word-break: break-all;
      color: #334155;
      border: 1px solid #E2E8F0;
    }}
    .verifier-box {{
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      background: #FAFAFA;
      transition: all 0.2s ease;
      cursor: pointer;
    }}
    .verifier-box.dragover {{
      border-color: var(--primary);
      background: var(--primary-light);
    }}
    .verifier-btn {{
      display: inline-block;
      margin-top: 8px;
      background: #FFFFFF;
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      cursor: pointer;
    }}
    .verifier-result {{
      margin-top: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      display: none;
    }}
    .verifier-result.match {{
      display: block;
      background: var(--success-bg);
      color: var(--success);
      border: 1px solid #86EFAC;
    }}
    .verifier-result.mismatch {{
      display: block;
      background: #FEE2E2;
      color: #DC2626;
      border: 1px solid #FCA5A5;
    }}
    .actions {{
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 24px;
    }}
    .btn-download {{
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: var(--primary);
      color: #FFFFFF;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      padding: 14px 20px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(27, 94, 32, 0.2);
      transition: background 0.15s ease;
    }}
    .btn-download:hover {{
      background: var(--primary-hover);
    }}
    .disclaimer {{
      font-size: 11.5px;
      color: var(--text-muted);
      line-height: 1.6;
      border-top: 1px solid var(--border);
      padding-top: 16px;
      text-align: center;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header-brand">
      <span class="brand-badge">Tanap AI</span>
      <span class="brand-title">Единый реестр верификации отчётов</span>
    </div>

    <div class="status-card">
      <div class="status-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          <polyline points="9 12 11 14 15 10"></polyline>
        </svg>
      </div>
      <div>
        <div class="status-title">Подлинность подтверждена</div>
        <div class="status-desc">
          Отчёт зарегистрирован в базе данных системы Tanap AI. Исходная спутниковая телеметрия и полигон контура зафиксированы криптографическим хэшем.
        </div>
      </div>
    </div>

    <!-- Реестровые данные -->
    <div class="card">
      <div class="card-title">Сведения о документе</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Реестровый номер</span>
          <span class="info-val" style="color: var(--primary);">{report_num}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Дата и время выпуска (UTC)</span>
          <span class="info-val">{created_at}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Идентификатор системы</span>
          <span class="info-val" style="font-family: monospace; font-size: 13px;">{report_id}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Статус в реестре</span>
          <span class="info-val" style="color: var(--success);">Действителен (Подлинный)</span>
        </div>
      </div>
    </div>

    <!-- Параметры поля -->
    <div class="card">
      <div class="card-title">Агрономический объект и телеметрия</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Наименование поля</span>
          <span class="info-val">{field_name}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Землепользователь</span>
          <span class="info-val">{farm_name}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Культура / Гибрид</span>
          <span class="info-val">{crop_type}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Расчётная площадь</span>
          <span class="info-val">{area_ha}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Регион</span>
          <span class="info-val">{region}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Центроид контура (WGS-84)</span>
          <span class="info-val">{coords_text}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Спутник наблюдения</span>
          <span class="info-val">{sat_source}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Классификация пашни</span>
          <span class="info-val">{class_label}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Метеорологическая модель</span>
          <span class="info-val">{weather_source} ({temp_text})</span>
        </div>
        <div class="info-item">
          <span class="info-label">Модельный прогноз урожая</span>
          <span class="info-val">{forecast_text}</span>
        </div>
      </div>
    </div>

    <!-- Криптографические хэши -->
    <div class="card">
      <div class="card-title">Криптографическая контрольная сумма (SHA-256)</div>
      <div class="hash-block">
        <div class="hash-label-row">
          <span class="hash-label">Контрольная сумма файла PDF (File SHA-256)</span>
          <button class="copy-btn" onclick="copyText('{file_sha256}')">Копировать</button>
        </div>
        <div class="hash-code" id="targetFileSha">{file_sha256}</div>
      </div>
      <div class="hash-block">
        <div class="hash-label-row">
          <span class="hash-label">Хэш набора данных телеметрии (Payload SHA-256)</span>
          <button class="copy-btn" onclick="copyText('{payload_sha256}')">Копировать</button>
        </div>
        <div class="hash-code">{payload_sha256}</div>
      </div>
    </div>

    <!-- Интерактивная проверка локального файла -->
    <div class="card">
      <div class="card-title">Проверка вашего файла PDF на подлинность</div>
      <div class="verifier-box" id="dropZone" onclick="document.getElementById('fileInput').click()">
        <p style="font-size: 13.5px; color: var(--text); font-weight: 500;">
          Перетащите сюда скачанный PDF-файл отчёта или нажмите для выбора
        </p>
        <span class="verifier-btn">Выбрать файл PDF</span>
        <input type="file" id="fileInput" accept="application/pdf" style="display: none;" onchange="handleFile(this.files[0])">
        <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
          Браузер рассчитает хэш SHA-256 локально через Web Crypto API без передачи файла в сеть.
        </p>
      </div>
      <div id="verifierResult" class="verifier-result"></div>
    </div>

    <!-- Кнопки действий -->
    <div class="actions">
      <a href="{download_url}" class="btn-download" download="tanap-report-{report_num}.pdf">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Скачать проверенный оригинал PDF
      </a>
    </div>

    <div class="disclaimer">
      Настоящий отчёт сформирован аналитической ГИС-платформой Tanap AI на основе данных Sentinel-2 (Copernicus) и Open-Meteo.
      Подлинность и целостность данных удостоверяются криптографическим отпечатком SHA-256 в базе данных системы.
      Документ носит информационно-аналитический характер и не является государственным правоустанавливающим кадастровым актом.
    </div>
  </div>

  <script>
    function copyText(text) {{
      navigator.clipboard.writeText(text).then(() => {{
        alert('Хэш скопирован в буфер обмена');
      }}).catch(() => {{
        prompt('Скопируйте хэш:', text);
      }});
    }}

    const targetHash = "{file_sha256}".trim().toLowerCase();
    const dropZone = document.getElementById('dropZone');
    const resultBox = document.getElementById('verifierResult');

    ['dragenter', 'dragover'].forEach(name => {{
      dropZone.addEventListener(name, (e) => {{
        e.preventDefault();
        dropZone.classList.add('dragover');
      }});
    }});

    ['dragleave', 'drop'].forEach(name => {{
      dropZone.addEventListener(name, (e) => {{
        e.preventDefault();
        dropZone.classList.remove('dragover');
      }});
    }});

    dropZone.addEventListener('drop', (e) => {{
      const files = e.dataTransfer.files;
      if (files && files[0]) handleFile(files[0]);
    }});

    async function handleFile(file) {{
      if (!file) return;
      resultBox.style.display = 'block';
      resultBox.className = 'verifier-result';
      resultBox.textContent = 'Вычисление контрольной суммы SHA-256…';

      try {{
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const computed = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();

        if (computed === targetHash) {{
          resultBox.className = 'verifier-result match';
          resultBox.innerHTML = '✓ Контрольная сумма совпадает на 100%!<br/><span style="font-weight:400;font-size:11.5px;font-family:monospace;">SHA-256: ' + computed + '</span><br/><span style="font-weight:400;">Файл является оригинальным заверенным отчётом Tanap AI.</span>';
        }} else {{
          resultBox.className = 'verifier-result mismatch';
          resultBox.innerHTML = '✕ Контрольная сумма не совпадает с реестром!<br/><span style="font-weight:400;font-size:11.5px;font-family:monospace;">Хэш файла: ' + computed + '</span><br/><span style="font-weight:400;">Файл был изменён, повреждён или относится к другой версии отчёта.</span>';
        }}
      }} catch (err) {{
        resultBox.className = 'verifier-result mismatch';
        resultBox.textContent = 'Ошибка чтения файла: ' + (err.message || err);
      }}
    }}
  </script>
</body>
</html>"""


def render_not_found_page(identifier: str) -> str:
    ident = html.escape(identifier)
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Запись не найдена · Tanap AI</title>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #F8FAFC;
      color: #0F172A;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      margin: 0;
    }}
    .card {{
      background: #FFFFFF;
      border: 1px solid #E2E8F0;
      border-radius: 16px;
      max-width: 480px;
      padding: 32px;
      text-align: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    }}
    .icon {{
      width: 56px;
      height: 56px;
      background: #FEE2E2;
      color: #DC2626;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
      font-size: 26px;
      font-weight: 700;
    }}
    h1 {{ font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #1E293B; }}
    p {{ font-size: 14px; color: #64748B; line-height: 1.5; margin-bottom: 20px; }}
    .code {{ font-family: monospace; background: #F1F5F9; padding: 4px 8px; border-radius: 6px; font-size: 13px; color: #334155; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✕</div>
    <h1>Запись не найдена в реестре</h1>
    <p>
      Отчёт с идентификатором <span class="code">{ident}</span> отсутствует в официальной базе данных Tanap AI либо был отозван.
    </p>
    <p style="font-size: 12px; color: #94A3B8;">
      Убедитесь, что QR-код или ссылка были открыты без ошибок и отчёт формировался в системе.
    </p>
  </div>
</body>
</html>"""
