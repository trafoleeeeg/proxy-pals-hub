export const EMPLOYEE_PREVIEW_KEY = "umbra:employee-preview:v1";
export const EMPLOYEE_AUTH_KEY = "umbra:employee-auth:v1";
export const EMPLOYEE_EXIT_KEY = "umbra:employee-exit:v1";
export const LEGACY_PREVIEW_KEY = "umbra:impersonation";

export type EmployeePreview = { ownerId: string; employeeId: string; employeeEmail: string; teamId: string };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePreview(raw: string | null): EmployeePreview | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || ![value.ownerId, value.employeeId, value.teamId].every(id => typeof id === "string" && uuid.test(id))
      || value.ownerId === value.employeeId || typeof value.employeeEmail !== "string" || value.employeeEmail.length > 254) return null;
    // Never copy owner credentials or arbitrary extra fields into the overlay.
    return { ownerId: value.ownerId, employeeId: value.employeeId, employeeEmail: value.employeeEmail, teamId: value.teamId };
  } catch { return null; }
}

export function readEmployeePreview(store: Store): EmployeePreview | null {
  try { return parsePreview(store.getItem(EMPLOYEE_PREVIEW_KEY)); } catch { return null; }
}

export function saveEmployeePreview(store: Store, preview: EmployeePreview) {
  const safe = parsePreview(JSON.stringify(preview));
  if (!safe) throw new Error("Некорректный режим сотрудника");
  store.setItem(EMPLOYEE_PREVIEW_KEY, JSON.stringify(safe));
}

export function employeeAuthKey(preview: EmployeePreview) {
  return `${EMPLOYEE_AUTH_KEY}:${preview.ownerId}:${preview.employeeId}`;
}

export function clearEmployeePreview(store: Store, preview = readEmployeePreview(store)) {
  const authKey = preview ? employeeAuthKey(preview) : EMPLOYEE_AUTH_KEY;
  for (const key of [EMPLOYEE_PREVIEW_KEY, authKey, authKey + "-user", authKey + "-code-verifier"]) store.removeItem(key);
}

export function queueEmployeeExit(store: Store, preview: EmployeePreview) {
  const safe = parsePreview(JSON.stringify(preview));
  if (safe) store.setItem(EMPLOYEE_EXIT_KEY, JSON.stringify(safe));
}

export function takeEmployeeExit(store: Store, ownerId: string): EmployeePreview | null {
  const value = parsePreview(store.getItem(EMPLOYEE_EXIT_KEY));
  if (!value || value.ownerId !== ownerId) return null;
  store.removeItem(EMPLOYEE_EXIT_KEY);
  return value;
}
