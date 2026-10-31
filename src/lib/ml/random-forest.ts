/**
 * Pure TypeScript Random Forest Classifier.
 * Implements a RandomForestClassifier equivalent to scikit-learn's,
 * with no external dependencies.
 */

export interface RandomForestOptions {
  nEstimators?: number;
  maxDepth?: number;
  minSamplesSplit?: number;
  minSamplesLeaf?: number;
  seed?: number;
}

export interface TreeNode {
  featureIndex: number;
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  value: Record<string, number>;
  n: number;
}

interface Meta {
  nTrees: number;
  maxDepth: number;
  minSamplesSplit: number;
  minSamplesLeaf: number;
  seed: number;
  featureImportance: Record<string, number>;
  numClasses: number;
}

const CLASSES = ["0", "1"];

export class RandomForestClassifier {
  trees: TreeNode[] = [];
  features: string[] = [];
  meta: Meta | null = null;

  fit(X: number[][], y: string[], featureNames: string[], options: RandomForestOptions = {}): void {
    const {
      nEstimators = 100,
      maxDepth = 10,
      minSamplesSplit = 5,
      minSamplesLeaf = 2,
      seed = 2026,
    } = options;

    const n = X.length;
    const nFeatures = featureNames.length;
    const maxFeatures = Math.max(1, Math.floor(Math.sqrt(nFeatures)));
    const rng = mulberry32(seed);

    const trees: TreeNode[] = [];
    for (let t = 0; t < nEstimators; t += 1) {
      const sample = bootstrapIndices(n, rng);
      const bootX = sample.map((i) => X[i]);
      const bootY = sample.map((i) => y[i]);
      trees.push(buildTree(bootX, bootY, featureNames, maxDepth, minSamplesSplit, minSamplesLeaf, maxFeatures, rng));
    }

    this.trees = trees;
    this.features = featureNames;
    this.meta = {
      nTrees: nEstimators,
      maxDepth,
      minSamplesSplit,
      minSamplesLeaf,
      seed,
      featureImportance: computeFeatureImportance(trees, maxFeatures),
      numClasses: CLASSES.length,
    };
  }

  predict(X: number[][]): string[] {
    return X.map((row) => {
      const probs = this.predictProba(row);
      const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      return best[0];
    });
  }

  predictProba(row: number[]): Record<string, number> {
    const sums: Record<string, number> = {};
    for (const tree of this.trees) {
      const leaf = walkTree(tree, row);
      if (!leaf) continue;
      for (const cls of CLASSES) {
        sums[cls] = (sums[cls] ?? 0) + (leaf.n > 0 ? (leaf.value[cls] ?? 0) / leaf.n : 0);
      }
    }
    const total = this.trees.length;
    const out: Record<string, number> = {};
    for (const cls of CLASSES) {
      out[cls] = total > 0 ? (sums[cls] ?? 0) / total : 0;
    }
    return out;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapIndices(n: number, rng: () => number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    idx.push(Math.floor(rng() * n));
  }
  return idx;
}

function shuffledFeatures(nFeatures: number, maxFeatures: number, rng: () => number): number[] {
  const pool = Array.from({ length: nFeatures }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, maxFeatures);
}

function gini(labels: string[]): number {
  const counts: Record<string, number> = {};
  for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
  const n = labels.length || 1;
  let impurity = 1;
  for (const c of Object.values(counts)) {
    const p = c / n;
    impurity -= p * p;
  }
  return impurity;
}

function buildTree(
  X: number[][],
  y: string[],
  featureNames: string[],
  maxDepth: number,
  minSamplesSplit: number,
  minSamplesLeaf: number,
  maxFeatures: number,
  rng: () => number,
  depth = 0
): TreeNode {
  const n = X.length;
  const value: Record<string, number> = {};
  for (const l of y) value[l] = (value[l] ?? 0) + 1;

  const shouldSplit =
    depth < maxDepth &&
    n >= minSamplesSplit &&
    Object.keys(value).length > 1;

  if (!shouldSplit) return { featureIndex: -1, threshold: 0, left: null, right: null, value, n };

  const nFeatures = featureNames.length;
  const candidates = shuffledFeatures(nFeatures, maxFeatures, rng);
  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeftX: number[][] = [];
  let bestLeftY: string[] = [];
  let bestRightX: number[][] = [];
  let bestRightY: string[] = [];
  const parentImpurity = gini(y);

  for (const f of candidates) {
    const values = X.map((row, i) => ({ v: row[f], i }));
    values.sort((a, b) => a.v - b.v);
    for (let k = 0; k < values.length - 1; k += 1) {
      if (values[k].v === values[k + 1].v) continue;
      const leftIdx = values.slice(0, k + 1).map((x) => x.i);
      const rightIdx = values.slice(k + 1).map((x) => x.i);
      if (leftIdx.length < minSamplesLeaf || rightIdx.length < minSamplesLeaf) continue;
      const leftY = leftIdx.map((i) => y[i]);
      const rightY = rightIdx.map((i) => y[i]);
      const weighted =
        (leftY.length / n) * gini(leftY) + (rightY.length / n) * gini(rightY);
      const gain = parentImpurity - weighted;
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = (values[k].v + values[k + 1].v) / 2;
        bestLeftX = leftIdx.map((i) => X[i]);
        bestLeftY = leftY;
        bestRightX = rightIdx.map((i) => X[i]);
        bestRightY = rightY;
      }
    }
  }

  if (bestFeature < 0 || bestGain <= 1e-12) {
    return { featureIndex: -1, threshold: 0, left: null, right: null, value, n };
  }

  return {
    featureIndex: bestFeature,
    threshold: bestThreshold,
    left: buildTree(bestLeftX, bestLeftY, featureNames, maxDepth, minSamplesSplit, minSamplesLeaf, maxFeatures, rng, depth + 1),
    right: buildTree(bestRightX, bestRightY, featureNames, maxDepth, minSamplesSplit, minSamplesLeaf, maxFeatures, rng, depth + 1),
    value,
    n,
  };
}

function walkTree(node: TreeNode, row: number[]): TreeNode | null {
  let current: TreeNode | null = node;
  while (current) {
    if (current.left === null || current.right === null || current.featureIndex < 0) {
      return current;
    }
    if (row[current.featureIndex] <= current.threshold) current = current.left;
    else current = current.right;
  }
  return null;
}

function computeFeatureImportance(trees: TreeNode[], maxFeatures: number): Record<string, number> {
  const total = trees.length * maxFeatures;
  const importance: Record<string, number> = {};
  for (const tree of trees) {
    const seen = new Set<number>();
    const stack: TreeNode[] = [tree];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.featureIndex < 0) continue;
      if (!seen.has(node.featureIndex)) {
        seen.add(node.featureIndex);
        importance[node.featureIndex] = (importance[node.featureIndex] ?? 0) + 1;
      }
      if (node.left) stack.push(node.left);
      if (node.right) stack.push(node.right);
    }
  }
  const normalized: Record<string, number> = {};
  for (const [featureIndex, count] of Object.entries(importance)) {
    normalized[featureIndex] = total > 0 ? count / total : 0;
  }
  return normalized;
}