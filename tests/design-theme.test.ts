import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const root = css.match(/:root\s*\{[\s\S]*?\}/)![0];
const shell = readFileSync(new URL("../src/routes/_authenticated/app.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("../desktop/runtime/theme.cjs", import.meta.url), "utf8");

function neutralLightness(token: string) {
  const match = root.match(new RegExp(`--${token}: oklch\\(([^)]+)\\)`));
  expect(match, token).not.toBeNull();
  const [lightness, chroma] = match![1]!.split(/\s+/).map(Number);
  expect(chroma, `${token} must stay neutral`).toBe(0);
  return lightness!;
}

function contrast(foreground: string, background: string) {
  // For neutral OKLCH colors, linear RGB luminance is L cubed.
  const a = neutralLightness(foreground) ** 3;
  const b = neutralLightness(background) ** 3;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("minimal graphite design", () => {
  test("neutral text and primary controls meet AA contrast on their surfaces", () => {
    for (const [foreground, background] of [
      ["foreground", "background"], ["card-foreground", "card"],
      ["popover-foreground", "popover"], ["muted-foreground", "background"],
      ["muted-foreground", "popover"], ["muted-foreground", "sidebar"],
      ["sidebar-foreground", "sidebar"], ["sidebar-accent-foreground", "sidebar-accent"],
      ["primary-foreground", "primary"], ["secondary-foreground", "secondary"],
    ]) expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
  });

  test("uses local readable fonts and retains accessible focus and reduced motion", () => {
    expect(root).toContain('"Segoe UI Variable", "Segoe UI", system-ui, sans-serif');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid var(--ring)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("transition-duration: 0s !important");
  });

  test("web and native UI share tokens, with a rounded scrollable workspace", () => {
    expect(theme).toContain('"src", "styles.css"');
    expect(shell).toContain("umbra-workspace flex h-dvh overflow-hidden bg-sidebar");
    expect(shell).toContain('aria-label="Боковая панель"');
    expect(shell).toContain('data-testid="workspace-surface"');
    expect(shell).toContain("overflow-hidden rounded-2xl border border-border/70 bg-background");
    expect(shell).toContain("min-w-0 flex-1 overflow-y-auto");
    expect(shell).toContain('aria-label="Развернуть меню"');
    expect(shell).toContain('aria-label="Свернуть меню"');
  });
});
