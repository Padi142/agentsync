import { useState } from 'react';

/** A value as saved on the server at some revision. */
export interface Revisioned<T> {
  revision: number;
  value: T;
}

/**
 * A local edit of a revisioned value. `revision` is what the next save sends as
 * `expectedRevision`, and `clean` is the value that counts as "no edits".
 */
export interface Draft<T> {
  revision: number;
  clean: T;
  value: T;
  busy: boolean;
}

export const start = <T>(loaded: Revisioned<T>): Draft<T> =>
  ({ revision: loaded.revision, clean: loaded.value, value: loaded.value, busy: false });

export const isDirty = <T>(draft: Draft<T>, equal: (a: T, b: T) => boolean) => !equal(draft.value, draft.clean);

/** Edits are ignored while a save is in flight, so what was sent is what is shown. */
export const edit = <T>(draft: Draft<T>, value: T): Draft<T> => (draft.busy ? draft : { ...draft, value });

export const begin = <T>(draft: Draft<T>): Draft<T> => ({ ...draft, busy: true });
export const end = <T>(draft: Draft<T>): Draft<T> => ({ ...draft, busy: false });

/** The draft's own save returned `revision`: it is now the base, and nothing is unsaved. */
export const saved = <T>(draft: Draft<T>, revision: number): Draft<T> => ({ ...draft, revision, clean: draft.value });

/**
 * Follow a newer revision saved elsewhere, but only while there is nothing to lose:
 * no unsaved edits and no save in flight. Otherwise the draft keeps its own base.
 */
export function follow<T>(draft: Draft<T>, loaded: Revisioned<T>, equal: (a: T, b: T) => boolean): Draft<T> {
  if (loaded.revision <= draft.revision || draft.busy || isDirty(draft, equal)) return draft;
  return start(loaded);
}

/** Merged into a newer revision: move the base and replace the value, but keep it unsaved. */
export const rebase = <T>(draft: Draft<T>, revision: number, value: T): Draft<T> => ({ ...draft, revision, value });

/**
 * A draft of `loaded` that loader refreshes never overwrite while it has edits.
 * `run` marks it busy for the duration of a save, which ignores edits meanwhile.
 */
export function useDraft<T>(loaded: Revisioned<T>, equal: (a: T, b: T) => boolean = Object.is) {
  const [state, setState] = useState(() => start(loaded));
  const draft = follow(state, loaded, equal);
  if (draft !== state) setState(draft);
  return {
    value: draft.value,
    revision: draft.revision,
    busy: draft.busy,
    dirty: isDirty(draft, equal),
    /** A newer revision saved elsewhere that the draft didn't take because it has edits. */
    newer: loaded.revision > draft.revision ? loaded : null,
    set: (value: T) => setState((d) => edit(d, value)),
    /** Drop any edits and start again from `next`. */
    load: (next: Revisioned<T>) => setState(start(next)),
    saved: (revision: number) => setState((d) => saved(d, revision)),
    rebase: (revision: number, value: T) => setState((d) => rebase(d, revision, value)),
    run: async <R>(task: (value: T, revision: number) => Promise<R>): Promise<R> => {
      setState(begin<T>);
      try {
        return await task(draft.value, draft.revision);
      } finally {
        setState(end<T>);
      }
    },
  };
}
