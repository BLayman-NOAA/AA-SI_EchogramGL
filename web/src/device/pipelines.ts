/**
 * Shader module and render pipeline cache.
 *
 * Pipelines are created on first use and kept by variant key. WGSL has no
 * preprocessor, so a variant is an entry point plus a set of overridable
 * constants rather than a separate source file.
 */

export interface RenderVariant {
  /** Identity of this pipeline. Two variants with the same key are the same
   *  pipeline, so everything that changes the pipeline belongs in it. */
  key: string;
  code: string;
  vertex: string;
  fragment: string;
  targets: GPUColorTargetState[];
  constants?: Record<string, number>;
  primitive?: GPUPrimitiveState;
  label?: string;
}

export class ShaderError extends Error {
  readonly messages: readonly GPUCompilationMessage[];

  constructor(label: string, messages: readonly GPUCompilationMessage[]) {
    const detail = messages
      .map((m) => `${m.lineNum}:${m.linePos} ${m.type}: ${m.message}`)
      .join('\n');
    super(`${label} failed to compile\n${detail}`);
    this.name = 'ShaderError';
    this.messages = messages;
  }
}

export class PipelineCache {
  private modules = new Map<string, Promise<GPUShaderModule>>();
  private pipelines = new Map<string, Promise<GPURenderPipeline>>();

  constructor(private device: GPUDevice) {}

  /**
   * Return the pipeline for a variant, creating it if this is its first use.
   *
   * Async because compilation diagnostics are only available that way, and a
   * WGSL error should surface as a message rather than as a blank canvas. The
   * promise is what is cached, so several layers asking at once share one
   * pipeline instead of racing to build the same thing.
   */
  render(variant: RenderVariant): Promise<GPURenderPipeline> {
    return remember(this.pipelines, variant.key, () => this.createPipeline(variant));
  }

  /** Compile a shader module, or throw with the diagnostics. */
  module(code: string, label: string): Promise<GPUShaderModule> {
    return remember(this.modules, code, () => this.compile(code, label));
  }

  /** Drop everything, as after device loss. */
  clear() {
    this.modules.clear();
    this.pipelines.clear();
  }

  /** Point the cache at a replacement device and drop what the old one made. */
  useDevice(device: GPUDevice) {
    this.clear();
    this.device = device;
  }

  private async createPipeline(variant: RenderVariant): Promise<GPURenderPipeline> {
    const shader = await this.module(variant.code, variant.label ?? variant.key);
    this.device.pushErrorScope('validation');
    const pipeline = this.device.createRenderPipeline({
      label: variant.label ?? variant.key,
      layout: 'auto',
      vertex: { module: shader, entryPoint: variant.vertex },
      fragment: {
        module: shader,
        entryPoint: variant.fragment,
        targets: variant.targets,
        constants: variant.constants,
      },
      primitive: variant.primitive ?? { topology: 'triangle-strip' },
    });
    const error = await this.device.popErrorScope();
    if (error) throw new Error(`${variant.key}: ${error.message}`);
    return pipeline;
  }

  private async compile(code: string, label: string): Promise<GPUShaderModule> {
    const shader = this.device.createShaderModule({ code, label });
    const info = await shader.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new ShaderError(label, info.messages);
    return shader;
  }
}

/**
 * Cache by key, keeping the promise rather than the result.
 *
 * A rejection is evicted, so a shader fixed after a failed compile is tried
 * again instead of returning the stale error forever.
 */
function remember<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;

  const started = create();
  cache.set(key, started);
  started.catch(() => cache.delete(key));
  return started;
}
