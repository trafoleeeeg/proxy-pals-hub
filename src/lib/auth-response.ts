export function isUnauthorizedServerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^Unauthorized(?::|$)/i.test(error.message);
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}