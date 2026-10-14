import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationErrorBoundary, applyThemeProjection } from "@compendlore/ui";
import { App } from "./App.js";
import "./styles/main.scss";

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) throw new Error("The site mount point was not found.");

const bootstrappedProjection = (
	globalThis as typeof globalThis & { __COMPENDLORE_THEME_PROJECTION__?: unknown }
).__COMPENDLORE_THEME_PROJECTION__;
const developmentProjection =
	import.meta.env.DEV && new URLSearchParams(window.location.search).has("theme-projection")
		? {
				schemaVersion: 1,
				surface: "site",
				designSystemVersion: "1.0.0",
				revision: "development.projection",
				variables: {
					"--bg": "#10151d",
					"--panel": "#17202b",
					"--text": "#f1eadc",
					"--gold": "#76c7b7",
					"--line": "#39675f",
					"--page-inline-spacing": "48px",
				},
				media: [
					{
						condition: { maxWidth: { value: 40, unit: "em" } },
						variables: { "--page-inline-spacing": "1em" },
					},
				],
			}
		: undefined;
applyThemeProjection(
	rootElement.ownerDocument.documentElement,
	"site",
	developmentProjection ?? bootstrappedProjection,
);

createRoot(rootElement).render(
	<StrictMode>
		<ApplicationErrorBoundary>
			<App />
		</ApplicationErrorBoundary>
	</StrictMode>,
);
