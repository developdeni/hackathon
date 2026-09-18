/**
 * Auth service — JWT token storage and auth API calls.
 * Token is persisted in AsyncStorage so it survives app restarts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LoginInput, RegisterInput, AuthResponse } from '../types/domain';

export const AUTH_TOKEN_KEY = 'tanap_auth_token';

export async function saveToken(token: string): Promise<void> {
  await AsyncStorage.setItem(AUTH_TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  return AsyncStorage.getItem(AUTH_TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
}
