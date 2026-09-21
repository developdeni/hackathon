#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "========================================="
echo "🌾 Tanap AI — Локальная установка проекта"
echo "========================================="

echo ""
echo "[1/2] Настройка Python бэкенда..."
cd "$PROJECT_ROOT/backend"
if [[ ! -d .venv ]]; then
  echo "Создание виртуального окружения Python (.venv)..."
  python3 -m venv .venv
fi

echo "Установка Python-зависимостей (FastAPI, Copernicus, Shapely, ReportLab, Argon2)..."
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

if [[ ! -f .env && -f .env.example ]]; then
  echo "Создание backend/.env из шаблона .env.example..."
  cp .env.example .env
fi

echo ""
echo "[2/2] Установка Node.js зависимостей для мобильного и веб приложения..."
cd "$PROJECT_ROOT/mobile"
npm install

if [[ ! -f .env.local && -f .env.example ]]; then
  echo "Создание mobile/.env.local из шаблона..."
  cp .env.example .env.local
fi

echo ""
echo "========================================="
echo "✅ Установка успешно завершена!"
echo "Для одновременного запуска бэкенда и фронтенда выполните:"
echo "  ./scripts/start-local.sh"
echo "========================================="
