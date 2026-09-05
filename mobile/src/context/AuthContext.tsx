import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch, setTokens, clearTokens, getAccessToken, ApiError } from "../services/api";
import { firebaseAuth } from "../services/firebase";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";

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
      const token = await getAccessToken();
      const storedUser = await AsyncStorage.getItem(USER_KEY);
      if (token && storedUser) {
        setUser(JSON.parse(storedUser));
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (identifier: string, password: string, rememberSession: boolean) => {
    setError(null);
    try {
      const resolved = await apiFetch<any>(`/auth/resolve-code/${encodeURIComponent(identifier)}`, { authRequired: false });
      const credential = await signInWithEmailAndPassword(firebaseAuth, resolved.email, password);
      const idToken = await credential.user.getIdToken();
      await setTokens(idToken, "");
      const res = await apiFetch<any>("/auth/me", { authRequired: true });
      const authedUser: AuthUser = {
        id: res.user.id,
        code: res.user.code,
        email: res.user.email,
        fullName: res.user.fullName,
      };
      if (rememberSession) {
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(authedUser));
      }
      setUser(authedUser);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión. Verifica tu conexión.");
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    await signOut(firebaseAuth);
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
