import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  testDir: local("./"), testMatch: "*.pw.ts", outputDir: local("./artifacts/results"),
  fullyParallel: false, workers: 1, retries: 0,
  reporter: [["list"], ["json", { outputFile: local("./artifacts/report.json") }]],
  use: { baseURL: "http://127.0.0.1:4179", headless: true,
    launchOptions: { executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
