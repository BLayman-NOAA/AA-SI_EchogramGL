/**
 * A ChunkStore over fetch.
 *
 * One implementation covers the store served from the workstation through the
 * tunnel, a store served from the user's own machine, and object storage. The
 * only difference is whether a header provider supplies a bearer token.
 */

import type { ChunkOptions, ChunkStore, RequestPriority } from './store';

export type HeaderProvider = () =>
  | Record<string, string>
  | Promise<Record<string, string>>;

export interface FetchStoreOptions {
  headers?: HeaderProvider;
  /** Default for every request, where one is not asked for per request. */
  priority?: RequestPriority;
}

export class FetchStore implements ChunkStore {
  private base: URL;

  constructor(
    base: string | URL,
    private options: FetchStoreOptions = {},
  ) {
    const text = base.toString();
    const withSlash = text.endsWith('/') ? text : `${text}/`;
    this.base = new URL(withSlash, globalThis.location?.href ?? 'http://localhost/');
  }

  get href(): string {
    return this.base.href;
  }

  /**
   * Fetch one key.
   *
   * Returns undefined for a missing key, because zarr reads an absent chunk as
   * fill value rather than as an error. Anything else that is not ok throws.
   * A 403 in particular is an expired or insufficient token, and treating it as
   * absence would draw an echogram with holes in it and report no problem.
   */
  async get(key: string, options?: ChunkOptions): Promise<Uint8Array | undefined> {
    const url = new URL(key.replace(/^\/+/, ''), this.base);
    const headers = this.options.headers ? await this.options.headers() : undefined;
    const request: RequestInit = { headers };
    if (options?.signal) request.signal = options.signal;

    // Per request first, because a tile on screen and a speculative ring tile
    // go through one store and 4.5 is about telling them apart.
    const priority = options?.priority ?? this.options.priority;
    if (priority) {
      (request as RequestInit & { priority: string }).priority = priority;
    }

    const response = await fetch(url, request);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url.href}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
