/**
 * Adding a store or dataset by where it is.
 *
 * A URL the browser can read, such as `/store/` or `https://...`, is opened
 * as it is: a pyramid, or a plain Sv dataset read as one level. Anything else,
 * a path on the server's disk or a `gs://` URL, is the server's to read, so
 * `/api/open` is asked what is there and mounts it.
 */

import { fetchJson } from '../../data/pieces';
import { type Resolution, describeFound, toSpec } from './catalog';
import {
  type ProviderHost,
  type SourceProvider,
  field,
  freeId,
  remembered,
  sourceList,
} from './provider';

const REMEMBERED = 'echogram.paths.fields';

/** Whether a location is one the browser reads itself. */
export function browserReadable(location: string): boolean {
  return /^https?:\/\//i.test(location) || location.startsWith('/');
}

/** The `/api/open` URL for a path the server reads. */
export function openUrl(server: string, path: string): string {
  return new URL(`api/open?${new URLSearchParams({ path })}`, server).href;
}

/** A source id from a location: its last part. */
export function nameOf(location: string): string {
  const parts = location.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || 'store';
}

/**
 * The path picker. With `autoOpen`, the store the server was started with is
 * opened if it has one, which is what `aa-echogram serve --store` is for.
 */
export function pathsProvider(server: string, autoOpen = true): SourceProvider {
  return {
    id: 'paths',
    title: 'Stores and paths',
    mount: (host) => mountPaths(server, host, autoOpen),
  };
}

function mountPaths(server: string, host: ProviderHost, autoOpen: boolean): HTMLElement {
  const doc = window.document;
  const form = doc.createElement('form');
  form.className = 'egl-row';
  form.style.padding = '0';
  const location = field('store or path', {
    className: 'egl-wide',
    placeholder: '/store/, a URL, a path, or gs://...',
    title:
      "A URL is opened by the browser. A path or gs:// URL is read by the server, " +
      'which works out whether it is a pyramid or a dataset.',
  });
  const add = doc.createElement('button');
  add.type = 'submit';
  add.textContent = 'add';
  const list = doc.createElement('span');
  const note = doc.createElement('span');
  note.className = 'egl-note';
  form.append(location.label, add, list, note);

  const memory = remembered(REMEMBERED);
  location.input.value = memory.read().location ?? '/store/';

  const added: string[] = [];
  const relist = () =>
    sourceList(
      list,
      added.map((id) => ({ id, label: id })),
      (id) =>
        void host
          .removeSource(id)
          .then(() => {
            added.splice(added.indexOf(id), 1);
            relist();
          })
          .catch((error) => host.showError(error)),
    );

  async function open(where: string) {
    note.textContent = '';
    if (!where) {
      note.textContent = 'name a store or path';
      return;
    }
    try {
      const id = freeId(host.sourceIds, nameOf(where));
      if (browserReadable(where)) {
        await host.addSource(id, where);
      } else {
        note.textContent = `opening ${where}...`;
        const resolution = await fetchJson<Resolution>(openUrl(server, where));
        await host.addSource(id, toSpec(server, resolution));
        note.textContent = describeFound(resolution);
      }
      added.push(id);
      relist();
    } catch (error) {
      note.textContent = '';
      host.showError(error);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const where = location.input.value.trim();
    memory.write({ location: where });
    void open(where);
  });

  if (autoOpen) {
    void served(server).then((found) => {
      if (found && !host.sourceIds.length) void open('/store/');
    });
  }
  return form;
}

/** Whether the server was started with a store, checked without an error. */
async function served(server: string): Promise<boolean> {
  for (const key of ['zarr.json', '.zgroup']) {
    try {
      const response = await fetch(new URL(`store/${key}`, server), { method: 'HEAD' });
      if (response.ok) return true;
    } catch {
      return false;
    }
  }
  return false;
}
