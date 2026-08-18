/**
 * The site's build.
 *
 * Output goes to `dist/`, which `wrangler.jsonc` serves as the Worker's static assets — the site
 * and the API are one deployment, so there is no separate host and no CORS between them.
 *
 * In development the site runs on Vite and the API does not: `/v1` is proxied to `wrangler dev` on
 * 8787. That keeps hot reload working on the front end without giving up the real Worker, the real
 * D1 and the real R2 behind it.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// Small enough to inline nothing; a data URL in a stylesheet is harder to cache than a file.
		assetsInlineLimit: 0,
	},
	server: {
		port: 5173,
		proxy: {
			"/v1": { target: "http://localhost:8787", changeOrigin: true },
			"/auth": { target: "http://localhost:8787", changeOrigin: true },
		},
	},
});
