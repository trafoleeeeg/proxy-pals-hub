// Intersection of desktop Chromium 152's buckets (2..32) and the shipped
// screen5 native API (0.25..8). Do not offer 16/32 until clients support them.
export const SUPPORTED_PROFILE_MEMORY = [2, 4, 8] as const;
export const PROFILE_MEMORY_ERROR = "Выберите сообщаемую память 2, 4 или 8 ГБ. Значения ниже 2 не соответствуют текущему настольному Chromium; 16/32 пока не поддерживаются движком Umbra.";
export function isSupportedProfileMemory(value: unknown): boolean {
  return typeof value === "number" && SUPPORTED_PROFILE_MEMORY.some((memory) => memory === value);
}
