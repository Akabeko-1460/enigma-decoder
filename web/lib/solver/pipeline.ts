/**
 * 解読の全体進行。
 *
 * Python 側 `decrypt_plugboard.attack_plugboard` および
 * `decrypt_known_plugboard.attack_known_plugboard` の移植。
 * 重い計算は WASM ワーカーへ投げ、ここでは分割・統合・並べ替えだけを行う。
 */

import { searchParamsFor, type BreakLevel } from "../breakLevels";
import { getPool, type SolverPool } from "./pool";
import { RANKED_STRIDE, type WorkerTask } from "./protocol";
import {
  includesEnglish,
  includesRomaji,
  rotorPermutations,
  textToInts,
  type Language,
  type Progress,
  type RankedRow,
  type ResultRow,
} from "./types";

/** Phase A で評価する先頭文字数の上限（Python の sample_len と同じ）。 */
const MAX_SAMPLE_LEN = 200;
/** プラグボードの最大ペア数。 */
const MAX_PAIRS = 10;
/** SA の温度（Python 側 phase2_staged_rust の既定値）。 */
const SA_T_START = 12.0;
const SA_T_END = 0.3;
/** PB既知版 Phase A で残す候補数（Python の top_n=20）。 */
const KNOWN_PB_TOP_N = 20;

