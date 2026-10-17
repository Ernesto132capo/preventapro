import { getSecureItem, setSecureItem, deleteSecureItem } from "./secureStorage";
import { API_BASE_URL } from "./config";

const ACCESS_TOKEN_KEY = "preventapro_access_token";
let accessToken: string | null = null;
let tokenLoaded = false;
type UnauthorizedListener = (rejectedToken: string | null) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Notifica 401 de rutas privadas para que la sesión local pueda pedir reautenticación. */
export function subscribeToUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(rejectedToken: string | null): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener(rejectedToken);
    } catch {
      // Un listener de sesión no debe alterar el error HTTP de la petición original.
    }
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getAccessToken(): Promise<string | null> {
  if (!tokenLoaded) {
    accessToken = await getSecureItem(ACCESS_TOKEN_KEY);
    tokenLoaded = true;
  }
  return accessToken;
}

/** Mantiene el token en memoria y lo persiste únicamente si se pidió recordar la sesión. */
export async function setTokens(token: string, rememberSession = true): Promise<void> {
  accessToken = token;
  tokenLoaded = true;
  if (rememberSession) {
    await setSecureItem(ACCESS_TOKEN_KEY, token);
  } else {
    await deleteSecureItem(ACCESS_TOKEN_KEY);
  }
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  tokenLoaded = true;
  await deleteSecureItem(ACCESS_TOKEN_KEY);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  authRequired?: boolean;
  timeoutMs?: number;
}

/** Cliente HTTP común. Las operaciones offline se guardan localmente; este cliente sube los cambios al backend Neon. */
export async function apiFetch<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authRequired = true, timeoutMs = 60000 } = opts;
  const token = authRequired ? await getAccessToken() : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new ApiError("El servidor tardó demasiado en responder. Espera unos segundos e inténtalo de nuevo.", 0);
    }
    throw new ApiError("No se pudo contactar al servidor. Verifica tu conexión e inténtalo de nuevo.", 0);
  } finally {
    clearTimeout(timeout);
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Algunas respuestas, como 204, no contienen JSON.
  }

  if (!res.ok) {
    if (res.status === 401 && authRequired) {
      notifyUnauthorized(token);
    }
    let message = data?.error || "Error del servidor.";
    if ([502, 503, 504].includes(res.status)) {
      message = "El servidor no está disponible. Tus datos locales no se perderán; vuelve a intentar cuando haya conexión.";
    }
    if (data?.details) {
      try {
        const fieldErrors = data.details.fieldErrors || {};
        const parts = Object.entries(fieldErrors)
          .filter(([, msgs]) => Array.isArray(msgs) && (msgs as any[]).length > 0)
          .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(", ")}`);
        if (parts.length) message = `${message} (${parts.join("; ")})`;
      } catch {
        // Conserva el mensaje genérico si el formato de validación cambia.
      }
    }
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export interface UserSessionInfo {
  id: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export async function fetchActiveSessions(): Promise<UserSessionInfo[]> {
  const data = await apiFetch<{ sessions: UserSessionInfo[] }>("/auth/sessions");
  return data.sessions || [];
}

export async function revokeOtherSessions(): Promise<number> {
  const data = await apiFetch<{ ok: boolean; revokedCount: number }>("/auth/sessions/revoke-others", {
    method: "POST",
  });
  return data.revokedCount || 0;
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  await apiFetch(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function logoutRemote(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST", timeoutMs: 5000 });
  } catch {
    // Si el dispositivo está sin red, la sesión se limpia localmente de todos modos
  }
}
