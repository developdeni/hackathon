import { Field, Inspection, ServerHealth } from '../types/domain';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.0.221:8000';

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
    const response = await fetch(`${API_URL}${path}`, { ...init, signal: controller.signal });
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

export function getServerHealth() {
  return apiFetch<ServerHealth>('/health');
}

export function listFields() {
  return apiFetch<Field[]>('/api/fields');
}

export function getField(id: string) {
  return apiFetch<Field>(`/api/fields/${encodeURIComponent(id)}`);
}

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
