import { restoreSaleaeAnalyzer, saleaeAnalyzerMetadata, type UiAnalyzerInstance } from "./analyzers.ts";
import type { SaleaeAnalyzerMetadata } from "./api";
import { readWorkbenchSnapshot, replaceWorkbenchAnalyzers, sameCapture, type WorkbenchSnapshot } from "./workbench.ts";

/** Persist semantic settings only; decoded frames and hover state are local. */
export function analyzerMetadataList(analyzers: UiAnalyzerInstance[]): SaleaeAnalyzerMetadata[] {
  return analyzers.map((analyzer) => saleaeAnalyzerMetadata(analyzer, analyzers));
}

export function sameAnalyzerSettings(a: UiAnalyzerInstance[], b: UiAnalyzerInstance[]): boolean {
  return canonical(analyzerMetadataList(a)) === canonical(analyzerMetadataList(b));
}

/** Return the server's current settings after CAS, including any later edit.
 * Capture replacement while awaiting the snapshot must not target a new tab. */
export async function commitWorkbenchAnalyzers(snapshot: WorkbenchSnapshot, analyzers: UiAnalyzerInstance[]): Promise<WorkbenchSnapshot> {
  await replaceWorkbenchAnalyzers(snapshot, analyzerMetadataList(analyzers));
  const current = await readWorkbenchSnapshot(snapshot.context.session_id);
  if (!sameCapture(snapshot.context, current.context)) throw new Error("Capture changed while saving analyzer settings");
  return current;
}

/** Revisions for annotations and configuration advance independently. */
export function mergeAnalyzerSnapshot(previous: WorkbenchSnapshot | null, incoming: WorkbenchSnapshot): WorkbenchSnapshot {
  if (!previous || !sameCapture(previous.context, incoming.context)) return incoming;
  if (BigInt(previous.context.config_revision ?? "0") > BigInt(incoming.context.config_revision ?? "0")) return previous;
  if (BigInt(previous.context.annotation_revision) > BigInt(incoming.context.annotation_revision)) {
    return {...incoming, annotations: previous.annotations, undo_batch_id: previous.undo_batch_id,
      context: {...incoming.context, annotation_revision: previous.context.annotation_revision, annotation_count: previous.context.annotation_count}};
  }
  return incoming;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Unchanged instances keep their local decode/render caches. Changed settings
 * get a fresh instance, invalidating results computed with the old config. */
export function analyzersFromWorkbench(snapshot: WorkbenchSnapshot, previous: UiAnalyzerInstance[]): UiAnalyzerInstance[] {
  if (!snapshot.context.analyzers_initialized || !snapshot.analyzers) return previous;
  const old = new Map(previous.map((instance) => [instance.id, instance]));
  const metadata = new Map(analyzerMetadataList(previous).map((item) => [
    (item.saleae_metadata as {uiAnalyzerId?: string} | undefined)?.uiAnalyzerId, item,
  ]));
  return snapshot.analyzers.reduce<UiAnalyzerInstance[]>((instances, item) => {
    const cached = old.get(item.id);
    if (cached && canonical(metadata.get(item.id)) === canonical(item.metadata)) instances.push(cached);
    else instances.push({...restoreSaleaeAnalyzer(item.metadata, instances), id: item.id});
    return instances;
  }, []);
}
