/**
 * Client widget script for the AI Edit plugin.
 *
 * Injected as an inline page fragment by the trusted plugin. The script is
 * identical for every visitor (auth is checked client-side against
 * /_emdash/api/auth/me) and only renders anything for author-or-higher
 * users, so the anonymous hot path stays untouched.
 */

const AUTH_THRESHOLD = 30; // Author

const CSRF_HEADER = { "X-EmDash-Request": "1", "Content-Type": "application/json" };

const MAX_RECORD_MS = 30_000;

async function fetchJson(url, init) {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({}));
	return { status: response.status, ...body };
}

let user = null;
let panel = null;
let messagesEl = null;
let inputEl = null;
let targetEl = null; // optional explicit target, wired into chat requests below
let recorder = null;
let recordTimer;
let proposal = null;

const history = [];

async function boot() {
	const me = await fetchJson("/_emdash/api/auth/me");
	if (me.success !== true || me.status !== 200) return;
	const data = me.data;
	if (
		!data ||
		typeof data !== "object" ||
		typeof data.role !== "number" ||
		data.role < AUTH_THRESHOLD
	)
		return;
	user = data;
	buildUi();
}

function buildUi() {
	const style = document.createElement("style");
	style.textContent = `
#emdash-ai-edit{position:fixed;bottom:1rem;right:1rem;z-index:2147483000;font:14px/1.45 system-ui,sans-serif;color:#111}
#emdash-ai-edit *{box-sizing:border-box}
.emdash-ai-pill{display:flex;align-items:center;gap:.35rem;padding:.5rem .75rem;border-radius:999px;background:#1b1e26;color:#fff;border:0;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.emdash-ai-panel{display:none;flex-direction:column;width:min(24rem,calc(100vw - 2rem));max-height:min(32rem,calc(100vh - 4rem));background:#fff;border-radius:.75rem;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden}
.emdash-ai-open .emdash-ai-panel{display:flex}
.emdash-ai-head{display:flex;align-items:center;justify-content:space-between;padding:.6rem .75rem;background:#1b1e26;color:#fff}
.emdash-ai-head strong{font-size:.9rem}
.emdash-ai-head button{background:none;border:0;color:#fff;cursor:pointer;font-size:1rem}
.emdash-ai-body{display:flex;flex-direction:column;gap:.5rem;padding:.75rem;overflow-y:auto}
.emdash-ai-msg{padding:.4rem .6rem;border-radius:.5rem;white-space:pre-wrap}
.emdash-ai-msg.assistant{background:#f1f3f7}
.emdash-ai-msg.user{background:#dbe7ff;align-self:flex-end}
.emdash-ai-msg.error{background:#ffe1e1}
.emdash-ai-msg.emdash-ai-link{background:none;text-decoration:underline;color:#2f5ded;cursor:pointer}
.emdash-ai-diff{border:1px solid #d8dee9;border-radius:.5rem;padding:.5rem .6rem;font-size:.85rem}
.emdash-ai-diff-row{display:flex;gap:.4rem;margin:.25rem 0}
.emdash-ai-diff .old{color:#a33;text-decoration:line-through;max-width:12rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.emdash-ai-diff .new{color:#180;max-width:12rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.emdash-ai-diff .field{font-weight:600;flex-shrink:0}
.emdash-ai-actions{display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap}
.emdash-ai-actions button{padding:.3rem .6rem;border-radius:.4rem;border:1px solid #c6cdd8;background:#fff;cursor:pointer}
.emdash-ai-actions .primary{background:#2f5ded;border-color:#2f5ded;color:#fff}
.emdash-ai-dock{display:flex;gap:.4rem;padding:.6rem .75rem;border-top:1px solid #e5e8ee;align-items:flex-end}
.emdash-ai-input{flex:1;resize:none;height:2.6rem;max-height:6rem;padding:.5rem .6rem;border:1px solid #c6cdd8;border-radius:.5rem;font:inherit}
.emdash-ai-mic{width:2.4rem;height:2.4rem;border-radius:50%;border:1px solid #c6cdd8;background:#fff;cursor:pointer;font-size:1rem}
.emdash-ai-mic[disabled]{opacity:.35;cursor:not-allowed}
.emdash-ai-mic.recording{background:#d33;border-color:#d33;color:#fff;animation:emdash-ai-pulse 1s infinite}
#emdash-ai-edit .emdash-ai-target{padding:0 .75rem .6rem;color:#667;font-size:.8rem}
.emdash-ai-target input{width:100%;margin-top:.2rem;padding:.3rem .5rem;border:1px solid #d5dae3;border-radius:.4rem;font-size:.8rem}
@keyframes emdash-ai-pulse{50%{opacity:.6}}
`;
	document.head.appendChild(style);

	const widget = document.createElement("div");
	widget.id = "emdash-ai-edit";
	widget.className = "";

	const pill = document.createElement("button");
	pill.className = "emdash-ai-pill";
	pill.textContent = "AI edit";
	pill.addEventListener("click", togglePanel);

	panel = document.createElement("div");
	panel.className = "emdash-ai-panel";
	panel.innerHTML = `
<div class="emdash-ai-head"><strong>AI edit — “this page”</strong><button type="button" data-act="close">✕</button></div>
<div class="emdash-ai-body" data-ref="messages"></div>
<div class="emdash-ai-target"><label>Also works with: paste a URL, slug or entry id<input type="text" data-ref="target" placeholder="optional"/></label></div>
<div class="emdash-ai-dock">
  <button class="emdash-ai-mic" data-act="mic" title="Record up to 30 s">🎤</button>
  <textarea class="emdash-ai-input" data-ref="input" placeholder="Describe the edit…"></textarea>
  <button class="emdash-ai-pill" data-act="send" style="border-radius:.5rem">Send</button>
</div>`;

	widget.appendChild(pill);
	widget.appendChild(panel);
	document.body.appendChild(widget);

	panel.querySelector('[data-act="close"]')?.addEventListener("click", togglePanel);
	panel.querySelector('[data-act="mic"]')?.addEventListener("click", toggleRecord);
	panel.querySelector('[data-act="send"]')?.addEventListener("click", send);
	inputEl = panel.querySelector('[data-ref="input"]');
	messagesEl = panel.querySelector('[data-ref="messages"]');
	targetEl = panel.querySelector('[data-ref="target"]');
}

