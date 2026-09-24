/**
 * Blend state per layer mode.
 *
 * Compositing is blend state and not a shader. `over` is the ordinary painter's
 * order; `add` is what makes the tricolor echogram, where 18 kHz red and 38 kHz
 * blue combine to magenta where both are strong and saturate where they are
 * stronger still.
 *
 * Both take `src-alpha`, so a layer's alpha carries its intensity and its
 * opacity together and neither mode needs premultiplied output.
 */

export type BlendMode = 'over' | 'add';

const OVER: GPUBlendState = {
  color: {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
  alpha: {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
};

const ADD: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
};

export function blendFor(mode: BlendMode): GPUBlendState {
  return mode === 'add' ? ADD : OVER;
}
