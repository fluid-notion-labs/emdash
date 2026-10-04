/**
 * Widget bootstrap for the AI Edit plugin.
 *
 * The actual widget lives in `client.js`; this wrapper imports it as raw
 * text (Vite `?raw`) so it ships verbatim as an inline page fragment. It is
 * identical for every visitor — the widget decides client-side whether the
 * caller has an editor session, so nothing renders for anonymous visitors.
 */

// @ts-ignore - Vite raw import
import clientSource from "./client.js?raw";

export function widgetScript(_options: { modelNote?: string }): string {
	return clientSource;
}
