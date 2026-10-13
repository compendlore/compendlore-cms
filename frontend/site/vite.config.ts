import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const administrationDocumentPath = resolve(currentDirectory, "../administration/index.html");
const administrationEntryPath = normalizePath(
	resolve(currentDirectory, "../administration/src/main.tsx"),
);

export default defineConfig({
	plugins: [administrationDevelopmentHost(), react()],
	build: {
		manifest: true,
		sourcemap: false,
	},
	server: {
		host: true,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://localhost:4000",
				changeOrigin: true,
			},
			"/backend": {
				target: "http://localhost:4000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/backend/, ""),
			},
		},
	},
});

function administrationDevelopmentHost(): Plugin {
	return {
		name: "compendlore-administration-development-host",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const accept = request.headers.accept ?? "";
				const pathname = new URL(request.url ?? "/", "http://frontend.local").pathname;
				if (
					request.method !== "GET" ||
					!accept.includes("text/html") ||
					!/^\/admin(?:\/|$)/.test(pathname)
				) {
					next();
					return;
				}

				try {
					const source = await readFile(administrationDocumentPath, "utf8");
					const document = source.replace(
						'src="/src/main.tsx"',
						`src="/@fs/${administrationEntryPath}"`,
					);
					const transformed = await server.transformIndexHtml(pathname, document);
					response.statusCode = 200;
					response.setHeader("content-type", "text/html; charset=utf-8");
					response.end(transformed);
				} catch (error) {
					next(error instanceof Error ? error : new Error("Chargement administratif impossible."));
				}
			});
		},
	};
}
