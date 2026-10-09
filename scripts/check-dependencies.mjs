import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ignored = new Set(["node_modules", "build", "dist", "artifacts", ".git"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const graph = new Map();

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (ignored.has(entry.name)) continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) await walk(target);
		else if (sourceExtensions.has(path.extname(entry.name))) await inspect(target);
	}
}

async function inspect(file) {
	const source = await readFile(file, "utf8");
	const dependencies = [];
	const pattern = /(?:from\s+|import\s*\()["'](\.[^"']+)["']/g;
	for (const match of source.matchAll(pattern)) {
		const resolved = await resolveImport(file, match[1]);
		if (resolved) dependencies.push(resolved);
	}
	graph.set(path.resolve(file), dependencies);
}

async function resolveImport(file, specifier) {
	const base = path.resolve(path.dirname(file), specifier);
	for (const candidate of [
		base,
		...[".ts", ".tsx", ".js", ".mjs"].map((extension) => base + extension),
		...[".ts", ".tsx", ".js", ".mjs"].map((extension) => path.join(base, "index" + extension)),
	]) {
		try {
			const stat = await import("node:fs/promises").then(({ stat }) => stat(candidate));
			if (stat.isFile()) return path.resolve(candidate);
		} catch {}
	}
	return undefined;
}

const visiting = new Set();
const visited = new Set();

function visit(node, trail = []) {
	if (visiting.has(node)) {
		throw new Error(
			"Dépendance circulaire : " +
				[...trail, node].map((item) => path.relative(process.cwd(), item)).join(" -> "),
		);
	}
	if (visited.has(node)) return;
	visiting.add(node);
	for (const dependency of graph.get(node) ?? []) visit(dependency, [...trail, node]);
	visiting.delete(node);
	visited.add(node);
}

await walk(process.cwd());
for (const node of graph.keys()) visit(node);
console.log("Aucune dépendance circulaire détectée.");
