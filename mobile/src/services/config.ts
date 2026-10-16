// Expo reemplaza EXPO_PUBLIC_API_URL al iniciar o compilar la aplicación.
// Si no se define, se usa el backend desplegado de PreventaPro.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || "https://preventapro-backend.onrender.com/api";
