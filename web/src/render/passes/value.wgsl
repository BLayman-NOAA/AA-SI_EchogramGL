// Value pass: colormap one channel of the value array.
//
// One instance per ping, four vertices, a quad spanning that ping's cell. The
// vertical position of every vertex comes from that ping's own range_start and
// range_step, so heave and a per channel sample interval are geometry rather
// than resampling. A coarse tile drawn into a fine slot is positioned from its
// own sidecar and is correct with no special handling.
//
// The x axis switch is a change of what fills xLeft and xRight, plus a change
// of matrix. No sample data is touched.
//
// The value texture is stored sample major: x is the sample axis and y is the
// ping axis, because a chunk arrives with a ping's samples contiguous and that
// is what a texture row is.
//
// Group 0 is everything a pass shares and group 1 is everything a tile owns.
// The split is what lets a pan write one matrix and replay a recorded bundle:
// nothing a tile holds changes when the view moves.

struct PingGeometry {
    xLeft: f32,
    xRight: f32,
    rangeStart: f32,
    rangeStep: f32,
};

struct ViewUniforms {
    matrix: mat3x3f,
    // Vertical data units one device pixel covers. Divided by a ping's own
    // range_step it says how many samples a pixel is standing for, which is
    // the sample axis half of level selection.
    yPerPixel: f32,
};

struct TileUniforms {
    // First sample the quad spans, and how many samples it spans.
    sampleSpan: vec2f,
    // First sample held in the texture, and how many columns it has. Wider
    // than the quad at an interior edge, where the tile carries an apron.
    textureSpan: vec2f,
    // Geometry index of this tile's first ping.
    pingOffset: u32,
    // Rows in the texture, which is this tile's ping count.
    textureRows: u32,
};

struct PassParams {
    clim: vec2f,
    nodata: f32,
    opacity: f32,
    nodataColor: vec4f,
};

@group(0) @binding(0) var<uniform> view: ViewUniforms;
@group(0) @binding(1) var<uniform> params: PassParams;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> geometry: array<PingGeometry>;
// The second channel's geometry, or the first channel's again where there is
// no second. Bound for every variant so one bind group layout serves the stack.
@group(0) @binding(5) var<storage, read> geometryOther: array<PingGeometry>;

@group(1) @binding(0) var<uniform> tile: TileUniforms;
@group(1) @binding(1) var values: texture_2d<f32>;
// The second channel of a difference or ratio layer. Bound for every variant,
// because one bind group layout across the stack is what lets a tile group be
// built once, and pointed at the first channel where there is no second.
@group(1) @binding(2) var other: texture_2d<f32>;
// The second tile's own uniform, reused rather than duplicated: all this needs
// from it is which samples its texture holds, which is already in there.
@group(1) @binding(3) var<uniform> pair: TileUniforms;

override NODATA_TRANSPARENT: bool = false;

// Whether the value array holds labels rather than magnitudes. A label indexes
// the table directly instead of being normalized through the limits, and it is
// never averaged: the mean of two cluster numbers is a third cluster.
override CATEGORICAL: bool = false;

// 0 draws one channel, 1 subtracts the second in decibels. There is no linear
// divide: Sv is already logarithmic, so the subtraction is the ratio.
override TRANSFORM: u32 = 0u;

struct VertexOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    // Depth of this fragment in the store's vertical reference, carried so a
    // second channel on a different sample grid can be read at the same place.
    @location(2) depth: f32,
    // Constant across a ping, because range_step is. Flat rather than
    // interpolated so the loop bound is the same for every fragment of a quad.
    @location(1) @interpolate(flat) taps: u32,
    // The second channel's vertical geometry for this ping, flat for the same
    // reason: it is a property of the ping, not of the fragment.
    @location(3) @interpolate(flat) otherStart: f32,
    @location(4) @interpolate(flat) otherStep: f32,
};

// Most a pixel will average over. The sample axis is bounded in a way the ping
// axis is not: what is on screen is at most the whole water column, so the
// reduction is samples over panel height, not survey length over panel width.
override MAX_TAPS: u32 = 16u;

// WGSL has log and log2 and no log10, so the decibel conversion carries its own
// constant: 10 / ln(10).
const DB_PER_NEPER: f32 = 4.342944819032518;

@vertex
fn vs_main(
    @builtin(vertex_index) corner: u32,
    @builtin(instance_index) row: u32,
) -> VertexOut {
    let g = geometry[tile.pingOffset + row];
    // Triangle strip corners: 0,0 then 1,0 then 0,1 then 1,1.
    let u = f32(corner & 1u);
    let v = f32(corner >> 1u);

    let x = mix(g.xLeft, g.xRight, u);
    let sample = tile.sampleSpan.x + v * tile.sampleSpan.y;
    // Half a sample up, because range_start is where sample zero *is*, not
    // where its cell begins. A sample is a cell like a ping is, spanning half a
    // step either side of its own range, so a quad drawn from range zero to
    // range n puts every cell half an interval too deep. The ping axis has
    // always been drawn from edges, which is what xLeft and xRight are; this is
    // the sample axis finally saying the same thing.
    let y = g.rangeStart + (sample - 0.5) * g.rangeStep;
    let clip = view.matrix * vec3f(x, y, 1.0);

    let other = geometryOther[tile.pingOffset + row];

    var out: VertexOut;
    out.position = vec4f(clip.xy, 0.0, 1.0);
    out.depth = y;
    out.otherStart = other.rangeStart;
    out.otherStep = other.rangeStep;
    out.taps = clamp(u32(round(view.yPerPixel / max(g.rangeStep, 1e-9))), 1u, MAX_TAPS);
    // Across the quad the sample coordinate moves and the ping does not: every
    // fragment of a ping reads the middle of that ping's own row, so no cell
    // borrows from its neighbour and no ping is interpolated across a tile
    // boundary. Only the sample axis needs the apron.
    out.uv = vec2f(
        (f32(row) + 0.5) / f32(tile.textureRows),
        (sample - tile.textureSpan.x) / tile.textureSpan.y,
    );
    return out;
}

