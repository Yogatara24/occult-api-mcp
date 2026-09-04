/**
 * What the API can do, fetched from the API itself.
 *
 * Not bundled into this package: the catalogue is generated from the live
 * serializers and reverified against a running server, so a frozen copy shipped
 * in an npm release starts drifting the day after it is published. Fetching it
 * means a new endpoint reaches every user the moment it goes live, with nothing
 * to install and no version to chase.
 *
 * Fetched once per process and kept in memory. It is public and unauthenticated
 * — the same JSON behind the published documentation — so this happens before
 * any key is involved.
 */

export type Summary = {
  slug: string;
  route: string;
  method: string;
  name: string;
  title: string;
  description: string;
  cost_credits: number;
  style: string;
  key_count: number;
  keys: string[];
};

export type Detail = Summary & {
  /**
   * The URL with named placeholders, e.g. /api/astrodatabank/celebrities/{id}/.
   * Absent on older servers, in which case `route` is already the full path.
   */
  path_template?: string;
  path_params?: Array<{ name: string; type: string; required: boolean; description: string }>;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    enum: string[] | null;
    minimum: number | null;
    maximum: number | null;
    description: string;
  }>;
  query_params: Array<{ name: string; type: string; required: boolean; description: string }>;
  sample_request: Record<string, unknown>;
  response_content_type?: string;
};

export class Catalogue {
  private index: Summary[] | null = null;
  private readonly details = new Map<string, Detail>();

  constructor(private readonly baseUrl: string) {}

  async endpoints(): Promise<Summary[]> {
    if (this.index) return this.index;
    const data = await this.get<{ endpoints: Summary[] }>("/api/docs/index/");
    this.index = data.endpoints;
    return this.index;
  }

  async detail(slug: string): Promise<Detail> {
    const cached = this.details.get(slug);
    if (cached) return cached;
    const data = await this.get<Detail>(`/api/docs/endpoint/${encodeURIComponent(slug)}/`);
    this.details.set(slug, data);
    return data;
  }

  /**
   * Match on the endpoint name AND on its keys, one word at a time.
   *
   * The keys are the point: roughly 420 named calculations sit behind ~90
   * endpoints, and nobody looking for "manglik" would guess it lives in
   * /api/astro/dosha/. Searching names alone would make most of the catalogue
   * unreachable in practice.
   *
   * Scored per WORD rather than on the whole phrase, because the caller is an
   * assistant relaying how a person actually asked: "marriage compatibility
   * matching" contains the answer but matches nothing as a literal substring,
   * and a bare "no results" is where the assistant gives up and guesses.
   */
  async search(query: string, limit = 12): Promise<Array<Summary & { matchedKeys: string[] }>> {
    const all = await this.endpoints();
    const words = tokenize(query);
    if (words.length === 0) return all.slice(0, limit).map((e) => ({ ...e, matchedKeys: [] }));

    const scored = all
      .map((e) => {
        const haystack = `${e.name} ${e.route} ${e.title ?? ""}`.toLowerCase();
        const matchedKeys = new Set<string>();
        let score = 0;

        for (const word of words) {
          // An exact key match is the strongest signal — the caller named a
          // specific calculation rather than a topic.
          if (e.keys.some((k) => k.toLowerCase() === word)) score += 100;
          if (haystack.includes(word)) score += 10;
          for (const k of e.keys) {
            if (k.toLowerCase().includes(word)) {
              matchedKeys.add(k);
              score += 1;
            }
          }
        }
        return { ...e, matchedKeys: [...matchedKeys], score };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ score: _score, ...rest }) => rest);
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(
        `Could not load the Occult API catalogue from ${this.baseUrl}: ${
          (error as Error).message
        }`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Could not load the Occult API catalogue: ${this.baseUrl}${path} returned ${response.status}.`,
      );
    }
    const payload = (await response.json()) as { data?: T };
    return (payload.data ?? payload) as T;
  }
}

/**
 * Words worth matching on. Drops the filler a person's phrasing carries into
 * the query, which would otherwise match everything or nothing at random.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "in", "on", "to", "and", "or", "my", "me",
  "is", "are", "was", "what", "whats", "how", "get", "find", "show", "tell",
  "give", "calculate", "chart", "please", "can", "you", "i", "do", "does",
]);

function tokenize(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  )];
}

/**
 * Put path parameters into the URL and return what is left for the body or
 * query string.
 *
 * A path parameter is part of the address, not something attached to it. Sent
 * as a query parameter the request goes to the literal template and 404s, which
 * an assistant reports as "that record does not exist" rather than "I built the
 * URL wrong".
 */
export function resolvePath(
  detail: Detail,
  params: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const template = detail.path_template ?? detail.route;
  const rest = { ...params };
  const path = template.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const value = rest[name];
    if (value === undefined || value === null || value === "") return whole;
    delete rest[name];
    return encodeURIComponent(String(value));
  });
  return { path, rest };
}
