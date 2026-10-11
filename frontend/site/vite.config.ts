import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		manifest: true,
		sourcemap: false,
	},
	server: {
		host: true,
		strictPort: true,
		proxy: {
			"/admin": {
				target: "http://127.0.0.1:5174",
				changeOrigin: true,
				ws: true,
				rewrite: (path) => (path === "/admin" ? "/admin/" : path),
			},
			"/backend": {
				target: "http://localhost:4000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/backend/, ""),
			},
		},
	},
});
