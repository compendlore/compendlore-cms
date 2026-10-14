import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./test/browser",
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: "line",
	outputDir: ".local/playwright-results",
	snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
	use: {
		baseURL: "http://127.0.0.1:5173",
		colorScheme: "dark",
		locale: "fr-FR",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command: "npm run dev --workspace @compendlore/site -- --host 127.0.0.1",
		url: "http://127.0.0.1:5173",
		reuseExistingServer: false,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	},
});
