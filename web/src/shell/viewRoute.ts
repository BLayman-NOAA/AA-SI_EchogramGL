/**
 * The second window.
 *
 * A panel and nothing else: no controls, because it is linked to a view that
 * has them. It starts empty, says hello on its group, and draws whatever
 * configuration comes back. After that the two move together.
 *
 * Opened by popOut, and equally by pasting the URL into a second window. That
 * is deliberate, and it is why the handoff is a hello and an answer rather than
 * anything passed through window.open: nothing here depends on having an
 * opener, so a reloaded window recovers by asking again.
 */

import { EchogramView } from '../app/EchogramView';
import { parseSettings } from '../app/settings';
import { createGpuContext } from '../device/context';
import { Link, newViewId } from './channel';
import { spawnDecodeWorker } from './worker';

const status = document.getElementById('status') as HTMLDivElement;
const plot = document.getElementById('plot') as HTMLDivElement;
const errorBox = document.getElementById('error') as HTMLPreElement;

const group = new URLSearchParams(globalThis.location.search).get('group') ?? 'default';
const id = newViewId();

const context = await createGpuContext().catch((error) => {
  show(error);
  return undefined;
});

if (context) {
  const view = new EchogramView({
    container: plot,
    context,
    onError: show,
    spawnWorker: spawnDecodeWorker,
    onViewChange: () => {
      describe();
      const info = view.info;
      if (info) link.send({ kind: 'viewport', x: info.x, y: info.y });
    },
  });

  const link = new Link({
    id,
    group,
    onMessage: (message) => {
      if (message.kind === 'viewport') {
        view.setViewport(message.x, message.y);
        describe();
        return;
      }
      if (message.kind === 'settings') {
        // Parsed rather than trusted. It arrived from another window, which may
        // be running an older build of this page, and settings.ts is where a
        // version that cannot be applied is refused with a reason.
        void Promise.resolve()
          .then(() => view.applySettings(parseSettings(message.settings)))
          .then(describe)
          .catch(show);
      }
    },
  });

  // Sent after the handler is attached, so the answer cannot arrive first.
  link.send({ kind: 'hello' });
  globalThis.addEventListener('pagehide', () => link.close());

  function describe() {
    const info = view.info;
    if (!info) return;
    clear();
    status.textContent =
      `${info.valueName} level ${info.level} x${info.factor}  |  ` +
      `${info.layers.length} layer(s)  |  ${info.xLabel}  |  ${info.yLabel}  |  ` +
      `linked to ${group}`;
  }
}

function show(error: unknown) {
  errorBox.textContent = error instanceof Error ? error.message : String(error);
}

function clear() {
  errorBox.textContent = '';
}
