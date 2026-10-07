/**
 * What a panel shows for a source just added, before anyone has chosen.
 */

import type { SourceInfo } from '../app/EchogramView';
import type { LayerSpec } from '../app/layers';

/**
 * One layer on a source's first channel.
 *
 * Cluster labels open on the cluster palette, since a colormap would invent an
 * order between clusters. Anything else opens on the colormap given.
 */
export function defaultLayerFor(source: SourceInfo, colormap: string): LayerSpec {
  return {
    id: `${source.id}-layer`,
    source: source.id,
    channel: 0,
    color:
      source.dataType === 'Cluster-MVBS' ? { palette: 'cluster' } : { colormap },
  };
}
