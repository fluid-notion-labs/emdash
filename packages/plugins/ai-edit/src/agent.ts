/**
 * Bounded agent tool loop.
 *
 * The model may only read via the tools below; writes are limited to
 * `propose_edits`, which produces a structured proposal the widget turns
 * into an explicit, user-confirmed content write. The loop never touches
 * the database beyond reads.
 */

import type { CollectionSchemaInfo, FieldSchemaInfo, PluginContext } from "emdash";

import { runChatTurn, AiBindingError } from "./ai.js";
import type { AiChatMessage, AiOptions, AiToolSpec } from "./ai.js";

export interface AgentProposalEdit {
	field: string;
	old: unknown;
	value: unknown;
}

export interface AgentProposal {
	collection: string;
	id: string;
	slug: string | null;
	title: string | null;
	status: string | null;
	/** url path for the widget to link the user's entry editor */
	edits: AgentProposalEdit[];
	note: string | null;
	suggestPublish: boolean;
	/** Entry author, so the widget can show publish actions per publish_own. */
	authorId: string | null;
}

export interface AgentTarget {
	/** resource the user is looking at, when known */
	collection: string | null;
	id: string | null;
	slug: string | null;
}

export interface AgentTurnRequest {
	messages: AiChatMessage[];
	target: AgentTarget;
	currentPath: string[];
	locale: string | null;
}

export interface AgentTurnResult {
	reply: string | null;
	proposal: AgentProposal | null;
	toolTrace: { name: string; ok: boolean }[];
	error?: { code: string; message: string };
}

const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RUNTIME_MS = 30_000;
const LIST_LIMIT = 20;

const FIELD_SLUG_RE = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

interface ToolContext {
	content?: PluginContext["content"];
	schema?: PluginContext["schema"];
}

// ── Tool executors ───────────────────────────────────────────────

type ToolExecutor = (args: unknown, toolsCtx: ToolContext) => Promise<unknown>;

async function summarizeSchema(schema: NonNullable<ToolContext["schema"]>, slug: string) {
	const info = await schema.getCollection(slug);
	if (!info) throw new Error(`Collection '${slug}' not found`);
	return compactSchema(info);
}

function compactSchema(info: CollectionSchemaInfo) {
	return {
		collection: info.slug,
		label: info.label,
		singularLabel: info.labelSingular,
		description: info.description,
		titleField: info.titleField,
		dateField: info.dateField,
		urlPattern: info.urlPattern,
		fields: info.fields.map((f) => compactField(f)),
	};
}

function compactField(f: FieldSchemaInfo) {
	const out: Record<string, unknown> = {
		field: f.slug,
		type: f.type,
		label: f.label,
		required: f.required,
	};
	if (f.options?.options) out.choiceOptions = f.options.options;
	return out;
}

