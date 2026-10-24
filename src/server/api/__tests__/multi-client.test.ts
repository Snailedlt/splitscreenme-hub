import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as catalogRoute from '@/app/api/v3/catalog/route';
import * as gameRoute from '@/app/api/v3/games/[slug]/route';
import * as handlerRoute from '@/app/api/v3/handlers/[id]/route';
import * as downloadRoute from '@/app/api/v3/handlers/[id]/download/route';
import * as scriptRoute from '@/app/api/v3/handlers/[id]/versions/[version]/script/route';
import * as searchRoute from '@/app/api/v3/handlers/route';
import { getDb } from '@/db';
import { games, handlerVersions, handlers } from '@/db/schema';
import { Catalog, HandlerDetail, HandlerPage } from '@/lib/api/schemas/handlers';
import { Game } from '@/lib/api/schemas/games';
import { env } from '@/lib/env';
import { resetAllRateLimits } from '@/lib/rate-limit';
import { clearCache } from '@/server/cache';
import { dbAvailable, truncateAll } from '@/test/db';
import { call, day, H, seed, sha256, USERS } from './fixtures';

/**
 * Handlers of more than one tool on the same hub (docs/ARCHITECTURE.md section 12): the API keeps the
 * Nucleus Co-op answers it always gave, and PartyDeck handlers are listed, filtered and downloaded as their
 * own kind of package.
 */

const PD = {
  onPortal: 'apiPartyDeck00001', // PartyDeck handler next to the Nucleus ones, more popular than any of them
  alone: 'apiPartyDeck00002', // the only handler of its game
} as const;
const PD_V = { onPortal: 'apiPdVersion00001', alone: 'apiPdVersion00002' } as const;
// Not a zip, not text: the hub must not care.
const PD_BYTES = Buffer.from([0x50, 0x44, 0x32, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x03]);

async function seedPartyDeck() {
  const db = getDb();
  const [portal] = await db.select({ id: games.id }).from(games).where(eq(games.slug, 'portal-2'));
  const [aloneGame] = await db
    .insert(games)
    .values({ slug: 'deck-only-game', name: 'Deck Only Game', genres: ['Platform'] })
    .returning({ id: games.id });
  const listed = {
    isPublic: true,
    approvedAt: day(2),
    publishedAt: day(2),
    createdAt: day(1),
    updatedAt: day(5),
  };
  await db.insert(handlers).values([
    {
      ...listed,
      id: PD.onPortal,
      client: 'partydeck',
      gameId: portal!.id,
      ownerId: USERS.owner,
      title: 'Portal 2 on the Steam Deck',
      maxPlayers: 2,
      trendScore: 9999,
      downloadCount: 9999,
    },
    {
      ...listed,
      id: PD.alone,
      client: 'partydeck',
      gameId: aloneGame!.id,
      ownerId: USERS.second,
      title: 'Deck Only Game, 2 players',
      maxPlayers: 2,
      trendScore: 3,
    },
  ]);
  for (const [key, id] of [
    ['onPortal', PD.onPortal],
    ['alone', PD.alone],
  ] as const) {
    const versionId = PD_V[key];
    const storageKey = `packages/${id}/${versionId}.pd2`;
    await db.insert(handlerVersions).values({
      id: versionId,
      handlerId: id,
      version: 1,
      releaseNotes: 'First',
      uploaderId: USERS.owner,
      storageKey,
      fileName: `handler-${id}-v1.pd2`,
      sizeBytes: PD_BYTES.length,
      sha256: sha256(PD_BYTES),
      script: '',
      manifest: [],
      verifiedAt: day(3),
      createdAt: day(2),
    });
    await db
      .update(handlers)
      .set({ currentVersionId: versionId, currentVersion: 1 })
      .where(eq(handlers.id, id));
    const file = path.join(path.resolve(env().STORAGE_DIR), storageKey);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, PD_BYTES);
  }
}

