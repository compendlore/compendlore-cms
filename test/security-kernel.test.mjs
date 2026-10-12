import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import {
	FileSecurityAnalyzer,
	InMemorySecurityAudit,
	SecurityKernel,
	SecurityKernelError,
} from "../backend/build/security-kernel/src/index.js";

const context = {
	correlationId: "security-test-correlation",
	surface: "administration",
	subject: {
		id: "user-1",
		kind: "user",
		capabilities: new Set(["content.update"]),
		multiFactorVerifiedAt: new Date("2026-10-12T10:00:00.000Z"),
	},
	resource: { kind: "entity", identifier: "entity-1" },
};

test("produit une preuve bornée pour une entrée autorisée", async () => {
	const audit = new InMemorySecurityAudit();
	const kernel = new SecurityKernel(audit, 30_000, () => new Date("2026-10-12T10:00:10.000Z"));
	const decision = await kernel.secureInput({
		operation: "entity.update",
		value: { title: "Caerthia" },
		context,
		policy: {
			identifier: "core.entity.update",
			version: "1.0.0",
			allowAnonymous: false,
			requiredCapabilities: ["content.update"],
			multiFactorMaximumAgeMs: 60_000,
		},
	});
	assert.equal(decision.status, "allowed");
	assert.deepEqual(decision.secured.value, { title: "Caerthia" });
	assert.doesNotThrow(() =>
		kernel.assertEvidence(decision.secured.evidence, {
			operation: "entity.update",
			resource: context.resource,
		}),
	);
	assert.throws(
		() =>
			kernel.assertEvidence(decision.secured.evidence, {
				operation: "entity.delete",
				resource: context.resource,
			}),
		SecurityKernelError,
	);
	assert.equal(audit.records.at(-1).outcome, "allowed");
});

test("refuse une capacité absente et demande une élévation expirée", async () => {
	const kernel = new SecurityKernel(undefined, 30_000, () => new Date("2026-10-12T10:02:00.000Z"));
	const denied = await kernel.secureInput({
		operation: "entity.delete",
		value: {},
		context,
		policy: {
			identifier: "core.entity.delete",
			version: "1.0.0",
			allowAnonymous: false,
			requiredCapabilities: ["content.delete"],
		},
	});
	assert.equal(denied.status, "denied");
	assert.equal(denied.reasonCode, "security.capability_required");

	const stepUp = await kernel.secureInput({
		operation: "entity.update",
		value: {},
		context,
		policy: {
			identifier: "core.entity.update",
			version: "1.0.0",
			allowAnonymous: false,
			requiredCapabilities: ["content.update"],
			multiFactorMaximumAgeMs: 60_000,
		},
	});
	assert.equal(stepUp.status, "step-up-required");
});

test("protège les sorties selon une politique explicite", async () => {
	const kernel = new SecurityKernel();
	const secured = await kernel.secureOutput({
		operation: "account.read",
		value: {
			id: "user-1",
			email: "founder@example.test",
			secretReference: "env:SECRET",
			nested: { email: "other@example.test" },
		},
		context,
		policy: {
			identifier: "core.account.output",
			version: "1.0.0",
			omittedFields: ["secretReference"],
			maskedFields: ["email"],
		},
	});
	assert.deepEqual(secured.value, {
		id: "user-1",
		email: "fo••••••••••••",
		nested: { email: "ot••••••••••••" },
	});
});

test("analyse le format réel, les exécutables et les archives dangereuses", async () => {
	const clean = new FileSecurityAnalyzer([
		{
			identifier: "test.scanner",
			version: "1.0.0",
			async scan() {
				return "clean";
			},
		},
	]);
	const png = await clean.analyze({
		name: "portrait.png",
		claimedMediaType: "image/png",
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	});
	assert.equal(png.verdict, "clean");
	assert.equal(png.detectedMediaType, "image/png");

	const executable = await clean.analyze({
		name: "image.png",
		claimedMediaType: "image/png",
		bytes: new Uint8Array(Buffer.from("MZ executable", "ascii")),
	});
	assert.equal(executable.verdict, "rejected");
	assert.ok(executable.reasonCodes.includes("security.file.executable_forbidden"));

	const archive = await clean.analyze({
		name: "addon.zip",
		claimedMediaType: "application/zip",
		bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
		archiveEntries: [
			{
				path: "../../backend/secret.ts",
				kind: "file",
				compressedBytes: 1,
				uncompressedBytes: 1_000,
				depth: 2,
			},
		],
	});
	assert.equal(archive.verdict, "rejected");
	assert.ok(archive.reasonCodes.includes("security.archive.path_invalid"));
	assert.ok(archive.reasonCodes.includes("security.archive.expansion_ratio_exceeded"));
});

test("maintient le fichier en quarantaine si un scanner est indisponible", async () => {
	const analyzer = new FileSecurityAnalyzer([
		{
			identifier: "offline.scanner",
			version: "1.0.0",
			async scan() {
				return "unavailable";
			},
		},
	]);
	const result = await analyzer.analyze({
		name: "notes.txt",
		claimedMediaType: "text/plain",
		bytes: new TextEncoder().encode("safe text"),
	});
	assert.equal(result.verdict, "quarantined");
});

test("maintient le fichier en quarantaine si aucun scanner antimalware n’est configuré", async () => {
	const result = await new FileSecurityAnalyzer().analyze({
		name: "notes.txt",
		claimedMediaType: "text/plain",
		bytes: new TextEncoder().encode("safe text"),
	});
	assert.equal(result.verdict, "quarantined");
	assert.ok(result.reasonCodes.includes("security.file.scanner_unavailable"));
});
