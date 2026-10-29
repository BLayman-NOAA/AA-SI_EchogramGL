import { afterEach, describe, expect, it, vi } from 'vitest';

import { GpuUnavailableError, createGpuContext, unavailable } from '../src/device/context';

/** Why `createGpuContext` failed, given the navigator it sees. */
async function failure(navigator?: unknown): Promise<GpuUnavailableError> {
  if (navigator) vi.stubGlobal('navigator', navigator);
  const failed = await createGpuContext().catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(GpuUnavailableError);
  return failed as GpuUnavailableError;
}

describe('no WebGPU', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says to use a secure address when navigator.gpu is missing', async () => {
    // Node has no navigator.gpu, which is what a plain http page looks like.
    const error = await failure();
    expect(error.reason).toBe('insecure-context');
    expect(error.message).toContain('secure context');
    expect(error.advice).toContain('http://localhost or https');
  });

  it('says what is needed when there is no adapter', async () => {
    const error = await failure({ gpu: { requestAdapter: async () => null } });
    expect(error.name).toBe('GpuUnavailableError');
    expect(error.reason).toBe('no-adapter');
    expect(error.message).toContain('requestAdapter returned null');
    expect(error.advice).toContain('Chrome or Edge');
  });

  it('carries why a device was refused', async () => {
    const adapter = {
      requestDevice: async () => {
        throw new Error('limits exceeded');
      },
    };
    const error = await failure({ gpu: { requestAdapter: async () => adapter } });
    expect(error.reason).toBe('no-device');
    expect(error.message).toBe('requestDevice failed: limits exceeded');
    expect(error.advice).toBeTruthy();
  });

  it('builds the same error for a host that checks before asking', () => {
    const error = unavailable('insecure-context');
    expect(error).toBeInstanceOf(GpuUnavailableError);
    expect(error.advice).toContain('plain http address');
  });
});
