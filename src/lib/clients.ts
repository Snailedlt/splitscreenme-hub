/**
 * The split-screen tools the hub hosts handlers for (docs/ARCHITECTURE.md section 12). One place for what each
 * tool is called, which package file it reads and how the hub treats that file, shared by the schema, the
 * upload pipeline, the API and the pages.
 *
 * Adding a tool: add its id here and to the `handler_client` enum in `src/db/schema.ts` (with a migration).
 * Nothing else needs to know the list.
 */

export const CLIENT_IDS = ['nucleus', 'partydeck'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** Handlers published before the hub knew about other tools are all Nucleus Co-op handlers. */
export const DEFAULT_CLIENT: ClientId = 'nucleus';

/**
 * How the hub treats the uploaded file:
 * - `nucleus`: a zip with a root `handler.js` that the hub reads, validates, stamps and rebuilds (6.3).
 * - `opaque`: the tool's own package. The hub checks the size and the extension, hashes and stores the
 *   file as it is, and serves it as a download. It never opens, runs or rewrites it. A moderator verifies it
 *   by hand like any other version.
 */
export type PackageKind = 'nucleus' | 'opaque';

export interface ClientInfo {
  id: ClientId;
  /** Name shown to people. */
  label: string;
  /** Short name for badges. */
  shortLabel: string;
  /** Operating system the tool runs on, as its own documentation states it. */
  platform: string;
  packageKind: PackageKind;
  /** Extension of the file the hub serves for a version, with the dot. */
  extension: string;
  /** Extensions accepted on upload, lower case, with the dot. The first one is the canonical one. */
  uploadExtensions: readonly string[];
  /** Media type of the download. */
  contentType: string;
  /** Project home page, shown on the pages of its handlers. */
  homepage: string;
  /** One sentence for the handler page: what to do with the downloaded file. */
  installHint: string;
  /** What the tool itself needs, as its own documentation states it (shown under "what you need"). */
  platformNote?: string;
}

export const CLIENTS: Record<ClientId, ClientInfo> = {
  nucleus: {
    id: 'nucleus',
    label: 'Nucleus Co-op',
    shortLabel: 'Nucleus',
    platform: 'Windows',
    packageKind: 'nucleus',
    extension: '.nc',
    uploadExtensions: ['.nc', '.zip'],
    contentType: 'application/zip',
    homepage: 'https://github.com/SplitScreen-Me/splitscreenme-nucleus',
    installHint:
      'Open the game in Nucleus Co-op and install the handler from the hub, or import the .nc file.',
  },
  partydeck: {
    id: 'partydeck',
    label: 'PartyDeck',
    shortLabel: 'PartyDeck',
    platform: 'Linux and SteamOS',
    packageKind: 'opaque',
    extension: '.pd2',
    uploadExtensions: ['.pd2'],
    contentType: 'application/octet-stream',
    homepage: 'https://github.com/partydeck/partydeck',
    installHint: 'In PartyDeck, use the Import button and pick the downloaded .pd2 file.',
    platformNote:
      'PartyDeck runs native Linux games and Windows games (through Proton). It works out of the box on SteamOS 3.8.1 or newer, and on desktop Linux. Its window tiling script needs KDE Plasma 6.0 or later.',
  },
};

export const isClientId = (v: unknown): v is ClientId =>
  typeof v === 'string' && (CLIENT_IDS as readonly string[]).includes(v);

/** `getClient('partydeck')`; an unknown value (never expected from the database) falls back to Nucleus. */
export const getClient = (id: string | null | undefined): ClientInfo =>
  CLIENTS[isClientId(id) ? id : DEFAULT_CLIENT];

/** `handler-<id>-v<n>.<ext>`: the name the hub gives a version's file. */
export const packageFileName = (client: ClientId, handlerId: string, version: number) =>
  `handler-${handlerId}-v${version}${CLIENTS[client].extension}`;

/** Does this uploaded file name belong to the tool? Case-insensitive. */
export const acceptsUpload = (client: ClientId, fileName: string) => {
  const lower = fileName.toLowerCase();
  return CLIENTS[client].uploadExtensions.some((ext) => lower.endsWith(ext));
};

/** "`.nc` (or `.zip`)", "`.pd2`": how the upload form names the accepted files. */
export const uploadExtensionsLabel = (client: ClientId) => CLIENTS[client].uploadExtensions.join(' or ');
