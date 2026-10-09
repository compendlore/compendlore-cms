import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["**/build/**", "**/dist/**", "**/artifacts/**", "**/node_modules/**"],
	},
	{
		files: ["**/*.{js,mjs}"],
		...js.configs.recommended,
		languageOptions: {
			globals: {
				console: "readonly",
				process: "readonly",
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