function togglePanel() {
	panel?.parentElement?.classList.toggle("emdash-ai-open");
	if (inputEl && panel?.parentElement?.classList.contains("emdash-ai-open")) inputEl.focus();
}

function appendMsg(text, cls) {
	const el = document.createElement("div");
	el.className = "emdash-ai-msg " + cls;
	el.textContent = text;
	messagesEl?.appendChild(el);
	messagesEl?.scrollTo(0, messagesEl.scrollHeight);
	return el;
}

async function toggleRecord() {
	if (recorder) return stopRecording();
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const media = new MediaRecorder(stream);
		const chunks = [];
		media.addEventListener("dataavailable", (event) => chunks.push(event.data));
		media.addEventListener("stop", () => void sendRecording());
		media.start();
		recorder = { media, stream, chunks };
		const mic = panel?.querySelector('[data-act="mic"]');
		mic?.classList.add("recording");
		recordTimer = window.setTimeout(stopRecording, MAX_RECORD_MS);
	} catch {
		appendMsg("Microphone permission denied.", "error");
	}
}

function stopRecording() {
	if (!recorder) return;
	window.clearTimeout(recordTimer);
	panel?.querySelector('[data-act="mic"]')?.classList.remove("recording");
	recorder.media.stop();
	recorder.stream.getTracks().forEach((track) => track.stop());
	recorder = null;
}

async function sendRecording() {
	if (!recorder) return;
	const blob = new Blob(recorder.chunks, { type: recorder.media.mimeType });
	recorder = null;
	appendMsg("Transcribing…", "assistant");
	const res = await fetchJson("/_emdash/api/plugins/ai-edit/transcribe", {
		method: "POST",
		headers: { "X-EmDash-Request": "1", "Content-Type": blob.type || "application/octet-stream" },
		body: blob,
	});
	if (res.success === true && typeof res.data?.text === "string") {
		appendMsg(res.data.text, "user");
		history.push({ role: "user", content: res.data.text });
		await runChat();
	} else {
		appendMsg(String(res.error?.message ?? "Transcription failed."), "error");
	}
}

async function send() {
	const text = inputEl?.value.trim();
	if (!text || !inputEl) return;
	inputEl.value = "";
	appendMsg(text, "user");
	history.push({ role: "user", content: text });
	await runChat();
}

