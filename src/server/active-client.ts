/**
 * ONE ACTIVE BROWSER CLIENT (browser-only mode). Each page load mints a
 * per-tab id and claims; the newest claim wins and every other tab is told
 * it was displaced. The active id lives in a small file (not a global)
 * because Proxy may run apart from route code (Next 16 proxy docs: never
 * rely on shared modules or globals). Desktop mode is untouched.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { CLIENT_DISPLACED, CLIENT_HEADER } from "../core/active-client.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { browserOnlyMode } from "./desktop-access.ts";

export const ACTIVE_CLIENT_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "active-client");

/** Paths exempt from the active-client check: claiming is how a tab
 * becomes active, and the events channel answers a stale id with a
 * displaced frame instead of a refusal (EventSource never retries a 409). */
const EXEMPT_PATHS = new Set(["/api/client/claim", "/api/events"]);

export function readActiveClient(file: string = ACTIVE_CLIENT_FILE): string | undefined {
	try {
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Record `id` as the active client and tell every open window. Returns
 * whether the lock is enforced (browser-only mode); desktop mode is a no-op
 * so multiple Electron windows never displace each other. */
export function claimActiveClient(
	id: string,
	env: Record<string, string | undefined> = process.env,
	file: string = ACTIVE_CLIENT_FILE,
): boolean {
	if (!browserOnlyMode(env)) return false;
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, id);
	emit("client-displaced", { active: id });
	return true;
}

/** A browser request (Sec-Fetch-Site or Origin present) from a tab that is
 * not the active client. Non-browser callers without an id pass. */
export function activeClientRefusal(
	request: Request,
	env: Record<string, string | undefined> = process.env,
	file: string = ACTIVE_CLIENT_FILE,
): string | undefined {
	if (!browserOnlyMode(env)) return;
	if (EXEMPT_PATHS.has(new URL(request.url).pathname.replace(/\/$/, ""))) return;
	const supplied = request.headers.get(CLIENT_HEADER);
	const fromBrowser = request.headers.has("sec-fetch-site") || request.headers.has("origin");
	if (!supplied && !fromBrowser) return;
	if (supplied && supplied === readActiveClient(file)) return;
	return CLIENT_DISPLACED;
}

/** For the events channel: is this (query-param) id stale? */
export function clientDisplaced(
	id: string | null,
	env: Record<string, string | undefined> = process.env,
	file: string = ACTIVE_CLIENT_FILE,
): boolean {
	if (!browserOnlyMode(env) || !id) return false;
	return id !== readActiveClient(file);
}
