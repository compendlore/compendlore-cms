import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/admin/",
	plugins: [react()],
	build: {
		manifest: true,
		sourcemap: false,
	},
	server: {
		host: "127.0.0.1",
		strictPort: true,
		hmr: {
			clientPort: 5173,
		},
		proxy: {
			"/backend": {
				target: "http://localhost:4000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/backend/, ""),
			},
		},
	},
});