export interface SolveOptions {
  ciphertext: string;
  language: Language;
  topResults: number;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

export interface PlugboardSolveOptions extends SolveOptions {
  level: BreakLevel;
}

export interface KnownPlugboardSolveOptions extends SolveOptions {
  plugboard: string;
  /** リング設定を 676 通り探索するか */
  accuracy: boolean;
}

export interface SolveOutcome {
  results: ResultRow[];
  elapsedMs: number;
  workers: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("解読を中止しました", "AbortError");
}

/** 配列を n 個以下のほぼ均等な塊に分ける。空の塊は作らない。 */
function chunkEvenly<T>(items: T[], parts: number): T[][] {
  if (items.length === 0) return [];
  const count = Math.min(parts, items.length);
  const size = Math.ceil(items.length / count);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Float64Array（[score, r0..r2, p0..p2] × N）を行の配列へ戻す。 */
function decodeRanked(flat: Float64Array): RankedRow[] {
  const rows: RankedRow[] = [];
  for (let i = 0; i + RANKED_STRIDE <= flat.length; i += RANKED_STRIDE) {
    rows.push({
      score: flat[i],
      rotors: [flat[i + 1], flat[i + 2], flat[i + 3]],
      pos: [flat[i + 4], flat[i + 5], flat[i + 6]],
    });
  }
  return rows;
}

function sortByScoreDesc<T extends { score: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.score - a.score);
}

/** 同一復号文を除いて上位 n 件を返す（Python の `_dedupe`）。 */
function dedupe(rows: ResultRow[], limit: number): ResultRow[] {
  const seen = new Set<string>();
  const unique: ResultRow[] = [];
  for (const row of rows) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    unique.push(row);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** 候補（ローター順＋初期位置）を平坦な Uint32Array へ。6 要素で 1 組。 */
function flattenCandidates(rows: RankedRow[]): Uint32Array {
  const flat = new Uint32Array(rows.length * 6);
  rows.forEach((row, i) => {
    flat.set(row.rotors, i * 6);
    flat.set(row.pos, i * 6 + 3);
  });
  return flat;
}

/**
 * 平坦なローター順（3 要素で 1 組）をワーカー数ぶんの塊に切る。
 * 組の途中で切らないよう 3 の倍数境界で分割する。
 */
function splitRotorPerms(perms: Uint32Array, parts: number): Uint32Array[] {
  const total = perms.length / 3;
  const perChunk = Math.ceil(total / Math.min(parts, total));
  const chunks: Uint32Array[] = [];
  for (let start = 0; start < total; start += perChunk) {
    chunks.push(perms.slice(start * 3, Math.min(start + perChunk, total) * 3));
  }
  return chunks;
}

/** Phase A: ローター順 60 通りをワーカーへ分配して全探索する。 */
async function runPhase1(
  pool: SolverPool,
  sample: Uint8Array,
  topN: number,
  known: { plugboard: Uint8Array; useEn: boolean; useJa: boolean } | null,
  onProgress?: (progress: Progress) => void
): Promise<RankedRow[]> {
  const tasks: WorkerTask[] = splitRotorPerms(rotorPermutations(), pool.size).map(
    (rotorPerms) =>
      known
        ? {
            kind: "phase1Known" as const,
            ct: sample,
            rotorPerms,
            plugboard: known.plugboard,
            useEn: known.useEn,
            useJa: known.useJa,
            topN,
          }
        : { kind: "phase1" as const, ct: sample, rotorPerms, topN }
  );

  const shards = (await pool.runAll(tasks, (done, total) =>
    onProgress?.({ phase: "phase1", done, total })
  )) as Float64Array[];

  const merged = shards.flatMap((flat) => decodeRanked(flat));
  return sortByScoreDesc(merged).slice(0, topN);
}

/** Phase B: リング設定の再探索。候補が少ないので 1 候補 1 タスクで配る。 */
async function runRefine(
  pool: SolverPool,
  ct: Uint8Array,
  rows: ResultRow[],
  accuracy: boolean,
  fixedPlugboard: Uint8Array | null,
  onProgress?: (progress: Progress) => void
): Promise<ResultRow[]> {
  const tasks: WorkerTask[] = rows.map((row) =>
    fixedPlugboard
      ? {
          kind: "refineRingsFixedPb" as const,
          ct,
          rows: [row],
          plugboard: fixedPlugboard,
          accuracy,
        }
      : { kind: "refineRings" as const, ct, rows: [row], accuracy }
  );

  const shards = (await pool.runAll(tasks, (done, total) =>
    onProgress?.({ phase: "refine", done, total })
  )) as ResultRow[][];

  return sortByScoreDesc(shards.flat());
}

/**
 * プラグボード未知の完全解読。
 *
 * Phase A: IC ベースでローター順＋初期位置を全探索
 * Phase C: 段階スコア（IC→bigram→trigram）でプラグボードを復元
 * Phase B: リング設定を再探索
 */
export async function solvePlugboard(options: PlugboardSolveOptions): Promise<SolveOutcome> {
  const { ciphertext, language, level, topResults, onProgress, signal } = options;
  const started = performance.now();

  const ct = textToInts(ciphertext);
  const params = searchParamsFor(level, ct.length);
  const sample = ct.slice(0, Math.min(MAX_SAMPLE_LEN, ct.length));
  const useEn = includesEnglish(language);
  const useJa = includesRomaji(language);

  onProgress?.({ phase: "init", done: 0, total: 1 });
  const pool = await getPool(useJa);
  onProgress?.({ phase: "init", done: 1, total: 1 });
  throwIfAborted(signal);

  const candidates = await runPhase1(pool, sample, params.breadth, null, onProgress);
  throwIfAborted(signal);

  // Phase C: Phase A が残した候補をすべて評価する。
  // SA のシードは候補の通し番号から決まるので、連続した塊に切って
  // 先頭の番号（baseIndex）を渡す。
  const targets = candidates;
  let offset = 0;
  const phase2Tasks: WorkerTask[] = chunkEvenly(targets, pool.size).map((chunk) => {
    const task: WorkerTask = {
      kind: "phase2Staged",
      ct,
      candidates: flattenCandidates(chunk),
      baseIndex: offset,
      useEn,
      useJa,
      params: {
        max_pairs: MAX_PAIRS,
        n_restarts: params.nRestarts,
        sa_steps: params.saSteps,
        t_start: SA_T_START,
        t_end: SA_T_END,
      },
    };
    offset += chunk.length;
    return task;
  });

  const phase2Shards = (await pool.runAll(phase2Tasks, (done, total) =>
    onProgress?.({ phase: "phase2", done, total })
  )) as ResultRow[][];
  throwIfAborted(signal);

  let rows = dedupe(sortByScoreDesc(phase2Shards.flat()), topResults);
  rows = dedupe(
    await runRefine(pool, ct, rows, params.refineAccuracy, null, onProgress),
    topResults
  );

  return { results: rows, elapsedMs: performance.now() - started, workers: pool.size };
}

/**
 * プラグボード既知の解読。
 *
 * 既知 PB で復号して n-gram スコアを直接使えるので、Phase A の時点で
 * 正解が上位に来る。プラグボード復元（Phase C）は不要。
 */
export async function solveKnownPlugboard(
  options: KnownPlugboardSolveOptions & { plugboardArray: Uint8Array }
): Promise<SolveOutcome> {
  const { ciphertext, language, topResults, accuracy, plugboardArray, onProgress, signal } = options;
  const started = performance.now();

  const ct = textToInts(ciphertext);
  const sample = ct.slice(0, Math.min(MAX_SAMPLE_LEN, ct.length));
  const useEn = includesEnglish(language);
  const useJa = includesRomaji(language);

  onProgress?.({ phase: "init", done: 0, total: 1 });
  const pool = await getPool(useJa);
  onProgress?.({ phase: "init", done: 1, total: 1 });
  throwIfAborted(signal);

  const candidates = await runPhase1(
    pool, sample, KNOWN_PB_TOP_N,
    { plugboard: plugboardArray, useEn, useJa },
    onProgress
  );
  throwIfAborted(signal);

  // Phase A の上位候補をリング (0,0,0) の結果行に変換してから
  // リング再探索へ渡す。スコア付けは refine 側で単語照合込みに揃う。
  const seeded: ResultRow[] = candidates.slice(0, topResults).map((row) => ({
    score: row.score,
    rotors: row.rotors,
    pos: row.pos,
    rings: [0, 0, 0],
    pb: Array.from(plugboardArray),
    lang: "english",
    text: "",
  }));

  const rows = await runRefine(pool, ct, seeded, accuracy, plugboardArray, onProgress);
  return {
    results: rows.slice(0, topResults),
    elapsedMs: performance.now() - started,
    workers: pool.size,
  };
}
