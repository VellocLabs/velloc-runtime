/**
 * What the topbar shows when the window is too narrow for all of it (F-9),
 * so no column paints over another: the centre tab strip hides first, then
 * right-group units fold into the More menu, then left-group units do.
 * Pure: the caller measures, this decides.
 */

/** One control that can leave the bar for the More menu. `width` includes
 *  the gap it takes from its group. */
export type TopbarFoldUnit = { key: string; width: number };

export type TopbarFitInput = {
  /** Header content width less the two column gaps. */
  inner: number;
  /** Width of the left group's controls that never fold. */
  leftFixed: number;
  /** Left fold units, first-to-fold first. */
  left: readonly TopbarFoldUnit[];
  rightFixed: number;
  right: readonly TopbarFoldUnit[];
  /** Below this many px the strip is not worth showing. */
  stripMin: number;
};

export type TopbarFit = {
  /** Px the strip may take while staying on the window's centre line; 0 when
   *  hidden; `undefined` before the first measure (no limit). */
  centerBudget: number | undefined;
  showStrip: boolean;
  /** Keys of the units folded into the More menu. */
  folded: ReadonlySet<string>;
};

const sum = (units: readonly TopbarFoldUnit[]) =>
  units.reduce((total, unit) => total + unit.width, 0);

export function planTopbarFit(input: TopbarFitInput): TopbarFit {
  let left = input.leftFixed + sum(input.left);
  let right = input.rightFixed + sum(input.right);
  const budget = input.inner - 2 * Math.max(left, right);
  if (budget >= input.stripMin) {
    return { centerBudget: budget, showStrip: true, folded: new Set() };
  }
  const folded = new Set<string>();
  for (const [units, side] of [
    [input.right, "right"],
    [input.left, "left"],
  ] as const) {
    for (const unit of units) {
      if (left + right <= input.inner) break;
      folded.add(unit.key);
      if (side === "right") right -= unit.width;
      else left -= unit.width;
    }
  }
  return { centerBudget: 0, showStrip: false, folded };
}

/** Same plan, same keys: lets a re-measure keep the previous object. */
export function sameTopbarFit(a: TopbarFit, b: TopbarFit): boolean {
  return (
    a.centerBudget === b.centerBudget &&
    a.showStrip === b.showStrip &&
    a.folded.size === b.folded.size &&
    [...b.folded].every((key) => a.folded.has(key))
  );
}
