import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const backendDirectory = fileURLToPath(new URL("../backend/", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const frenchDiagnostic =
	/[À-ÿ]|\b(?:Le|La|Les|Un|Une|Ce|Cet|Cette|Ces|Seul|Seule|Il|Elle|Ils|Elles|Corps|Trop|Aucun|Aucune|doit|doivent|déjà|invalide|invalides|interdit|interdite|absent|absente|inconnu|inconnue|introuvable|indisponible|ressource|accès|facteur|Erreur|échec|refusé|refusée|obligatoire|obligatoires|manquant|manquante|peut|peuvent|modifier|contient|contiennent|utilise|exige|bloqué|bloquée|détecté|détectée)\b|\b(?:[LlDdNQ]|[Qq]u)'/u;
const diagnosticLabelFunctions = new Set([
	"assertValidDate",
	"assertKnownValue",
	"assertOptionalArray",
	"assertRequiredArray",
	"validateIdentifier",
	"validateNonNegativeLimit",
	"validatePositiveLimit",
	"validateUniqueIdentifiers",
	"validateUniqueValues",
]);
const failures = [];

for (const path of await collectTypeScriptFiles(backendDirectory)) {
	const sourceText = await readFile(path, "utf8");
	const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);

	function inspect(node, insideDiagnostic = false, insideErrorClass = false) {
		const inErrorClass = insideErrorClass || isErrorClass(node, source);
		const isErrorConstructor =
			ts.isNewExpression(node) && /Error$/.test(node.expression.getText(source));
		const isErrorSuperCall =
			inErrorClass &&
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.SuperKeyword;
		const inDiagnostic =
			insideDiagnostic || ts.isThrowStatement(node) || isErrorConstructor || isErrorSuperCall;
		if (inDiagnostic && ts.isStringLiteralLike(node) && frenchDiagnostic.test(node.text)) {
			report(node, "exception diagnostic");
		}
		if (ts.isCallExpression(node)) {
			const name = node.expression.getText(source);
			if (diagnosticLabelFunctions.has(name)) {
				for (const argument of node.arguments) {
					if (ts.isStringLiteralLike(argument) && frenchDiagnostic.test(argument.text)) {
						report(argument, "diagnostic label");
					}
				}
			}
		}
		ts.forEachChild(node, (child) => inspect(child, inDiagnostic, inErrorClass));
	}

	function report(node, kind) {
		const position = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(
			`${relative(repositoryDirectory, path)}:${position.line + 1}:${position.character + 1} contains a French ${kind}.`,
		);
	}

	inspect(source);
}

function isErrorClass(node, source) {
	if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return false;
	return Boolean(
		node.heritageClauses?.some((clause) =>
			clause.types.some((type) => /Error$/.test(type.expression.getText(source))),
		),
	);
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Backend exception diagnostics and diagnostic labels are English.");
}

async function collectTypeScriptFiles(directory) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await collectTypeScriptFiles(path)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			paths.push(path);
		}
	}
	return paths;
}
