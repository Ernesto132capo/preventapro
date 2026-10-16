import AsyncStorage from "@react-native-async-storage/async-storage";

// Cargar expo-secure-store dinámicamente si está disponible en el entorno nativo
let SecureStore: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SecureStore = require("expo-secure-store");
} catch {
  SecureStore = null;
}

/**
 * Obtiene un ítem del almacenamiento seguro (Keystore/Keychain).
 * Si aún residía en AsyncStorage (versión anterior), lo migra de forma transparente
 * al almacenamiento seguro y limpia la copia en texto plano para no desloguear al usuario.
 */
export async function getSecureItem(key: string): Promise<string | null> {
  if (SecureStore && typeof SecureStore.getItemAsync === "function") {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null && val !== undefined) return val;
    } catch {
      // Si falla en dispositivos no soportados, continuar con fallback
    }
  }

  // Fallback y migración transparente desde AsyncStorage
  const legacyVal = await AsyncStorage.getItem(key);
  if (legacyVal && SecureStore && typeof SecureStore.setItemAsync === "function") {
    try {
      await SecureStore.setItemAsync(key, legacyVal);
      await AsyncStorage.removeItem(key);
    } catch {}
  }
  return legacyVal;
}

/**
 * Guarda un ítem cifrado en almacenamiento seguro.
 * Elimina cualquier copia residual sin cifrar de AsyncStorage.
 */
export async function setSecureItem(key: string, value: string): Promise<void> {
  if (SecureStore && typeof SecureStore.setItemAsync === "function") {
    try {
      await SecureStore.setItemAsync(key, value);
      await AsyncStorage.removeItem(key);
      return;
    } catch {}
  }
  await AsyncStorage.setItem(key, value);
}

/**
 * Elimina el ítem tanto del almacenamiento seguro como de AsyncStorage.
 */
export async function deleteSecureItem(key: string): Promise<void> {
  if (SecureStore && typeof SecureStore.deleteItemAsync === "function") {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {}
  }
  await AsyncStorage.removeItem(key);
}
