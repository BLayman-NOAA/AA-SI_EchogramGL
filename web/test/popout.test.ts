import { describe, expect, it, vi } from 'vitest';

import { SETTINGS_VERSION, type ViewSettings } from '../src/app/settings';
import { type ChannelLike, Link } from '../src/shell/channel';
import { VIEW_ROUTE, popOut, serveHandoff } from '../src/shell/popout';

const settings: ViewSettings = {
  version: SETTINGS_VERSION,
  store: 'http://127.0.0.1:8128/store/',
  layers: [{ id: 'layer-0', channel: 0 }],
  level: 'auto',
  pixelsPerPing: 2,
  colormap: 'viridis',
  filter: 'nearest',
  xUnit: 'pings',
  yUnit: 'range',
  aspect: { mode: 'free', exaggeration: 1 },
};

describe('popping a view out', () => {
  it('opens the view route on the group', () => {
    const open = vi.fn((_url: string, _target: string, _features: string) => ({}) as Window);
    popOut({ group: 'left', settings: () => settings, open });

    const [url] = open.mock.calls[0];
    expect(url).toBe(`${VIEW_ROUTE}?group=left`);
  });

  it('names the window by group, so a second click raises the same one', () => {
    const open = vi.fn((_url: string, _target: string, _features: string) => ({}) as Window);
    popOut({ group: 'left', settings: () => settings, open });
    popOut({ group: 'left', settings: () => settings, open });

    expect(open.mock.calls[0][1]).toBe(open.mock.calls[1][1]);
  });

  it('escapes a group that would otherwise break the query', () => {
    const open = vi.fn((_url: string, _target: string, _features: string) => ({}) as Window);
    popOut({ group: 'a&b=c', settings: () => settings, open });
    expect(open.mock.calls[0][0]).toBe(`${VIEW_ROUTE}?group=a%26b%3Dc`);
  });

  it('reports a refusal rather than pretending it opened', () => {
    expect(popOut({ group: 'left', settings: () => settings, open: () => null })).toBeNull();
  });
});

describe('the handoff', () => {
  function channel() {
    const posted: unknown[] = [];
    const fake: ChannelLike = {
      postMessage: (message) => posted.push(message),
      close: () => undefined,
      onmessage: null,
    };
    const link = new Link({
      id: 'opener',
      group: 'left',
      onMessage: () => undefined,
      open: () => fake,
    });
    return { link, posted };
  }

  it('answers a hello with the configuration', () => {
    const { link, posted } = channel();
    serveHandoff(link, () => settings)({ kind: 'hello' });

    expect(posted).toEqual([
      { kind: 'settings', settings, from: 'opener', group: 'left' },
    ]);
  });

  it('answers any hello, so reopening the window works', () => {
    // Nothing depends on the opener still being the window that opened it,
    // which is what makes a reload of the second window recover on its own.
    const { link, posted } = channel();
    const serve = serveHandoff(link, () => settings);
    serve({ kind: 'hello' });
    serve({ kind: 'hello' });
    expect(posted).toHaveLength(2);
  });

  it('says nothing to anything else', () => {
    const { link, posted } = channel();
    const serve = serveHandoff(link, () => settings);
    serve({ kind: 'viewport' });
    serve({ kind: 'goodbye' });
    expect(posted).toEqual([]);
  });

  it('says nothing when there is no store open to describe', () => {
    const { link, posted } = channel();
    serveHandoff(link, () => undefined)({ kind: 'hello' });
    expect(posted).toEqual([]);
  });
});
