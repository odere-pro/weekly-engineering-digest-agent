/**
 * Which model the server ran last. With `OLLAMA_MAX_LOADED_MODELS=1` (the documented setting) only
 * that one is in memory, so a call to any other model may have to load it first and is "cold".
 */
export interface LoadTracker {
  isCold(model: string): boolean;
  /** Call when the server answered for `model`: it is loaded now, and the one before it is not. */
  markLoaded(model: string): void;
}

export function createLoadTracker(): LoadTracker {
  let loaded: string | undefined;
  return {
    isCold: (model) => model !== loaded,
    markLoaded: (model) => {
      loaded = model;
    },
  };
}
