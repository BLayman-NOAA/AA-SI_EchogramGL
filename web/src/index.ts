/**
 * The public surface of the echogram viewer.
 *
 * Everything an embedding application needs and nothing it does not. A host
 * creates one `GpuContext` for the page, then an `EchogramView` per panel, and
 * hands each one a store. That is the whole of it:
 *
 *     const context = await createGpuContext();
 *     const view = new EchogramView({ container, context });
 *     await view.setStore('https://example/store/');
 *     // ...
 *     view.destroy();
 *
 * **What this library does not know about.** Where the bytes come from. The
 * only thing it needs is a `ChunkStore`, which is one method wide, so a host
 * that reads from object storage, from an authenticated backend, or from a
 * directory the user picked implements that method and this never learns the
 * difference. `FetchStore` covers a plain URL, with a header provider for a
 * token that rotates. Nothing here knows about SSH, GCS, recipes or
 * provenance, and nothing here should start to.
 *
 * **What it draws.** A pyramid store: a zarr group with a `multiscales`
 * attribute, as `aa-echogram build` writes one. A plain Sv dataset, read as one
 * level. And a set of datasets laid side by side in time, each described by a
 * header a server computed (`PieceSetSpec`). Not a raw file: turning a file a
 * user selected into one of these belongs to whatever owns the processing.
 *
 * **Two ways to embed it.** `EchogramView` is the echogram alone, for a host
 * that builds its own controls. `EchogramPanel` is the echogram with the
 * controls that change how it is drawn, in collapsible sections, and a
 * readout of what is under the pointer. Neither chooses data: a host does,
 * and hands it over with `setStore`, `addSource` or `replaceSource`.
 *
 * `shell/` is deliberately absent. It is the development page, with its own
 * data pickers, and it is what an embedding host replaces with its own.
 */

export {
  EchogramView,
  type EchogramViewOptions,
  type LevelChoice,
  type Probe,
  type ProbeLayer,
  type SetStoreOptions,
  type SourceInfo,
  type SourceInput,
  type StatisticsRequest,
  type TileStatus,
  type ViewInfo,
  type ViewStatistics,
} from './app/EchogramView';

export { EchogramPanel, type EchogramPanelOptions } from './panel/EchogramPanel';

export { type Readout, formatProbe } from './panel/readout';

export {
  type Header,
  type PieceSetSpec,
  type PieceSpec,
  isPieceSet,
} from './data/pieces';

export {
  type AspectMode,
  type Range as ViewportRange,
} from './app/viewport';

export {
  type Color,
  type ColorMode,
  type Layer,
  type LayerSpec,
  type NodataMode,
  type Transform,
  DIFFERENCE_CLIM,
  VALUE_CLIM,
  defaultClim,
} from './app/layers';

export {
  type ViewSettings,
  SETTINGS_VERSION,
  SettingsError,
  copySettings,
  parseSettings,
  serializeSettings,
} from './app/settings';

export {
  type ChannelOption,
  type ChannelSource,
  channelLabel,
  channelOptions,
  formatFrequency,
} from './app/channels';

export { type AlignmentProblem } from './app/alignment';

export {
  type DeviceLostHandler,
  type GpuContextOptions,
  GpuContext,
  GpuUnavailableError,
  createGpuContext,
  describeContext,
} from './device/context';

export {
  type Axis,
  type ChunkOptions,
  type ChunkStore,
  type LevelEntry,
  type Multiscales,
  type RequestPriority,
  EchogramStore,
  StoreError,
  openEchogramStore,
} from './data/store';

export {
  type FetchStoreOptions,
  type HeaderProvider,
  FetchStore,
} from './data/FetchStore';

export { type SpawnWorker, type WorkerLike } from './data/decode';

export { type XUnit, type YUnit, AxisUnitError } from './geometry/axes';

export { type Extent } from './geometry/coords';

export { colormapNames } from './render/colormaps';
