/**
 * Collapsible sections above the echogram.
 *
 * Native `<details>` and `<summary>`, so a section opens and closes from the
 * keyboard and for a screen reader with nothing written for it here. Which
 * sections are open is remembered per section id, so a panel reopens the way
 * it was left and the echogram keeps the room the user gave it.
 */

/** Section id to whether it is open. */
export type SectionState = Record<string, boolean>;

/** The part of Storage this needs, so a test can pass a plain object. */
export interface StateStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read remembered section state, or nothing when there is none to read. */
export function readSections(store: StateStore | undefined, key: string): SectionState {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const state: SectionState = {};
    for (const [id, open] of Object.entries(parsed)) {
      if (typeof open === 'boolean') state[id] = open;
    }
    return state;
  } catch {
    return {};
  }
}

/** Remember section state. A store that refuses costs only the memory of it. */
export function writeSections(
  store: StateStore | undefined,
  key: string,
  state: SectionState,
) {
  try {
    store?.setItem(key, JSON.stringify(state));
  } catch {
    // Storage full or refused: sections open as their defaults next time.
  }
}

export interface Section {
  id: string;
  element: HTMLDetailsElement;
  /** Where the section's controls go. */
  body: HTMLElement;
}

/**
 * Build one section.
 *
 * `onToggle` hears every open and close, which is how the state is kept.
 */
export function createSection(
  id: string,
  title: string,
  open: boolean,
  onToggle: (id: string, open: boolean) => void,
): Section {
  const doc = window.document;
  const element = doc.createElement('details');
  element.className = 'egl-section';
  element.dataset.section = id;
  element.open = open;
  const summary = doc.createElement('summary');
  summary.textContent = title;
  const body = doc.createElement('div');
  body.className = 'egl-row';
  element.append(summary, body);
  element.addEventListener('toggle', () => onToggle(id, element.open));
  return { id, element, body };
}
