import { useEffect, useState } from "react";

/**
 * Hook para retrasar la actualización de un valor hasta que haya pasado
 * el tiempo indicado (en ms) sin nuevos cambios. Ideal para búsquedas
 * en SQLite y filtros en tiempo real.
 */
export function useDebounce<T>(value: T, delayMs: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
