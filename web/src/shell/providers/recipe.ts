/**
 * Adding a recipe step's output.
 *
 * A recipe file and a step id name the checkpoint the recipe's current
 * parameters produce, which is what the recipe manager's own button will name
 * once there is one. Cache roots in place of the recipe take the newest
 * computation of the step instead. A time window limits a step mapped over
 * thousands of files to the ones it reaches.
 *
 * The recipe and cache paths are paths on the server's disk or bucket URLs,
 * since the server is what reads them.
 */

import { fetchJson } from '../../data/pieces';
import {
  type Resolution,
  describeFound,
  sameCheckpoint,
  toSpec,
} from './catalog';
import {
  type ProviderHost,
  type SourceProvider,
  field,
  freeId,
  remembered,
  sourceList,
} from './provider';

/** What to ask the server to resolve. */
export interface StepQuery {
  recipe: string;
  step: string;
  /** NAME=VALUE pairs, passed as `aa-recipe run --input` passes them. */
  inputs: string[];
  /** Cache roots, used when there is no recipe. */
  caches: string[];
  start: string;
  end: string;
}

const REMEMBERED = 'echogram.sources.fields';

/** Split a comma separated field into its non empty parts. */
function parts(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The `/api/resolve` URL for a query, against the server's origin. */
export function resolveUrl(server: string, query: StepQuery): string {
  const params = new URLSearchParams();
  params.set('step', query.step);
  if (query.recipe) {
    params.set('recipe', query.recipe);
    for (const input of query.inputs) params.append('input', input);
  } else {
    for (const cache of query.caches) params.append('cache', cache);
  }
  if (query.start) params.set('start', query.start);
  if (query.end) params.set('end', query.end);
  return new URL(`api/resolve?${params}`, server).href;
}

/** Say why a resolved step has nothing to draw. */
export function describeMiss(resolution: Resolution): string {
  const step = resolution.step;
  if (resolution.status === 'never_run') return `${step} has never been run into this cache.`;
  if (resolution.status === 'not_run') {
    const nearest = resolution.nearest?.createdAt
      ? ` The newest run, ${resolution.nearest.createdAt}, differs in `
      : ' The newest run differs in ';
    // A parent's hash says only that something upstream changed, not what.
    const fields = [
      ...new Set(
        (resolution.differences ?? []).map((d) =>
          d.path.startsWith('parents') ? 'an upstream step' : d.path,
        ),
      ),
    ];
    const named = fields.length ? fields.slice(0, 4).join(', ') : 'nothing it recorded';
    return `${step} has not been run with these parameters.${nearest}${named}.`;
  }
  const reasons = (resolution.outputs ?? [])
    .filter((output) => !output.kind)
    .map((output) => `${output.name}: ${output.reason}`);
  return `${step} wrote nothing the viewer can draw. ${reasons.join('; ')}`;
}

/** The recipe and cache picker, resolving through the server at `server`. */
export function recipeProvider(server: string): SourceProvider {
  return {
    id: 'recipe',
    title: 'Recipe steps',
    mount: (host) => mountRecipe(server, host),
  };
}

function mountRecipe(server: string, host: ProviderHost): HTMLElement {
  const doc = window.document;
  const form = doc.createElement('form');
  form.className = 'egl-row';
  form.style.padding = '0';
  const recipe = field('recipe', {
    className: 'egl-wide',
    placeholder: 'path to a recipe yaml',
    title: "A recipe file on the server's disk. Its current parameters name the checkpoint.",
  });
  const step = field('step', { placeholder: 'step id' });
  const inputs = field('inputs', {
    placeholder: 'NAME=VALUE, ...',
    title: 'Pipeline inputs, as aa-recipe run --input takes them',
  });
  const start = field('from', {
    className: 'egl-time',
    placeholder: '2016-07-25T20:58',
    title: 'Limits a step mapped over files to the ones in this window',
  });
  const end = field('to', { className: 'egl-time' });
  const caches = field('or caches', {
    className: 'egl-wide',
    placeholder: 'cache roots, comma separated',
    title: 'Cache roots to search instead of a recipe, newest computation first',
  });
  const add = doc.createElement('button');
  add.type = 'submit';
  add.textContent = 'add step';
  const refresh = doc.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'refresh';
  const list = doc.createElement('span');
  const note = doc.createElement('span');
  note.className = 'egl-note';
  form.append(
    recipe.label,
    step.label,
    inputs.label,
    start.label,
    end.label,
    caches.label,
    add,
    refresh,
    list,
    note,
  );

  const inputsByName = {
    recipe: recipe.input,
    step: step.input,
    inputs: inputs.input,
    caches: caches.input,
    start: start.input,
    end: end.input,
  };
  const memory = remembered(REMEMBERED);
  const saved = memory.read();
  for (const [name, input] of Object.entries(inputsByName)) input.value = saved[name] ?? '';

  const read = (): StepQuery => ({
    recipe: recipe.input.value.trim(),
    step: step.input.value.trim(),
    inputs: parts(inputs.input.value),
    caches: parts(caches.input.value),
    start: start.input.value.trim(),
    end: end.input.value.trim(),
  });

  /** Steps added, by source id, with what each was asked as. */
  const steps = new Map<string, { query: StepQuery; resolution: Resolution }>();
  const relist = () =>
    sourceList(
      list,
      [...steps.keys()].map((id) => ({ id, label: id })),
      (id) =>
        void host
          .removeSource(id)
          .then(() => {
            steps.delete(id);
            relist();
          })
          .catch((error) => host.showError(error)),
    );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    memory.write(
      Object.fromEntries(
        Object.entries(inputsByName).map(([name, input]) => [name, input.value]),
      ),
    );
    void addStep(read());
  });
  refresh.addEventListener('click', () => void refreshSteps());

  async function addStep(query: StepQuery) {
    note.textContent = '';
    if (!query.step) {
      note.textContent = 'name a step';
      return;
    }
    try {
      note.textContent = `resolving ${query.step}...`;
      const resolution = await fetchJson<Resolution>(resolveUrl(server, query));
      if (resolution.status !== 'found' || !resolution.kind) {
        note.textContent = describeMiss(resolution);
        return;
      }
      const id = freeId(host.sourceIds, query.step);
      await host.addSource(id, toSpec(server, resolution));
      steps.set(id, { query, resolution });
      note.textContent = describeFound(resolution);
      relist();
    } catch (error) {
      note.textContent = '';
      host.showError(error);
    }
  }

  /**
   * Resolve every step again, and reopen any that now names another
   * checkpoint, in place, so its layers keep their color, limits and place in
   * the stack. One that is unchanged is still asked again: resolving mounts its
   * datasets afresh, which is what a restarted server needs before failed
   * reads are worth retrying.
   */
  async function refreshSteps() {
    const changed: string[] = [];
    const notes: string[] = [];
    try {
      for (const [id, held] of steps) {
        const resolution = await fetchJson<Resolution>(resolveUrl(server, held.query));
        if (resolution.status !== 'found' || !resolution.kind) {
          notes.push(describeMiss(resolution));
          continue;
        }
        if (sameCheckpoint(resolution, held.resolution)) continue;
        await host.replaceSource(id, toSpec(server, resolution));
        steps.set(id, { query: held.query, resolution });
        changed.push(id);
      }
      if (!changed.length) await host.retry();
      if (changed.length) notes.unshift(`updated ${changed.join(', ')}`);
      note.textContent = notes.length ? notes.join(' ') : 'no newer runs';
    } catch (error) {
      note.textContent = notes.join(' ');
      host.showError(error);
    }
  }

  return form;
}
