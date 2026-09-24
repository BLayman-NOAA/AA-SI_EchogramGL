import { describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect';

import source from '../src/render/passes/value.wgsl?raw';

/**
 * Parsing is not the full validation a device performs, but it catches the
 * typo that would otherwise show up as an error overlay instead of a picture.
 */
const shader = new WgslReflect(source);

type UniformBlock = { members?: { name: string; offset: number }[] | null };

function offsetsOf(block: UniformBlock | undefined) {
  return Object.fromEntries((block?.members ?? []).map((m) => [m.name, m.offset]));
}

describe('value pass', () => {
  it('declares the entry points the pipeline asks for', () => {
    expect(shader.entry.vertex.map((e) => e.name)).toContain('vs_main');
    expect(shader.entry.fragment.map((e) => e.name)).toContain('fs_value');
  });

  it('keeps what a pass shares in group 0 and what a tile owns in group 1', () => {
    // The split is what makes a pan one buffer write: nothing a tile holds
    // changes when the view moves, so a recorded bundle survives it.
    const bindings = Object.fromEntries(
      shader.uniforms.map((u) => [u.name, `${u.group}.${u.binding}`]),
    );
    expect(bindings.view).toBe('0.0');
    expect(bindings.params).toBe('0.1');
    expect(bindings.tile).toBe('1.0');
  });

  it('binds the per ping geometry as a storage buffer', () => {
    const geometry = shader.storage.find((s) => s.name === 'geometry');
    expect(`${geometry?.group}.${geometry?.binding}`).toBe('0.4');
    // Four f32 per ping: xLeft, xRight, rangeStart, rangeStep.
    expect(geometry?.type?.name).toBe('array');
  });

  it('binds the value texture, the table and the sampler', () => {
    const textures = Object.fromEntries(
      shader.textures.map((t) => [t.name, `${t.group}.${t.binding}`]),
    );
    expect(textures.lut).toBe('0.2');
    expect(textures.values).toBe('1.1');
    expect(shader.samplers.map((s) => `${s.name} ${s.group}.${s.binding}`)).toEqual([
      'samp 0.3',
    ]);
  });

  it('lays the uniform blocks out the way the buffers are written', () => {
    const view = shader.uniforms.find((u) => u.name === 'view');
    const params = shader.uniforms.find((u) => u.name === 'params');
    const tile = shader.uniforms.find((u) => u.name === 'tile');
    expect(view?.size).toBe(64);
    expect(params?.size).toBe(32);
    // Reported without the rounding the uniform address space applies: a
    // struct there aligns to 16, so the buffer written into is 32.
    expect(tile?.size).toBe(24);

    expect(offsetsOf(view)).toEqual({ matrix: 0, yPerPixel: 48 });
    expect(offsetsOf(params)).toEqual({
      clim: 0,
      nodata: 8,
      opacity: 12,
      nodataColor: 16,
    });
    expect(offsetsOf(tile)).toEqual({
      sampleSpan: 0,
      textureSpan: 8,
      pingOffset: 16,
      textureRows: 20,
    });
  });

  it('samples at an explicit level so a branch cannot make it illegal', () => {
    // No texture here carries mip levels, and implicit derivatives would tie
    // every sample to uniform control flow. The nodata branch breaks that, so
    // textureSample in a fragment entry point is a compile error waiting to
    // happen rather than a style preference.
    const fragment = source.slice(source.indexOf('@fragment'));
    expect(fragment).not.toMatch(/\btextureSample\s*\(/);
    expect(fragment).toMatch(/\btextureSampleLevel\s*\(/);
  });

  it('exposes the two branches as overridable constants', () => {
    // Both are pipeline variants rather than uniforms, which is what keeps them
    // in the pipeline key and everything else about a layer out of it.
    const overrides = shader.overrides.map((o) => o.name);
    expect(overrides).toContain('NODATA_TRANSPARENT');
    expect(overrides).toContain('CATEGORICAL');
  });

  it('exposes the transform as an overridable constant', () => {
    expect(shader.overrides.map((o) => o.name)).toContain('TRANSFORM');
  });

  it('reads the second channel at a depth, not at a sample index', () => {
    // The two channels are not on one grid. On HB2407, 200 kHz samples every
    // 0.191 m and 38 kHz every 0.179 m, which is 4.7 m apart by 391 samples.
    // Differencing by index would be wrong by twenty five samples at the
    // seabed and would look entirely plausible.
    const fn = source.slice(source.indexOf('fn secondChannel'));
    const body = fn.slice(0, fn.indexOf('@fragment'));
    expect(body).toMatch(/in\.depth - in\.otherStart/);
    expect(body).toMatch(/in\.otherStep/);
    expect(body).toMatch(/textureLoad\(other,/);
  });

  it('binds the second channel and its geometry for every variant', () => {
    // One bind group layout across the stack, so a value layer points both at
    // its own texture and its own geometry rather than needing a second layout.
    const textures = Object.fromEntries(
      shader.textures.map((t) => [t.name, `${t.group}.${t.binding}`]),
    );
    expect(textures.other).toBe('1.2');
    const geometry = shader.storage.find((s) => s.name === 'geometryOther');
    expect(`${geometry?.group}.${geometry?.binding}`).toBe('0.5');
  });

  it('makes a difference nodata where either channel is', () => {
    // A difference is defined only where both have data, and on masked Sv that
    // is most of the panel.
    const fragment = source.slice(source.indexOf('@fragment'));
    expect(fragment).toMatch(/second < params\.nodata/);
  });

  it('reads a palette entry rather than sampling one', () => {
    // A filtered palette lookup blends two entries into a color no cluster
    // has, which is the raster equivalent of ignoring BoundaryNorm. textureLoad
    // takes no sampler, so the path cannot be filtered by a wrong descriptor.
    const lookup = source.slice(source.indexOf('fn paletteColor'));
    const body = lookup.slice(0, lookup.indexOf('@fragment'));
    expect(body).toMatch(/textureLoad\(lut,/);
    expect(body).not.toMatch(/textureSample/);
  });

  it('never averages a label, whatever the sample density asks for', () => {
    // The linear mean of two cluster numbers is a third cluster.
    const fragment = source.slice(source.indexOf('@fragment'));
    expect(fragment).toMatch(/in\.taps > 1u && !CATEGORICAL/);
  });

  it('reduces the sample axis in linear space rather than in decibels', () => {
    // Averaging decibels is up to 55 dB from the answer on real data, and a
    // hardware filter would also count the sentinel as a value. Both are why
    // the reduction is written out rather than left to the sampler.
    const reduce = source.slice(source.indexOf('fn reduce'));
    expect(reduce).toMatch(/pow\(10\.0, value \* 0\.1\)/);
    expect(reduce).toMatch(/DB_PER_NEPER \* log\(/);
    expect(reduce).toMatch(/value >= params\.nodata/);
    expect(shader.overrides.map((o) => o.name)).toContain('MAX_TAPS');
  });

  it('calls nothing WGSL does not have', () => {
    // Names every other shading language provides and WGSL does not. The
    // parser is happy with an unresolved call target, so the device is the
    // first thing to complain and the page is where it shows.
    const called = new Set(
      (source.match(/\b[A-Za-z_]\w*\s*\(/g) ?? []).map((call) =>
        call.replace(/\s*\($/, ''),
      ),
    );
    const absent = [
      'log10',
      'exp10',
      'mod',
      'lerp',
      'frac',
      'rsqrt',
      'texture2D',
      'textureSize',
      'dFdx',
      'dFdy',
    ];
    expect(absent.filter((name) => called.has(name))).toEqual([]);
  });
});

describe('where a sample is drawn', () => {
  it('places a cell around its range rather than below it', () => {
    // range_start is where sample zero is, not where its cell begins. A sample
    // is a cell like a ping is, so the quad spans half a step either side of
    // the samples it covers. Without the half, everything on screen sits half
    // a sample interval too deep: 0.09 m on this survey, which is a pixel at
    // survey scale and fourteen of them zoomed into the seabed.
    expect(source).toContain('(sample - 0.5) * g.rangeStep');
  });

  it('averages a pixel symmetrically about it', () => {
    // Centred, so the tap count can differ between two channels on different
    // sample intervals without moving one of them relative to the other.
    expect(source).toContain('round(centre - f32(in.taps) * 0.5)');
  });
});
