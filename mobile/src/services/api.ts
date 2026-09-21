import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AgroWeather,
  ClimateRiskForecast,
  AiChatMessage,
  AiDiagnosisResult,
  AiGrainQualityResult,
  AiLivestockResult,
  AiStandCountResult,
  AutoBoundaryResult,
  AuthResponse,
  CreateFieldInput,
  CreateProfileInput,
  FarmProfile,
  Field,
  FieldOperationsRecommendation,
  Inspection,
  LandUseClassification,
  LoginInput,
  ProfileShare,
  RegisterInput,
  SatelliteData,
  SharePermission,
  ServerHealth,
  User,
  YieldForecast,
  YieldHistoryRecord,
  YieldHistorySource,
  ZonesData,
  AiFarmSummary,
  AiFieldBadge,
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
  removeLocalCache,
  removePendingInspection,
  saveLocalCache,
} from './offline';

export const API_URL =
  typeof window !== 'undefined' && window.location?.origin && window.location.origin.startsWith('http')
    ? window.location.origin
    : (process.env.EXPO_PUBLIC_API_URL ?? 'https://lamps-sat-increases-pencil.trycloudflare.com');

export class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

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
      throw new ApiRequestError(message, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (retries > 0 && !(error instanceof ApiRequestError)) {
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

export function telegramAuthUser(input: {
  initData: string;
  name: string;
  companyName: string;
}) {
  return apiFetch<AuthResponse>('/api/auth/telegram-webapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function getMe() {
  return apiFetch<User>('/api/auth/me');
}

export function updateProfile(input: {
  name?: string;
  organization?: string;
  region?: string;
}) {
  return apiFetch<User>('/api/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function requestEmailCode(newEmail: string) {
  return apiFetch<{ delivered: boolean; target: string; isChange: boolean; devCode?: string }>(
    '/api/auth/email/request-code',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newEmail }),
    },
  );
}

export function confirmEmailCode(code: string) {
  return apiFetch<User>('/api/auth/email/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

// ---------------------------------------------------------------------------
// Командный доступ (RBAC)
// ---------------------------------------------------------------------------

export function inviteToProfile(
  profileId: string,
  input: {
    granteePublicId: string;
    permissions: SharePermission[];
    fieldScope: 'all' | 'selected';
    fieldIds?: string[];
  },
) {
  return apiFetch<ProfileShare>(`/api/profiles/${profileId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function listProfileShares(profileId: string) {
  return apiFetch<ProfileShare[]>(`/api/profiles/${profileId}/shares`);
}

export function listMyInvitations() {
  return apiFetch<ProfileShare[]>('/api/shares/invitations');
}

export function acceptInvitation(shareId: string) {
  return apiFetch<ProfileShare>(`/api/shares/${shareId}/accept`, { method: 'POST' });
}

export function declineInvitation(shareId: string) {
  return apiFetch<{ ok: boolean }>(`/api/shares/${shareId}/decline`, { method: 'POST' });
}

export function revokeShare(shareId: string) {
  return apiFetch<void>(`/api/shares/${shareId}`, { method: 'DELETE' });
}

export function getTelegramLinkCode() {
  return apiFetch<{ code: string; deepLink: string; botUsername: string }>(
    '/api/auth/telegram-link-code',
    { method: 'POST' },
  );
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
  SATELLITE: (fieldId: string) => `sat_v2_${fieldId}`,
  ZONES: (fieldId: string) => `zones_v2_${fieldId}`,
  WEATHER: (fieldId: string) => `weather_v2_${fieldId}`,
  CLASSIFICATION: (fieldId: string) => `class_v2_${fieldId}`,
  CLIMATE_RISK: (fieldId: string) => `climaterisk_v2_${fieldId}`,
  YIELD_FORECAST: (fieldId: string) => `yieldforecast_v1_${fieldId}`,
  YIELD_HISTORY: (fieldId: string) => `yieldhistory_v1_${fieldId}`,
  OPERATIONS: (fieldId: string) => `operations_v1_${fieldId}`,
  AI_FARM_SUMMARY: (profileId: string) => `ai_farm_summary_v1_${profileId}`,
};

export function cleanAiText(text: string): string {
  if (!text) return '';
  let cleaned = text;
  // Remove markdown horizontal rules (---, ———, – – –, ***, ___)
  cleaned = cleaned.replace(/^[\s\t]*[-—–_*]{2,}[\s\t]*$/gm, '');
  // Remove inline 3+ dashes / hyphens / em-dashes
  cleaned = cleaned.replace(/[-—–]{3,}/g, '');
  // Remove bold/italic markdown asterisks: ***text*** -> text, **text** -> text, *text* -> text
  cleaned = cleaned.replace(/\*{3}(.*?)\*{3}/g, '$1');
  cleaned = cleaned.replace(/\*{2}(.*?)\*{2}/g, '$1');
  cleaned = cleaned.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1');
  // Convert bullet asterisks to clean bullets
  cleaned = cleaned.replace(/^[\s\t]*\*\s+/gm, '• ');
  // Remove any remaining asterisks
  cleaned = cleaned.replace(/\*/g, '');
  // Collapse excessive newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

export async function getAiFarmSummary(profileId: string, refresh = false): Promise<AiFarmSummary> {
  const cacheKey = CACHE_KEYS.AI_FARM_SUMMARY(profileId);
  if (!refresh) {
    const cached = await getLocalCache<AiFarmSummary>(cacheKey);
    if (cached) {
      if (cached.summaryText) {
        cached.summaryText = cleanAiText(cached.summaryText);
      }
      // Return cached immediately and refresh in background
      apiFetch<AiFarmSummary>(`/api/profiles/${encodeURIComponent(profileId)}/ai-summary`)
        .then((fresh) => {
          if (fresh.summaryText) fresh.summaryText = cleanAiText(fresh.summaryText);
          void saveLocalCache(cacheKey, fresh);
        })
        .catch(() => {});
      return cached;
    }
  }
  try {
    const url = `/api/profiles/${encodeURIComponent(profileId)}/ai-summary${refresh ? '?refresh=true' : ''}`;
    const data = await apiFetch<AiFarmSummary>(url);
    if (data.summaryText) {
      data.summaryText = cleanAiText(data.summaryText);
    }
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<AiFarmSummary>(cacheKey);
    if (cached) {
      if (cached.summaryText) cached.summaryText = cleanAiText(cached.summaryText);
      return cached;
    }
    throw err;
  }
}

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

export async function deleteInspection(id: string, fieldId: string): Promise<void> {
  if (id.startsWith('local_')) {
    await removePendingInspection(id);
  } else {
    await apiFetch<void>(`/api/inspections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  const listKey = CACHE_KEYS.INSPECTIONS(fieldId);
  const cached = await getLocalCache<Inspection[]>(listKey);
  if (cached) {
    await saveLocalCache(listKey, cached.filter((item) => item.id !== id));
  }
  await removeLocalCache(CACHE_KEYS.INSPECTION(id));
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
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}

export async function getFieldZones(fieldId: string): Promise<ZonesData> {
  const cacheKey = CACHE_KEYS.ZONES(fieldId);
  try {
    const data = await apiFetch<ZonesData>(`/api/fields/${encodeURIComponent(fieldId)}/zones`, undefined, 70_000, 0);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<ZonesData>(cacheKey);
    if (cached) return { ...cached, stale: true };
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
    if (cached) return { ...cached, status: 'cached', message: `Сохранённый прогноз от ${cached.updatedAt ?? 'неизвестной даты'}. Обновление недоступно.` };
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

export async function getFieldClimateRisk(fieldId: string): Promise<ClimateRiskForecast> {
  const cacheKey = CACHE_KEYS.CLIMATE_RISK(fieldId);
  try {
    const data = await apiFetch<ClimateRiskForecast>(`/api/fields/${encodeURIComponent(fieldId)}/climate-risk`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<ClimateRiskForecast>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export async function getFieldYieldForecast(fieldId: string): Promise<YieldForecast> {
  const cacheKey = CACHE_KEYS.YIELD_FORECAST(fieldId);
  try {
    const data = await apiFetch<YieldForecast>(
      `/api/fields/${encodeURIComponent(fieldId)}/yield-forecast`,
      undefined,
      90_000,
      0
    );
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<YieldForecast>(cacheKey);
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}

export async function getFieldOperationsRecommendation(fieldId: string): Promise<FieldOperationsRecommendation> {
  const cacheKey = CACHE_KEYS.OPERATIONS(fieldId);
  try {
    const data = await apiFetch<FieldOperationsRecommendation>(
      `/api/fields/${encodeURIComponent(fieldId)}/operations-recommendation`,
      undefined,
      35_000,
      0
    );
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<FieldOperationsRecommendation>(cacheKey);
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}

export async function listYieldHistory(fieldId: string): Promise<YieldHistoryRecord[]> {
  const cacheKey = CACHE_KEYS.YIELD_HISTORY(fieldId);
  try {
    const data = await apiFetch<YieldHistoryRecord[]>(`/api/fields/${encodeURIComponent(fieldId)}/yield-history`);
    void saveLocalCache(cacheKey, data);
    return data;
  } catch (err) {
    const cached = await getLocalCache<YieldHistoryRecord[]>(cacheKey);
    if (cached) return cached;
    throw err;
  }
}

export function createYieldHistory(
  fieldId: string,
  input: { seasonYear: number; cropType?: string; yieldTPerHa: number; source: YieldHistorySource; notes: string }
) {
  return apiFetch<YieldHistoryRecord>(`/api/fields/${encodeURIComponent(fieldId)}/yield-history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteYieldHistory(fieldId: string, recordId: string) {
  return apiFetch<void>(
    `/api/fields/${encodeURIComponent(fieldId)}/yield-history/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' }
  );
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
// AI Agronomic Advisor & Vision Diagnostics (via Python Backend)
// ---------------------------------------------------------------------------

const STORAGE_KEY_AI_CHAT = 'tanap_ai_chat_messages_v1';

export async function diagnoseCropPhoto(
  photoBase64: string,
  photoName = 'photo.jpg'
): Promise<AiDiagnosisResult> {
  const cleanBase64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
  const res = await apiFetch<AiDiagnosisResult>(
    '/api/ai/diagnose-photo',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_base64: cleanBase64, photo_name: photoName }),
    },
    35_000,
    1 // retry once on failure
  );
  if (res) {
    if (res.object_name) res.object_name = cleanAiText(res.object_name);
    if (res.crop) res.crop = cleanAiText(res.crop);
    if (res.diagnosis) res.diagnosis = cleanAiText(res.diagnosis);
    if (res.description) res.description = cleanAiText(res.description);
    if (res.recommendation) res.recommendation = cleanAiText(res.recommendation);
    if (res.chemicals) res.chemicals = cleanAiText(res.chemicals);
    if (res.rate) res.rate = cleanAiText(res.rate);
    if (res.weather_limits) res.weather_limits = cleanAiText(res.weather_limits);
  }
  return res;
}

export async function countSeedlingsPhoto(
  photoBase64: string,
  photoName = 'field.jpg',
  frameAreaM2?: number
): Promise<AiStandCountResult> {
  const cleanBase64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
  const res = await apiFetch<AiStandCountResult>(
    '/api/ai/count-seedlings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_base64: cleanBase64,
        photo_name: photoName,
        frame_area_m2: frameAreaM2,
      }),
    },
    35_000,
    1 // retry once on failure
  );
  if (res) {
    if (res.crop) res.crop = cleanAiText(res.crop);
    if (res.assessment) res.assessment = cleanAiText(res.assessment);
    if (res.recommendation) res.recommendation = cleanAiText(res.recommendation);
  }
  return res;
}

export async function countLivestock(
  photoBase64: string,
  photoName = 'herd.jpg'
): Promise<AiLivestockResult> {
  const cleanBase64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
  const res = await apiFetch<AiLivestockResult>(
    '/api/ai/count-livestock',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_base64: cleanBase64, photo_name: photoName }),
    },
    40_000,
    1
  );
  if (res) {
    if (res.dominant_species) res.dominant_species = cleanAiText(res.dominant_species);
    if (res.assessment) res.assessment = cleanAiText(res.assessment);
    if (res.recommendation) res.recommendation = cleanAiText(res.recommendation);
  }
  return res;
}

export async function analyzeGrainQuality(
  photoBase64: string,
  photoName = 'grain.jpg'
): Promise<AiGrainQualityResult> {
  const cleanBase64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64;
  const res = await apiFetch<AiGrainQualityResult>(
    '/api/ai/grain-quality',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_base64: cleanBase64, photo_name: photoName }),
    },
    35_000,
    1
  );
  if (res) {
    if (res.crop) res.crop = cleanAiText(res.crop);
    if (res.assessment) res.assessment = cleanAiText(res.assessment);
    if (res.recommendation) res.recommendation = cleanAiText(res.recommendation);
  }
  return res;
}

