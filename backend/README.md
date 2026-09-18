# Tanap AI Local API

API и SQLite работают на ноутбуке и доступны телефону в той же Wi-Fi сети.

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- Проверка: `http://127.0.0.1:8000/health`
- Документация API: `http://127.0.0.1:8000/docs`
- База: `backend/data/tanap.db`
- Фотографии: `backend/data/uploads/`
