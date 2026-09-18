import AsyncStorage from '@react-native-async-storage/async-storage';
import { Inspection } from '../types/domain';

export interface PendingInspection {
  localId: string;
  fieldId: string;
  note: string;
  photoUri: string | null;
  photoBase64?: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  syncError?: string | null;
}

const CACHE_PREFIX = '@tanap_cache:';
const OUTBOX_KEY = '@tanap_pending_inspections';

// In-memory RAM cache for 0ms synchronous access
const memoryCache = new Map<string, unknown>();

export function getMemoryCache<T>(key: string): T | null {
  return (memoryCache.get(key) as T) ?? null;
}

export function setMemoryCache<T>(key: string, data: unknown): void {
  memoryCache.set(key, data);
}

/**
 * Saves arbitrary data to local offline cache (memory + AsyncStorage)
 */
export async function saveLocalCache<T>(key: string, data: T): Promise<void> {
  memoryCache.set(key, data);
  try {
    const payload = JSON.stringify({
      timestamp: Date.now(),
      data,
    });
    await AsyncStorage.setItem(`${CACHE_PREFIX}${key}`, payload);
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Retrieves data from local offline cache (fast RAM tier first, then disk)
 */
export async function getLocalCache<T>(key: string): Promise<T | null> {
  if (memoryCache.has(key)) {
    return memoryCache.get(key) as T;
  }
  try {
    const raw = await AsyncStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const data = parsed.data as T;
    memoryCache.set(key, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Removes data from local offline cache
 */
export async function removeLocalCache(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${CACHE_PREFIX}${key}`);
  } catch {
    // Ignore
  }
}

/**
 * Adds an inspection to the offline outbox queue
 */
export async function enqueuePendingInspection(
  item: Omit<PendingInspection, 'localId' | 'createdAt'>
): Promise<PendingInspection> {
  const pendingItem: PendingInspection = {
    ...item,
    localId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };

  try {
    const existing = await getPendingInspections();
    existing.unshift(pendingItem);
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(existing));
  } catch {
    // Ignore storage error
  }

  return pendingItem;
}

/**
 * Returns all inspections waiting to be synced
 */
export async function getPendingInspections(fieldId?: string): Promise<PendingInspection[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as PendingInspection[];
    if (fieldId) {
      return all.filter((i) => i.fieldId === fieldId);
    }
    return all;
  } catch {
    return [];
  }
}

/**
 * Returns a specific pending inspection by ID
 */
export async function getPendingInspectionById(localId: string): Promise<PendingInspection | null> {
  try {
    const all = await getPendingInspections();
    return all.find((i) => i.localId === localId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Converts a PendingInspection into a domain Inspection object
 */
export function pendingToDomainInspection(pending: PendingInspection): Inspection {
  let photoUrl: string | null = pending.photoUri;
  if (!photoUrl && pending.photoBase64) {
    photoUrl = pending.photoBase64.startsWith('data:')
      ? pending.photoBase64
      : `data:image/jpeg;base64,${pending.photoBase64}`;
  }

  return {
    id: pending.localId,
    fieldId: pending.fieldId,
    createdAt: pending.createdAt,
    note: pending.note,
    photoUrl,
    latitude: pending.latitude,
    longitude: pending.longitude,
    status: 'pending',
  };
}

/**
 * Removes a synced inspection from the queue
 */
export async function removePendingInspection(localId: string): Promise<void> {
  try {
    const existing = await getPendingInspections();
    const updated = existing.filter((i) => i.localId !== localId);
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage error
  }
}

/**
 * Attempts to flush all pending inspections to the server
 */
export async function flushPendingInspections(
  uploader: (inspection: PendingInspection) => Promise<unknown>
): Promise<{ synced: number; failed: number }> {
  const queue = await getPendingInspections();
  if (queue.length === 0) {
    return { synced: 0, failed: 0 };
  }

  let syncedCount = 0;
  let failedCount = 0;

  for (const item of queue) {
    try {
      await uploader(item);
      await removePendingInspection(item.localId);
      syncedCount++;
    } catch {
      failedCount++;
    }
  }

  return { synced: syncedCount, failed: failedCount };
}
