#!/usr/bin/env node
/**
 * Occult API — MCP server.
 *
 * Gives an AI assistant access to ~90 Vedic astrology endpoints and the ~420
 * named calculations behind them, using the customer's own API key.
 *
 * Why discovery tools rather than one tool per endpoint: every tool's schema
 * sits in the model's context on every single message. Ninety of them, several
 * carrying fifty-odd keys, would crowd out the conversation before the user had
 * asked anything — and most clients degrade well before ninety. So the model
 * gets a search function and looks things up, plus a couple of named tools for
 * what people actually ask for.
 *
 * Every call spends credits on the customer's account exactly as a direct HTTP
 * call would; the API's own metering does the charging, and nothing here can
 * bypass it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiError, DEFAULT_BASE_URL, OccultClient } from "./api.js";
import { Catalogue } from "./catalogue.js";

const API_KEY = (process.env.OCCULT_API_KEY ?? "").trim();
const BASE_URL = (process.env.OCCULT_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

const client = new OccultClient(API_KEY, BASE_URL);
const catalogue = new Catalogue(BASE_URL);

const server = new McpServer(
  { name: "occult-api", version: "0.1.0" },
  {
    instructions:
      "Vedic astrology calculations from the Occult API. Use search_endpoints to " +
      "find a calculation by name or by feature (for example 'manglik' or " +
      "'nakshatra'), describe_endpoint to see the exact request fields and a " +
      "working example, then call_endpoint to run it. Each successful call costs " +
      "one credit; failed requests cost nothing. Ask for several keys in one call " +
      "rather than making several calls — the price is the same.",
  },
);

/** Every tool answers through this, so success and failure look consistent. */
function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  const message =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : "Unexpected error calling the Occult API.";
  // isError tells the client this did not succeed, so the assistant reports it
  // rather than treating the text as a result.
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function requireKey(): string | null {
  if (API_KEY) return null;
  return (
    "No Occult API key is configured. Add OCCULT_API_KEY to this MCP server's " +
    "env block — create a key at https://occultapi.com/keys — then restart this app."
  );
}

