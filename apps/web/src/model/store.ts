// The browser's copy of each project's model: fetched once per project, built into a ProjectModel, and kept
// until the snapshot it was built from is no longer the latest. A failed load is not kept, so a retry can succeed.
import { loadModel, type ProjectModel, type SerializedModel } from "@insight/model";

export interface LoadedModel {
  snapshot: string;
  model: ProjectModel;
}

export class ModelStore {
  private loads = new Map<string, Promise<LoadedModel>>();

  /** The model under a key, loaded with `fetchModel` the first time. */
  get(key: string, fetchModel: () => Promise<SerializedModel>): Promise<LoadedModel> {
    let hit = this.loads.get(key);
    if (!hit) {
      hit = fetchModel().then((json) => ({ snapshot: json.snapshot, model: loadModel(json) }));
      this.loads.set(key, hit);
      hit.catch(() => {
        if (this.loads.get(key) === hit) this.loads.delete(key);
      });
    }
    return hit;
  }

  /**
   * Tells the store which snapshot is the latest. A key loaded from another snapshot is dropped, so the next
   * read loads the new model. Nothing happens while the key is still loading or when no model is kept.
   */
  noteLatest(key: string, snapshot: string | undefined): void {
    if (snapshot === undefined) return;
    const hit = this.loads.get(key);
    if (!hit) return;
    void hit.then(
      (loaded) => {
        if (loaded.snapshot !== snapshot && this.loads.get(key) === hit) this.loads.delete(key);
      },
      () => undefined,
    );
  }
}

/** The one store the app reads through. The demo and the live app use different keys, so they never share an entry. */
export const models = new ModelStore();
