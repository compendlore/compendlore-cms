import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/main.scss";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("Le point de montage de l'administration est introuvable.");

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
