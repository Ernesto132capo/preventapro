import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch, setTokens, clearTokens, getAccessToken, ApiError, subscribeToUnauthorized } from "../services/api";

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
  const unauthorizedHandlingRef = useRef(false);
  const userRef = useRef(user);
  userRef.current = user;

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

  useEffect(() => subscribeToUnauthorized((rejectedToken) => {
    if (!userRef.current || unauthorizedHandlingRef.current) return;
    unauthorizedHandlingRef.current = true;

    void (async () => {
      const currentToken = await getAccessToken().catch(() => null);
      // Ignora respuestas tardías de una sesión anterior si el usuario ya volvió a entrar.
      if (currentToken !== rejectedToken) {
        unauthorizedHandlingRef.current = false;
        return;
      }

      // La expiración de sesión solo elimina credenciales; nunca reinicia SQLite ni el outbox.
      await clearTokens().catch(() => undefined);
      await AsyncStorage.removeItem(USER_KEY).catch(() => undefined);
      setError(null);
      setUser(null);
      Alert.alert(
        "Sesión vencida",
        "Inicia sesión nuevamente para continuar. Tus datos locales y preventas pendientes se conservaron."
      );
    })();
  }), []);

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
      unauthorizedHandlingRef.current = false;
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
