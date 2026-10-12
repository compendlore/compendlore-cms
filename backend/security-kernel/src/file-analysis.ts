import { createHash } from "node:crypto";

export type FileSecurityVerdict = "clean" | "quarantined" | "rejected";

export interface ArchiveEntryInspection {
	readonly path: string;
	readonly kind: "directory" | "file" | "symbolic-link";
	readonly compressedBytes: number;
	readonly uncompressedBytes: number;
	readonly depth: number;
}

export interface FileInspectionInput {
	readonly name: string;
	readonly claimedMediaType: string;
	readonly bytes: Uint8Array;
	readonly archiveEntries?: readonly ArchiveEntryInspection[];
}

export interface FileThreatScanner {
	readonly identifier: string;
	readonly version: string;
	scan(input: FileInspectionInput): Promise<"clean" | "malicious" | "unavailable">;
}

export interface FileInspectionResult {
	readonly verdict: FileSecurityVerdict;
	readonly reasonCodes: readonly string[];
	readonly detectedMediaType: string;
	readonly sha256: string;
	readonly byteSize: number;
	readonly scanners: readonly {
		readonly identifier: string;
		readonly version: string;
		readonly result: "clean" | "malicious" | "unavailable";
	}[];
}

export interface FileInspectionLimits {
	readonly maximumBytes: number;
	readonly maximumArchiveEntries: number;
	readonly maximumArchiveDepth: number;
	readonly maximumExpandedBytes: number;
	readonly maximumExpansionRatio: number;
}

const defaultLimits: FileInspectionLimits = {
	maximumBytes: 64 * 1024 * 1024,
	maximumArchiveEntries: 10_000,
	maximumArchiveDepth: 12,
	maximumExpandedBytes: 512 * 1024 * 1024,
	maximumExpansionRatio: 200,
};

export class FileSecurityAnalyzer {
	constructor(
		private readonly scanners: readonly FileThreatScanner[] = [],
		private readonly limits: FileInspectionLimits = defaultLimits,
	) {}

	async analyze(input: FileInspectionInput): Promise<FileInspectionResult> {
		const reasonCodes = inspectFileMetadata(input, this.limits);
		const detectedMediaType = detectMediaType(input.bytes);
		if (!compatibleMediaType(input.claimedMediaType, detectedMediaType)) {
			reasonCodes.push("security.file.media_type_mismatch");
		}
		if (executableSignature(input.bytes)) {
			reasonCodes.push("security.file.executable_forbidden");
		}
		const scanners: Array<FileInspectionResult["scanners"][number]> = [];
		for (const scanner of this.scanners) {
			let result: "clean" | "malicious" | "unavailable";
			try {
				result = await scanner.scan(input);
			} catch {
				result = "unavailable";
			}
			scanners.push({ identifier: scanner.identifier, version: scanner.version, result });
			if (result === "malicious") reasonCodes.push("security.file.malware_detected");
		}
		const scannerUnavailable =
			scanners.length === 0 || scanners.some((scanner) => scanner.result === "unavailable");
		const rejected = reasonCodes.length > 0;
		if (scanners.length === 0) reasonCodes.push("security.file.scanner_unavailable");
		return {
			verdict: rejected ? "rejected" : scannerUnavailable ? "quarantined" : "clean",
			reasonCodes: [...new Set(reasonCodes)],
			detectedMediaType,
			sha256: createHash("sha256").update(input.bytes).digest("hex"),
			byteSize: input.bytes.byteLength,
			scanners,
		};
	}
}

function inspectFileMetadata(input: FileInspectionInput, limits: FileInspectionLimits): string[] {
	const reasons: string[] = [];
	if (
		!input.name ||
		input.name !== input.name.trim() ||
		input.name.includes("/") ||
		input.name.includes("\\") ||
		input.name.includes("\0") ||
		input.name === "." ||
		input.name === ".." ||
		windowsReservedName(input.name)
	) {
		reasons.push("security.file.name_invalid");
	}
	if (input.bytes.byteLength === 0 || input.bytes.byteLength > limits.maximumBytes) {
		reasons.push("security.file.size_invalid");
	}
	const entries = input.archiveEntries ?? [];
	if (entries.length > limits.maximumArchiveEntries) {
		reasons.push("security.archive.too_many_entries");
	}
	let expandedBytes = 0;
	let compressedBytes = 0;
	for (const entry of entries) {
		expandedBytes += entry.uncompressedBytes;
		compressedBytes += entry.compressedBytes;
		if (
			entry.kind === "symbolic-link" ||
			entry.path.startsWith("/") ||
			/^[A-Za-z]:/.test(entry.path) ||
			entry.path.split(/[\\/]/).some((segment) => segment === "..")
		) {
			reasons.push("security.archive.path_invalid");
		}
		if (entry.depth > limits.maximumArchiveDepth) {
			reasons.push("security.archive.too_deep");
		}
	}
	if (expandedBytes > limits.maximumExpandedBytes) {
		reasons.push("security.archive.expanded_size_exceeded");
	}
	if (compressedBytes > 0 && expandedBytes / compressedBytes > limits.maximumExpansionRatio) {
		reasons.push("security.archive.expansion_ratio_exceeded");
	}
	return reasons;
}

function detectMediaType(bytes: Uint8Array): string {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWithText(bytes, "GIF87a") || startsWithText(bytes, "GIF89a")) return "image/gif";
	if (startsWithText(bytes, "%PDF-")) return "application/pdf";
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
	if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
	if (
		startsWithText(bytes, "RIFF") &&
		bytes.byteLength >= 12 &&
		new TextDecoder("ascii").decode(bytes.slice(8, 12)) === "WEBP"
	) {
		return "image/webp";
	}
	return isUtf8Text(bytes) ? "text/plain" : "application/octet-stream";
}

function executableSignature(bytes: Uint8Array): boolean {
	return (
		startsWithText(bytes, "MZ") ||
		startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
		startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
		startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
		startsWithText(bytes, "#!")
	);
}

function compatibleMediaType(claimed: string, detected: string): boolean {
	const normalized = claimed.split(";", 1)[0]!.trim().toLowerCase();
	if (normalized === detected) return true;
	if (detected === "text/plain") {
		return (
			normalized.startsWith("text/") || ["application/json", "application/xml"].includes(normalized)
		);
	}
	return detected === "application/octet-stream" && normalized === detected;
}

function windowsReservedName(name: string): boolean {
	const stem = name.split(".", 1)[0]!.toUpperCase();
	return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
	return expected.every((value, index) => bytes[index] === value);
}

function startsWithText(bytes: Uint8Array, expected: string): boolean {
	return startsWith(bytes, [...Buffer.from(expected, "ascii")]);
}

function isUtf8Text(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}
