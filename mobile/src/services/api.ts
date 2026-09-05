import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE_URL } from "./config";

const ACCESS_TOKEN_KEY = "preventapro_access_token";
const REFRESH_TOKEN_KEY = "preventapro_refresh_token";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

import { firebaseAuth } from "./firebase";

export async function getAccessToken(): Promise<string | null> {
  if (firebaseAuth.currentUser) {
    try {
      const token = await firebaseAuth.currentUser.getIdToken();
      await AsyncStorage.setItem(ACCESS_TOKEN_KEY, token);
      return token;
    } catch {
      // Fallback si falla la llamada
    }
  }
  return AsyncStorage.getItem(ACCESS_TOKEN_KEY);
}

export async function setTokens(accessToken: string, refreshToken: string) {
  await AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export async function clearTokens() {
  await AsyncStorage.multiRemove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]);
}

async function refreshAccessToken(): Promise<string | null> {
  if (firebaseAuth.currentUser) {
    try {
      const newToken = await firebaseAuth.currentUser.getIdToken(true);
      await AsyncStorage.setItem(ACCESS_TOKEN_KEY, newToken);
      return newToken;
    } catch {
      return null;
    }
  }
  return null;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  authRequired?: boolean;
  timeoutMs?: number;
}

/**
 * Cliente HTTP central. Lanza ApiError con mensajes en español listos para mostrar.
 * Maneja: token expirado (reintenta 1 vez con refresh), timeout (para no colgar la UI
 * cuando la señal es mala en campo), y errores de red (para que la capa de sync los
 * distinga de errores de validación del servidor).
 */
export async function apiFetch<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  // Firestore puede demorar en el primer acceso (credenciales/red). En campo
  // 15 s provocaba falsos errores de sincronización aun con Wi‑Fi estable.
  const { method = "GET", body, authRequired = true, timeoutMs = 60000 } = opts;

  const doFetch = async (token: string | null): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  let token = authRequired ? await getAccessToken() : null;
  let res: Response;
  try {
    res = await doFetch(token);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new ApiError("Tiempo de espera agotado. Verifica tu conexión.", 0);
    }
    throw new ApiError("Sin conexión al servidor.", 0);
  }

  if (res.status === 401 && authRequired) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      res = await doFetch(newToken);
    }
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // respuesta sin cuerpo (ej. 204)
  }

    if (!res.ok) {
    let message = data?.error || "Error del servidor.";
    if (data?.details) {
      try {
        const fieldErrors = data.details.fieldErrors || {};
        const parts = Object.entries(fieldErrors)
          .filter(([, msgs]) => Array.isArray(msgs) && (msgs as any[]).length > 0)
          .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(", ")}`);
        if (parts.length) message = `${message} (${parts.join("; ")})`;
      } catch {
        // si el formato de details cambia, no rompemos el flujo, solo mostramos el mensaje genérico
      }
    }
    throw new ApiError(message, res.status);
  }
  return data as T;
}
