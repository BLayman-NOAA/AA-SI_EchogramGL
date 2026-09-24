# Embedding the viewer

`aa-si-echogram-gl` is a library, not an application. It draws echograms into a
container element you give it and knows nothing about where you got the data,
who you are, or what the rest of your interface looks like.

The development pages under `web/src/shell/` are a demonstration and are not
part of the published surface. `web/src/index.ts` is.

## The whole interface

```ts
import { createGpuContext, EchogramView } from 'aa-si-echogram-gl';

// Once per page. Holds the device, the pipeline cache, the texture pool and
// the decoded tile cache, all shared by every view.
const context = await createGpuContext();

// Once per panel.
const view = new EchogramView({ container, context });
await view.setStore('https://example.org/stores/abc123/');

// When the panel closes. Hands its textures back to the shared pool.
view.destroy();
```

Everything else is `setOptions`, which takes layers, units, limits, an aspect
policy and a window, and `info`, which reports what the view settled on.

## What it draws

Two things, and one of them is much better than the other.

**A pyramid store**, which is a zarr group with a `multiscales` attribute as
`aa-echogram build` writes one: levels, per level geometry sidecars, per chunk
summaries. This is what the viewer is for.

**A plain Sv dataset**, which is the zarr a processing pipeline leaves behind,
holding `Sv` or `Sv_corrected` and its coordinates. `setStore` falls back to
this when a group has no `multiscales` attribute, and it is read as a one level
pyramid so that layers, differences and statistics all behave the same.

Expect the fallback to be slow, and understand why before choosing it. A pyramid
exists so that an overview reads a small array; without one, every zoom reads
level zero. On top of that, a dataset written for processing is chunked for
processing: a real HB2407 checkpoint holds 5 channels by 2000 pings by 391
samples in a single chunk, so answering a request for one channel decompresses
31 MB of float64. The values are then rounded to float16 for the texture, which
costs about 0.06 dB. `store.isPlain` says which kind you have, and
`multiscales.aggregation` is `"none"` rather than `"linear_mean"`, because
nothing was aggregated.

It does not read raw `.raw` files. Turning a file somebody selected into either
of these is a separate job with its own cost and its own failure modes, and it
belongs to whatever owns the processing. From the viewer's side a store either
exists at a URL or it does not.

This is the part worth agreeing on before wiring anything together. A host that
lets a user pick a file needs an answer to "where is the store for this file",
and that answer comes from the host's catalog, not from here.

### What a plain dataset has to have

- `Sv` or `Sv_corrected`, three dimensional.
- `depth` or `echo_range`, covering the same channels and pings.
- A `ping_time` coordinate.
- Dimension names recorded, as `_ARRAY_DIMENSIONS` in zarr v2 or
  `dimension_names` in v3. These are read rather than assumed, because they have
  to be: a real checkpoint stores `Sv` as (channel, ping_time, range_sample) and
  `depth` as (ping_time, channel, range_sample), in the same group.

`range_start` and `range_step` are derived from the first samples of the
vertical, which is a linear ramp per ping. The ramp is checked rather than
assumed, and a vertical that is not evenly spaced is refused rather than drawn
at confidently wrong depths.

## Where the bytes come from is yours

`setStore` takes a URL or a `ChunkStore`, which is one method wide:

```ts
interface ChunkStore {
  get(key: string, options?: ChunkOptions): Promise<Uint8Array | undefined>;
}
```

`FetchStore` covers a plain URL, and takes a header provider for a token that
rotates:

```ts
new FetchStore(url, { headers: async () => ({ Authorization: `Bearer ${await token()}` }) })
```

Anything else, implement the method. Reading through your own backend, out of
object storage with signed URLs, from a directory the user picked with the File
System Access API: the viewer never learns the difference. `options.signal` is
an abort the viewer raises when it stops wanting a tile, and honouring it is
what keeps a drag responsive. `options.priority` distinguishes a visible tile
from a speculative one.

Nothing in the library knows about SSH, GCS, recipes or provenance, and nothing
in it should start to. That rule is enforced mechanically: `dependency-cruiser`
fails the build if anything below `shell/` imports from it.

## Several panels

Create one `GpuContext` and pass it to every view. They share the device, the
texture pool and the decoded tile cache, so a second panel on nearby water costs
almost nothing, and the memory budget is the page's rather than each panel's.

`view.destroy()` returns everything that view took. Opening and closing panels
all afternoon leaves the allocation where it started.

## The decode worker

Tiles are compressed, and inflating them on the main thread costs frames during
a pan. The viewer will use a worker if you give it one:

```ts
new EchogramView({
  container,
  context,
  spawnWorker: () =>
    new Worker(new URL('./echogramDecode.js', import.meta.url), { type: 'module' }),
});
```

There is no default, deliberately. `new URL(..., import.meta.url)` is resolved
by whichever bundler compiles the line it appears in, so a default inside the
library would be a path that is right for this project's build and wrong inside
yours. It would also pull the worker and the two decompressors it carries, more
than a megabyte, into a bundle where you cannot use them.

Leave it out and tiles decode on the main thread. That is slower and completely
correct.

## Saving and restoring a panel

```ts
const saved = view.settingsObject;     // plain JSON, versioned
await other.applySettings(saved);
```

Configuration only: the store, the layers, the units, the aspect and the
window. Not which level is drawn or what is resident, because those are answers
the receiving view works out from its own size.

`parseSettings` validates on the way back in and refuses a version it cannot
apply rather than applying half of it.

## Linking two panels

There is no linking in the library. `view.setViewport(x, y)` moves a view and
deliberately does not fire `onViewChange`, which is all a host needs to link any
number of panels without them arguing:

```ts
const a = new EchogramView({ container: left, context, onViewChange: () => {
  const info = a.info;
  if (info) b.setViewport(info.x, info.y);
}});
```

`web/src/shell/channel.ts` does this across browser windows with a
`BroadcastChannel`. It is shell, so it is an example rather than an import.

## Building it

```
npm run build:lib     # dist/aa-si-echogram-gl.js + dist/types/
```

ESM only. `zarrita` is a peer dependency so your application resolves one copy
of it.

## Versions

The library is built against TypeScript 5.9 and Vite 8. Consuming the built
output makes that irrelevant: it is plain ESM with declaration files. Consuming
the source directly, through a workspace or a path dependency, means your
bundler compiles `.wgsl?raw` imports and a worker, so match the toolchain or
build the library first.
