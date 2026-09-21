#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Определение локального IP-адреса для связки фронтенда и бэкенда
LOCAL_IP="${1:-}"
if [[ -z "$LOCAL_IP" ]]; then
  if command -v ipconfig &>/dev/null; then
    LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [[ -z "$LOCAL_IP" ]] && command -v hostname &>/dev/null; then
    LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -z "$LOCAL_IP" ]]; then
    LOCAL_IP="127.0.0.1"
  fi
fi

if [[ ! -x "$PROJECT_ROOT/backend/.venv/bin/uvicorn" ]]; then
  echo "❌ Виртуальное окружение не найдено."
  echo "Сначала выполните установку: ./scripts/setup-local.sh"
  exit 1
fi

# Запись локального URL бэкенда для Expo приложения
printf 'EXPO_PUBLIC_API_URL=http://%s:8000\n' "$LOCAL_IP" > "$PROJECT_ROOT/mobile/.env.local"

echo "========================================="
echo "🌾 Запуск Tanap AI (Локальный режим)"
echo "========================================="
echo "📡 Backend API:      http://$LOCAL_IP:8000"
echo "📖 Swagger API Docs: http://$LOCAL_IP:8000/docs"
echo "🌐 API ReDoc:        http://$LOCAL_IP:8000/redoc"
echo "📱 API URL записан в: mobile/.env.local"
echo "========================================="
echo ""
echo "🚀 Запуск FastAPI в фоне..."

cd "$PROJECT_ROOT/backend"
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

stop_backend() {
  echo ""
  echo "Остановка бэкенда (PID: $BACKEND_PID)..."
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap stop_backend EXIT INT TERM

echo "🚀 Запуск Expo Metro (нажмите 'w' для браузера, 'i' для iOS, 'a' для Android)..."
cd "$PROJECT_ROOT/mobile"
npx expo start
