import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

const applications = [
	{ name: "site", expectedEntry: "index.html" },
	{ name: "administration", expectedEntry: "index.html" },
];

const manifests = new Map();
for (const application of applications) {
	const root = join(process.cwd(), "frontend", application.name, "dist");
	const files = await recursiveFiles(root);
	const sourceMaps = files.filter((file) => file.endsWith(".map"));
	if (sourceMaps.length)
		throw new Error(`${application.name} exposes source maps: ${sourceMaps.join(", ")}`);
	const manifest = JSON.parse(await readFile(join(root, ".vite", "manifest.json"), "utf8"));
	const entry = Object.values(manifest).find((value) => value.isEntry);
	if (!entry || entry.src !== application.expectedEntry)
		throw new Error(`The ${application.name} manifest has an invalid entry point.`);
	if (!files.includes("index.html") || !files.includes(entry.file))
		throw new Error(`The ${application.name} build is incomplete.`);
	manifests.set(application.name, manifest);
}

const siteFiles = new Set(Object.values(manifests.get("site")).map((entry) => entry.file));
const administrationFiles = new Set(
	Object.values(manifests.get("administration")).map((entry) => entry.file),
);
const leakedScripts = [...administrationFiles].filter(
	(file) => file.endsWith(".js") && siteFiles.has(file),
);
if (leakedScripts.length)
	throw new Error(`The public bundle shares an administration script: ${leakedScripts.join(", ")}`);

const administrationDocument = await readFile(
	join(process.cwd(), "frontend", "administration", "dist", "index.html"),
	"utf8",
);
if (!administrationDocument.includes('src="/admin/assets/')) {
	throw new Error("The administration bundle is not built for the /admin route.");
}

console.log("Frontend bundles are separate, manifests are valid, and no source maps were emitted.");

async function recursiveFiles(root, relative = "") {
	const entries = await readdir(join(root, relative), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) files.push(...(await recursiveFiles(root, path)));
		else files.push(path.split(sep).join("/"));
	}
	return files;
}
