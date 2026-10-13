import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { encoreExecutable } from "./encore-process.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const backendRoot = fileURLToPath(new URL("../backend", import.meta.url));
const validationScript = fileURLToPath(
	new URL(process.argv[2] ?? "./validate-core-schema.sql", import.meta.url),
);

loadEnvFile(`${repositoryRoot}/.env`);

const sql = await readFile(validationScript, "utf8");
const connectionUri = await readCoreConnectionUri();
const connection = new URL(connectionUri);
const host = isLoopbackHost(connection.hostname) ? "host.docker.internal" : connection.hostname;
const database = connection.pathname.replace(/^\//u, "");
const password = decodeURIComponent(connection.password);

if (!connection.username || !database || !password) {
	throw new Error("Encore returned an incomplete PostgreSQL connection URI.");
}

const child = spawn(
	process.env.DOCKER_BINARY ?? "docker",
	[
		"run",
		"--rm",
		"-i",
		"--add-host",
		"host.docker.internal:host-gateway",
		"-e",
		"PGPASSWORD",
		"-e",
		"PGSSLMODE",
		process.env.CORE_SCHEMA_PSQL_IMAGE ?? "encoredotdev/postgres:18",
		"psql",
		"--host",
		host,
		"--port",
		connection.port || "5432",
		"--username",
		decodeURIComponent(connection.username),
		"--dbname",
		database,
		"--set",
		"ON_ERROR_STOP=1",
	],
	{
		cwd: repositoryRoot,
		env: {
			...process.env,
			PGPASSWORD: password,
			PGSSLMODE: connection.searchParams.get("sslmode") ?? "disable",
		},
		stdio: ["pipe", "inherit", "inherit"],
	},
);

child.stdin.end(sql);
process.exitCode = await waitForProcess(child, "Docker PostgreSQL client");

async function readCoreConnectionUri() {
	const child = spawn(encoreExecutable(), ["db", "conn-uri", "core", "--write"], {
		cwd: backendRoot,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = [];
	const stderr = [];

	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));

	const exitCode = await waitForProcess(child, "Encore", false);
	if (exitCode !== 0) {
		const diagnostic = Buffer.concat(stderr).toString().trim();
		throw new Error(
			diagnostic
				? `Unable to obtain the core database connection: ${diagnostic}`
				: "Unable to obtain the core database connection.",
		);
	}

	const uri = Buffer.concat(stdout).toString().trim();
	if (!uri.startsWith("postgres")) {
		throw new Error("Encore did not return a PostgreSQL connection URI.");
	}
	return uri;
}

function isLoopbackHost(hostname) {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function waitForProcess(child, name, reportStartFailure = true) {
	return new Promise((resolve) => {
		let settled = false;
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (reportStartFailure) {
				console.error(`Unable to start ${name}.`, error);
			}
			resolve(1);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			resolve(signal ? 1 : (code ?? 1));
		});
	});
}