const TOOL_DEFINITIONS: Record<string, { spec: AiToolSpec; execute: ToolExecutor }> = {
	list_collections: {
		spec: {
			name: "list_collections",
			description: "List the site's content collections with their labels and URL patterns.",
			parameters: { type: "object", properties: {} },
		},
		execute: async (_args, ctx) => {
			const schema = ctx.schema;
			if (!schema) throw new Error("schema:read capability missing");
			const collections = await schema.listCollections();
			return collections.map((c) => ({
				collection: c.slug,
				label: c.label,
				singularLabel: c.labelSingular,
				urlPattern: c.urlPattern,
				routable: c.routable,
			}));
		},
	},

	get_collection_schema: {
		spec: {
			name: "get_collection_schema",
			description:
				"Get one collection's fields (slug, type, label, required, options) with validation rules.",
			parameters: {
				type: "object",
				properties: { collection: { type: "string", description: "Collection slug" } },
				required: ["collection"],
			},
		},
		execute: async (args, ctx) => {
			const collection = str(isRecord(args) ? args.collection : null);
			if (!collection) throw new Error("collection is required");
			if (!ctx.schema) throw new Error("schema:read capability missing");
			return await summarizeSchema(ctx.schema, collection);
		},
	},

	get_entry_data: {
		spec: {
			name: "get_entry_data",
			description: "Read one content entry: every field's current value plus its status.",
			parameters: {
				type: "object",
				properties: {
					collection: { type: "string", description: "Collection slug" },
					id: {
						type: "string",
						description: "Entry id (or slug if the id is unknown)",
					},
				},
				required: ["collection", "id"],
			},
		},
		execute: async (args, ctx) => {
			const collection = str(isRecord(args) ? args.collection : null);
			const id = str(isRecord(args) ? args.id : null);
			if (!collection || !id) throw new Error("collection and id are required");
			const content = ctx.content;
			if (!content) throw new Error("content:read capability missing");
			const item =
				(await content.get(collection, id)) ?? (await findBySlug(content, collection, id));
			if (!item) throw new Error(`Entry '${collection}/${id}' not found`);
			return { collection, id: item.id, slug: item.slug, status: item.status, data: item.data };
		},
	},

	search_entries: {
		spec: {
			name: "search_entries",
			description:
				"List recent entries in one collection, newest first; filter by status (published, draft, scheduled) and optionally by slug fragment.",
			parameters: {
				type: "object",
				properties: {
					collection: { type: "string" },
					status: { type: "string", description: 'default "published"' },
					slugFragment: { type: "string", description: "Match part of the entry slug" },
				},
				required: ["collection"],
			},
		},
		execute: async (args, ctx) => {
			const collection = str(isRecord(args) ? args.collection : null);
			if (!collection) throw new Error("collection is required");
			const arg = isRecord(args) ? args : {};
			const status = str(arg.status) ?? "published";
			const fragment = str(arg.slugFragment)?.toLowerCase() ?? null;
			const content = ctx.content;
			if (!content) throw new Error("content:read capability missing");
			const { items } = await content.list(collection, {
				limit: LIST_LIMIT * 2,
				where: { status },
			});
			const filtered = fragment
				? items.filter((i) => i.slug?.toLowerCase().includes(fragment))
				: items;
			return filtered.slice(0, LIST_LIMIT).map((i) => ({
				id: i.id,
				slug: i.slug,
				title: pickTitle(i),
				status: i.status,
				updatedAt: i.updatedAt,
			}));
		},
	},

	propose_edits: {
		spec: {
			name: "propose_edits",
			description:
				"Propose field edits for ONE entry using the collection's real field slugs. The user reviews and confirms before anything is written.",
			parameters: {
				type: "object",
				properties: {
					collection: { type: "string" },
					id: { type: "string" },
					edits: {
						type: "array",
						description: "Field-level edits to apply",
						items: {
							type: "object",
							properties: {
								field: { type: "string" },
								value: { description: "New field value" },
							},
							required: ["field", "value"],
						},
					},
					note: { type: "string", description: "One-line reason shown to the user" },
					publish: { type: "boolean", description: "Suggest applying AND publishing" },
				},
				required: ["collection", "id", "edits"],
			},
		},
		execute: async (args, ctx) => {
			const arg = isRecord(args) ? args : {};
			const collection = str(arg.collection);
			const id = str(arg.id);
			const edits = Array.isArray(arg.edits) ? arg.edits : null;
			if (!collection || !id || !edits || edits.length === 0) {
				throw new Error("collection, id and at least one edit are required");
			}
			if (!ctx.content || !ctx.schema) throw new Error("Missing access");
			const schemaInfo = await summarizeSchema(ctx.schema, collection);
			const validFields = new Set(schemaInfo.fields.map((f) => String(f.field)));
			const rejected = edits
				.map((e) => (isRecord(e) ? e.field : null))
				.filter((f): f is string => !!f)
				.filter((f) => !FIELD_SLUG_RE.test(f) || !validFields.has(f));
			if (rejected.length > 0) {
				throw new Error(`Unknown field(s) for '${collection}': ${rejected.join(", ")}`);
			}
			const item = await ctx.content.get(collection, id);
			if (!item) throw new Error(`Entry '${collection}/${id}' not found`);
			return {
				ok: true,
				entry: {
					collection,
					id: item.id,
					slug: item.slug,
					title: pickTitle(item),
					status: item.status,
					authorId: item.authorId ?? null,
				},
				currentData: item.data,
			};
		},
	},
};

