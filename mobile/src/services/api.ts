import {
  AgroWeather,
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

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.8.100:8000';

type CreateInspectionInput = {
  fieldId: string;
  note: string;
  photoUri: string | null;
  latitude: number | null;
  longitude: number | null;
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // Attach JWT token if available
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
        if (typeof body.detail === 'string') message = body.detail;
      } catch {
        // The server did not return JSON.
      }
      throw new Error(message);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Сервер не ответил за 10 секунд');
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
  return apiFetch<ServerHealth>('/health');
}

// ---------------------------------------------------------------------------
// Fields & Profiles
// ---------------------------------------------------------------------------

export function listFields() {
  return apiFetch<Field[]>('/api/fields');
}

export function listFieldsForProfile(profileId: string) {
  return apiFetch<Field[]>(`/api/fields?profile_id=${encodeURIComponent(profileId)}`);
}

export function getField(id: string) {
  return apiFetch<Field>(`/api/fields/${encodeURIComponent(id)}`);
}

export function deleteField(id: string) {
  return apiFetch<void>(`/api/fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listProfiles() {
  return apiFetch<FarmProfile[]>('/api/profiles');
}

export function createProfile(input: CreateProfileInput) {
  return apiFetch<FarmProfile>('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
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
// Inspections
// ---------------------------------------------------------------------------

export function listInspections(fieldId: string) {
  return apiFetch<Inspection[]>(`/api/fields/${encodeURIComponent(fieldId)}/inspections`);
}

export function getInspection(id: string) {
  return apiFetch<Inspection>(`/api/inspections/${encodeURIComponent(id)}`);
}

export function createInspection(input: CreateInspectionInput) {
  const form = new FormData();
  form.append('note', input.note);
  if (input.latitude !== null) form.append('latitude', String(input.latitude));
  if (input.longitude !== null) form.append('longitude', String(input.longitude));
  if (input.photoUri) {
    const extension = input.photoUri.split('.').pop()?.toLowerCase() ?? 'jpg';
    const mimeType = extension === 'png' ? 'image/png' : extension === 'heic' ? 'image/heic' : 'image/jpeg';
    form.append('photo', {
      uri: input.photoUri,
      name: `inspection.${extension}`,
      type: mimeType,
    } as unknown as Blob);
  }
  return apiFetch<Inspection>(`/api/fields/${encodeURIComponent(input.fieldId)}/inspections`, {
    method: 'POST',
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function getFieldSatellite(fieldId: string) {
  return apiFetch<SatelliteData>(`/api/fields/${encodeURIComponent(fieldId)}/satellite`);
}

export function getFieldZones(fieldId: string) {
  return apiFetch<ZonesData>(`/api/fields/${encodeURIComponent(fieldId)}/zones`);
}

export function getFieldWeather(fieldId: string) {
  return apiFetch<AgroWeather>(`/api/fields/${encodeURIComponent(fieldId)}/weather`);
}

export function getFieldClassification(fieldId: string) {
  return apiFetch<LandUseClassification>(`/api/fields/${encodeURIComponent(fieldId)}/classification`);
}

export function detectFieldBoundary(input: { latitude: number; longitude: number; radiusMeters: number }) {
  return apiFetch<AutoBoundaryResult>('/api/fields/auto-boundary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function buildAuthorizedDownloadUrl(path: string) {
  const token = await loadToken();
  const separator = path.includes('?') ? '&' : '?';
  const suffix = token ? `${separator}access_token=${encodeURIComponent(token)}` : '';
  return `${API_URL}${path}${suffix}`;
}
