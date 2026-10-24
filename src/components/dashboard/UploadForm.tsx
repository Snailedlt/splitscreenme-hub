'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { CLIENTS, DEFAULT_CLIENT, uploadExtensionsLabel, type ClientId } from '@/lib/clients';

type Status =
  | { kind: 'idle' }
  | { kind: 'sending'; percent: number }
  | { kind: 'processing' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string; field?: string };

/**
 * Uploads a package to /api/me/handlers/<id>/versions. With JavaScript: XHR (upload progress), answer
 * shown in place. Without: a plain multipart POST, the route redirects back here. The package type follows
 * the handler's tool: a Nucleus Co-op zip with handler.js is stamped, another tool's file is stored as is.
 */
export function UploadForm({
  handlerId,
  nextVersion,
  maxBytes,
  client = DEFAULT_CLIENT,
}: {
  handlerId: string;
  nextVersion: number;
  maxBytes: number;
  client?: ClientId;
}) {
  const tool = CLIENTS[client];
  const stamped = tool.packageKind === 'nucleus';
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const busy = status.kind === 'sending' || status.kind === 'processing';
  const url = `/api/me/handlers/${encodeURIComponent(handlerId)}/versions`;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const file = (form.elements.namedItem('package') as HTMLInputElement).files?.[0];
    if (!file) {
      return setStatus({
        kind: 'error',
        message: `Choose a ${uploadExtensionsLabel(client)} package.`,
        field: 'package',
      });
    }
    if (file.size > maxBytes) {
      return setStatus({ kind: 'error', message: 'The package is larger than 30 MiB.', field: 'package' });
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const percent = Math.round((ev.loaded / ev.total) * 100);
      setStatus(percent >= 100 ? { kind: 'processing' } : { kind: 'sending', percent });
    };
    xhr.onerror = () => setStatus({ kind: 'error', message: 'The connection dropped. Try again.' });
    xhr.onload = () => {
      let body: { ok?: boolean; message?: string; version?: number; executables?: number; field?: string } =
        {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // nginx error pages are HTML
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
        form.reset();
        setStatus({
          kind: 'done',
          message:
            `Version ${body.version} is up. It is now the current version, marked unverified until a moderator checks it.` +
            (body.executables
              ? ` It contains ${body.executables} executable file(s): expect a closer look.`
              : ''),
        });
        router.refresh();
      } else {
        const message =
          body.message ??
          (xhr.status === 413
            ? 'The package is larger than 30 MiB.'
            : `The upload failed (HTTP ${xhr.status}).`);
        setStatus({ kind: 'error', message, field: body.field });
      }
    };
    setStatus({ kind: 'sending', percent: 0 });
    xhr.send(new FormData(form));
  };

  return (
    <form
      ref={formRef}
      action={url}
      method="post"
      encType="multipart/form-data"
      onSubmit={onSubmit}
      className="grid gap-4"
      aria-busy={busy || undefined}
    >
      <div className="form-field">
        <label htmlFor="package">Package ({tool.extension})</label>
        <input
          id="package"
          name="package"
          type="file"
          accept={tool.uploadExtensions.join(',')}
          required
          className="control"
          aria-invalid={status.kind === 'error' && status.field === 'package' ? true : undefined}
          aria-describedby="package-hint"
        />
        <p className="form-hint" id="package-hint">
          {stamped ? (
            <>
              A zip with <code>handler.js</code> at its root, 30 MiB at most, no symbolic links. We stamp it
              as version {nextVersion} (<code>Hub.Handler.Version</code>, <code>Hub.Handler.Id</code>,
              maintainer).
            </>
          ) : (
            <>
              The {tool.label} package file, 30 MiB at most. The hub does not open it: it is stored and served
              as it is, as version {nextVersion}, and a moderator checks it before it is marked verified.
            </>
          )}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor="releaseNotes">Release notes</label>
        <textarea
          id="releaseNotes"
          name="releaseNotes"
          className="control"
          rows={4}
          minLength={2}
          maxLength={2000}
          required
          placeholder="What changed in this version?"
          aria-invalid={status.kind === 'error' && status.field === 'releaseNotes' ? true : undefined}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" icon="update" disabled={busy}>
          {busy ? 'Uploading…' : `Upload version ${nextVersion}`}
        </Button>
        {status.kind === 'sending' && (
          <span className="flex min-w-48 items-center gap-2" role="status">
            <progress max={100} value={status.percent} className="w-40" aria-label="Upload progress" />
            <span className="small muted">{status.percent}%</span>
          </span>
        )}
        {status.kind === 'processing' && (
          <span className="small muted" role="status">
            {stamped ? 'Checking and stamping the package…' : 'Storing the package…'}
          </span>
        )}
      </div>
      {status.kind === 'done' && (
        <p role="status" className="small text-ok">
          {status.message}
        </p>
      )}
      {status.kind === 'error' && (
        <p role="alert" className="form-error small">
          {status.message}
        </p>
      )}
    </form>
  );
}
