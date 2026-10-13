import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	base: "/admin/",
	envDir: resolve(currentDirectory, "../.."),
	plugins: [react()],
	build: {
		manifest: true,
		sourcemap: false,
	},
});
