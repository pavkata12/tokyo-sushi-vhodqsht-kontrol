import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5175,
    host: true,
    allowedHosts: true,
    proxy: { "/api": "http://127.0.0.1:3003" }
  },
  build: { cssCodeSplit: true, modulePreload: true }
});
