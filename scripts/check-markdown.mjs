import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { lint } from "markdownlint/sync";

const ignored = new Set(["node_modules", "build", "dist", "artifacts", ".git"]);
const files = [];

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (ignored.has(entry.name)) continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) await walk(target);
		else if (entry.name.endsWith(".md")) files.push(target);
	}
}

await walk(process.cwd());
const config = JSON.parse(await readFile(".markdownlint.json", "utf8"));
const result = lint({ files, config });
const issues = Object.entries(result).flatMap(([file, errors]) =>
	errors.map(
		(error) =>
			`${file}:${error.lineNumber} ${error.ruleNames.join("/")} ${error.ruleDescription}${error.errorDetail ? ` [${error.errorDetail}` + "]" : ""}`,
	),
);
if (issues.length > 0) {
	console.error(issues.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Markdownlint : ${files.length} fichier(s), aucune erreur.`);
}
