/**
 * Workers AI access for the AI Edit plugin.
 *
 * The plugin runs trusted, so it resolves the site's Cloudflare AI binding
 * directly. On a Node.js deployment there is no Workers AI binding and every
 * call throws AiBindingError, which callers turn into a user-facing message.
 */

export interface AiChatMessage {
	role: "system" | "assistant" | "user" | "tool";
	content: string | null;
	name?: string;
	tool_call_id?: string;
	/** Echoed back on assistant messages so the next round binds tool results. */
	tool_calls?: { type: "function"; id: string; function: { name: string; arguments: string } }[];
}

export interface AiToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface AiToolCall {
	/** The provider's call id; tool results must reference it. */
	id: string;
	name: string;
	arguments: unknown;
}

export interface AiChatResult {
	content: string | null;
	toolCalls: AiToolCall[];
}

export class AiBindingError extends Error {}

export interface AiOptions {
	/** Workers AI chat model. @default "@cf/zai-org/glm-5.3-flash" */
	model?: string;
	/** Speech-to-text model. @default "@cf/openai/whisper-large-v3-turbo" */
	speechModel?: string;
	/** AI binding name in wrangler.jsonc. @default "AI" */
	binding?: string;
}

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
const DEFAULT_SPEECH_MODEL = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_BINDING = "AI";

interface WorkerAiBinding {
	run(model: string, args: unknown): Promise<unknown>;
}

/** Resolve the `AI` binding via cloudflare:workers, or throw AiBindingError. */
export async function resolveAiBinding(options: AiOptions = {}): Promise<WorkerAiBinding> {
	const bindingName = options.binding ?? DEFAULT_BINDING;
	try {
		const workers = (await import("cloudflare:workers")) as unknown as {
			env?: Record<string, WorkerAiBinding | undefined>;
		};
		const ai = workers.env?.[bindingName];
		if (ai && typeof ai.run === "function") return ai;
		throw new AiBindingError(
			`No AI binding named "${bindingName}" found in the Cloudflare environment.`,
		);
	} catch (error) {
		if (error instanceof AiBindingError) throw error;
		throw new AiBindingError(
			"The AI Edit widget requires the Cloudflare Workers runtime (an AI binding is only available under workerd).",
		);
	}
}

interface NormalizedAiResponse {
	content: string | null;
	toolCalls: AiToolCall[];
}

/**
 * Workers AI chat models wrap responses differently depending on the model
 * family; normalize the shapes seen across them.
 */
function normalizeChatResponse(raw: unknown): NormalizedAiResponse {
	if (typeof raw === "string") return { content: raw, toolCalls: [] };
	if (!isRecord(raw)) return { content: null, toolCalls: [] };

	const choiceMessage = extractFirstChoiceMessage(raw);
	if (choiceMessage) return choiceMessage;

	// llama-style wrapper: { response: "text", tool_calls: [...] }
	if (typeof raw.response === "string") {
		return { content: raw.response, toolCalls: parseToolCalls(raw.tool_calls) };
	}
	if (isRecord(raw.response)) {
		const wrapped = extractFirstChoiceMessage(raw.response);
		if (wrapped) return wrapped;
		return {
			content: typeof raw.response.content === "string" ? raw.response.content : null,
			toolCalls: parseToolCalls(raw.response.tool_calls ?? raw.response.toolCalls),
		};
	}

	return {
		content: typeof raw.content === "string" ? raw.content : null,
		toolCalls: parseToolCalls(raw.tool_calls ?? raw.toolCalls),
	};
}

function extractFirstChoiceMessage(raw: Record<string, unknown>): NormalizedAiResponse | null {
	const choices = raw.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0];
	if (!isRecord(first)) return null;
	const message = isRecord(first.message)
		? first.message
		: isRecord(first.delta)
			? first.delta
			: null;
	if (!message) return { content: null, toolCalls: [] };
	return {
		content: typeof message.content === "string" ? message.content : null,
		toolCalls: parseToolCalls(message.tool_calls ?? message.toolCalls),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): AiToolCall[] {
	if (!Array.isArray(value)) return [];
	const calls: AiToolCall[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const fn = isRecord(entry.function) ? entry.function : null;
		const name =
			typeof fn?.name === "string" ? fn.name : typeof entry.name === "string" ? entry.name : null;
		if (!name) continue;
		const rawArgs = fn?.arguments ?? entry.arguments ?? entry.parameters ?? "{}";
		let args: unknown;
		try {
			args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
		} catch {
			args = {};
		}
		calls.push({
			id: typeof entry.id === "string" && entry.id ? entry.id : `${name}-${calls.length}`,
			name,
			arguments: args,
		});
	}
	return calls;
}

/** One non-streaming chat completion with tools. Tool calls, if any, stop the turn. */
export async function runChatTurn(
	options: AiOptions,
	messages: AiChatMessage[],
	tools: AiToolSpec[],
): Promise<AiChatResult> {
	const ai = await resolveAiBinding(options);
	const raw = await ai.run(options.model ?? DEFAULT_MODEL, {
		messages,
		tools: tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		})),
		tool_choice: "auto",
		// Reasoning models (gpt-oss, GLM) spend the budget on reasoning before
		// emitting content or tool calls; too small a cap yields empty replies.
		max_completion_tokens: 2048,
		stream: false,
	});
	return normalizeChatResponse(raw);
}

/** Transcribe speech audio with Workers AI Whisper. */
export async function transcribeAudio(options: AiOptions, audio: Uint8Array): Promise<string> {
	const ai = await resolveAiBinding(options);
	// Whisper's schema wants base64; a raw Uint8Array does not survive the
	// binding's JSON serialization.
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < audio.length; i += chunk) {
		binary += String.fromCharCode(...audio.subarray(i, i + chunk));
	}
	const raw = await ai.run(options.speechModel ?? DEFAULT_SPEECH_MODEL, {
		audio: btoa(binary),
	});
	const text = isRecord(raw) && typeof raw.text === "string" ? raw.text : "";
	if (!text.trim()) {
		throw new AiBindingError("Transcription returned no speech.");
	}
	return text;
}
