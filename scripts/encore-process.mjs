import { join } from "node:path";

export function encoreExecutable(environment = process.env) {
	return (
		environment.ENCORE_BINARY ??
		(process.platform === "win32" && environment.USERPROFILE
			? join(environment.USERPROFILE, ".encore", "bin", "encore.exe")
			: "encore")
	);
}

export function waitForEncore(child) {
	let output = "";
	child.stdout?.on("data", (chunk) => {
		const text = chunk.toString();
		process.stdout.write(text);
		output = `${output}${text}`.slice(-65_536);
	});
	child.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		process.stderr.write(text);
		output = `${output}${text}`.slice(-65_536);
	});

	return new Promise((resolve) => {
		let settled = false;
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			console.error("Unable to start Encore.", error);
			resolve(1);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			if (signal || /^error:/imu.test(output)) {
				resolve(1);
				return;
			}
			resolve(code ?? 1);
		});
	});
}
