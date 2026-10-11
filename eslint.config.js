import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"**/.encore/**",
			"**/encore.gen/**",
			"**/build/**",
			"**/dist/**",
			"**/artifacts/**",
			"**/node_modules/**",
		],
	},
	{
		files: ["**/*.{js,mjs}"],
		...js.configs.recommended,
		languageOptions: {
			globals: {
				Buffer: "readonly",
				console: "readonly",
				process: "readonly",
				Response: "readonly",
				setTimeout: "readonly",
				URL: "readonly",
			},
		},
		rules: {
			...js.configs.recommended.rules,
			"no-empty": ["error", { allowEmptyCatch: true }],
		},
	},
	...tseslint.configs.recommended.map((configuration) => ({
		...configuration,
		files: ["**/*.ts"],
	})),
);
