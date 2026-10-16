import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch, setTokens, clearTokens, getAccessToken, ApiError } from "../services/api";

export interface AuthUser {
  id: string;
  code: string;
  email: string | null;
  fullName: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (identifier: string, password: string, rememberSession: boolean) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const USER_KEY = "preventapro_user";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [token, storedUser] = await Promise.all([
          getAccessToken(),
          AsyncStorage.getItem(USER_KEY),
        ]);
        if (token && storedUser) {
          try {
            setUser(JSON.parse(storedUser) as AuthUser);
          } catch {
            await AsyncStorage.removeItem(USER_KEY);
            await clearTokens();
          }
        }
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (identifier: string, password: string, rememberSession: boolean) => {
    setError(null);
    try {
      const res = await apiFetch<{ accessToken: string; user: AuthUser }>("/auth/login", {
        method: "POST",
        authRequired: false,
        body: { identifier, password },
      });
      await setTokens(res.accessToken, rememberSession);
      if (rememberSession) {
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(res.user));
      } else {
        await AsyncStorage.removeItem(USER_KEY);
      }
      setUser(res.user);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión. Verifica tu conexión.");
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    await clearTokens();
    await AsyncStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, error, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
}
