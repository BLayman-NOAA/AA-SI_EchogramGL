/**
 * Getting decoded values into the form a value texture takes.
 *
 * The texture is `r16float`, so what it wants is raw float16 bits. A store
 * built by `aa-echogram build` already holds exactly that and the bytes pass
 * through untouched. A plain Sv dataset holds float32 or float64 with NaN where
 * there is nothing, and has to be converted.
 *
 * Two things happen in the conversion and both matter. The values are rounded
 * to float16, which costs about 0.06 dB of precision around -100 dB and is what
 * the pyramid builder does anyway. And every value that is not finite becomes
 * the sentinel, because the shader tests against a threshold and NaN fails
 * every comparison it is given: left as NaN, a masked sample would be neither
 * data nor nodata and would draw as whatever the colormap does with a NaN
 * texture coordinate.
 *
 * Storing decibels in float16 is safe. The trap in this codebase is converting
 * Sv to linear in a narrow dtype, where 10 ** (-80 / 10) underflows to zero;
 * that happens in f32 in the shader and in float64 in Python, never here.
 */

/** Values at or below this are nodata. Mirrors contract.NODATA_THRESHOLD. */
export const NODATA = -9999;

/**
 * Convert any numeric array to float16 bits, sending non finite values to the
 * sentinel.
 *
 * Used for a plain Sv dataset, where the dtype is whatever the processing wrote
 * and the gaps are NaN.
 */
export function toFloat16Bits(
  data: ArrayLike<number>,
  nodata = NODATA,
): Uint16Array<ArrayBuffer> {
  const half = new Float16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    half[i] = Number.isFinite(value) ? value : nodata;
  }
  return new Uint16Array(half.buffer);
}

/** Whether this runtime can convert at all. Float16Array is recent. */
export function canConvert(): boolean {
  return typeof Float16Array === 'function';
}
