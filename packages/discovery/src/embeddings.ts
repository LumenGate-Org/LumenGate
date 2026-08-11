/**
 * Local, offline semantic embedding generation for the Bazaar catalog's
 * hybrid search (`catalog.ts`) — the vector half of the lexical+semantic
 * fusion protocol-quality goals
 * (Section 3.2) calls for.
 *
 * Runs entirely in-process via `@huggingface/transformers` (ONNX runtime),
 * not a paid third-party embeddings API: a reviewer running this project
 * from a clean checkout shouldn't need an API key to validate that semantic
 * search actually works. The model (`Xenova/all-MiniLM-L6-v2`, ~90MB,
 * 384-dimension output) downloads once from the Hugging Face Hub on first
 * use and is cached locally afterward — the only network dependency, and
 * only on first run.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_DIMENSIONS = 384;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
  return pipelinePromise;
}

/**
 * Computes a normalized embedding vector for `text`. Mean-pooled and
 * L2-normalized so `pgvector`'s cosine distance operator (`<=>`) in
 * `catalog.ts` behaves as a plain `1 - cosine_similarity` comparison.
 *
 * @param text - The text to embed (a query, or a resource's combined searchable text)
 * @returns A `Float32Array` of length `EMBEDDING_DIMENSIONS`
 */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float32Array);
}

/**
 * Pre-loads the embedding model so the first real `embed()` call (e.g. the
 * first resource cataloged, or the first search) doesn't pay the model-load
 * latency. Safe to call multiple times; a no-op after the first.
 */
export async function warmUpEmbeddings(): Promise<void> {
  await getPipeline();
}
