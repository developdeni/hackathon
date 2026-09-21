import { useContext, createContext, useCallback, useEffect, useState, ReactNode } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { loginUser, registerUser, telegramAuthUser, getMe, isAuthenticationError } from '../services/api';
import {
  clearAuthSession,
  loadCachedUser,
  loadToken,
  saveCachedUser,
  saveToken,
} from '../services/auth';
import { LoginInput, RegisterInput, User } from '../types/domain';

type TelegramAuthInput = {
  initData: string;
  name: string;
  companyName: string;
};

type AuthContextValue = {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  loginWithTelegram: (input: TelegramAuthInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  applyUser: (user: User) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();

  // On mount — restore token and load user profile
  useEffect(() => {
    void (async () => {
      try {
        const [stored, cachedUser] = await Promise.all([loadToken(), loadCachedUser()]);
        if (stored) {
          setToken(stored);
          if (cachedUser) setUser(cachedUser);
          try {
            const me = await getMe();
            setUser(me);
            await saveCachedUser(me);
          } catch (error) {
            // A network outage is not a logout. Clear only a token that the
            // server explicitly rejects.
            if (isAuthenticationError(error)) {
              await clearAuthSession();
              setToken(null);
              setUser(null);
            }
          }
        }
      } catch {
        // Local storage can fail independently. Do not destroy a recoverable session.
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Navigation guard — redirect to login if no user, redirect to home if already logged in
  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === 'auth';
    if (!token && !user && !inAuthGroup) {
      // Not authenticated → send to login, clear any history
      router.replace('/auth/login');
    } else if (user && inAuthGroup) {
      // Authenticated but on auth screen → go home, clear history
      router.replace('/');
    }
  }, [user, token, isLoading, segments, router]);

  const login = useCallback(async (input: LoginInput) => {
    const response = await loginUser(input);
    await Promise.all([saveToken(response.token), saveCachedUser(response.user)]);
    setToken(response.token);
    setUser(response.user);
    // Explicitly navigate home and clear auth history
    router.replace('/');
  }, [router]);

  const register = useCallback(async (input: RegisterInput) => {
    const response = await registerUser(input);
    await Promise.all([saveToken(response.token), saveCachedUser(response.user)]);
    setToken(response.token);
    setUser(response.user);
    // Explicitly navigate home and clear auth history
    router.replace('/');
  }, [router]);

  const loginWithTelegram = useCallback(async (input: TelegramAuthInput) => {
    const response = await telegramAuthUser(input);
    await Promise.all([saveToken(response.token), saveCachedUser(response.user)]);
    setToken(response.token);
    setUser(response.user);
    router.replace('/');
  }, [router]);

  const logout = useCallback(async () => {
    await clearAuthSession();
    setToken(null);
    setUser(null);
    router.replace('/auth/login');
  }, [router]);

  const applyUser = useCallback(async (next: User) => {
    setUser(next);
    await saveCachedUser(next);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      await saveCachedUser(me);
    } catch (error) {
      if (isAuthenticationError(error)) {
        await clearAuthSession();
        setToken(null);
        setUser(null);
      }
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, loginWithTelegram, logout, refreshUser, applyUser }}>
      {children}
    </AuthContext.Provider>
  );
}
