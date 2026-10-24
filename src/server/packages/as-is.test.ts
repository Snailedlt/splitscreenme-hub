import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyPackageAsIs } from './as-is';

describe('copyPackageAsIs', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssm-as-is-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the bytes unchanged and reports their size and SHA-256', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, ...Buffer.from('not a zip, not text')]);
    const src = path.join(dir, 'a.pd2');
    const dest = path.join(dir, 'a.out');
    await writeFile(src, bytes);
    const out = await copyPackageAsIs(src, dest);
    expect(out.sizeBytes).toBe(bytes.length);
    expect(out.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await readFile(dest)).equals(bytes)).toBe(true);
  });

  it('stops past the size limit', async () => {
    const src = path.join(dir, 'big.pd2');
    await writeFile(src, Buffer.alloc(2048, 7));
    await expect(copyPackageAsIs(src, path.join(dir, 'big.out'), 1024)).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('refuses an empty package', async () => {
    const src = path.join(dir, 'empty.pd2');
    await writeFile(src, Buffer.alloc(0));
    await expect(copyPackageAsIs(src, path.join(dir, 'empty.out'))).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('never overwrites an existing destination', async () => {
    const src = path.join(dir, 'c.pd2');
    const dest = path.join(dir, 'c.out');
    await writeFile(src, 'data');
    await writeFile(dest, 'existing');
    await expect(copyPackageAsIs(src, dest)).rejects.toThrow();
    expect(await readFile(dest, 'utf8')).toBe('existing');
  });
});
