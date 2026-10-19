/**
 * The seam between choosing data and drawing it.
 *
 * A provider is one way of finding data: from a recipe, from a list of paths,
 * from whatever a host application keeps. It draws its own controls and hands
 * what it finds to a host, which `EchogramPanel` is. Small on purpose, so a
 * host with its own way of finding data writes one of these and nothing else.
 */

import type { SourceInput } from '../../app/EchogramView';
import type { Choice } from './catalog';

/** What a provider may ask of the panel it feeds. */
export interface ProviderHost {
  addSource(id: string, input: SourceInput, options?: { layer?: boolean }): Promise<void>;
  replaceSource(id: string, input: SourceInput): Promise<void>;
  removeSource(id: string): Promise<void>;
  readonly sourceIds: string[];
  /** Ask again for anything that failed to read. */
  retry(): Promise<void>;
  showError(error: unknown): void;
}

export interface SourceProvider {
  readonly id: string;
  readonly title: string;
  /** Build the provider's controls, wired to a host. */
  mount(host: ProviderHost): HTMLElement;
}

/** An id not yet taken, from the one wanted. */
export function freeId(taken: string[], wanted: string): string {
  const held = new Set(taken);
  if (!held.has(wanted)) return wanted;
  for (let i = 2; ; i += 1) if (!held.has(`${wanted}-${i}`)) return `${wanted}-${i}`;
}

/** A list of what a provider added, each with a button that removes it. */
export function sourceList(
  element: HTMLElement,
  entries: { id: string; label: string }[],
  remove: (id: string) => void,
) {
  element.replaceChildren(
    ...entries.map((entry) => {
      const line = window.document.createElement('span');
      line.textContent = entry.label;
      const button = window.document.createElement('button');
      button.type = 'button';
      button.textContent = 'remove';
      button.addEventListener('click', () => remove(entry.id));
      line.append(' ', button);
      return line;
    }),
  );
}

/** A labelled input, as the panel's own controls are laid out. */
export function field(
  caption: string,
  options: { className?: string; placeholder?: string; title?: string } = {},
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const doc = window.document;
  const label = doc.createElement('label');
  const input = doc.createElement('input');
  if (options.className) input.className = options.className;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.title) label.title = options.title;
  label.append(caption, input);
  return { label, input };
}

/**
 * A list of what a found step or path offers, and a button adding the one
 * selected. Hidden until there is something to choose from.
 */
export function chooser(add: (choice: Choice) => void): {
  element: HTMLElement;
  offer(offered: Choice[], selected: number): void;
  clear(): void;
} {
  const doc = window.document;
  const element = doc.createElement('span');
  const select = doc.createElement('select');
  select.title = 'An output of the step, and for a dataset the variable in it to draw';
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'add';
  element.append(select, button);
  element.hidden = true;
  let offered: Choice[] = [];
  button.addEventListener('click', () => {
    const choice = offered[select.selectedIndex];
    if (choice) add(choice);
  });
  return {
    element,
    offer(next, selected) {
      offered = next;
      select.replaceChildren(
        ...next.map((choice) => {
          const option = doc.createElement('option');
          option.textContent = choice.label;
          return option;
        }),
      );
      select.selectedIndex = selected;
      element.hidden = false;
    },
    clear() {
      offered = [];
      select.replaceChildren();
      element.hidden = true;
    },
  };
}

/** Read and write a provider's remembered fields. Storage that refuses is fine. */
export function remembered(key: string): {
  read(): Record<string, string>;
  write(values: Record<string, string>): void;
} {
  return {
    read() {
      try {
        const found: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}');
        if (!found || typeof found !== 'object') return {};
        return Object.fromEntries(
          Object.entries(found).filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>;
      } catch {
        return {};
      }
    },
    write(values) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(values));
      } catch {
        // Storage refused, which only costs retyping next time.
      }
    },
  };
}
