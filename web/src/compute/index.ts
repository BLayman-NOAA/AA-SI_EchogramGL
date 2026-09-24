/**
 * Reductions over what is on screen.
 *
 * The device answers questions about the data it is already holding: a
 * histogram for auto contrast, and a count and two sums for the region
 * statistics a host application presents. Nothing here draws, and nothing that
 * draws depends on it, so a view with no reduction in flight is the view
 * milestone 7 left behind.
 */

export { Cancelled, Readback, settle } from './readback';
export {
  type ReduceRequest,
  type ReduceResult,
  type ReduceTile,
  Reducer,
} from './reducer';
export {
  type Accumulated,
  type Histogram,
  type RegionStatistics,
  DEFAULT_BINS,
  DEFAULT_RANGE,
  accumulate,
  labelCounts,
  labelShares,
  percentileLimits,
  statistics,
} from './statistics';
