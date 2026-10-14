import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationErrorBoundary, applyThemeProjection } from "@compendlore/ui";
import { App } from "./App.js";
import "./styles/main.scss";

const rootElement = document.querySelector("#root");
if (!(rootElement instanceof HTMLElement)) {
	throw new Error("The administration mount point was not found.");
}

const bootstrappedProjection = (
	globalThis as typeof globalThis & { __COMPENDLORE_THEME_PROJECTION__?: unknown }
).__COMPENDLORE_THEME_PROJECTION__;
applyThemeProjection(
	rootElement.ownerDocument.documentElement,
	"administration",
	bootstrappedProjection,
);

createRoot(rootElement).render(
	<StrictMode>
		<ApplicationErrorBoundary>
			<App />
		</ApplicationErrorBoundary>
	</StrictMode>,
);
