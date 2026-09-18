#!/bin/zsh
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Устанавливаем мобильные зависимости…"
cd "$PROJECT_ROOT/mobile"
npm install

echo "Настраиваем Python-сервер…"
cd "$PROJECT_ROOT/backend"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -r requirements.txt

echo "Готово. Запуск: $PROJECT_ROOT/scripts/start-local.sh"