async function runChat(prefix) {
	const thinking = appendMsg("Thinking…", "assistant");
	const hint = targetEl?.value.trim() || null;
	const res = await fetchJson("/_emdash/api/plugins/ai-edit/chat", {
		method: "POST",
		headers: CSRF_HEADER,
		body: JSON.stringify({
			messages: [...history, ...(prefix ?? [])].map((m) =>
				typeof m === "string" ? { role: "user", content: m } : m,
			),
			urlPath: window.location.pathname,
			locale: document.documentElement.lang || null,
			target: hint ? { slug: hint, id: hint } : null,
		}),
	});
	thinking.remove();
	if (res.success !== true) {
		appendMsg(String(res.error?.message ?? "The agent could not complete your request."), "error");
		return;
	}
	const data = res.data;
	proposal = data.proposal ?? null;
	if (data.reply) {
		appendMsg(data.reply, "assistant");
		history.push({ role: "assistant", content: data.reply });
	}
	if (proposal) renderProposal(proposal);
}

async function renderProposal(p) {
	const edits = Array.isArray(p.edits) ? p.edits : [];
	const wrap = document.createElement("div");
	wrap.className = "emdash-ai-diff";
	const title = p.title || p.slug || p.id || "entry";
	const head = document.createElement("div");
	head.textContent = `Proposed edits → ${title}`;
	wrap.appendChild(head);
	for (const edit of edits) {
		const row = document.createElement("div");
		row.className = "emdash-ai-diff-row";
		const field = document.createElement("span");
		field.className = "field";
		field.textContent = String(edit.field ?? "");
		const old = document.createElement("span");
		old.className = "old";
		old.textContent = summarize(edit.old);
		const arrow = document.createElement("span");
		arrow.textContent = "→";
		const nw = document.createElement("span");
		nw.className = "new";
		nw.textContent = summarize(edit.value);
		row.appendChild(field);
		row.appendChild(old);
		row.appendChild(arrow);
		row.appendChild(nw);
		wrap.appendChild(row);
	}
	const actions = document.createElement("div");
	actions.className = "emdash-ai-actions";
	const role = user?.role ?? 0;
	// Authors (30) may publish only their own entries; editors (40+) any entry.
	// Ownership is enforced server-side either way; this only hides a button
	// the server would reject.
	const canPublish = role >= 40 || (role === 30 && p.authorId != null && p.authorId === user?.id);
	const save = document.createElement("button");
	save.textContent = "Apply (draft)";
	save.addEventListener("click", () => void applyProposal(p, false));
	actions.appendChild(save);
	if (canPublish) {
		const publish = document.createElement("button");
		publish.className = "primary";
		publish.textContent = "Apply & publish";
		publish.addEventListener("click", () => void applyProposal(p, true));
		actions.appendChild(publish);
	}
	const discard = document.createElement("button");
	discard.textContent = "Discard";
	discard.addEventListener("click", () => {
		wrap.remove();
		proposal = null;
	});
	actions.appendChild(discard);
	wrap.appendChild(actions);
	messagesEl?.appendChild(wrap);
	messagesEl?.scrollTo(0, messagesEl.scrollHeight);
}

function summarize(value) {
	if (value == null) return "";
	let text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	if (text.length > 60) text = text.slice(0, 57) + "…";
	return text;
}

async function applyProposal(p, publish) {
	const collection = String(p.collection ?? "");
	const id = String(p.id ?? "");
	const path = `/_emdash/api/content/${collection}/${id}`;
	const data = {};
	for (const edit of Array.isArray(p.edits) ? p.edits : []) {
		data[String(edit.field ?? "")] = edit.value;
	}
	const get = await fetchJson(path);
	if (get.success !== true) {
		appendMsg(String(get.error?.message ?? "Could not read the entry."), "error");
		return;
	}
	const rev = get.data?._rev;
	const put = await fetchJson(path, {
		method: "PUT",
		headers: CSRF_HEADER,
		body: JSON.stringify({ data, _rev: rev }),
	});
	if (put.success !== true) {
		appendMsg(String(put.error?.message ?? "Save failed."), "error");
		return;
	}
	if (!publish) {
		appendMsg("Saved as draft.", "assistant");
		const view = document.createElement("a");
		view.href = `/_emdash/admin/content/${collection}/${id}`;
		view.className = "emdash-ai-msg assistant emdash-ai-link";
		view.textContent = "Open in the admin to review and publish →";
		messagesEl?.appendChild(view);
		messagesEl?.scrollTo(0, messagesEl.scrollHeight);
		return;
	}
	const newRev = put.data?._rev;
	const pub = await fetchJson(`${path}/publish`, {
		method: "POST",
		headers: CSRF_HEADER,
		body: JSON.stringify(newRev ? { _rev: newRev } : {}),
	});
	if (pub.success !== true) {
		appendMsg(String(pub.error?.message ?? "Publish failed."), "error");
		return;
	}
	appendMsg("Published. Reloading your page…", "assistant");
	window.setTimeout(() => window.location.reload(), 700);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", () => void boot());
} else {
	void boot();
}
