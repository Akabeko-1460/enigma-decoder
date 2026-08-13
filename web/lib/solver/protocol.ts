/** メインスレッドと Web Worker のメッセージ定義。 */

import type { ResultRow, SolverAssets, StagedParams } from "./types";

/** Phase 1 の 1 行あたりの要素数。Rust 側 `RANKED_STRIDE` と一致させること。 */
export const RANKED_STRIDE = 7;

export type WorkerTask =
  | { kind: "init"; assets: SolverAssets }
  | { kind: "phase1"; ct: Uint8Array; rotorPerms: Uint32Array; topN: number }
  | {
      kind: "phase1Known";
      ct: Uint8Array;
      rotorPerms: Uint32Array;
      plugboard: Uint8Array;
      useEn: boolean;
      useJa: boolean;
      topN: number;
    }
  | {
      kind: "phase2Staged";
      ct: Uint8Array;
      candidates: Uint32Array;
      baseIndex: number;
      useEn: boolean;
      useJa: boolean;
      params: StagedParams;
    }
  | { kind: "refineRings"; ct: Uint8Array; rows: ResultRow[]; accuracy: boolean }
  | {
      kind: "refineRingsFixedPb";
      ct: Uint8Array;
      rows: ResultRow[];
      plugboard: Uint8Array;
      accuracy: boolean;
    };

export type WorkerRequest = WorkerTask & { id: number };

export type WorkerResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

/** タスク種別ごとの戻り値の型。 */
export interface TaskResult {
  init: null;
  phase1: Float64Array;
  phase1Known: Float64Array;
  phase2Staged: ResultRow[];
  refineRings: ResultRow[];
  refineRingsFixedPb: ResultRow[];
}
