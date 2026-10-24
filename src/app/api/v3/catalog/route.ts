import { toHandlerSummary } from '@/lib/api/dto';
import { CACHE, jsonWithEtag, preflight, serialized, weakEtag, withApi } from '@/lib/api/http';
import { CatalogQuery, parseQuery } from '@/lib/api/schemas/params';
import type { ClientId } from '@/lib/clients';
import { getLinkContext } from '@/server/api/context';
import { cached, TAGS } from '@/server/cache';
import { getCatalog } from '@/server/public';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v3/catalog: every listed handler, trend order (the desktop app's whole catalogue). The payload
 * is serialised and its ETag computed once per cache period (a 304 costs no serialisation); the ETag
 * covers the items only, so it stays the same across rebuilds while nothing changed.
 *
 * `client` picks the tool: `nucleus` by default, which is exactly what the Nucleus Co-op app has always
 * received, so handlers of other tools never reach it by surprise. One cached payload per value.
 */
function catalogPayload(client: ClientId | 'all') {
  return cached(
    `api:catalog:${client}`,
    5 * 60_000,
    async () => {
      const [handlers, ctx] = await Promise.all([
        getCatalog(client === 'all' ? undefined : client),
        getLinkContext(),
      ]);
      const items = handlers.map((h) => toHandlerSummary(h, ctx));
      return {
        body: serialized({ generatedAt: new Date().toISOString(), count: items.length, items }),
        etag: weakEtag(JSON.stringify(items)),
      };
    },
    [TAGS.catalog],
  );
}

export const GET = withApi(
  async (req) => {
    const { client } = parseQuery(CatalogQuery, req.nextUrl);
    const { body, etag } = await catalogPayload(client);
    return jsonWithEtag(req, body, { etag, cacheControl: CACHE.catalog });
  },
  { rateLimit: 'catalog' },
);
export const OPTIONS = preflight;
