import { auth } from "../firebase/admin";

// Firebase Authentication necesita un email para el login con Email/Password.
// Tus preventistas inician sesión con un "código", así que le generamos un
// email sintético estable a partir del código (nunca se muestra al usuario).
const EMAIL_DOMAIN = "preventapro.local";

export function codeToEmail(code: string): string {
  const clean = code.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `${clean}@${EMAIL_DOMAIN}`;
}

export async function createAuthUser(params: {
  code: string;
  password: string;
  fullName: string;
}) {
  const email = codeToEmail(params.code);
  return auth.createUser({
    email,
    password: params.password,
    displayName: params.fullName,
  });
}

export async function verifyIdToken(idToken: string) {
  // Verifica el ID token que emite Firebase Authentication en el celular
  // (equivalente a tu verifyToken() de jsonwebtoken, pero validado contra Firebase).
  return auth.verifyIdToken(idToken);
}