describe.runIf(dbAvailable())('API v3 with handlers for several tools', () => {
  beforeAll(async () => {
    await truncateAll();
    await seed();
    await seedPartyDeck();
  });
  beforeEach(() => {
    clearCache();
    resetAllRateLimits();
  });

  describe('GET /catalog', () => {
    it('answers the Nucleus Co-op app exactly what it always got: Nucleus handlers only', async () => {
      const res = await call(catalogRoute.GET, '/api/v3/catalog', {});
      expect(res.status).toBe(200);
      const body = Catalog.parse(await res.json());
      expect(body.items.map((h) => h.id)).toEqual([H.second, H.primary, H.banned, H.orphan]);
      expect(body.items.every((h) => h.client === 'nucleus')).toBe(true);
      expect(body.count).toBe(4);
    });

    it('lists the other tool with client=partydeck, and everything with client=all', async () => {
      const deck = Catalog.parse(
        await (await call(catalogRoute.GET, '/api/v3/catalog?client=partydeck', {})).json(),
      );
      expect(deck.items.map((h) => h.id)).toEqual([PD.onPortal, PD.alone]);
      expect(deck.items.every((h) => h.client === 'partydeck')).toBe(true);
      const all = Catalog.parse(
        await (await call(catalogRoute.GET, '/api/v3/catalog?client=all', {})).json(),
      );
      expect(all.items.map((h) => h.id).sort()).toEqual(
        [H.second, H.primary, H.banned, H.orphan, PD.onPortal, PD.alone].sort(),
      );
      expect(all.count).toBe(6);
    });

    it('keeps one cached answer per client value', async () => {
      const a = await (await call(catalogRoute.GET, '/api/v3/catalog', {})).json();
      const b = await (await call(catalogRoute.GET, '/api/v3/catalog?client=all', {})).json();
      const c = await (await call(catalogRoute.GET, '/api/v3/catalog', {})).json();
      expect((a as { count: number }).count).toBe(4);
      expect((b as { count: number }).count).toBe(6);
      expect((c as { count: number }).count).toBe(4);
    });

    it('rejects an unknown client', async () => {
      const res = await call(catalogRoute.GET, '/api/v3/catalog?client=uss', {});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /handlers', () => {
    const search = async (qs: string) => {
      const res = await call(searchRoute.GET, `/api/v3/handlers${qs}`, {});
      expect(res.status).toBe(200);
      return HandlerPage.parse(await res.json());
    };

    it('searches every tool unless asked for one', async () => {
      const all = await search('?pageSize=100');
      expect(all.total).toBe(6);
      expect(new Set(all.items.map((h) => h.client))).toEqual(new Set(['nucleus', 'partydeck']));
    });

    it('filters by tool, together with the other filters', async () => {
      const deck = await search('?client=partydeck');
      expect(deck.items.map((h) => h.id).sort()).toEqual([PD.onPortal, PD.alone].sort());
      expect(deck.total).toBe(2);
      const nucleus = await search('?client=nucleus&pageSize=100');
      expect(nucleus.items.every((h) => h.client === 'nucleus')).toBe(true);
      expect(nucleus.total).toBe(4);
      expect((await search('?client=partydeck&genre=platformer')).items.map((h) => h.id)).toEqual([PD.alone]);
      expect((await search('?client=partydeck&q=portal')).items.map((h) => h.id)).toEqual([PD.onPortal]);
      expect((await search('?client=partydeck&verified=true')).total).toBe(2);
      expect((await search('?client=partydeck&players=3-4')).total).toBe(0);
    });

    it('rejects an unknown client', async () => {
      expect((await call(searchRoute.GET, '/api/v3/handlers?client=nope', {})).status).toBe(400);
    });
  });

  describe('games and the primary handler', () => {
    it('keeps a Nucleus Co-op handler as the primary one, even when the other tool’s is more popular', async () => {
      const res = await call(gameRoute.GET, '/api/v3/games/portal-2', { slug: 'portal-2' });
      const game = Game.parse(await res.json());
      expect([H.primary, H.second]).toContain(game.primaryHandlerId);
      const pd = game.handlers.find((h) => h.id === PD.onPortal);
      expect(pd?.client).toBe('partydeck');
      // not primary: its canonical page is its own handler page, not the game page
      expect(pd?.url).toContain(`/hub/portal-2/${PD.onPortal}`);
      expect(game.handlers[0]?.client).toBe('nucleus');
    });

    it('makes it the primary handler when it is the only one of the game', async () => {
      const res = await call(gameRoute.GET, '/api/v3/games/deck-only-game', { slug: 'deck-only-game' });
      expect(res.status).toBe(200);
      const game = Game.parse(await res.json());
      expect(game.primaryHandlerId).toBe(PD.alone);
      expect(game.handlers).toHaveLength(1);
    });
  });

  describe('GET /handlers/{id}', () => {
    it('says which tool the handler is for and names its package file', async () => {
      const res = await call(handlerRoute.GET, `/api/v3/handlers/${PD.onPortal}`, { id: PD.onPortal });
      const body = HandlerDetail.parse(await res.json());
      expect(body.client).toBe('partydeck');
      expect(body.currentVersion.fileName).toBe(`handler-${PD.onPortal}-v1.pd2`);
      expect(body.currentVersion.sha256).toBe(sha256(PD_BYTES));
      const nuc = HandlerDetail.parse(
        await (await call(handlerRoute.GET, `/api/v3/handlers/${H.primary}`, { id: H.primary })).json(),
      );
      expect(nuc.client).toBe('nucleus');
    });
  });

  describe('GET /handlers/{id}/download', () => {
    it('serves a PartyDeck package byte for byte as a .pd2 file', async () => {
      const res = await call(downloadRoute.GET, `/api/v3/handlers/${PD.onPortal}/download?count=false`, {
        id: PD.onPortal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="handler-${PD.onPortal}-v1.pd2"`,
      );
      expect(res.headers.get('etag')).toBe(`"${sha256(PD_BYTES)}"`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(PD_BYTES)).toBe(true);
    });

    it('still serves Nucleus Co-op packages as zip .nc files', async () => {
      const res = await call(downloadRoute.GET, `/api/v3/handlers/${H.primary}/download?count=false`, {
        id: H.primary,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="handler-${H.primary}-v2.nc"`,
      );
    });
  });

  describe('GET /handlers/{id}/versions/{version}/script', () => {
    it('has no script for a package the hub does not read', async () => {
      const res = await call(scriptRoute.GET, `/api/v3/handlers/${PD.onPortal}/versions/1/script`, {
        id: PD.onPortal,
        version: '1',
      });
      expect(res.status).toBe(404);
    });

    it('still serves the script of a Nucleus Co-op handler', async () => {
      const res = await call(scriptRoute.GET, `/api/v3/handlers/${H.primary}/versions/2/script`, {
        id: H.primary,
        version: '2',
      });
      expect(res.status).toBe(200);
    });
  });
});
