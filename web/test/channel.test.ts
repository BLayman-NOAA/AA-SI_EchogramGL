import { describe, expect, it, vi } from 'vitest';

import { SETTINGS_VERSION, type ViewSettings } from '../src/app/settings';
import { type ChannelLike, Link, newViewId } from '../src/shell/channel';

/**
 * A broadcast channel that reaches every other channel of the same name.
 *
 * The real one does not deliver to the sender, but the self filter cannot rely
 * on that: a view also hears a second view in the same window. This one
 * delivers to everybody, including the sender, so the filter is what is under
 * test rather than the browser's behaviour.
 */
class Bus {
  private open: { name: string; channel: FakeChannel }[] = [];

  connect(name: string): ChannelLike {
    const channel = new FakeChannel(this, name);
    this.open.push({ name, channel });
    return channel;
  }

  publish(name: string, message: unknown) {
    for (const entry of this.open) {
      if (entry.name !== name || entry.channel.closed) continue;
      entry.channel.onmessage?.({ data: message });
    }
  }
}

class FakeChannel implements ChannelLike {
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(
    private bus: Bus,
    private name: string,
  ) {}

  postMessage(message: unknown) {
    this.bus.publish(this.name, message);
  }

  close() {
    this.closed = true;
  }
}

const settings: ViewSettings = {
  version: SETTINGS_VERSION,
  layers: [],
  level: 'auto',
  pixelsPerPing: 2,
  colormap: 'viridis',
  filter: 'nearest',
  xUnit: 'pings',
  yUnit: 'range',
  aspect: { mode: 'free', exaggeration: 1 },
};

function pair(group = 'g', otherGroup = group) {
  const bus = new Bus();
  const heardByFirst = vi.fn();
  const heardBySecond = vi.fn();
  const first = new Link({
    id: 'first',
    group,
    onMessage: heardByFirst,
    open: (name) => bus.connect(name),
  });
  const second = new Link({
    id: 'second',
    group: otherGroup,
    onMessage: heardBySecond,
    open: (name) => bus.connect(name),
  });
  return { first, second, heardByFirst, heardBySecond };
}

describe('link', () => {
  it('carries a viewport to the other view', () => {
    const { first, heardBySecond } = pair();
    first.send({ kind: 'viewport', x: [0, 10], y: [0, 70] });

    expect(heardBySecond).toHaveBeenCalledWith({
      kind: 'viewport',
      from: 'first',
      group: 'g',
      x: [0, 10],
      y: [0, 70],
    });
  });

  it('ignores its own message', () => {
    // The whole reason for the id. A view that acted on its own viewport would
    // move, report having moved, send again, and never stop.
    const { first, heardByFirst } = pair();
    first.send({ kind: 'viewport', x: [0, 10], y: [0, 70] });
    expect(heardByFirst).not.toHaveBeenCalled();
  });

  it('does not hear a different group', () => {
    const { first, heardBySecond } = pair('left', 'right');
    first.send({ kind: 'hello' });
    expect(heardBySecond).not.toHaveBeenCalled();
  });

  it('carries a whole settings object', () => {
    const { first, heardBySecond } = pair();
    first.send({ kind: 'settings', settings });
    expect(heardBySecond.mock.calls[0][0].settings).toEqual(settings);
  });

  it('says goodbye when it closes, and then stops talking', () => {
    const { first, second, heardBySecond } = pair();
    first.close();
    expect(heardBySecond).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'goodbye', from: 'first' }),
    );

    heardBySecond.mockClear();
    first.send({ kind: 'hello' });
    expect(heardBySecond).not.toHaveBeenCalled();
    expect(first.connected).toBe(false);
    expect(second.connected).toBe(true);
  });

  it('hears nothing more after it has closed', () => {
    const { first, second, heardByFirst } = pair();
    first.close();
    second.send({ kind: 'hello' });
    expect(heardByFirst).not.toHaveBeenCalled();
  });

  it('ignores anything that is not one of its messages', () => {
    // Same origin means anything on the page can post here.
    const bus = new Bus();
    const heard = vi.fn();
    new Link({ id: 'a', group: 'g', onMessage: heard, open: (n) => bus.connect(n) });
    bus.publish('aa-si-echogram', 'hello');
    bus.publish('aa-si-echogram', { kind: 'viewport' });
    bus.publish('aa-si-echogram', null);
    expect(heard).not.toHaveBeenCalled();
  });

  it('works with no BroadcastChannel at all, silently', () => {
    // A viewer with no linking beats a viewer that will not open.
    const link = new Link({ id: 'a', group: 'g', onMessage: vi.fn() });
    expect(() => link.send({ kind: 'hello' })).not.toThrow();
  });
});

describe('view ids', () => {
  it('gives a different one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newViewId()));
    expect(ids.size).toBe(50);
  });
});
