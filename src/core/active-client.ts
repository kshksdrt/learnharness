/** Browser-safe wire names for the single-active-client lock (browser-only
 * mode): the per-tab id rides this header on /api fetches and this query
 * param on the events channel. Server half: src/server/active-client.ts. */
export const CLIENT_HEADER = "x-learnharness-client";
export const CLIENT_QUERY = "client";
/** The refusal body's `error` for a displaced tab (HTTP 409). */
export const CLIENT_DISPLACED = "displaced";
