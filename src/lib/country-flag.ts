/** Convert a verified ISO-3166 alpha-2 country to a native flag emoji. */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return "";
  const upper = code.toUpperCase();
  return String.fromCodePoint(...[...upper].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}
