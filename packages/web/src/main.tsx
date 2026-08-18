/** Mount point. Everything interesting is in `App`. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./theme.css";
import "./app.css";
import "./detail.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
