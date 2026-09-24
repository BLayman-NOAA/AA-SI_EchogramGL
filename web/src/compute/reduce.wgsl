// Reduce the values inside a rectangle: a histogram, a count, and two sums.
//
// One pass rather than the two the plan sketched. The histogram and the region
// statistics walk the same texels under the same bounds test, and the bounds
// test is the expensive part, so computing both from one traversal halves the
// work and removes any chance of the two disagreeing about which texels were
// inside.
//
// Bounds are tested in data space, not in texel indices. A tile is a rectangle
// of pings and samples, but which of its texels are on screen depends on each
// ping's own range_start and range_step, so the test reads the same geometry
// buffer the render pass positions quads from. That is what makes the answer
// exactly "what is visible" rather than "what is in the tiles that overlap".
//
// Sums are per workgroup partials rather than global atomics. WGSL has no
// float atomic, and the alternatives are worse: fixed point cannot hold linear
// Sv, which runs over eight orders of magnitude, and deriving the mean from
// the histogram biases it by the bin width. A partial per 64 by 64 block is a
// few hundred floats for a screenful, summed on the processor after readback.

struct PingGeometry {
    xLeft: f32,
    xRight: f32,
    rangeStart: f32,
    rangeStep: f32,
};

struct Region {
    // The rectangle, in the units the geometry buffer is packed in.
    x: vec2f,
    y: vec2f,
    // Lowest and highest value the histogram covers.
    range: vec2f,
    // Anything below this is nodata and contributes to nothing.
    nodata: f32,
    bins: u32,
};

struct TileSpan {
    // First sample the tile owns, and how many. The apron is excluded, so two
    // neighbouring tiles never count the same sample twice.
    sampleSpan: vec2f,
    // First sample held in the texture, and how many columns it has.
    textureSpan: vec2f,
    // Geometry index of this tile's first ping.
    pingOffset: u32,
    // Pings the tile owns, which is also the texture's row count.
    pings: u32,
    // Where this tile's partials start, so several tiles share one buffer.
    blockBase: u32,
    // Workgroups across the sample axis, for the block index.
    blocksAcross: u32,
};

struct Partial {
    // Sum of linear Sv over the texels this block counted.
    linear: f32,
    // The same, weighted by each ping's range step, which integrates over
    // depth and is what the area scattering coefficient is made of.
    weighted: f32,
    count: u32,
    pad: u32,
};

@group(0) @binding(0) var<uniform> region: Region;
@group(0) @binding(1) var<uniform> tile: TileSpan;
@group(0) @binding(2) var<storage, read> geometry: array<PingGeometry>;
@group(0) @binding(3) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> partials: array<Partial>;
@group(0) @binding(5) var values: texture_2d<f32>;

// Bins the workgroup histogram holds. The dispatch may use fewer; it may not
// use more, because workgroup storage cannot be sized at pipeline creation.
const MAX_BINS: u32 = 256u;

// Invocations per workgroup on each axis, and texels each one walks. Together
// they make a 64 by 64 block, which is few enough partials to sum on the
// processor and enough texels that the geometry lookup is amortized.
const SIDE: u32 = 8u;
const STEP: u32 = 8u;

var<workgroup> localBins: array<atomic<u32>, MAX_BINS>;
var<workgroup> localLinear: array<f32, 64>;
var<workgroup> localWeighted: array<f32, 64>;
var<workgroup> localCount: array<u32, 64>;

@compute @workgroup_size(8, 8, 1)
fn reduce(
    @builtin(workgroup_id) block: vec3u,
    @builtin(local_invocation_id) local: vec3u,
    @builtin(local_invocation_index) slot: u32,
) {
    for (var i = slot; i < MAX_BINS; i = i + 64u) {
        atomicStore(&localBins[i], 0u);
    }
    workgroupBarrier();

    var linear = 0.0;
    var weighted = 0.0;
    var counted = 0u;

    let firstSample = block.x * SIDE * STEP + local.x * STEP;
    let firstPing = block.y * SIDE * STEP + local.y * STEP;

    for (var p = 0u; p < STEP; p = p + 1u) {
        let row = firstPing + p;
        if (row >= tile.pings) { break; }

        let g = geometry[tile.pingOffset + row];
        // A ping is a cell, and its centre is what decides whether the ping is
        // in the rectangle. Half in is in: the alternative rejects every ping
        // at either edge of a narrow selection.
        let centre = (g.xLeft + g.xRight) * 0.5;
        if (centre < region.x.x || centre > region.x.y) { continue; }

        for (var s = 0u; s < STEP; s = s + 1u) {
            let column = firstSample + s;
            if (f32(column) >= tile.sampleSpan.y) { break; }

            let sample = tile.sampleSpan.x + f32(column);
            let depth = g.rangeStart + (sample + 0.5) * g.rangeStep;
            if (depth < region.y.x || depth > region.y.y) { continue; }

            let texel = vec2i(i32(sample - tile.textureSpan.x), i32(row));
            let value = textureLoad(values, texel, 0).r;
            if (value < region.nodata) { continue; }

            let power = pow(10.0, value * 0.1);
            linear = linear + power;
            weighted = weighted + power * g.rangeStep;
            counted = counted + 1u;

            let t = (value - region.range.x) / (region.range.y - region.range.x);
            let bin = u32(clamp(t, 0.0, 0.9999) * f32(region.bins));
            atomicAdd(&localBins[min(bin, region.bins - 1u)], 1u);
        }
    }

    localLinear[slot] = linear;
    localWeighted[slot] = weighted;
    localCount[slot] = counted;
    workgroupBarrier();

    // One partial per block, written by one invocation. Summing 64 floats in
    // order here rather than atomically anywhere keeps the result the same from
    // run to run, which a comparison against a reference needs.
    if (slot == 0u) {
        var totalLinear = 0.0;
        var totalWeighted = 0.0;
        var totalCount = 0u;
        for (var i = 0u; i < 64u; i = i + 1u) {
            totalLinear = totalLinear + localLinear[i];
            totalWeighted = totalWeighted + localWeighted[i];
            totalCount = totalCount + localCount[i];
        }
        let index = tile.blockBase + block.y * tile.blocksAcross + block.x;
        partials[index].linear = totalLinear;
        partials[index].weighted = totalWeighted;
        partials[index].count = totalCount;
    }

    // The histogram is shared across tiles, so it goes out atomically. One
    // atomic per bin per block rather than one per texel, which is the whole
    // reason for the workgroup copy.
    for (var i = slot; i < region.bins; i = i + 64u) {
        let total = atomicLoad(&localBins[i]);
        if (total > 0u) {
            atomicAdd(&bins[i], total);
        }
    }
}
