import { describe, expect, it } from 'vitest';

import { channelLabel, channelOptions, formatFrequency } from '../src/app/channels';

/** HB2407 records its transceivers in this order, which is not frequency order. */
const HB2407 = {
  channels: 5,
  channelNames: [
    'WBT 400479-15 ES18_ES',
    'WBT 400503-15 ES70-7C_ES',
    'WBT 400509-15 ES200-7C_ES',
    'WBT 400517-15 ES120-7C_ES',
    'WBT 400528-15 ES38-7_ES',
  ],
  channelFrequencies: [18000, 70000, 200000, 120000, 38000],
};

describe('channel options', () => {
  it('offers them by frequency, not by store position', () => {
    expect(channelOptions(HB2407).map((option) => option.label)).toEqual([
      '18 kHz',
      '38 kHz',
      '70 kHz',
      '120 kHz',
      '200 kHz',
    ]);
  });

  it('keeps the store index against each one', () => {
    // The index is what a layer holds and what the store reads, so sorting the
    // list must not renumber anything.
    expect(channelOptions(HB2407).map((option) => option.index)).toEqual([0, 4, 1, 3, 2]);
  });

  it('falls back to the channel name where there are no frequencies', () => {
    const named = { channels: 2, channelNames: ['ES18', 'ES38'] };
    expect(channelOptions(named).map((option) => option.label)).toEqual(['ES18', 'ES38']);
  });

  it('falls back to the index where the store carries neither', () => {
    expect(channelOptions({ channels: 2 }).map((option) => option.label)).toEqual([
      'channel 0',
      'channel 1',
    ]);
  });

  it('leaves the order alone unless every channel has a frequency', () => {
    // A partial sort puts the known ones in frequency order and the rest
    // wherever they fell, which reads as neither of the two real orders.
    const partial = { channels: 3, channelFrequencies: [200000, 18000] };
    expect(channelOptions(partial).map((option) => option.index)).toEqual([0, 1, 2]);
  });
});

describe('frequency labels', () => {
  it('says what an analyst says', () => {
    expect(formatFrequency(38000)).toBe('38 kHz');
    expect(formatFrequency(200000)).toBe('200 kHz');
  });

  it('keeps a decimal below ten, where rounding would collapse two channels', () => {
    expect(formatFrequency(1200)).toBe('1.2 kHz');
    expect(formatFrequency(1800)).toBe('1.8 kHz');
  });

  it('names one channel the same way the list does', () => {
    expect(channelLabel(HB2407, 4)).toBe('38 kHz');
  });
});