function pickTitle(item: { data: Record<string, unknown>; slug: string | null }): string | null {
	const data = isRecord(item.data) ? item.data : {};
	for (const key of ["title", "name", "heading"]) {
		if (typeof data[key] === "string") return data[key];
	}
	return item.slug;
}

/** Fast models pass the slug as id; resolve it with a bounded list-and-match. */
async function findBySlug(
	content: NonNullable<ToolContext["content"]>,
	collection: string,
	slug: string,
) {
	const { items } = await content.list(collection, { limit: 100 });
	return items.find((i) => i.slug === slug) ?? items.find((i) => i.id === slug) ?? null;
}

const TOOL_SPECS: AiToolSpec[] = Object.values(TOOL_DEFINITIONS).map((t) => t.spec);

// ── System prompt ────────────────────────────────────────────────

function buildSystemPrompt(target: AgentTarget, path: string[], locale: string | null): string {
	const lines = [
		"You are the in-site editing agent of an EmDash CMS. The user is viewing their own site and wants content changes.",
		"The user's current page belongs to:",
		`- URL path: ${path.join(" ") || "/"}`,
		`- collection: ${target.collection ?? "unknown"}`,
		`- entry id: ${target.id ?? "unknown"}${target.slug ? ` (slug: ${target.slug})` : ""}`,
		locale ? `- content locale: ${locale}` : "",
		"",
		"Rules:",
		"1. Default the target entry to the entry on the user's current page. Only switch when the user explicitly gives another page, slug or id.",
		"2. Read before proposing: call get_entry_data on the target before editing it.",
		"3. Use get_collection_schema to learn real field slugs, types and validation before propose_edits.",
		"4. Make focused, plural edits in one call when the user asks for several changes.",
		"5. Only change content the user asked for — never embellish or invent facts.",
		"6. Set publish: false when unsure; the user decides whether to also publish.",
		"7. Never mention internal tool names in your reply; speak as a helpful editor.",
		"8. Your reply must end with a short natural-language sentence about what the edit request achieves.",
	];
	return lines.filter(Boolean).join("\n");
}

/** Compact snapshot of the page's entry injected as context (if any). */
function targetSnapshot(target: AgentTarget) {
	if (!target.collection || !target.id) return null;
	return { collection: target.collection, id: target.id, slug: target.slug };
}

// ── The loop ─────────────────────────────────────────────────────

