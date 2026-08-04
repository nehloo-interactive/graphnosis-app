//! Graphnosis Neural Network — a small trained link-predictor.
//!
//! This is the one genuinely non-deterministic component of Autonomous
//! Indelibility, and it is OFF by default. It is a real neural network: a
//! 1-hidden-layer multilayer perceptron, trained by gradient descent on
//! binary cross-entropy. It learns, from the engram's existing connections
//! (positive examples) and sampled non-connections (negatives), to score
//! which *missing* connections are likely real.
//!
//! Non-determinism is intentional and comes from the random weight
//! initialisation + sampled negatives — two runs will not produce
//! identical edges. That is exactly why it is opt-in and snapshot-guarded.
//!
//! It is NOT a message-passing graph neural network: features are computed
//! deterministically per node pair (embedding similarity, classic
//! link-prediction graph features, and a random-walk positional encoding);
//! the MLP only learns how to weigh them.

/** Deterministically-computed features for one candidate node pair. Each
 *  field is normalised to roughly [0, 1] by the caller. */
export interface PairFeatures {
  /**
   * Cosine similarity of the two nodes' embedding vectors, or `null` when
   * no real embedder is behind them.
   *
   * IT USED TO SAY "0 IF ABSENT". That was the same defect one level down
   * from the one this file's caller now guards: 0 is a VALUE on this axis,
   * and it means ORTHOGONAL — a positive claim that the two memories are
   * maximally dissimilar in meaning. Feeding that for "we do not know"
   * teaches the model a fact nobody established. When it is null the axis is
   * REMOVED from the vector (see `featureDim`), not zeroed and not
   * substituted.
   */
  cosine: number | null;
  /**
   * TF-IDF cosine of the two nodes' text, on the substrate's own scale.
   * ALWAYS PRESENT: TF-IDF is derived from the text itself and needs no
   * model, so this axis never has to be dropped. It is what keeps a content
   * signal in the vector when the embedding axis is gone.
   */
  tfidfCosine: number;
  /** Shared-neighbour count, normalised. */
  commonNeighbors: number;
  /** Preferential attachment — a function of the two nodes' degrees. */
  prefAttachment: number;
  /** Shared named-entity count, normalised. */
  sharedEntities: number;
  /** Cosine similarity of the two nodes' random-walk positional encodings —
   *  a deterministic, multi-hop structural-role match (RWPE; see
   *  arXiv:2110.07875). Already in [0, 1]: RWPE entries are non-negative. */
  rwpeSim: number;
}

/** Axis count WITH the embedding cosine. */
const FEATURE_DIM_WITH_COSINE = 6;
/** Axis count WITHOUT it — the embedding axis is absent, not zeroed. */
const FEATURE_DIM_NO_COSINE = 5;
const HIDDEN_DIM = 8;

/**
 * NO MIGRATION IS NEEDED for the dimension change. The MLP is trained
 * IN-SITU at run time from random init on the engram's own edges — there
 * are no shipped weights and nothing is persisted across the dimension
 * boundary (`gnn-store` holds predicted EDGES, not parameters). A run
 * either trains at 6 or trains at 5, whole.
 */
function featureVec(f: PairFeatures, includeCosine: boolean): Float64Array {
  if (includeCosine) {
    if (f.cosine === null) {
      // Refusing loudly beats silently substituting a number. A caller that
      // built a 6-dim model and then handed over a pair with no embedding
      // has mixed two incompatible runs; zero-filling here is precisely the
      // defect this file was changed to remove.
      throw new Error(
        '[gnn] featureVec: model expects the embedding-cosine axis but the pair has none. ' +
        'Construct GnnLinkPredictor with { semanticSimilarityAvailable: false } for this run ' +
        'instead of substituting a value for an absent signal.',
      );
    }
    return Float64Array.of(
      f.cosine, f.tfidfCosine, f.commonNeighbors, f.prefAttachment, f.sharedEntities, f.rwpeSim,
    );
  }
  return Float64Array.of(
    f.tfidfCosine, f.commonNeighbors, f.prefAttachment, f.sharedEntities, f.rwpeSim,
  );
}

/**
 * A 6→8→1 (or 5→8→1) MLP link-predictor. ReLU hidden layer, sigmoid output,
 * trained with full-batch gradient descent on binary cross-entropy.
 *
 * The input width depends on ONE thing: whether a real embedder is loaded.
 * With one, the vector is [embeddingCosine, tfidfCosine, commonNeighbors,
 * prefAttachment, sharedEntities, rwpeSim]. Without one, the embedding axis
 * is absent entirely and the model trains at width 5 on the remaining
 * axes — all of which are still fully determined.
 *
 * Index reads carry `!` — the indices are loop counters that are always in
 * bounds; the assertion only satisfies `noUncheckedIndexedAccess`.
 */
