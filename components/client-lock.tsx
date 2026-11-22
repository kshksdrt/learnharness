"use client";

/**
 * ONE ACTIVE BROWSER CLIENT, CLIENT HALF (browser-only mode). Each page load
 * mints an in-memory tab id (not sessionStorage: a duplicated tab would copy
 * it), wraps window.fetch so same-origin /api requests carry it, and claims
 * the active slot before the events channel opens. The newest claim wins:
 * every other tab gets a client-displaced frame, drops its channel (so
 * EventSource's auto-reconnect can't fight the new tab) and locks itself
 * behind a full-screen overlay ("Close session", or "Close other
 * session", which reclaims by reloading). A 409 {error:"displaced"}
 * from any wrapped fetch locks the same way. Server half:
 * src/server/active-client.ts; Proxy refuses the displaced tab's requests.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CLIENT_DISPLACED, CLIENT_HEADER, CLIENT_QUERY } from "@/src/core";
import { ServerEventsProvider, type NotifySource } from "./server-events";

// ── module state (one per page load) ────────────────────────────────────────

const isBrowser = typeof window !== "undefined";
const tabId = isBrowser ? crypto.randomUUID() : "";

let locked = false;
const lockListeners = new Set<() => void>();
const lockTeardowns = new Set<() => void>();

function lock(): void {
	if (locked) return;
	locked = true;
	for (const teardown of [...lockTeardowns]) teardown();
	for (const listener of [...lockListeners]) listener();
}

/** Same-origin /api (or /api/…) URL — the only requests that carry the id. */
export function isOwnApiUrl(url: URL, origin: string): boolean {
	return url.origin === origin && !url.username && !url.password && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
}

/** Wrap a fetch so own-API requests carry `id` and a displaced 409 locks.
 * Exported for tests; installed once on window below. */
export function wrapFetch(original: typeof fetch, id: string, origin: string, onDisplaced: () => void): typeof fetch {
	return async (input, init) => {
		const raw = input instanceof Request ? input.url : String(input);
		let url: URL;
		try {
			url = new URL(raw, origin);
		} catch {
			return original(input, init);
		}
		if (!isOwnApiUrl(url, origin)) return original(input, init);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set(CLIENT_HEADER, id);
		const response = await original(input, { ...init, headers });
		if (response.status === 409) {
			response.clone().json().then(
				(body: { error?: unknown } | null) => { if (body?.error === CLIENT_DISPLACED) onDisplaced(); },
				() => {},
			);
		}
		return response;
	};
}

let claimed: Promise<boolean> = Promise.resolve(false);

if (isBrowser) {
	window.fetch = wrapFetch(window.fetch.bind(window), tabId, window.location.origin, lock);
	// Claim BEFORE the channel opens: a channel carrying an unclaimed id would
	// be answered with an immediate displaced frame.
	claimed = window
		.fetch("/api/client/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: tabId }),
		})
		.then(async (res) => (res.ok ? Boolean(((await res.json()) as { enforced?: unknown }).enforced) : false))
		.catch(() => false);
}

// ── the events channel, opened after the claim ──────────────────────────────

/** ServerEventsProvider's `connect`: the same EventSource the default opens,
 * carrying ?client=<id>, deferred until the claim settles. Handlers wired
 * synchronously (wireSource) are queued and attached on open. */
export function openClaimedEventsChannel(): NotifySource {
	let es: EventSource | undefined;
	let closed = false;
	const opens: Array<() => void> = [];
	const events: Array<[string, (data: string) => void]> = [];
	const close = () => {
		closed = true;
		es?.close();
		lockTeardowns.delete(close);
	};
	lockTeardowns.add(close);
	void claimed.then((enforced) => {
		if (closed || locked) return;
		es = new EventSource(enforced ? `/api/events?${CLIENT_QUERY}=${encodeURIComponent(tabId)}` : "/api/events");
		es.onopen = () => { for (const cb of opens) cb(); };
		for (const [name, cb] of events) es.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		if (!enforced) return;
		es.addEventListener("client-displaced", (ev) => {
			try {
				const { active } = JSON.parse((ev as MessageEvent).data) as { active?: unknown };
				if (active !== tabId) lock();
			} catch { /* unparseable frame: ignore, like the hub */ }
		});
	});
	return {
		close,
		onOpen: (cb) => { opens.push(cb); },
		onEvent: (name, cb) => { events.push([name, cb]); },
	};
}

/** The root layout's events provider (a Server Component can't pass the
 * connect function across the client boundary itself). */
export function ClaimedServerEventsProvider({ children }: { children: ReactNode }) {
	return <ServerEventsProvider connect={openClaimedEventsChannel}>{children}</ServerEventsProvider>;
}

// ── the lock overlay ────────────────────────────────────────────────────────

function useLocked(): boolean {
	return useSyncExternalStore(
		(cb) => { lockListeners.add(cb); return () => { lockListeners.delete(cb); }; },
		() => locked,
		() => false,
	);
}

export function ClientLockOverlay() {
	const isLocked = useLocked();
	const [closeFailed, setCloseFailed] = useState(false);
	if (!isLocked) return null;
	const closeTab = () => {
		window.close();
		// Browsers only let scripts close tabs they opened.
		setTimeout(() => setCloseFailed(true), 300);
	};
	return (
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="client-lock-title"
			className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 p-4"
		>
			<div className="w-[32rem] max-w-full rounded-xl border bg-card p-8 text-center shadow-xl">
				<h2 id="client-lock-title" className="text-lg font-semibold text-foreground">
					LearnHarness is open in another tab
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">
					Only one tab can use LearnHarness at a time. The newest tab took over.
				</p>
				{closeFailed ? (
					<p className="mt-6 text-base text-foreground">You can close this tab.</p>
				) : (
					<button
						type="button"
						autoFocus
						onClick={closeTab}
						className="mt-6 w-full rounded-lg bg-primary px-6 py-4 text-lg font-semibold text-primary-foreground hover:opacity-90"
					>
						Close session
					</button>
				)}
				{/* A reload mints a new tab id and claims on load (newest wins),
				    so the other tab is displaced and locks itself. */}
				<button
					type="button"
					onClick={() => window.location.reload()}
					className="mt-6 w-full rounded-lg bg-primary px-6 py-4 text-lg font-semibold text-primary-foreground hover:opacity-90"
				>
					Close other session
				</button>
			</div>
		</div>
	);
}
