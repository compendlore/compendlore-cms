import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { encoreExecutable, waitForEncore } from "./encore-process.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const backendRoot = fileURLToPath(new URL("../backend", import.meta.url));

loadEnvFile(`${repositoryRoot}/.env`);

const child = spawn(encoreExecutable(), process.argv.slice(2), {
	cwd: backendRoot,
	env: process.env,
	stdio: ["inherit", "pipe", "pipe"],
});

process.exitCode = await waitForEncore(child);
