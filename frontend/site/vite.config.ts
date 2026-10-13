import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const administrationDocumentPath = resolve(currentDirectory, "../administration/index.html");
const administrationEntryPath = normalizePath(
	resolve(currentDirectory, "../administration/src/main.tsx"),
);
const administrationSourcePrefix = `/@fs/${normalizePath(
	resolve(currentDirectory, "../administration"),
).replace(/^\/+/, "")}/`;

export default defineConfig({
	envDir: resolve(currentDirectory, "../.."),
	plugins: [rejectBackendPaths(), administrationDevelopmentHost(), react()],
	build: {
		manifest: true,
		sourcemap: false,
	},
	server: {
		host: true,
		strictPort: true,
	},
});

function rejectBackendPaths(): Plugin {
	return {
		name: "compendlore-reject-backend-paths",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? "/", "http://frontend.local").pathname;
				if (!/^\/api(?:\/|$)/.test(pathname)) {
					next();
					return;
				}

				response.statusCode = 404;
				response.setHeader("content-type", "text/plain; charset=utf-8");
				response.end("Not Found");
			});
		},
	};
}

function administrationDevelopmentHost(): Plugin {
	return {
		name: "compendlore-administration-development-host",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				const accept = request.headers.accept ?? "";
				const pathname = decodeURIComponent(
					new URL(request.url ?? "/", "http://frontend.local").pathname,
				);
				const administrationDocument =
					request.method === "GET" &&
					accept.includes("text/html") &&
					/^\/admin(?:\/|$)/.test(pathname);
				const administrationSource =
					request.method === "GET" && pathname.startsWith(administrationSourcePrefix);
				if (!administrationDocument && !administrationSource) {
					next();
					return;
				}

				try {
					if (!(await hasAdministrationAccess(request, server.config.env.VITE_API_ORIGIN))) {
						response.statusCode = administrationDocument ? 302 : 404;
						response.setHeader("cache-control", "no-store");
						if (administrationDocument) response.setHeader("location", "/");
						response.end();
						return;
					}
					if (administrationSource) {
						next();
						return;
					}
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

async function hasAdministrationAccess(
	request: IncomingMessage,
	apiOrigin = "http://localhost:4000",
): Promise<boolean> {
	try {
		const authorization = request.headers.authorization;
		const cookie = request.headers.cookie;
		const result = await fetch(new URL("/api/catalog/administration", apiOrigin), {
			headers: {
				accept: "application/json",
				...(typeof authorization === "string" ? { authorization } : {}),
				...(typeof cookie === "string" ? { cookie } : {}),
			},
		});
		return result.ok;
	} catch {
		return false;
	}
}
