// Expo reemplaza EXPO_PUBLIC_API_URL al iniciar o compilar la aplicación.
const envUrl = process.env.EXPO_PUBLIC_API_URL;

if (!envUrl && typeof __DEV__ !== "undefined" && __DEV__) {
  console.warn("⚠️ EXPO_PUBLIC_API_URL no está configurada. Usando fallback de desarrollo local: http://localhost:4000/api");
}

export const API_BASE_URL = envUrl || "http://localhost:4000/api";
