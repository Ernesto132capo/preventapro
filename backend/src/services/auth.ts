import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";

const PASSWORD_KEY_LENGTH = 64;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const REPORT_TOKEN_TTL_SECONDS = 120;

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function authSecret(): string {
  const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) {
    if (isTest) return "preventapro_super_secure_jwt_auth_secret_key_32_chars_test";
    throw new Error("Falta la variable de entorno AUTH_TOKEN_SECRET (debe tener al menos 32 caracteres).");
  }
  if (secret.length < 32) {
    if (isTest) return "preventapro_super_secure_jwt_auth_secret_key_32_chars_test";
    throw new Error("AUTH_TOKEN_SECRET debe tener al menos 32 caracteres de longitud por seguridad.");
  }
  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) return false;
  const [scheme, saltEncoded, keyEncoded] = storedHash.split("$");
  if (scheme !== "scrypt" || !saltEncoded || !keyEncoded) return false;

  try {
    const salt = Buffer.from(saltEncoded, "base64url");
    const expected = Buffer.from(keyEncoded, "base64url");
    if (salt.length !== 16 || expected.length !== PASSWORD_KEY_LENGTH) return false;
    const actual = await derivePasswordKey(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createSignedToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${encodedPayload}`;
  const signature = createHmac("sha256", authSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifySignedToken(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token inválido.");

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", authSecret()).update(unsigned).digest();
  const received = Buffer.from(parts[2], "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Firma inválida.");
  }

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "HS256" || !Number.isInteger(payload.exp)) throw new Error("Token inválido.");
  if (payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("Token expirado.");
  return payload;
}

export function createAccessToken(userId: string, sessionId?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    typ: "access",
    sub: userId,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  if (sessionId) {
    payload.sid = sessionId;
  }
  return createSignedToken(payload);
}

export function verifyAccessToken(token: string): { uid: string; sid?: string } {
  const payload = verifySignedToken(token);
  if (payload.typ !== "access" || typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Token inválido.");
  }
  return {
    uid: payload.sub,
    sid: typeof payload.sid === "string" ? payload.sid : undefined,
  };
}

export function createReportDownloadToken(workDayId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return createSignedToken({ typ: "report", workDayId, iat: now, exp: now + REPORT_TOKEN_TTL_SECONDS });
}

export function verifyReportDownloadToken(token: string, workDayId: string): void {
  const payload = verifySignedToken(token);
  if (payload.typ !== "report" || payload.workDayId !== workDayId) throw new Error("Enlace de descarga inválido.");
}
