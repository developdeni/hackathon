import { useContext, createContext, useCallback, useEffect, useState, ReactNode } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { loginUser, registerUser, getMe } from '../services/api';
import { clearToken, loadToken, saveToken } from '../services/auth';
import { LoginInput, RegisterInput, User } from '../types/domain';

type AuthContextValue = {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
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
        const stored = await loadToken();
        if (stored) {
          setToken(stored);
          const me = await getMe();
          setUser(me);
        }
      } catch {
        // Token expired or server offline — clear it
        await clearToken();
        setToken(null);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Navigation guard — redirect to login if no user, redirect to home if already logged in
  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === 'auth';
    if (!user && !inAuthGroup) {
      // Not authenticated → send to login, clear any history
      router.replace('/auth/login');
    } else if (user && inAuthGroup) {
      // Authenticated but on auth screen → go home, clear history
      router.replace('/');
    }
  }, [user, isLoading, segments, router]);

  const login = useCallback(async (input: LoginInput) => {
    const response = await loginUser(input);
    await saveToken(response.token);
    setToken(response.token);
    setUser(response.user);
    // Explicitly navigate home and clear auth history
    router.replace('/');
  }, [router]);

  const register = useCallback(async (input: RegisterInput) => {
    const response = await registerUser(input);
    await saveToken(response.token);
    setToken(response.token);
    setUser(response.user);
    // Explicitly navigate home and clear auth history
    router.replace('/');
  }, [router]);

  const logout = useCallback(async () => {
    await clearToken();
    setToken(null);
    setUser(null);
    router.replace('/auth/login');
  }, [router]);

  const refreshUser = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
    } catch {
      // ignore refresh failures silently
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}
