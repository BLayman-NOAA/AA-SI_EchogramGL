/**
 * Splitting a view into its own window.
 *
 * Two constraints shape this. The window has to open synchronously inside the
 * click handler, because a browser blocks `window.open` called from a promise
 * continuation and the block is silent. And the new window cannot be handed an
 * object: it starts empty, so the configuration reaches it over the link once
 * it says hello.
 *
 * The handoff is therefore: open the window with the group in its URL, and
 * answer the hello it sends with the settings. That also covers the window
 * being reopened, or opened by hand at the same URL, since nothing depends on
 * the opener still being the one holding the configuration.
 */

import type { ViewSettings } from '../app/settings';
import type { Link } from './channel';

export interface PopoutOptions {
  /** The link the new window will join. */
  group: string;
  /** What to send when it asks. */
  settings: () => ViewSettings | undefined;
  /** The route the second window loads. */
  route?: string;
  features?: string;
  /** Defaults to window.open, so a test can watch without opening anything. */
  open?: (url: string, target: string, features: string) => Window | null;
}

/**
 * Where a second window lives.
 *
 * With the extension, not a bare /view. The viewer is served as static files,
 * by the development server here and by object storage later, and neither has
 * routing rules to map an extensionless path onto a page.
 */
export const VIEW_ROUTE = '/view.html';

const DEFAULT_FEATURES = 'popup=yes,width=1100,height=750';

/**
 * Open a second window on the same group.
 *
 * Returns the window, or null where the browser refused. Called straight from a
 * click handler: nothing here awaits before opening, and nothing should be
 * added in front of it.
 */
export function popOut(options: PopoutOptions): Window | null {
  const open = options.open ?? defaultOpen;
  const route = options.route ?? VIEW_ROUTE;
  const url = `${route}?group=${encodeURIComponent(options.group)}`;
  // Named by group rather than left blank, so a second click on a split that
  // is already open raises that window instead of opening a third.
  return open(url, `echogram-${options.group}`, options.features ?? DEFAULT_FEATURES);
}

/**
 * Answer a new window's hello with the configuration it needs.
 *
 * Attached by whichever view is doing the splitting. It replies to any hello on
 * its group, which is what makes reopening the window work.
 */
export function serveHandoff(link: Link, settings: () => ViewSettings | undefined) {
  return (message: { kind: string }) => {
    if (message.kind !== 'hello') return;
    const found = settings();
    if (found) link.send({ kind: 'settings', settings: found });
  };
}

function defaultOpen(url: string, target: string, features: string): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open(url, target, features);
}
