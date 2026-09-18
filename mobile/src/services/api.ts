import {
  AgroWeather,
  AiDiagnosisResult,
  AutoBoundaryResult,
  AuthResponse,
  CreateFieldInput,
  CreateProfileInput,
  FarmProfile,
  Field,
  Inspection,
  LandUseClassification,
  LoginInput,
  RegisterInput,
  SatelliteData,
  ServerHealth,
  User,
  ZonesData,
} from '../types/domain';
import { loadToken } from './auth';
import {
  enqueuePendingInspection,
  flushPendingInspections,
  getLocalCache,
  getPendingInspectionById,
  getPendingInspections,
  PendingInspection,
  pendingToDomainInspection,
  saveLocalCache,
} from './offline';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.8.100:8000';

type CreateInspectionInput = {
  fieldId: string;
  note: string;
  photoUri: string | null;
  photoBase64?: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * Robust fetch with JWT injection, abort timeouts, and 1 auto-retry for GET requests
 */
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 20_000,
  retries = init?.method && init.method !== 'GET' ? 0 : 1
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = await loadToken();
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `Ошибка сервера: ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.detail === 'string') {
          message = body.detail;
        } else if (Array.isArray(body.detail)) {
          message = body.detail
            .map((item: { loc?: string[]; msg?: string }) => {
              const field = item.loc ? item.loc.filter((l) => l !== 'body').join('.') : '';
              return field ? `${field}: ${item.msg}` : item.msg;
            })
            .filter(Boolean)
            .join('; ');
        }
      } catch {
        // Response was not JSON
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (retries > 0) {
      await new Promise((res) => setTimeout(res, 800));
      return apiFetch<T>(path, init, timeoutMs, retries - 1);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} секунд`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function loginUser(input: LoginInput) {
  return apiFetch<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function registerUser(input: RegisterInput) {
  return apiFetch<AuthResponse>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function getMe() {
  return apiFetch<User>('/api/auth/me');
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function getServerHealth() {
  return apiFetch<ServerHealth>('/health', undefined, 4_000, 0);
}

// ---------------------------------------------------------------------------
// Fields & Profiles (Offline Cache-First)
// ---------------------------------------------------------------------------

export const CACHE_KEYS = {
  PROFILES: 'profiles',
  FIELDS_PROFILE: (profileId: string) => `fields_${profileId}`,
  FIELD: (id: string) => `field_${id}`,
  INSPECTIONS: (fieldId: string) => `inspections_${fieldId}`,
  INSPECTION: (id: string) => `inspection_${id}`,
  SATELLITE: (fieldId: string) => `sat_${fieldId}`,
  ZONES: (fieldId: string) => `zones_${fieldId}`,
  WEATHER: (fieldId: string) => `weather_${fieldId}`,
  CLASSIFICATION: (fieldId: string) => `class_${fieldId}`,
};

export async function listProfiles(): Promise<FarmProfile[]> {
  try {
    const data = await apiFetch<FarmProfile[]>('/api/profiles');
    void saveLocalCache(CACHE_KEYS.PROFILES, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<FarmProfile[]>(CACHE_KEYS.PROFILES);
    if (cached) return cached;
    throw err;
  }
}

export function createProfile(input: CreateProfileInput) {
  return apiFetch<FarmProfile>('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function listFields() {
  return apiFetch<Field[]>('/api/fields');
}

export async function listFieldsForProfile(profileId: string): Promise<Field[]> {
  const cacheKey = CACHE_KEYS.FIELDS_PROFILE(profileId);
  try {
    const data = await apiFetch<Field[]>(`/api/fields?profile_id=${encodeURIComponent(profileId)}`);
    void saveLocalCache(cacheKey, data);
    // Prime individual field cache in RAM/storage for instant 0ms tap response
    for (const f of data) {
      void saveLocalCache(CACHE_KEYS.FIELD(f.id), f);
    }
    return data;
  } catch (err) {
    const cached = await getLocalCache<Field[]>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export async function getField(id: string): Promise<Field> {
  const cacheKey = CACHE_KEYS.FIELD(id);
  try {
    const data = await apiFetch<Field>(`/api/fields/${encodeURIComponent(id)}`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<Field>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export function deleteField(id: string) {
  return apiFetch<void>(`/api/fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createField(input: CreateFieldInput) {
  return apiFetch<Field>(`/api/profiles/${encodeURIComponent(input.profileId)}/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      cropType: input.cropType,
      areaHa: input.areaHa,
      boundary: input.boundary,
    }),
  });
}

export function updateField(fieldId: string, input: Omit<CreateFieldInput, 'profileId'>) {
  return apiFetch<Field>(`/api/fields/${encodeURIComponent(fieldId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      cropType: input.cropType,
      areaHa: input.areaHa,
      boundary: input.boundary,
    }),
  });
}

// ---------------------------------------------------------------------------
// Inspections (Offline Cache + Outbox Queue)
// ---------------------------------------------------------------------------

export async function listInspections(fieldId: string): Promise<Inspection[]> {
  const cacheKey = CACHE_KEYS.INSPECTIONS(fieldId);
  let savedItems: Inspection[] = [];

  try {
    savedItems = await apiFetch<Inspection[]>(`/api/fields/${encodeURIComponent(fieldId)}/inspections`);
    void saveLocalCache(cacheKey, savedItems);
  } catch {
    savedItems = (await getLocalCache<Inspection[]>(cacheKey)) ?? [];
  }

  // Merge pending outbox inspections for this field so user sees them immediately
  const pending = await getPendingInspections(fieldId);
  const pendingDomain = pending.map(pendingToDomainInspection);

  return [...pendingDomain, ...savedItems];
}

export async function getInspection(id: string): Promise<Inspection> {
  // Check if it's an offline pending inspection
  if (id.startsWith('local_')) {
    const pending = await getPendingInspectionById(id);
    if (pending) {
      return pendingToDomainInspection(pending);
    }
  }

  const cacheKey = CACHE_KEYS.INSPECTION(id);
  try {
    const data = await apiFetch<Inspection>(`/api/inspections/${encodeURIComponent(id)}`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<Inspection>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

/**
 * Direct upload of inspection payload to backend
 */
async function uploadInspectionPayload(input: {
  fieldId: string;
  note: string;
  latitude: number | null;
  longitude: number | null;
  photoBase64?: string | null;
  photoUri?: string | null;
}): Promise<Inspection> {
  const extension = input.photoUri?.split('.').pop()?.toLowerCase() ?? 'jpg';
  const fileName = `inspection.${extension}`;

  return apiFetch<Inspection>(
    `/api/fields/${encodeURIComponent(input.fieldId)}/inspections`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: input.note,
        latitude: input.latitude,
        longitude: input.longitude,
        photo_base64: input.photoBase64 ?? null,
        photo_name: fileName,
      }),
    },
    45_000 // Extended timeout for mobile uploads
  );
}

/**
 * Creates an inspection online or automatically saves to outbox queue if network fails
 */
export async function createInspection(
  input: CreateInspectionInput
): Promise<{ inspection: Inspection; isOffline: boolean }> {
  try {
    const saved = await uploadInspectionPayload(input);
    return { inspection: saved, isOffline: false };
  } catch (error) {
    // Network / timeout error: enqueue into offline outbox so nothing is lost!
    const pending = await enqueuePendingInspection({
      fieldId: input.fieldId,
      note: input.note,
      photoUri: input.photoUri,
      photoBase64: input.photoBase64 ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
    });
    return { inspection: pendingToDomainInspection(pending), isOffline: true };
  }
}

/**
 * Synchronizes any pending inspections in the offline queue to the server
 */
export async function syncOfflineQueue(): Promise<{ synced: number; failed: number }> {
  return flushPendingInspections(async (pending: PendingInspection) => {
    await uploadInspectionPayload({
      fieldId: pending.fieldId,
      note: pending.note,
      latitude: pending.latitude,
      longitude: pending.longitude,
      photoBase64: pending.photoBase64,
      photoUri: pending.photoUri,
    });
  });
}

// ---------------------------------------------------------------------------
// Analytics (Offline Cache-First)
// ---------------------------------------------------------------------------

export async function getFieldSatellite(fieldId: string): Promise<SatelliteData> {
  const cacheKey = CACHE_KEYS.SATELLITE(fieldId);
  try {
    const data = await apiFetch<SatelliteData>(`/api/fields/${encodeURIComponent(fieldId)}/satellite`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<SatelliteData>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export async function getFieldZones(fieldId: string): Promise<ZonesData> {
  const cacheKey = CACHE_KEYS.ZONES(fieldId);
  try {
    const data = await apiFetch<ZonesData>(`/api/fields/${encodeURIComponent(fieldId)}/zones`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<ZonesData>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export async function getFieldWeather(fieldId: string): Promise<AgroWeather> {
  const cacheKey = CACHE_KEYS.WEATHER(fieldId);
  try {
    const data = await apiFetch<AgroWeather>(`/api/fields/${encodeURIComponent(fieldId)}/weather`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<AgroWeather>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export async function getFieldClassification(fieldId: string): Promise<LandUseClassification> {
  const cacheKey = CACHE_KEYS.CLASSIFICATION(fieldId);
  try {
    const data = await apiFetch<LandUseClassification>(`/api/fields/${encodeURIComponent(fieldId)}/classification`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<LandUseClassification>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export function detectFieldBoundary(input: { latitude: number; longitude: number; radiusMeters: number }) {
  return apiFetch<AutoBoundaryResult>(
    '/api/fields/auto-boundary',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    35_000
  );
}

export async function buildAuthorizedDownloadUrl(path: string) {
  const token = await loadToken();
  const separator = path.includes('?') ? '&' : '?';
  const suffix = token ? `${separator}access_token=${encodeURIComponent(token)}` : '';
  return `${API_URL}${path}${suffix}`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI Agronomic Advisor & Computer Vision (100% On-Device & Offline-First)
// ---------------------------------------------------------------------------

import {
  analyzeLeafPhotoLocally,
  generateLocalAiChatResponse,
} from './localAiModel';

export async function diagnoseCropPhoto(
  photoBase64: string,
  photoName = 'leaf.jpg'
): Promise<AiDiagnosisResult> {
  // On-device neural vision inference directly in JS/Hermes (100% offline, zero network delay)
  return analyzeLeafPhotoLocally(photoBase64, photoName);
}

export async function askAiAgronomist(question: string): Promise<string> {
  // On-device SLM reasoning directly in JS/Hermes (100% offline, zero network delay)
  return generateLocalAiChatResponse(question);
}

