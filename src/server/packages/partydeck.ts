import { PACKAGE_LIMITS, PackageError } from './limits';
import { scanZip, type ManifestEntry } from './zip';

/**
 * PartyDeck packages (`.pd2`, docs section 12.3): a zip with a `handler.json` at its root, an `overlay/` that
 * is copied over the game, `imgs/`, `icon.png` and sometimes a profile copy. PartyDeck unpacks the archive on
 * the player's machine and runs the `exec` script from it, so the hub holds it to the same zip rules as any
 * package (names, symlinks, bombs, encryption) and checks `handler.json`. It does not rewrite the archive: the
 * bytes the author uploaded are the bytes served.
 *
 * Only what the sample handlers show is required (`name`); every other field is passed on untouched, since
 * the format is PartyDeck's and may grow (`spec_ver`).
 */

export const PARTYDECK_MANIFEST_FILE = 'handler.json';
/** handler.json is a few hundred bytes in practice. */
const MAX_JSON_BYTES = 64 * 1024;

export interface PartyDeckMeta {
  name: string;
  author: string | null;
  version: string | null;
  info: string | null;
  specVer: number | null;
  exec: string | null;
  steamAppId: number | null;
}

export interface PartyDeckInspection {
  meta: PartyDeckMeta;
  manifest: ManifestEntry[];
  entryCount: number;
  totalUncompressed: number;
}

const invalid = (why: string) => new PackageError('handler_invalid', `handler.json ${why}.`);

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

export function parsePartyDeckMeta(raw: Buffer): PartyDeckMeta {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw invalid('is not valid UTF-8 text');
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw invalid('is not valid JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalid('must be a JSON object');
  const o = json as Record<string, unknown>;
  const name = text(o.name, 200);
  if (!name) throw invalid('needs a "name"');
  return {
    name,
    author: text(o.author, 200),
    // PartyDeck writes the version as a string ("2"); a number is accepted too.
    version: typeof o.version === 'number' ? String(o.version) : text(o.version, 50),
    info: text(o.info, 2000),
    specVer: int(o.spec_ver),
    exec: text(o.exec, 260),
    steamAppId: int(o.steam_appid),
  };
}

export async function inspectPartyDeckPackage(
  file: string,
  limits: typeof PACKAGE_LIMITS = PACKAGE_LIMITS,
): Promise<PartyDeckInspection> {
  const scan = await scanZip(
    file,
    {
      match: (name) => name === PARTYDECK_MANIFEST_FILE,
      maxBytes: MAX_JSON_BYTES,
      tooLarge: () => new PackageError('handler_too_large', 'handler.json is larger than 64 KiB.'),
    },
    limits,
  );
  if (!scan.captured) {
    throw new PackageError('missing_handler', 'The package has no handler.json at its root.');
  }
  const manifest = [...scan.manifest].sort((a, b) => a.path.localeCompare(b.path));
  return {
    meta: parsePartyDeckMeta(scan.captured.data),
    manifest,
    entryCount: scan.entryCount,
    totalUncompressed: scan.totalUncompressed,
  };
}
