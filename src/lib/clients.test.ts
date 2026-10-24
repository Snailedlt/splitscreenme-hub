import { describe, expect, it } from 'vitest';
import {
  acceptsUpload,
  CLIENT_IDS,
  CLIENTS,
  DEFAULT_CLIENT,
  getClient,
  isClientId,
  packageFileName,
  uploadExtensionsLabel,
} from './clients';

describe('client registry', () => {
  it('has an entry for every id, keyed by its own id', () => {
    for (const id of CLIENT_IDS) expect(CLIENTS[id].id).toBe(id);
    expect(CLIENTS[DEFAULT_CLIENT].packageKind).toBe('nucleus');
  });

  it('keeps Nucleus Co-op exactly as the hub always served it', () => {
    const n = CLIENTS.nucleus;
    expect(n.extension).toBe('.nc');
    expect(n.contentType).toBe('application/zip');
    expect(packageFileName('nucleus', 'abc', 3)).toBe('handler-abc-v3.nc');
  });

  it('serves PartyDeck packages as opaque .pd2 files', () => {
    const p = CLIENTS.partydeck;
    expect(p.packageKind).toBe('opaque');
    expect(packageFileName('partydeck', 'abc', 3)).toBe('handler-abc-v3.pd2');
    expect(p.contentType).toBe('application/octet-stream');
  });

  it('accepts only the tool’s own extensions, case-insensitively', () => {
    expect(acceptsUpload('nucleus', 'My Handler.NC')).toBe(true);
    expect(acceptsUpload('nucleus', 'x.zip')).toBe(true);
    expect(acceptsUpload('nucleus', 'x.pd2')).toBe(false);
    expect(acceptsUpload('partydeck', 'x.PD2')).toBe(true);
    expect(acceptsUpload('partydeck', 'x.nc')).toBe(false);
    expect(acceptsUpload('partydeck', 'x.zip')).toBe(false);
    expect(acceptsUpload('partydeck', 'pd2')).toBe(false);
    expect(acceptsUpload('partydeck', 'x.pd2.exe')).toBe(false);
  });

  it('names the accepted files for the upload form', () => {
    expect(uploadExtensionsLabel('nucleus')).toBe('.nc or .zip');
    expect(uploadExtensionsLabel('partydeck')).toBe('.pd2');
  });

  it('validates ids and falls back to Nucleus Co-op for anything unknown', () => {
    expect(isClientId('partydeck')).toBe(true);
    expect(isClientId('uss')).toBe(false);
    expect(isClientId(undefined)).toBe(false);
    expect(getClient('nope').id).toBe('nucleus');
    expect(getClient(null).id).toBe('nucleus');
    expect(getClient('partydeck').id).toBe('partydeck');
  });
});
