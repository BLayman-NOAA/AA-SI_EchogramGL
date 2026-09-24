/**
 * Linking panels and windows.
 *
 * A BroadcastChannel reaches every context on the same origin, which is what
 * makes one message work for a panel beside you and a window on the other
 * monitor without either knowing which it is talking to.
 *
 * Every message carries the id of the view it came from, and a view ignores its
 * own. Without that, a view receives the viewport it just sent, moves to it,
 * reports having moved, and sends it again: two linked panels feed each other
 * forever and neither of them is wrong.
 *
 * A group is a plain string. Views in the same group hear each other and views
 * in different groups do not, so a page can hold two independent pairs.
 */

import type { ViewSettings } from '../app/settings';

export type LinkMessage =
  | { kind: 'viewport'; from: string; group: string; x: [number, number]; y: [number, number] }
  | { kind: 'settings'; from: string; group: string; settings: ViewSettings }
  | { kind: 'hello'; from: string; group: string }
  | { kind: 'goodbye'; from: string; group: string };

/**
 * A message as the sender writes it, with the envelope left off.
 *
 * Distributed over the union deliberately. A plain Omit of a union keeps only
 * the keys every member has, which here is none of them, so every send would be
 * a type error about a property that does exist.
 */
export type Outgoing<T = LinkMessage> = T extends unknown ? Omit<T, 'from' | 'group'> : never;

/** The part of BroadcastChannel this uses, so a test can supply one. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface LinkOptions {
  /** This view's id, which is what its own messages are recognised by. */
  id: string;
  group: string;
  onMessage(message: LinkMessage): void;
  /** Defaults to a real BroadcastChannel where the browser has one. */
  open?: (name: string) => ChannelLike;
}

/** Channel name. One per origin, with the group carried inside the message. */
export const CHANNEL_NAME = 'aa-si-echogram';

export class Link {
  private channel?: ChannelLike;
  private closed = false;
  /** False where the browser has no BroadcastChannel and sends go nowhere. */
  private live: boolean;

  constructor(private options: LinkOptions) {
    const open = options.open ?? defaultOpen;
    this.live = options.open !== undefined || typeof BroadcastChannel === 'function';
    this.channel = open(CHANNEL_NAME);
    if (!this.channel) return;
    this.channel.onmessage = (event) => this.receive(event.data);
  }

  get id(): string {
    return this.options.id;
  }

  get group(): string {
    return this.options.group;
  }

  /**
   * Whether there is anything to talk over.
   *
   * False without a BroadcastChannel, where sends are accepted and dropped. A
   * host that shows a linked or unlinked state has to be told the difference,
   * or it reports a link that cannot carry anything.
   */
  get connected(): boolean {
    return this.live && Boolean(this.channel) && !this.closed;
  }

  send(message: Outgoing) {
    if (!this.channel || this.closed) return;
    this.channel.postMessage({
      ...message,
      from: this.options.id,
      group: this.options.group,
    } as LinkMessage);
  }

  close() {
    if (this.closed) return;
    this.send({ kind: 'goodbye' });
    this.closed = true;
    this.channel?.close();
    this.channel = undefined;
  }

  private receive(data: unknown) {
    if (this.closed) return;
    const message = data as Partial<LinkMessage>;
    if (!message || typeof message !== 'object') return;
    if (typeof message.from !== 'string' || typeof message.kind !== 'string') return;
    // Its own message, come back around. Acting on it is the oscillation.
    if (message.from === this.options.id) return;
    if (message.group !== this.options.group) return;
    this.options.onMessage(message as LinkMessage);
  }
}

/** A view id that is unique across windows, which is what the filter needs. */
export function newViewId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `view-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function defaultOpen(name: string): ChannelLike {
  if (typeof BroadcastChannel !== 'function') {
    // No channel is a working viewer with no linking, which is better than a
    // viewer that will not open.
    return {
      postMessage: () => undefined,
      close: () => undefined,
      onmessage: null,
    };
  }
  return new BroadcastChannel(name) as unknown as ChannelLike;
}
