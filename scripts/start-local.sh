#!/bin/zsh
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

if [[ -z "$LOCAL_IP" ]]; then
  echo "Не удалось определить IP Wi-Fi. Подключите ноутбук к сети и повторите запуск."
  exit 1
fi

if [[ ! -x "$PROJECT_ROOT/backend/.venv/bin/uvicorn" ]]; then
  echo "Сначала выполните: $PROJECT_ROOT/scripts/setup-local.sh"
  exit 1
fi

printf 'EXPO_PUBLIC_API_URL=http://%s:8000\n' "$LOCAL_IP" > "$PROJECT_ROOT/mobile/.env.local"

echo "Tanap AI API: http://$LOCAL_IP:8000"
echo "Документация: http://$LOCAL_IP:8000/docs"

cd "$PROJECT_ROOT/backend"
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

stop_backend() {
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap stop_backend EXIT INT TERM

cd "$PROJECT_ROOT/mobile"
npx expo start --dev-client --lan