// --------------------------------------------------------------------------
// Account
// --------------------------------------------------------------------------
server.registerTool(
  "check_account",
  {
    title: "Check Occult API key and credit balance",
    description:
      "Verify the configured API key and report the remaining credit balance. " +
      "Costs no credits. Use this first if a call fails, to tell a bad key apart " +
      "from an empty balance.",
    inputSchema: {},
  },
  async () => {
    const missing = requireKey();
    if (missing) return failure(new Error(missing));
    try {
      const result = await client.call("/api/developer/key-info/", "GET", {});
      return text(result.body);
    } catch (error) {
      return failure(error);
    }
  },
);

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------
server.registerTool(
  "search_endpoints",
  {
    title: "Search Occult API calculations",
    description:
      "Find endpoints by name or by the calculation you want. Searches the ~420 " +
      "named keys as well as endpoint names, so 'manglik', 'tithi' or 'ashtakoota' " +
      "all resolve even though none of them is an endpoint name. Costs no credits.",
    inputSchema: {
      query: z
        .string()
        .describe("What you are looking for, e.g. 'manglik', 'panchang', 'dasha'."),
    },
  },
  async ({ query }) => {
    try {
      const matches = await catalogue.search(query);
      if (matches.length === 0) {
        return text(
          `Nothing in the Occult API matches "${query}". Try a broader term, or a ` +
            `Sanskrit spelling (for example 'kundli' rather than 'birth chart').`,
        );
      }
      return text(
        matches.map((m) => ({
          slug: m.slug,
          route: m.route,
          method: m.method,
          summary: m.title || m.name,
          cost_credits: m.cost_credits,
          total_keys: m.key_count,
          matched_keys: m.matchedKeys.slice(0, 20),
        })),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "describe_endpoint",
  {
    title: "Describe an Occult API endpoint",
    description:
      "The exact request fields, every available key, and a request body that is " +
      "known to work. Read this before calling an endpoint for the first time. " +
      "Costs no credits.",
    inputSchema: {
      slug: z.string().describe("Endpoint slug from search_endpoints, e.g. 'astro.panchanga'."),
    },
  },
  async ({ slug }) => {
    try {
      const detail = await catalogue.detail(slug);
      return text({
        slug: detail.slug,
        route: detail.route,
        method: detail.method,
        cost_credits: detail.cost_credits,
        fields: detail.fields,
        query_params: detail.query_params,
        keys: detail.keys,
        // The bodies in the catalogue were run against a live server, so this is
        // a proven starting point rather than a guess from the schema.
        working_example: detail.sample_request,
        note:
          detail.style === "keys"
            ? "List the calculations you want in `keys`. Asking for ten costs the " +
              "same one credit as asking for one, so batch them."
            : undefined,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "call_endpoint",
  {
    title: "Call an Occult API endpoint",
    description:
      "Run any Occult API endpoint. Spends one credit if it succeeds; failed " +
      "requests cost nothing. Call describe_endpoint first so the fields are right.",
    inputSchema: {
      slug: z.string().describe("Endpoint slug, e.g. 'astro.panchanga'."),
      body: z
        .record(z.string(), z.unknown())
        .describe(
          "Request fields as an object. For GET endpoints these become query parameters.",
        ),
    },
  },
  async ({ slug, body }) => {
    const missing = requireKey();
    if (missing) return failure(new Error(missing));
    try {
      const detail = await catalogue.detail(slug);
      const result = await client.call(
        detail.route,
        detail.method === "GET" ? "GET" : "POST",
        body,
      );
      return text({
        result: result.body,
        credits_remaining: result.creditsRemaining,
        ...(lowBalanceNote(result.creditsRemaining) ?? {}),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// --------------------------------------------------------------------------
// Named shortcut for the thing people ask for most
// --------------------------------------------------------------------------
server.registerTool(
  "get_panchanga",
  {
    title: "Get the panchanga for a date and place",
    description:
      "Tithi, nakshatra, yoga, karana and related almanac values for a given " +
      "moment and location. Spends one credit.",
    inputSchema: {
      date_time: z
        .string()
        .describe("Local date and time, e.g. '2026-09-01 06:00:00' or ISO 8601."),
      latitude: z.number().describe("Latitude in degrees, e.g. 26.9124 for Jaipur."),
      longitude: z.number().describe("Longitude in degrees, e.g. 75.7873 for Jaipur."),
      timezone_as_float: z
        .number()
        .describe("UTC offset in hours, e.g. 5.5 for India."),
      keys: z
        .array(z.string())
        .optional()
        .describe(
          "Which values to return, e.g. ['tithi','yogam','karana']. Ask for all " +
            "you need at once — the cost is one credit regardless. Use " +
            "describe_endpoint('astro.panchanga') for the full list.",
        ),
    },
  },
  async ({ keys, ...rest }) => {
    const missing = requireKey();
    if (missing) return failure(new Error(missing));
    try {
      const result = await client.call("/api/astro/panchanga/", "POST", {
        ...rest,
        keys: keys?.length ? keys : ["tithi", "yogam", "karana", "nakshatra"],
      });
      return text({
        result: result.body,
        credits_remaining: result.creditsRemaining,
        ...(lowBalanceNote(result.creditsRemaining) ?? {}),
      });
    } catch (error) {
      return failure(error);
    }
  },
);

/** Warn before the balance runs out, not after. */
function lowBalanceNote(remaining: number | null) {
  if (remaining === null || remaining > 50) return null;
  return {
    warning:
      remaining <= 0
        ? "This account is out of credits. Top up at https://occultapi.com/billing."
        : `Only ${remaining} credits left. Top up at https://occultapi.com/billing.`,
  };
}

async function main() {
  // stdout is the MCP wire protocol — anything printed there corrupts it, so
  // diagnostics go to stderr, which clients surface in their logs.
  if (!API_KEY) {
    process.stderr.write(
      "occult-api-mcp: OCCULT_API_KEY is not set. The server will start and can " +
        "still search and describe endpoints, but no calculation will run.\n",
    );
  }
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`occult-api-mcp: fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
