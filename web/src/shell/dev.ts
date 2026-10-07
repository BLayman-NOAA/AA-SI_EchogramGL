/**
 * Development page.
 *
 * An `EchogramPanel` with two data pickers above it, one for recipe steps and
 * one for stores and paths, and the split window. The panel draws and holds
 * the rendering controls; everything here is how this page finds data, which
 * is what an embedding host replaces with its own.
 */

import { createGpuContext, describeContext } from '../device/context';
import { EchogramPanel } from '../panel/EchogramPanel';
import { Link, newViewId } from './channel';
import { popOut, serveHandoff } from './popout';
import { pathsProvider } from './providers/paths';
import { recipeProvider } from './providers/recipe';
import { spawnDecodeWorker } from './worker';

const root = window.document.getElementById('app');
if (!root) throw new Error('no element with id app');

/** Where the catalog answers: this page's own origin, proxied or served. */
const server = new URL('/', globalThis.location.href).href;

const context = await createGpuContext().catch((error) => {
  root.textContent = error instanceof Error ? error.message : String(error);
  return undefined;
});

if (context) {
  /** One group per page load, so two tabs do not link to each other by accident. */
  const group = newViewId();
  let link: Link | undefined;

  const panel = new EchogramPanel({
    container: root,
    context,
    spawnWorker: spawnDecodeWorker,
    storageKey: 'echogram.sections',
    onError: (error) => console.error(error),
    onViewChange: () => {
      const info = panel.view.info;
      if (info) link?.send({ kind: 'viewport', x: info.x, y: info.y });
    },
  });

  globalThis.addEventListener('unhandledrejection', (event) => panel.showError(event.reason));
  globalThis.addEventListener('error', (event) =>
    panel.showError(event.error ?? event.message),
  );

  // Both pickers in one section, one above the other.
  const data = window.document.createElement('div');
  data.style.display = 'flex';
  data.style.flexDirection = 'column';
  data.style.gap = '8px';
  for (const provider of [recipeProvider(server), pathsProvider(server)]) {
    data.append(provider.mount(panel));
  }
  panel.addSection('data', 'Data', data);

  const split = window.document.createElement('button');
  split.type = 'button';
  split.textContent = 'split window';
  const adapter = window.document.createElement('button');
  adapter.type = 'button';
  adapter.textContent = 'adapter';
  panel.appendTo('display', split);
  panel.appendTo('display', adapter);

  link = new Link({
    id: newViewId(),
    group,
    onMessage: (message) => {
      // A split window asking for the configuration, and a viewport it moved.
      // Nothing else is accepted here: this window owns the controls.
      serveHandoff(link!, () => panel.settingsObject)(message);
      if (message.kind === 'viewport') panel.view.setViewport(message.x, message.y);
    },
  });
  globalThis.addEventListener('pagehide', () => link?.close());

  // Straight from the click, with nothing awaited in front of it. A window
  // opened from a promise continuation is blocked, and blocked silently.
  split.addEventListener('click', () => {
    if (!popOut({ group, settings: () => panel.settingsObject })) {
      panel.showError(
        new Error('the browser refused a second window. Allow popups for this page.'),
      );
    }
  });
  adapter.addEventListener('click', () => {
    panel.showError(new Error(JSON.stringify(describeContext(context), null, 2)));
  });
}