export class GnnLinkPredictor {
  private readonly w1: Float64Array;  // HIDDEN_DIM × featureDim, row-major
  private readonly b1: Float64Array;  // HIDDEN_DIM
  private readonly w2: Float64Array;  // HIDDEN_DIM
  private b2 = 0;
  /** True when this model's input includes the embedding-cosine axis. */
  readonly includeCosine: boolean;
  /** Input width of this model — 6 with the embedding axis, 5 without. */
  readonly featureDim: number;
  trained = false;

  /**
   * @param opts.semanticSimilarityAvailable the host's single capability
   *   state. Pass `host.semanticSimilarityAvailable()`; do NOT re-derive it
   *   from whether vectors came back.
   */
  constructor(opts: { semanticSimilarityAvailable: boolean }) {
    this.includeCosine = opts.semanticSimilarityAvailable;
    this.featureDim = this.includeCosine ? FEATURE_DIM_WITH_COSINE : FEATURE_DIM_NO_COSINE;
    this.w1 = new Float64Array(HIDDEN_DIM * this.featureDim);
    this.b1 = new Float64Array(HIDDEN_DIM);
    this.w2 = new Float64Array(HIDDEN_DIM);
    // Small random init — the source of the model's non-determinism.
    for (let k = 0; k < this.w1.length; k++) this.w1[k] = (Math.random() - 0.5) * 0.5;
    for (let h = 0; h < HIDDEN_DIM; h++) this.w2[h] = (Math.random() - 0.5) * 0.5;
  }

  private forward(x: Float64Array): { yhat: number; a1: Float64Array; z1: Float64Array } {
    const z1 = new Float64Array(HIDDEN_DIM);
    const a1 = new Float64Array(HIDDEN_DIM);
    for (let h = 0; h < HIDDEN_DIM; h++) {
      let s = this.b1[h]!;
      const base = h * this.featureDim;
      for (let i = 0; i < this.featureDim; i++) s += this.w1[base + i]! * x[i]!;
      z1[h] = s;
      a1[h] = s > 0 ? s : 0; // ReLU
    }
    let z2 = this.b2;
    for (let h = 0; h < HIDDEN_DIM; h++) z2 += this.w2[h]! * a1[h]!;
    return { yhat: 1 / (1 + Math.exp(-z2)), a1, z1 };
  }

  /**
   * Train on labelled pair-features. Full-batch gradient descent, BCE loss.
   * Returns the final average loss (a caller can sanity-check it is finite).
   */
  train(
    samples: ReadonlyArray<{ features: PairFeatures; label: 0 | 1 }>,
    epochs = 150,
    lr = 0.2,
  ): number {
    if (samples.length === 0) return 0;
    const data = samples.map((s) => ({ x: featureVec(s.features, this.includeCosine), y: s.label as number }));
    for (let epoch = 0; epoch < epochs; epoch++) {
      const gw1 = new Float64Array(HIDDEN_DIM * this.featureDim);
      const gb1 = new Float64Array(HIDDEN_DIM);
      const gw2 = new Float64Array(HIDDEN_DIM);
      let gb2 = 0;
      for (const d of data) {
        const { yhat, a1, z1 } = this.forward(d.x);
        const dz2 = yhat - d.y; // dL/dz2 for sigmoid + BCE
        gb2 += dz2;
        for (let h = 0; h < HIDDEN_DIM; h++) {
          gw2[h] = gw2[h]! + dz2 * a1[h]!;
          const dz1 = z1[h]! > 0 ? dz2 * this.w2[h]! : 0; // through ReLU
          gb1[h] = gb1[h]! + dz1;
          const base = h * this.featureDim;
          for (let i = 0; i < this.featureDim; i++) {
            gw1[base + i] = gw1[base + i]! + dz1 * d.x[i]!;
          }
        }
      }
      const n = data.length;
      for (let k = 0; k < this.w1.length; k++) {
        this.w1[k] = this.w1[k]! - (lr * gw1[k]!) / n;
      }
      for (let h = 0; h < HIDDEN_DIM; h++) {
        this.b1[h] = this.b1[h]! - (lr * gb1[h]!) / n;
        this.w2[h] = this.w2[h]! - (lr * gw2[h]!) / n;
      }
      this.b2 -= (lr * gb2) / n;
    }
    let loss = 0;
    for (const d of data) {
      const yhat = this.forward(d.x).yhat;
      loss += -(d.y * Math.log(yhat + 1e-9) + (1 - d.y) * Math.log(1 - yhat + 1e-9));
    }
    this.trained = true;
    return loss / data.length;
  }

  /** Probability in [0,1] that a pair with these features is a real link. */
  score(features: PairFeatures): number {
    return this.forward(featureVec(features, this.includeCosine)).yhat;
  }
}
