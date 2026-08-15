/**
 * L2 semantic reranking (docs/bazaar-usage-ranking-design.md §2.1) — a
 * genuine second-stage cross-encoder, the same shape as Azure AI Search's
 * L2 semantic ranking: first-stage retrieval (`catalog.ts`'s lexical +
 * vector RRF fusion) produces a candidate shortlist, and this module
 * computes a **new**, independently-derived relevance score for each
 * candidate against the query — not a recombination of first-stage scores.
 *
 * Model: `Xenova/ms-marco-MiniLM-L-6-v2`, loaded via `AutoTokenizer` +
 * `AutoModelForSequenceClassification` — not the high-level `pipeline()`
 * helper `embeddings.ts` uses for the feature-extraction model, since the
 * installed `@huggingface/transformers` version doesn't support a
 * `text_pair` input through that API for sequence-classification models.
 * Verified live against this project's exact installed dependency: a
 * matching (query, resource) pair scores clearly higher than unrelated
 * ones, with a wide separation — see this module's tests.
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

let modelPromise: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;

function getModel(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> {
  modelPromise ??= (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "fp32" }),
    ]);
    return { tokenizer, model };
  })();
  return modelPromise;
}

/** One candidate to score against a query — `text` is the same combined searchable text the lexical/semantic channels already index, not arbitrary unbounded content. */
export interface RerankCandidate {
  id: string;
  text: string;
}

/**
 * Scores every candidate against `query` in a single batched inference
 * call (measured ~38% faster than one call per candidate at 50 candidates
 * — see docs/bazaar-usage-ranking-design.md §2.1). Truncation to the
 * model's max sequence length is handled by the tokenizer itself
 * (`truncation: true`), the same principle as Azure bounding per-candidate
 * text rather than passing full documents.
 *
 * Returns raw classifier logits, not probabilities — only the *relative*
 * order matters to `search()`'s caller, which sorts by this score
 * descending; the absolute scale isn't meaningful on its own.
 *
 * @param query - The search query
 * @param candidates - Candidates to score, each with its combined searchable text
 * @returns A map from candidate id to its cross-encoder relevance score
 */
export async function rerank(query: string, candidates: readonly RerankCandidate[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (candidates.length === 0) return scores;

  const { tokenizer, model } = await getModel();
  const inputs = tokenizer(
    candidates.map(() => query),
    { text_pair: candidates.map(c => c.text), padding: true, truncation: true },
  );
  const { logits } = await model(inputs);
  const data = logits.data as Float32Array;

  candidates.forEach((candidate, i) => scores.set(candidate.id, data[i]));
  return scores;
}

/**
 * Pre-loads the reranker model so the first real `search()` call with L2
 * reranking enabled doesn't pay the model-load latency. Safe to call
 * multiple times; a no-op after the first — same pattern as
 * `warmUpEmbeddings()`.
 */
export async function warmUpReranker(): Promise<void> {
  await getModel();
}
