import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationErrorBoundary } from "@compendlore/ui";
import { App } from "./App.js";
import "./styles/main.scss";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("Le point de montage du site est introuvable.");

createRoot(rootElement).render(
	<StrictMode>
		<ApplicationErrorBoundary>
			<App />
		</ApplicationErrorBoundary>
	</StrictMode>,
);