export async function countSeedlingsVideoFrames(
  frameBase64: string[],
  videoName = 'field.mp4',
  frameAreaM2?: number
): Promise<AiStandCountResult> {
  const frames = frameBase64.map((f) => (f.includes(',') ? f.split(',')[1] : f));
  const res = await apiFetch<AiStandCountResult>(
    '/api/ai/count-seedlings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_frames_base64: frames,
        photo_name: videoName,
        frame_area_m2: frameAreaM2,
      }),
    },
    45_000,
    0
  );
  if (res) {
    if (res.crop) res.crop = cleanAiText(res.crop);
    if (res.assessment) res.assessment = cleanAiText(res.assessment);
    if (res.recommendation) res.recommendation = cleanAiText(res.recommendation);
  }
  return res;
}

export async function askAiAgronomist(
  question: string,
  history?: AiChatMessage[],
  farmContext?: any
): Promise<string> {
  const historyPayload = history?.slice(-30).map((m) => ({
    role: m.sender === 'user' ? 'user' : 'model',
    text: cleanAiText(m.text),
  }));

  const res = await apiFetch<{ question: string; answer: string }>(
    '/api/ai/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: historyPayload,
        farm_context: farmContext,
      }),
    },
    35_000,
    1 // retry once on failure
  );

  return cleanAiText(res.answer);
}

export async function loadAiChatHistory(): Promise<AiChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_AI_CHAT);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function saveAiChatHistory(messages: AiChatMessage[]): Promise<void> {
  try {
    const trimmed = messages.slice(-30);
    await AsyncStorage.setItem(STORAGE_KEY_AI_CHAT, JSON.stringify(trimmed));
  } catch {
    // Ignore storage errors
  }
}

export async function clearAiChatHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY_AI_CHAT);
  } catch {
    // Ignore storage errors
  }
}
