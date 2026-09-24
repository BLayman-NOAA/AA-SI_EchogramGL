/**
 * Naming and ordering the channels.
 *
 * A channel index is a position in the store, and on a real survey it is not
 * frequency order: HB2407 records 18, 70, 200, 120 and 38 kHz in that sequence,
 * because the order is whatever the transceivers were configured in. An analyst
 * choosing between layers is choosing between frequencies, so the pickers are
 * sorted and labelled by frequency while the index stays what the store says.
 *
 * Sorting the store's channel axis instead was considered and rejected: the
 * index is part of the contract, a saved layer configuration names one, and
 * reordering at write time would make the same number mean different things in
 * two stores of the same survey.
 */

export interface ChannelSource {
  channels: number;
  channelNames?: string[];
  channelFrequencies?: number[];
}

export interface ChannelOption {
  /** Index into the store's channel axis, which is what a layer holds. */
  index: number;
  label: string;
  /** Hertz, where the store knows it. */
  frequency?: number;
}

/**
 * The channels in the order to offer them.
 *
 * Sorted by frequency only when every channel has one. A partial sort would put
 * the named channels in frequency order and the rest wherever they fell, which
 * reads as an arbitrary order rather than as either of the two real ones.
 */
export function channelOptions(source: ChannelSource): ChannelOption[] {
  const options: ChannelOption[] = [];
  for (let index = 0; index < source.channels; index += 1) {
    const frequency = source.channelFrequencies?.[index];
    options.push({ index, frequency, label: channelLabel(source, index) });
  }
  const complete = options.every((option) => option.frequency !== undefined);
  if (!complete) return options;
  return options.sort((a, b) => a.frequency! - b.frequency!);
}

/**
 * What to call one channel.
 *
 * The frequency if the store knows it, then the channel name, then the index.
 * Older stores carry neither, which is why the index is still an answer.
 */
export function channelLabel(source: ChannelSource, index: number): string {
  const frequency = source.channelFrequencies?.[index];
  if (frequency) return formatFrequency(frequency);
  return source.channelNames?.[index] ?? `channel ${index}`;
}

/** Hertz as an analyst says it: 38 kHz, and 1.2 kHz rather than 1 kHz. */
export function formatFrequency(hertz: number): string {
  const kilohertz = hertz / 1000;
  const rounded = kilohertz >= 10 ? Math.round(kilohertz) : Math.round(kilohertz * 10) / 10;
  return `${rounded} kHz`;
}
