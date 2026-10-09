import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const policy = JSON.parse(await readFile("architecture.layers.json", "utf8"));
const ignored = new Set(["node_modules", "build", "dist", "artifacts", ".git"]);
const violations = [];

function layerFor(file) {
	const normalized = path.relative(process.cwd(), file).replaceAll("\\", "/");
	return policy.layers.find((layer) => layer.paths.some((prefix) => normalized.startsWith(prefix)));
}

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (ignored.has(entry.name)) continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) await walk(target);
		else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) await inspect(target);
	}
}

async function inspect(file) {
	const sourceLayer = layerFor(file);
	if (!sourceLayer) return;
	const source = await readFile(file, "utf8");
	const pattern = /(?:from\s+|import\s*\()["'](\.[^"']+)["']/g;
	for (const match of source.matchAll(pattern)) {
		const target = path.resolve(path.dirname(file), match[1]);
		const targetLayer = layerFor(target);
		if (
			targetLayer &&
			targetLayer.name !== sourceLayer.name &&
			!sourceLayer.mayImport.includes(targetLayer.name)
		) {
			violations.push(
				path.relative(process.cwd(), file) + " ne peut pas importer " + targetLayer.name,
			);
		}
	}
}

await walk(process.cwd());
if (violations.length > 0) {
	console.error(violations.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Frontières d'architecture respectées.");
}
