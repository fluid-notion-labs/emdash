/**
 * AI Edit plugin — an in-site editing agent.
 *
 * Trusted (native) plugin: injects a small client widget onto public pages
 * through the page:fragments hook and exposes two HTTP routes under
 * /_emdash/api/plugins/ai-edit/ for chat and speech transcription. Content
 * writes happen through the stock content API from the widget after an
 * explicit Apply click; the agent itself only produces proposals.
 */

import { definePlugin, PluginRouteError, resolveEmDashPath } from "emdash";
import type { PluginDescriptor, ResolvedPlugin } from "emdash";

import { runAgentTurn } from "./agent.js";
import type { AgentTarget, AgentTurnRequest } from "./agent.js";
import { transcribeAudio, AiBindingError } from "./ai.js";
import type { AiChatMessage, AiOptions } from "./ai.js";
import { widgetScript } from "./widget.js";

export interface AiEditPluginOptions extends AiOptions {
	/** Disable the public-page widget injection (routes stay available). */
	widget?: boolean;
	/** Minimum role for the widget (higher not supported; default author 30). */
	editorRole?: number;
}

/** Validate and coerce the agent target from the request path. */
function coerceTarget(value: unknown): AgentTarget {
	if (!isRecord(value)) return { collection: null, id: null, slug: null };
	return {
		collection: safeString(value.collection),
		id: safeString(value.id),
		slug: safeString(value.slug),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string | null {
	return typeof value === "string" && value.length <= 256 ? value : null;
}

/** Map the widget's messages into chat roles; accepts strings or {role, content}. */
function coerceMessages(value: unknown): AiChatMessage[] {
	if (!Array.isArray(value)) return [];
	const messages: AiChatMessage[] = [];
	for (const entry of value) {
		if (isRecord(entry)) {
			const role = entry.role;
			const content = typeof entry.content === "string" ? entry.content : null;
			if (content && (role === "user" || role === "assistant")) {
				messages.push({ role, content });
			}
		} else if (typeof entry === "string") {
			messages.push({ role: "user", content: entry });
		}
	}
	return messages.slice(-20);
}

function safePath(value: unknown): string {
	if (typeof value !== "string" || value.length > 512) return "/";
	return value.startsWith("/") ? value : `/${value}`;
}

function createPlugin(options: AiEditPluginOptions = {}): ResolvedPlugin {
	return definePlugin({
		id: "ai-edit",
		version: "0.0.1",
		// Chat needs schema discovery; transcription is capability-free but the
		// route permission still gates it at the HTTP layer. widgets inject into
		// public pages, so page-fragments registration is declared too.
		capabilities: ["content:read", "content:write", "schema:read", "hooks.page-fragments:register"],
		allowedHosts: [],
		admin: {
			entry: "@emdash-cms/plugin-ai-edit/widget",
			pages: [{ path: "/about", label: "AI Edit", icon: "sparkles" }],
		},

		hooks: {
			"page:fragments": async (event, ctx) => {
				if (options.widget === false) return null;
				// Admin panel frames have their own chrome; skip everything under
				// /_emdash so the widget never mounts inside itself.
				if (event.page.path.startsWith("/_emdash")) return null;
				try {
					const code = widgetScript({
						modelNote: options.model ?? "@cf/zai-org/glm-5.3-flash",
					});
					ctx.log.info(
						`[ai-edit] injecting widget for ${event.page.path} (content: ${event.page.content ? `${event.page.content.collection}/${event.page.content.id}` : "none"})`,
					);
					return {
						kind: "inline-script",
						key: "ai-edit-widget",
						placement: "body:end",
						code,
					};
				} catch (error) {
					ctx.log.error("[ai-edit] failed to build widget script", error);
					return null;
				}
			},
		},

		routes: {
			// One chat turn: resolve target from urlPath, run the bounded
			// tool loop, return reply + optional proposal.
			chat: {
				permission: "content:edit_own",
				methods: ["POST"],
				handler: async (routeCtx) => {
					const input = isRecord(routeCtx.input) ? routeCtx.input : {};
					let target = coerceTarget(input.target);
					const urlPath = safePath(input.urlPath);
					// Default target: the entry rendered on the page the user is on.
					if (!target.id && urlPath !== "/") {
						try {
							const resolved = await resolveEmDashPath(urlPath);
							if (resolved) {
								target = {
									collection: resolved.collection,
									id: resolved.entry.id,
									slug: resolved.params.slug ?? null,
								};
							}
						} catch (error) {
							routeCtx.log.error("[ai-edit] url-path resolution failed", error);
						}
					}
					const turn: AgentTurnRequest = {
						messages: coerceMessages(input.messages),
						target,
						currentPath: [urlPath],
						locale: safeString(input.locale),
					};
					const result = await runAgentTurn(
						{ model: options.model, binding: options.binding, speechModel: options.speechModel },
						{ content: routeCtx.content, schema: routeCtx.schema },
						turn,
					);
					if (result.error) {
						routeCtx.log.error(`[ai-edit] chat turn failed: ${result.error.code}`);
						throw new PluginRouteError(result.error.code, result.error.message, 400);
					}
					return {
						reply: result.reply,
						proposal: result.proposal,
						toolTrace: result.toolTrace,
					};
				},
			},

			// Speech → text with Whisper. Raw audio bytes in body.
			transcribe: {
				permission: "content:edit_own",
				methods: ["POST"],
				request: {
					body: "bytes",
					maxBytes: 1_200_000,
					headers: ["content-type"],
				},
				handler: async (routeCtx) => {
					if (!(routeCtx.input instanceof Uint8Array) || routeCtx.input.length === 0) {
						return { success: false, error: { code: "EMPTY_AUDIO", message: "No audio provided" } };
					}
					try {
						const text = await transcribeAudio(options, routeCtx.input as Uint8Array);
						return { text };
					} catch (error) {
						routeCtx.log.error("[ai-edit] transcription failed", error);
						throw new PluginRouteError(
							error instanceof AiBindingError ? "AI_BINDING_MISSING" : "TRANSCRIBE_ERROR",
							error instanceof Error ? error.message : String(error),
							400,
						);
					}
				},
			},
		},
	});
}

export { createPlugin };
export default createPlugin;

/**
 * Descriptor factory for the Astro integration's `plugins: [...]` list.
 * The actual plugin runs in-process (trusted) from the sibling `/plugin`
 * entrypoint.
 */
export function aiEditPlugin(
	options: AiEditPluginOptions = {},
): PluginDescriptor<AiEditPluginOptions> {
	return {
		id: "ai-edit",
		version: "0.0.1",
		entrypoint: "@emdash-cms/plugin-ai-edit/plugin",
		options,
		adminEntry: "@emdash-cms/plugin-ai-edit/widget",
	};
}

// P0 note: writes use the stock content API (`PUT /_emdash/api/content/...`),
// so the scoped `apply` plugin route is not needed yet; revalidate there first
// if/when a server-side apply route is introduced.
