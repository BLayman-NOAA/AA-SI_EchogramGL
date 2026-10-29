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
  type Choice,
  type Resolution,
  choices,
  describeFound,
  describeMiss,
  draws,
  preferred,
  sameCheckpoint,
  sourceName,
  toSpec,
} from '../../catalog/resolution';
import {
  type ProviderHost,
  type SourceProvider,
  chooser,
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
  /** Which output, and which variable in it. Absent asks for the defaults. */
  output?: string;
  var?: string;
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
  if (query.output) params.set('output', query.output);
  if (query.var) params.set('var', query.var);
  return new URL(`api/resolve?${params}`, server).href;
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
  const find = doc.createElement('button');
  find.type = 'submit';
  find.textContent = 'find';
  find.title = 'Find the step, then choose what of it to add';
  // What the last find offered, and what it was asked as.
  let found: { query: StepQuery; resolution: Resolution } | undefined;
  const choose = chooser((choice) => {
    if (found) void addChoice(found.query, found.resolution, choice);
  });
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
    find,
    choose.element,
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

  const fields = () =>
    Object.fromEntries(Object.entries(inputsByName).map(([name, input]) => [name, input.value]));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    memory.write({ ...memory.read(), ...fields() });
    void findStep(read());
  });
  // What was found was found for the fields as they were.
  const typed = new Set<EventTarget>(Object.values(inputsByName));
  form.addEventListener('input', (event) => {
    if (event.target && typed.has(event.target)) {
      found = undefined;
      choose.clear();
    }
  });
  refresh.addEventListener('click', () => void refreshSteps());

  /** Resolve a step and offer what it holds; a step with one thing adds it. */
  async function findStep(query: StepQuery) {
    note.textContent = '';
    found = undefined;
    choose.clear();
    if (!query.step) {
      note.textContent = 'name a step';
      return;
    }
    try {
      note.textContent = `resolving ${query.step}...`;
      const resolution = await fetchJson<Resolution>(resolveUrl(server, query));
      const offered = resolution.status === 'found' ? choices(resolution) : [];
      if (!offered.length) {
        note.textContent = describeMiss(resolution);
        return;
      }
      found = { query, resolution };
      if (offered.length === 1) {
        await addChoice(query, resolution, offered[0]);
        return;
      }
      choose.offer(offered, preferred(offered, resolution, memory.read()));
      note.textContent = `${query.step}: ${offered.length} things to draw; choose one and add it`;
    } catch (error) {
      note.textContent = '';
      host.showError(error);
    }
  }

  /** Add one choice of a found step, asking again unless it is what was drawn. */
  async function addChoice(query: StepQuery, first: Resolution, choice: Choice) {
    const asked: StepQuery = { ...query, output: choice.output || undefined, var: choice.var };
    try {
      const resolution = draws(first, choice)
        ? first
        : await fetchJson<Resolution>(resolveUrl(server, asked));
      if (resolution.status !== 'found' || !resolution.kind) {
        note.textContent = describeMiss(resolution);
        return;
      }
      const id = freeId(host.sourceIds, sourceName(resolution));
      await host.addSource(id, toSpec(server, resolution));
      steps.set(id, { query: asked, resolution });
      memory.write({ ...memory.read(), output: choice.output, var: choice.var ?? '' });
      note.textContent = describeFound(resolution);
      relist();
    } catch (error) {
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