fn nodataPixel() -> vec4f {
    if (NODATA_TRANSPARENT) {
        discard;
    }
    return vec4f(params.nodataColor.rgb, params.opacity);
}

// Neither texture carries mip levels yet, so sampling at an explicit level is
// the same image as sampling with implicit derivatives, and it lifts the
// requirement that every sample sit in uniform control flow. Without it the
// nodata branch makes the table lookup that follows it illegal.
// Average the samples one pixel covers, in linear space, skipping the sentinel.
//
// A hardware filter cannot do either: it would take the mean of decibels, which
// is up to 55 dB from the answer on real data, and it would count nodata as a
// value. A mip chain cannot do it at all, because a mip halves both axes and
// the two axes here need different factors: at the true scale fit point the
// ping axis is magnified about ten times while the sample axis is minified
// about twelve, so halving them together would throw away the ping resolution
// that the whole stored pyramid exists to preserve.
fn reduce(in: VertexOut) -> f32 {
    let size = vec2f(textureDimensions(values));
    let row = i32(in.uv.x * size.y);
    let centre = in.uv.y * size.x;
    let first = i32(round(centre - f32(in.taps) * 0.5));

    var total = 0.0;
    var count = 0.0;
    for (var i = 0u; i < in.taps; i = i + 1u) {
        let column = clamp(first + i32(i), 0, i32(size.x) - 1);
        let value = textureLoad(values, vec2i(column, row), 0).r;
        if (value >= params.nodata) {
            total = total + pow(10.0, value * 0.1);
            count = count + 1.0;
        }
    }
    if (count == 0.0) {
        return params.nodata - 1.0;
    }
    return DB_PER_NEPER * log(total / count);
}

// Look up a label's color.
//
// textureLoad and not a sampler: a filtered palette lookup would blend two
// entries and produce a color no cluster has, which is the raster equivalent of
// ignoring BoundaryNorm. Labels start at -1 for noise, so the table is indexed
// from one.
fn paletteColor(label: f32) -> vec4f {
    let width = i32(textureDimensions(lut).x);
    let index = clamp(i32(round(label)) + 1, 0, width - 1);
    return textureLoad(lut, vec2i(index, 0), 0);
}

// The second channel at this fragment's depth.
//
// Read with textureLoad at the nearest sample rather than filtered: the second
// channel's grid does not line up with the first, so a filtered read would
// interpolate two samples whose depths straddle the fragment, which is a
// different and less defensible number than the sample nearest to it.
fn secondChannel(in: VertexOut) -> f32 {
    let size = vec2f(textureDimensions(other));
    let sample = (in.depth - in.otherStart) / max(in.otherStep, 1e-9);
    let column = i32(round(sample - pair.textureSpan.x));
    if (column < 0 || column >= i32(size.x)) {
        return params.nodata - 1.0;
    }
    let row = i32(in.uv.x * size.y);
    return textureLoad(other, vec2i(column, row), 0).r;
}

@fragment
fn fs_value(in: VertexOut) -> @location(0) vec4f {
    let texel = vec2f(in.uv.y, in.uv.x);
    // One tap is one measurement under the pixel, where the sampler setting is
    // what decides how it is read. More than one is a reduction, and averaging
    // is the only honest way to do it.
    var sv = textureSampleLevel(values, samp, texel, 0.0).r;
    if (in.taps > 1u && !CATEGORICAL) {
        sv = reduce(in);
    }
    if (sv < params.nodata) {
        return nodataPixel();
    }
    if (TRANSFORM != 0u) {
        let second = secondChannel(in);
        // A difference is defined only where both channels have data. Either
        // one masked makes the answer nodata rather than makes it up.
        if (second < params.nodata) {
            return nodataPixel();
        }
        // Sv is already logarithmic, so this subtraction is the linear ratio
        // expressed in decibels, which is the quantity a frequency response is
        // read from.
        sv = sv - second;
    }
    if (CATEGORICAL) {
        var color = paletteColor(sv);
        color.a = color.a * params.opacity;
        return color;
    }
    let t = (sv - params.clim.x) / (params.clim.y - params.clim.x);
    var color = textureSampleLevel(lut, samp, vec2f(clamp(t, 0.0, 1.0), 0.5), 0.0);
    color.a = color.a * params.opacity;
    return color;
}
