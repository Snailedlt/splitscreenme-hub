import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { auditLog, handlerVersions, handlers } from '@/db/schema';
import { resetAllRateLimits } from '@/lib/rate-limit';
import { absolutePath, tempPath } from '@/lib/storage';
import { asViewer, makeHandler, makeUser } from '@/server/auth/test-fixtures';
import { createHandler, parseHandlerMeta } from '@/server/private/handlers';
import { setVersionVerified } from '@/server/private/moderation';
import { dbAvailable, truncateAll } from '@/test/db';
import { receiveUpload, UploadRequestError } from './receive';
import { buildZip, VALID_SCRIPT } from './test-zip';
import { processUpload } from './upload';

const meta = () => {
  const r = parseHandlerMeta({
    title: 'Deck handler',
    description: '',
    maxPlayers: '2',
    controllers: 'yes',
    keyboardMouse: 'unknown',
    multiKeyboardMouse: 'unknown',
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const multipart = (fileName: string, bytes: Buffer) => {
  const form = new FormData();
  form.set('package', new Blob([new Uint8Array(bytes)]), fileName);
  form.set('releaseNotes', 'notes');
  return new Request('http://localhost/upload', { method: 'POST', body: form });
};

describe('receiving an upload for each tool', () => {
  it('accepts a .pd2 for PartyDeck and keeps the bytes', async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 255]);
    const got = await receiveUpload(multipart('thing.PD2', bytes), undefined, 'partydeck');
    expect((await readFile(got.file)).equals(bytes)).toBe(true);
    expect(got.fileName).toBe('thing.PD2');
    expect(got.fields.releaseNotes).toBe('notes');
  });

  it('refuses the other tool’s file type, and names the right one', async () => {
    await expect(
      receiveUpload(multipart('x.nc', Buffer.from('PK')), undefined, 'partydeck'),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Upload a .pd2 package.',
    });
    await expect(
      receiveUpload(multipart('x.pd2', Buffer.from('PK')), undefined, 'nucleus'),
    ).rejects.toBeInstanceOf(UploadRequestError);
    await expect(
      receiveUpload(multipart('x.zip', Buffer.from('PK')), undefined, 'partydeck'),
    ).rejects.toThrow('Upload a .pd2 package.');
  });

  it('still takes .nc and .zip for Nucleus Co-op, the default', async () => {
    for (const name of ['a.nc', 'b.zip']) {
      const got = await receiveUpload(multipart(name, Buffer.from('PK data')));
      expect(got.size).toBe(7);
    }
    await expect(receiveUpload(multipart('c.exe', Buffer.from('MZ')))).rejects.toThrow(
      'Upload a .nc or .zip package.',
    );
  });
});