export async function runAgentTurn(
	options: AiOptions,
	toolsCtx: ToolContext,
	turn: AgentTurnRequest,
): Promise<AgentTurnResult> {
	const toolTrace: AgentTurnResult["toolTrace"] = [];
	const proposal: AgentProposal | null = null;
	const messages: AiChatMessage[] = [
		{ role: "system", content: buildSystemPrompt(turn.target, turn.currentPath, turn.locale) },
		...turn.messages,
	];
	const deadline = Date.now() + MAX_TOOL_RUNTIME_MS;

	try {
		let proposalResult: AgentProposal | null = null;

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			if (Date.now() > deadline) {
				return {
					reply: null,
					proposal: null,
					toolTrace,
					error: { code: "AGENT_TIMEOUT", message: "The agent turn took too long." },
				};
			}
			const result = await runChatTurn(
				options,
				messages,
				TOOL_SPECS,
				toolTrace.some((t) => t.ok) ? {} : { forceToolChoice: true },
			);

			if (result.toolCalls.length === 0) {
				return {
					reply: result.content?.trim() || "I could not understand that request.",
					proposal: null,
					toolTrace,
				};
			}

			// Execute tools; feed results back to the model. The provider
			// requires the assistant message to echo its own tool_calls array
			// (with the original call ids) for tool results to be accepted.
			messages.push({
				role: "assistant",
				content: result.content ?? "",
				tool_calls: result.toolCalls.map((call) => ({
					type: "function" as const,
					id: call.id,
					function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
				})),
			});

			let sawProposal = false;
			for (const call of result.toolCalls) {
				const def = TOOL_DEFINITIONS[call.name];
				let payload: unknown;
				try {
					if (!def) throw new Error(`Unknown tool: ${call.name}`);
					payload = await def.execute(call.arguments, toolsCtx);
					toolTrace.push({ name: call.name, ok: true });
				} catch (error) {
					payload = {
						error: error instanceof Error ? error.message : String(error),
					};
					toolTrace.push({ name: call.name, ok: false });
				}

				if (call.name === "propose_edits") {
					const p = isRecord(payload) ? payload : {};
					if (p.ok === true && isRecord(p.entry)) {
						const args = isRecord(call.arguments) ? call.arguments : {};
						const editsInput = Array.isArray(args.edits) ? args.edits : [];
						const currentData = isRecord(p.currentData) ? p.currentData : {};
						const cleanEdits: AgentProposalEdit[] = [];
						for (const edit of editsInput) {
							if (!isRecord(edit) || typeof edit.field !== "string") continue;
							if (!FIELD_SLUG_RE.test(edit.field)) continue;
							if (!validFieldGuard(toolsCtx, p.entry.collection)) continue;
							cleanEdits.push({
								field: edit.field,
								old: edit.field in currentData ? currentData[edit.field] : undefined,
								value: edit.value ?? null,
							});
						}
						proposalResult = {
							collection: typeof p.entry.collection === "string" ? p.entry.collection : "",
							id: typeof p.entry.id === "string" ? p.entry.id : "",
							slug: pickString(p.entry.slug),
							title: pickString(p.entry.title),
							status: pickString(p.entry.status),
							edits: cleanEdits,
							note: pickString(args.note),
							suggestPublish: args.publish === true,
							authorId: pickString(p.entry.authorId),
						};
						sawProposal = true;
					} else {
						toolTrace.push({ name: `${call.name}:reject`, ok: false });
					}
				}

				messages.push({
					role: "tool",
					content: JSON.stringify(payload),
					tool_call_id: call.id,
				});
			}

			// A proposal always ends the turn: writes stop here and the user reviews.
			if (sawProposal && proposalResult) {
				return finalizeWithProposal(proposalResult, toolTrace);
			}
		}

		return {
			reply: null,
			proposal: null,
			toolTrace,
			error: {
				code: "AGENT_NO_REPLY",
				message: "No final response produced.",
			},
		};
	} catch (error) {
		return {
			reply: null,
			proposal,
			toolTrace,
			error: {
				code: error instanceof AiBindingError ? "AI_BINDING_MISSING" : "AGENT_ERROR",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function finalizeWithProposal(
	proposal: AgentProposal,
	toolTrace: AgentTurnResult["toolTrace"],
): AgentTurnResult {
	return {
		reply: formatProposalReply(proposal),
		proposal,
		toolTrace,
	};
}

function formatProposalReply(proposal: AgentProposal): string {
	const fields = proposal.edits.map((e) => e.field).join(", ");
	const target = proposal.title != null ? `“${proposal.title}”` : (proposal.slug ?? proposal.id);
	const publishing = proposal.suggestPublish ? " and publish" : "";
	return `I drafted changes for ${target}: ${fields}. Review them and choose whether to save${publishing}.`;
}

function pickString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Belt-and-braces field check at proposal assembly time. */
function validFieldGuard(toolsCtx: ToolContext, collection: unknown): boolean {
	if (typeof collection !== "string") return false;
	if (!toolsCtx.schema) return false;
	return true;
}

export function targetSnapshotForMessages(target: AgentTarget) {
	return targetSnapshot(target);
}
