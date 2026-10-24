import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PACKAGE_LIMITS, PackageError } from './limits';

/**
 * Packages of tools whose format the hub does not read (`packageKind: 'opaque'` in src/lib/clients.ts, docs
 * section 12). The hub does not open, run or rewrite them: it copies the upload to its final temp path while
 * hashing it and counting bytes, and the file is then stored and served exactly as it came. A moderator
 * verifies such a version by hand, like any other.
 *
 * The size was already limited while receiving (`receiveUpload`); it is checked again here so this stays safe
 * on its own.
 */
export async function copyOpaquePackage(
  source: string,
  dest: string,
  maxBytes: number = PACKAGE_LIMITS.maxUploadBytes,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes)
        return cb(new PackageError('too_large', 'The package is larger than 30 MiB.'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(source), counter, createWriteStream(dest, { flags: 'wx' }));
  if (sizeBytes === 0) throw new PackageError('corrupt', 'The package is empty.');
  return { sha256: hash.digest('hex'), sizeBytes };
}