describe.runIf(dbAvailable())('handlers of other tools', () => {
  beforeEach(async () => {
    await truncateAll();
    resetAllRateLimits();
  });

  it('creates a handler for the chosen tool, and for Nucleus Co-op when none is given', async () => {
    const owner = asViewer(await makeUser());
    const gameId = (await makeHandler(owner.id)).gameId;
    const viewer = { ...owner, trustedAuthor: false };
    const deck = await createHandler(viewer, { gameId, client: 'partydeck', meta: meta(), ip: '1' });
    const plain = await createHandler(viewer, { gameId, meta: meta(), ip: '1' });
    const rows = await getDb().select({ id: handlers.id, client: handlers.client }).from(handlers);
    const clientOf = (r: typeof deck) => rows.find((x) => r.ok && x.id === r.value.id)?.client;
    expect(clientOf(deck)).toBe('partydeck');
    expect(clientOf(plain)).toBe('nucleus');
    const [log] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'handler.create'));
    expect(log?.details).toMatchObject({ client: 'partydeck' });
  });

  it('checks a PartyDeck package, then stores it exactly as uploaded: no stamp, no script, same bytes', async () => {
    const owner = asViewer(await makeUser({ username: 'deckmaker' }));
    const gameId = (await makeHandler(owner.id)).gameId;
    const created = await createHandler(
      { ...owner, trustedAuthor: false },
      { gameId, client: 'partydeck', meta: meta(), ip: '1' },
    );
    const id = created.ok ? created.value.id : '';

    const bytes = buildZip([
      { name: 'handler.json', data: JSON.stringify({ name: 'Deck game', spec_ver: 3, steam_appid: 12 }) },
      { name: 'overlay/partydeckrun.sh', data: '#!/bin/bash\n' },
      { name: 'overlay/server/Server.dll', data: 'MZ' },
      { name: 'icon.png', data: Buffer.from([0x89, 0x50]) },
    ]);
    const tmp = await tempPath();
    await writeFile(tmp, bytes);
    const out = await processUpload({
      actor: owner,
      handlerId: id,
      tempFile: tmp,
      releaseNotes: 'First',
      ip: '1',
    });
    expect(out.version).toBe(1);
    expect(out.executables).toBe(2); // the .sh and the .dll are what a moderator looks at

    const [v] = await getDb().select().from(handlerVersions).where(eq(handlerVersions.id, out.versionId));
    expect(v?.storageKey).toBe(`packages/${id}/${out.versionId}.pd2`);
    expect(v?.fileName).toBe(`handler-${id}-v1.pd2`);
    expect(v?.script).toBe('');
    expect(v?.manifest.map((m) => m.path)).toEqual([
      'handler.json',
      'icon.png',
      'overlay/partydeckrun.sh',
      'overlay/server/Server.dll',
    ]);
    expect(v?.verifiedAt).toBeNull();
    expect(v?.sizeBytes).toBe(bytes.length);
    const stored = await readFile(absolutePath(v!.storageKey));
    expect(stored.equals(bytes)).toBe(true);
    await expect(readFile(tmp)).rejects.toThrow(); // temp removed

    const [h] = await getDb().select().from(handlers).where(eq(handlers.id, id));
    expect(h?.currentVersionId).toBe(out.versionId);
    const [log] = await getDb().select().from(auditLog).where(eq(auditLog.action, 'version.upload'));
    expect(log?.details).toMatchObject({
      client: 'partydeck',
      files: 4,
      executables: 2,
      archive: { name: 'Deck game', specVer: 3, steamAppId: 12 },
    });

    // A second upload is version 2, and a moderator can verify it like any other.
    const tmp2 = await tempPath();
    await writeFile(tmp2, bytes);
    const second = await processUpload({
      actor: owner,
      handlerId: id,
      tempFile: tmp2,
      releaseNotes: 'Two',
      ip: '1',
    });
    expect(second.version).toBe(2);
    const mod = asViewer(await makeUser({ role: 'moderator' }));
    expect((await setVersionVerified(mod, second.versionId, true, '1')).ok).toBe(true);
  });

  it('refuses a PartyDeck package without a usable handler.json, and records nothing', async () => {
    const owner = asViewer(await makeUser());
    const gameId = (await makeHandler(owner.id)).gameId;
    const created = await createHandler(
      { ...owner, trustedAuthor: false },
      { gameId, client: 'partydeck', meta: meta(), ip: '1' },
    );
    const id = created.ok ? created.value.id : '';
    const upload = async (data: Buffer) => {
      const tmp = await tempPath();
      await writeFile(tmp, data);
      return processUpload({ actor: owner, handlerId: id, tempFile: tmp, releaseNotes: 'x', ip: '1' });
    };
    await expect(upload(Buffer.alloc(0))).rejects.toMatchObject({ code: 'not_zip' });
    await expect(upload(Buffer.from([1, 2, 3, 4, 5, 6]))).rejects.toMatchObject({ code: 'not_zip' });
    // A Nucleus Co-op package is not a PartyDeck one.
    await expect(upload(buildZip([{ name: 'handler.js', data: VALID_SCRIPT }]))).rejects.toMatchObject({
      code: 'missing_handler',
    });
    await expect(upload(buildZip([{ name: 'handler.json', data: '{}' }]))).rejects.toMatchObject({
      code: 'handler_invalid',
    });
    await expect(
      upload(
        buildZip([
          { name: 'handler.json', data: '{"name":"G"}' },
          { name: 'overlay/../../x', data: 'x' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
    const versions = await getDb().select().from(handlerVersions).where(eq(handlerVersions.handlerId, id));
    expect(versions).toHaveLength(0);
  });

  it('still reads, stamps and rebuilds a Nucleus Co-op package', async () => {
    const owner = asViewer(await makeUser({ username: 'ncmaker' }));
    const gameId = (await makeHandler(owner.id)).gameId;
    const created = await createHandler(
      { ...owner, trustedAuthor: false },
      { gameId, meta: meta(), ip: '1' },
    );
    const id = created.ok ? created.value.id : '';
    const tmp = await tempPath();
    await writeFile(tmp, buildZip([{ name: 'handler.js', data: VALID_SCRIPT }]));
    const out = await processUpload({
      actor: owner,
      handlerId: id,
      tempFile: tmp,
      releaseNotes: 'First',
      ip: '1',
    });
    const [v] = await getDb().select().from(handlerVersions).where(eq(handlerVersions.id, out.versionId));
    expect(v?.storageKey).toBe(`packages/${id}/${out.versionId}.nc`);
    expect(v?.fileName).toBe(`handler-${id}-v1.nc`);
    expect(v?.script).toContain(`Hub.Handler.Id = "${id}";`);
    expect(v?.manifest).toEqual([{ path: 'handler.js', size: expect.any(Number) }]);
  });
});
