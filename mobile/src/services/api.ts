import { API_BASE_URL } from "./config";

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
      return await firebaseAuth.currentUser.getIdToken();
    } catch {
      return null;
    }
  }
  return null;
}

// Firebase mantiene su propia sesión. No duplicamos ID tokens en AsyncStorage:
// son credenciales de corta vida y deben pedirse al SDK cuando se necesiten.
export async function setTokens(_accessToken: string, _refreshToken: string) {
  return;
}

export async function clearTokens() {
  return;
}

async function refreshAccessToken(): Promise<string | null> {
  if (firebaseAuth.currentUser) {
    try {
      const newToken = await firebaseAuth.currentUser.getIdToken(true);
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
      throw new ApiError("El servidor está despertando o la conexión es lenta. Espera unos segundos e inténtalo de nuevo.", 0);
    }
    throw new ApiError("No se pudo contactar al servidor. Si acaba de estar inactivo, espera unos segundos mientras Render lo despierta.", 0);
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
    if ([502, 503, 504].includes(res.status)) {
      message = "El servidor está despertando. Espera unos segundos y vuelve a intentar; tus datos locales no se perderán.";
    }
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
