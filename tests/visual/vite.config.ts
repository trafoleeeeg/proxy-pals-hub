import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// This isolated configuration is never imported by the production Vite build.
export default defineConfig({
  root: local("./"),
  envDir: local("./"),
  cacheDir: local("./.vite"),
  plugins: [
    { name: "fixture-api", enforce: "pre", resolveId(source) {
      if (/(?:^|\/)(?:team|profiles|proxies|session|profile-metadata)\.functions$/.test(source)) return local("./mock-api.ts");
      return null;
    } },
    react(), tailwindcss(),
  ],
  resolve: { alias: [
    { find: "@tanstack/react-start", replacement: local("./mock-start.ts") },
    { find: "@/integrations/supabase/client", replacement: local("./mock-auth.ts") },
    { find: "@", replacement: local("../../src") },
  ] },
  server: { host: "127.0.0.1", fs: { allow: [local("../../")] }, watch: { ignored: ["**/artifacts/**", "**/tests/visual/tests/**"] } },
});
