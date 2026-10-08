// Emitted only after the auth service has rejected the persisted session and
// local cleanup has been attempted. Transport failures use a different error.
export class SessionExpiredError extends Error {
  constructor() {
    super("Сессия истекла. Войдите снова.");
    this.name = "SessionExpiredError";
  }
}
