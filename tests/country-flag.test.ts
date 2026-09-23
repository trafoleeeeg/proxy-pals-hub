import { expect, test } from "bun:test";
import { countryFlag } from "../src/lib/country-flag";

test("renders a flag only for a two-letter country code", () => {
  expect(countryFlag("us")).toBe("🇺🇸");
  expect(countryFlag("DE")).toBe("🇩🇪");
  expect(countryFlag(null)).toBe("");
  expect(countryFlag("USA")).toBe("");
});
