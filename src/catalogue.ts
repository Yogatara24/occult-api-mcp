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
   * Match on the endpoint name AND on its keys.
   *
   * The keys are the point: roughly 420 named calculations sit behind ~90
   * endpoints, and nobody looking for "manglik" would guess it lives in
   * /api/astro/dosha/. Searching names alone would make most of the catalogue
   * unreachable in practice.
   */
  async search(query: string, limit = 12): Promise<Array<Summary & { matchedKeys: string[] }>> {
    const term = query.trim().toLowerCase();
    const all = await this.endpoints();
    if (!term) return all.slice(0, limit).map((e) => ({ ...e, matchedKeys: [] }));

    const scored = all
      .map((e) => {
        const matchedKeys = e.keys.filter((k) => k.toLowerCase().includes(term));
        const inName =
          e.name.toLowerCase().includes(term) ||
          e.route.toLowerCase().includes(term) ||
          (e.title || "").toLowerCase().includes(term);
        // An exact key match is the strongest signal — it means the caller
        // named a specific calculation rather than a topic.
        const score =
          (e.keys.some((k) => k.toLowerCase() === term) ? 100 : 0) +
          (inName ? 10 : 0) +
          matchedKeys.length;
        return { ...e, matchedKeys, score };
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
