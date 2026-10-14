import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { lint } from "markdownlint/sync";

const ignored = new Set(["node_modules", "build", "dist", "artifacts", ".git"]);
const files = [];
const policyIssues = [];

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (ignored.has(entry.name)) continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) await walk(target);
		else if (entry.name.endsWith(".md")) files.push(target);
	}
}

await walk(process.cwd());

if (
	(await readdir(process.cwd(), { withFileTypes: true })).some(
		(entry) => entry.isDirectory() && entry.name === "docs",
	)
) {
	policyIssues.push(
		"docs: repository documentation must be stored in the workspace documentation tree",
	);
}

for (const file of files) {
	const content = await readFile(file, "utf8");
	const relativeFile = path.relative(process.cwd(), file);
	if (path.basename(file) === "CHANGELOG.md") {
		if (!content.includes("## [Unreleased]")) {
			policyIssues.push(
				`${relativeFile}: the changelog must contain an English-only [Unreleased] section`,
			);
		}
		if (/^## Français\s*$/mu.test(content)) {
			policyIssues.push(`${relativeFile}: changelogs must be written in English only`);
		}
		continue;
	}

	const englishIndex = content.indexOf("## English");
	const frenchIndex = content.indexOf("## Français");
	if (englishIndex < 0 || frenchIndex < 0 || englishIndex > frenchIndex) {
		policyIssues.push(
			`${relativeFile}: repository Markdown must contain English first, then French`,
		);
	}
}

const config = JSON.parse(await readFile(".markdownlint.json", "utf8"));
const result = lint({ files, config });
const issues = Object.entries(result).flatMap(([file, errors]) =>
	errors.map(
		(error) =>
			`${file}:${error.lineNumber} ${error.ruleNames.join("/")} ${error.ruleDescription}${error.errorDetail ? ` [${error.errorDetail}` + "]" : ""}`,
	),
);
const allIssues = [...policyIssues, ...issues];
if (allIssues.length > 0) {
	console.error(allIssues.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`Markdownlint: ${files.length} file(s), no errors.`);
}
