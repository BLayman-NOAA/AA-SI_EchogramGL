/**
 * The panel's look, injected once per document.
 *
 * Scoped under `.egl-panel` so it reaches nothing else on a host's page, with
 * its colors as custom properties a host can set on the container to match
 * its own.
 */

const STYLE_ID = 'egl-panel-styles';

/**
 * Each color's value where neither the container nor anything above it sets
 * one. Given at the point of use rather than declared on `.egl-panel`, so a
 * value a host sets on the container is inherited rather than shadowed.
 */
const DEFAULTS = {
  background: '#000',
  bar: '#1b1b1b',
  line: '#333',
  text: '#ddd',
  muted: '#999',
  warning: '#d8a657',
  readout: 'rgba(12, 12, 12, 0.88)',
};

/** A color property, falling back to its default. */
function token(name: keyof typeof DEFAULTS): string {
  return `var(--egl-${name}, ${DEFAULTS[name]})`;
}

const CSS = `
.egl-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: ${token('background')};
  color: ${token('text')};
  font: 13px system-ui, sans-serif;
  color-scheme: var(--egl-color-scheme, dark);
}
.egl-panel .egl-bars {
  flex: none;
}
.egl-panel .egl-section {
  background: ${token('bar')};
  border-bottom: 1px solid ${token('line')};
}
.egl-panel .egl-section > summary {
  cursor: pointer;
  padding: 4px 14px;
  font-size: 11px;
  text-transform: lowercase;
  color: ${token('muted')};
  user-select: none;
}
.egl-panel .egl-section[open] > summary {
  color: ${token('text')};
}
.egl-panel .egl-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  padding: 4px 14px 10px;
}
.egl-panel .egl-row.egl-stack {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.egl-panel label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  text-transform: lowercase;
  color: ${token('muted')};
}
.egl-panel label:has(select:disabled) {
  opacity: 0.4;
}
.egl-panel input,
.egl-panel select,
.egl-panel button {
  font: inherit;
  background: #111;
  color: ${token('text')};
  border: 1px solid ${token('line')};
  border-radius: 3px;
  padding: 4px 6px;
}
.egl-panel button {
  cursor: pointer;
}
.egl-panel button:disabled {
  opacity: 0.4;
  cursor: default;
}
.egl-panel input[type='number'] {
  width: 5.5em;
}
.egl-panel input.egl-wide {
  width: 22em;
}
.egl-panel input.egl-time {
  width: 11em;
}
.egl-panel .egl-bounds input {
  width: 7em;
}
.egl-panel .egl-slider {
  min-width: 30em;
}
.egl-panel .egl-slider input[type='range'] {
  width: 100%;
  padding: 0;
}
.egl-panel .egl-number {
  color: ${token('text')};
  font-variant-numeric: tabular-nums;
}
.egl-panel .egl-note {
  color: ${token('warning')};
  align-self: center;
}
.egl-panel .egl-result {
  align-self: center;
  color: #9c9;
  font-variant-numeric: tabular-nums;
}
.egl-panel .layer {
  display: flex;
  gap: 6px;
  align-items: center;
}
.egl-panel .layer input[type='range'] {
  width: 9em;
  padding: 0;
}
.egl-panel .layer input.clim {
  width: 4.5em;
}
.egl-panel .opacityValue {
  width: 3em;
  color: ${token('muted')};
  font-variant-numeric: tabular-nums;
}
.egl-panel .egl-plot {
  position: relative;
  flex: 1;
  min-height: 0;
}
.egl-panel .egl-readout {
  position: absolute;
  top: 10px;
  right: 10px;
  max-width: 28em;
  padding: 8px 12px;
  background: ${token('readout')};
  border: 1px solid ${token('line')};
  border-radius: 4px;
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  white-space: pre;
  pointer-events: none;
}
.egl-panel .egl-readout:empty {
  display: none;
}
.egl-panel .egl-readout .egl-dim {
  color: ${token('muted')};
  font-size: 12px;
}
.egl-panel .egl-readout .egl-warn {
  color: ${token('warning')};
  white-space: normal;
}
.egl-panel .egl-error {
  position: absolute;
  inset: 12px;
  display: none;
  overflow: auto;
  margin: 0;
  padding: 12px 14px;
  background: rgba(40, 0, 0, 0.92);
  border: 1px solid #883333;
  border-radius: 4px;
  color: #ffd9d9;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
}
`;

/** Add the panel's styles to a document, once. */
export function injectStyles(doc: Document = window.document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}
