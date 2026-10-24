import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectPartyDeckPackage, parsePartyDeckMeta } from './partydeck';
import { buildZip, type RawEntry } from './test-zip';

// The shape of a real handler (Celeste, spec_ver 3): handler.json, icon, screenshots, an overlay with launch
// scripts and bundled binaries, a profile copy. Content is synthetic.
const HANDLER_JSON = JSON.stringify({
  name: 'Celeste',
  author: 'someone/someone else',
  version: '2',
  info: 'Install the mod first.',
  spec_ver: 3,
  exec: 'partydeckrun.sh',
  args: '$INSTANCENUM',
  use_goldberg: true,
  steam_appid: 504230,
});

const sample = (extra: RawEntry[] = [], json: string | Buffer = HANDLER_JSON): RawEntry[] => [
  { name: 'handler.json', data: json },
  { name: 'profile_copy_home/' },
  { name: 'profile_copy_home/.local/share/Celeste/Saves/modsettings.celeste', data: 'x' },
  { name: 'icon.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'imgs/' },
  { name: 'imgs/1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'overlay/' },
  {
    name: 'overlay/partydeckrun.sh',
    data: '#!/bin/bash\n./runstandalone.sh\n',
    versionMadeBy: 0x031e,
    externalAttr: (0o100755 << 16) >>> 0,
  },
  { name: 'overlay/server/Server.dll', data: 'MZ' },
  ...extra,
];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pd2-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const write = async (name: string, entries: RawEntry[]) => {
  const file = path.join(dir, name);
  await writeFile(file, buildZip(entries));
  return file;
};

describe('parsePartyDeckMeta', () => {
  it('reads the fields PartyDeck writes', () => {
    expect(parsePartyDeckMeta(Buffer.from(HANDLER_JSON))).toEqual({
      name: 'Celeste',
      author: 'someone/someone else',
      version: '2',
      info: 'Install the mod first.',
      specVer: 3,
      exec: 'partydeckrun.sh',
      steamAppId: 504230,
    });
  });

  it('needs only a name, and ignores fields it does not know', () => {
    const meta = parsePartyDeckMeta(Buffer.from('{"name":" Game ","future_field":{"a":1},"version":3}'));
    expect(meta).toMatchObject({ name: 'Game', version: '3', author: null, specVer: null, steamAppId: null });
  });

  it('accepts a BOM', () => {
    expect(parsePartyDeckMeta(Buffer.from('﻿{"name":"G"}')).name).toBe('G');
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no name', '{"author":"a"}'],
    ['a blank name', '{"name":"  "}'],
    ['a numeric name', '{"name":5}'],
  ])('refuses %s', (_label, body) => {
    expect(() => parsePartyDeckMeta(Buffer.from(body))).toThrowError(/handler\.json/);
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(() => parsePartyDeckMeta(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toThrowError(/UTF-8/);
  });
});

describe('inspectPartyDeckPackage', () => {
  it('accepts a handler shaped like the real ones and lists its files', async () => {
    const out = await inspectPartyDeckPackage(await write('ok.pd2', sample()));
    expect(out.meta.name).toBe('Celeste');
    expect(out.manifest.map((m) => m.path)).toEqual([
      'handler.json',
      'icon.png',
      'imgs/1.png',
      'overlay/partydeckrun.sh',
      'overlay/server/Server.dll',
      'profile_copy_home/.local/share/Celeste/Saves/modsettings.celeste',
    ]);
    expect(out.manifest.find((m) => m.path === 'handler.json')?.size).toBe(HANDLER_JSON.length);
  });

  it('wants handler.json at the root, spelled exactly', async () => {
    await expect(
      inspectPartyDeckPackage(await write('nojson.pd2', [{ name: 'overlay/x.sh', data: 'x' }])),
    ).rejects.toMatchObject({ code: 'missing_handler' });
    await expect(
      inspectPartyDeckPackage(
        await write('nested.pd2', [{ name: 'Celeste/handler.json', data: HANDLER_JSON }]),
      ),
    ).rejects.toMatchObject({ code: 'missing_handler' });
    await expect(
      inspectPartyDeckPackage(await write('case.pd2', [{ name: 'Handler.JSON', data: HANDLER_JSON }])),
    ).rejects.toMatchObject({ code: 'missing_handler' });
  });

  it('refuses a broken handler.json', async () => {
    await expect(
      inspectPartyDeckPackage(await write('bad.pd2', sample([], '{"author":"x"}'))),
    ).rejects.toMatchObject({
      code: 'handler_invalid',
    });
    await expect(
      inspectPartyDeckPackage(
        await write('big.pd2', sample([], JSON.stringify({ name: 'x', pad: 'y'.repeat(70_000) }))),
      ),
    ).rejects.toMatchObject({ code: 'handler_too_large' });
  });

  it('applies the zip rules every package goes through: PartyDeck unpacks these on the player’s machine', async () => {
    const cases: [string, RawEntry[], string][] = [
      ['traversal', sample([{ name: 'overlay/../../etc/cron.d/x', data: 'x' }]), 'unsafe_path'],
      ['absolute', sample([{ name: '/etc/passwd', data: 'x' }]), 'unsafe_path'],
      ['backslash', sample([{ name: 'overlay\\x.sh', data: 'x' }]), 'unsafe_path'],
      [
        'symlink',
        sample([
          { name: 'overlay/link', data: '/etc', versionMadeBy: 0x031e, externalAttr: (0o120777 << 16) >>> 0 },
        ]),
        'symlink',
      ],
      ['encrypted', sample([{ name: 'overlay/secret.bin', data: 'x', flags: 1 }]), 'encrypted'],
      ['duplicate', sample([{ name: 'ICON.png', data: 'x' }]), 'duplicate'],
      ['bomb', sample([{ name: 'overlay/zeros.bin', data: Buffer.alloc(8 * 1024 * 1024) }]), 'zip_bomb'],
    ];
    for (const [label, entries, code] of cases) {
      await expect(
        inspectPartyDeckPackage(await write(`${label}.pd2`, entries)),
        label,
      ).rejects.toMatchObject({
        code,
      });
    }
  });

  it('refuses a file that is not a zip', async () => {
    const file = path.join(dir, 'plain.pd2');
    await writeFile(file, Buffer.from('not a zip at all'));
    await expect(inspectPartyDeckPackage(file)).rejects.toMatchObject({ code: 'not_zip' });
  });
});
