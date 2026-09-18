import math
import os
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from jose import JWTError, jwt

# Secret key — read from env var or use a development default.
# In production this must be a long random string.
SECRET_KEY = os.environ.get("JWT_SECRET", "tanap-ai-hackathon-secret-2026")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24 * 30  # 30 days — long-lived for demo purposes

_ph = PasswordHasher()

# ---------------------------------------------------------------------------
# Password utilities
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    return _ph.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, plain)
    except VerifyMismatchError:
        return False


# ---------------------------------------------------------------------------
# JWT utilities
# ---------------------------------------------------------------------------

def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> str | None:
    """Return user_id from token or None if invalid/expired."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str | None = payload.get("sub")
        return user_id
    except JWTError:
        return None


# ---------------------------------------------------------------------------
# Geo utilities — real area & perimeter calculation
# ---------------------------------------------------------------------------

_EARTH_RADIUS_KM = 6371.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance between two WGS-84 points in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def compute_area_ha(boundary: list[dict]) -> float:
    """
    Spherical excess (Gauss shoelace on a sphere) approximation.
    Returns area in hectares. Boundary is a list of {latitude, longitude} dicts.
    Requires at least 3 points.
    """
    n = len(boundary)
    if n < 3:
        return 0.0

    # Project to local metric plane using the centroid as origin (equirectangular)
    mean_lat = sum(p["latitude"] for p in boundary) / n
    mean_lon = sum(p["longitude"] for p in boundary) / n

    lat_rad = math.radians(mean_lat)
    # degrees → km conversion at this latitude
    km_per_deg_lat = math.pi * _EARTH_RADIUS_KM / 180.0
    km_per_deg_lon = km_per_deg_lat * math.cos(lat_rad)

    xs = [(p["longitude"] - mean_lon) * km_per_deg_lon for p in boundary]
    ys = [(p["latitude"] - mean_lat) * km_per_deg_lat for p in boundary]

    # Shoelace formula → area in km²
    area_km2 = 0.0
    for i in range(n):
        j = (i + 1) % n
        area_km2 += xs[i] * ys[j]
        area_km2 -= xs[j] * ys[i]
    area_km2 = abs(area_km2) / 2.0

    return area_km2 * 100.0  # 1 km² = 100 ha


def compute_perimeter_km(boundary: list[dict]) -> float:
    """Perimeter of the polygon in kilometres (Haversine segments)."""
    n = len(boundary)
    if n < 2:
        return 0.0
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += _haversine_km(
            boundary[i]["latitude"], boundary[i]["longitude"],
            boundary[j]["latitude"], boundary[j]["longitude"],
        )
    return round(total, 3)
