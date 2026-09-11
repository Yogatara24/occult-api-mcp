/**
 * The HTTP client, and the error handling that decides how this feels to use.
 *
 * Everything here runs on the customer's machine. The API key comes from their
 * environment, goes out as a header, and is never returned to the assistant —
 * the model sees results, never the credential.
 */
import { gunzipSync } from "node:zlib";

/**
 * The API host, which is NOT the portal host.
 *
 * occultapi.com serves the website where a customer signs up, buys credits and
 * creates keys; the calculations answer here. Every user-facing link in this
 * package points at the former and every request goes to the latter, and
 * confusing the two sends every call to a Next.js app that knows nothing about
 * astrology. Overridable with OCCULT_API_URL for when the API moves to its own
 * subdomain.
 */
export const DEFAULT_BASE_URL = "https://api.occultapi.com";
const TIMEOUT_MS = 60_000;

/**
 * Failures the caller must stop on, keyed by the API's own machine codes.
 *
 * The wording matters more than it looks. An assistant that gets an opaque
 * error will usually try again two or three times; on a dead key that is just
 * noise, but against a working key a retry loop spends real credits. So these
 * say exactly what is wrong and what to do about it, and `retryable` is false
 * for every one of them.
 */
const TERMINAL: Record<string, string> = {
  invalid_api_key:
    "Your Occult API key is invalid, revoked, or expired. Create a new one at " +
    "https://occultapi.com/keys and update OCCULT_API_KEY in your MCP config, " +
    "then restart this app.",
  insufficient_credits:
    "You are out of Occult API credits. Top up at https://occultapi.com/billing.",
  account_suspended:
    "This Occult API account is suspended. Contact support at occultapi.com.",
  ip_not_allowed:
    "This API key only accepts requests from an allowlisted IP address, and this " +
    "machine is not on the list. Edit the key at https://occultapi.com/keys.",
  scope_not_allowed:
    "This API key does not have the scope required for that calculation. Create a " +
    "key with wider scopes at https://occultapi.com/keys.",
  endpoint_not_allowed:
    "That endpoint is not enabled for API keys on this account.",
  api_key_required:
    "That endpoint must be called with an API key.",
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiResult = {
  body: unknown;
  /** From X-Credits-Remaining, so the assistant can warn before the tank empties. */
  creditsRemaining: number | null;
  creditsCharged: number | null;
};

export class OccultClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async call(
    route: string,
    method: "GET" | "POST",
    params: Record<string, unknown>,
  ): Promise<ApiResult> {
    // One retry, and only for the two cases where trying again can genuinely
    // succeed: a rate limit that has since reset, or a transient fault on our
    // side. Never for 401/402/403 — those cost credits to re-attempt and will
    // fail identically.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(route, method, params);
      } catch (error) {
        if (attempt >= 1 || !(error instanceof ApiError) || !error.retryable) throw error;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  private async attempt(
    route: string,
    method: "GET" | "POST",
    params: Record<string, unknown>,
  ): Promise<ApiResult> {
    const search =
      method === "GET"
        ? `?${new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => [k, String(v)]),
          )}`
        : "";

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${route}${search}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new ApiError(
        timedOut
          ? "The Occult API did not respond within 60 seconds."
          : `Could not reach the Occult API: ${(error as Error).message}`,
        0,
        timedOut ? "timeout" : "unreachable",
        true,
      );
    }

    const raw = Buffer.from(await response.arrayBuffer());
    const text = inflateIfGzipped(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) throw this.toError(response.status, parsed);

    return {
      body: parsed,
      creditsRemaining: numericHeader(response, "x-credits-remaining"),
      creditsCharged: numericHeader(response, "x-credits-charged"),
    };
  }

  private toError(status: number, parsed: unknown): ApiError {
    const payload = (parsed ?? {}) as Record<string, unknown>;
    const code = String(payload.message ?? "");

    const known = TERMINAL[code];
    if (known) return new ApiError(known, status, code, false);

    if (status === 429) {
      const seconds =
        (payload.data as Record<string, unknown> | undefined)?.retry_after_seconds ?? 2;
      return new ApiError(
        `Rate limit reached for this API key. Retrying in ${seconds}s.`,
        429,
        "api_key_rate_limited",
        true,
      );
    }

    if (status === 400) {
      // The request itself was wrong — usually a field the assistant guessed.
      // Hand back the API's own validation detail so it can correct itself,
      // and note that this cost nothing.
      return new ApiError(
        `The Occult API rejected the request (no credits were charged): ${JSON.stringify(
          payload.message ?? payload.error ?? payload,
        )}`,
        400,
        "invalid_request",
        false,
      );
    }

    if (status >= 500) {
      return new ApiError(
        "The Occult API had an internal error. No credits were charged.",
        status,
        "server_error",
        true,
      );
    }

    return new ApiError(
      String(payload.error ?? `Request failed with status ${status}.`),
      status,
      code || "error",
      false,
    );
  }
}

/**
 * A few endpoints answer with application/gzip as a download. fetch only
 * auto-inflates Content-ENCODING, so those arrive as bytes and would reach the
 * assistant as mojibake.
 */
function inflateIfGzipped(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      return gunzipSync(raw).toString("utf-8");
    } catch {
      return "";
    }
  }
  return raw.toString("utf-8");
}

function numericHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
