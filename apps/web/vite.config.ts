import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발 중 API와 Event stream은 같은 origin의 /api로 서버에 넘긴다.
const api = process.env.BABOJUBOT_API ?? "http://127.0.0.1:3100";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: api, ws: true } },
  },
});
