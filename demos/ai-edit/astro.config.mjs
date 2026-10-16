import node from "@astrojs/node";
import react from "@astrojs/react";
import { aiEditPlugin } from "@emdash-cms/plugin-ai-edit";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

// The AI Edit plugin needs a Cloudflare Workers runtime with an `AI` binding
// to reach Workers AI. Under this Node demo the widget and routes run, but
// chat/transcribe return an explanatory AI_BINDING_MISSING error until the
// same setup is deployed to Workers (see demos/cloudflare for a full example).
export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [aiEditPlugin()],
		}),
	],
});
