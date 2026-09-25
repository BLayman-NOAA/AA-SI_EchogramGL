/**
 * Axis unit selectors.
 *
 * The options a store actually supports come back from the view, so a unit the
 * data cannot express is never offered rather than offered and refused.
 */

import type { ViewInfo } from '../../app/EchogramView';
import type { XUnit, YUnit } from '../../geometry/axes';

export interface AxisSelection {
  xUnit: XUnit;
  yUnit: YUnit;
}

export interface AxisControls {
  /** Fill the selectors from what the open store supports. */
  update(info: ViewInfo): void;
  read(): AxisSelection;
}

export function createAxisControls(
  x: HTMLSelectElement,
  y: HTMLSelectElement,
  onChange: () => void,
): AxisControls {
  x.addEventListener('change', onChange);
  y.addEventListener('change', onChange);
  // What the view last reported. A select with no option chosen reads as an
  // empty string, which happens when a setting changes before the selectors
  // have been filled from the store; the view's own units stand in then,
  // rather than an empty unit that the view would refuse.
  let reported: AxisSelection = { xUnit: 'pings', yUnit: 'meters' };

  return {
    update(info: ViewInfo) {
      reported = { xUnit: info.xUnit, yUnit: info.yUnit };
      fill(x, info.validX, info.xUnit);
      fill(y, info.validY, info.yUnit);
    },
    read() {
      return {
        xUnit: (x.value || reported.xUnit) as XUnit,
        yUnit: (y.value || reported.yUnit) as YUnit,
      };
    },
  };
}

function fill(select: HTMLSelectElement, units: string[], selected: string) {
  const current = [...select.options].map((o) => o.value).join(',');
  if (current !== units.join(',')) {
    select.replaceChildren();
    for (const unit of units) select.append(new Option(unit, unit));
  }
  select.value = selected;
}
