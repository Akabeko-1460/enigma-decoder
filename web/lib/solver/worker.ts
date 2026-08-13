/**
 * 解読ワーカー。WASM インスタンスを 1 つ持ち、渡された担当分だけを処理する。
 *
 * 並列化はワーカーを複数立てることで実現する（Rayon 相当）。WASM 側は
 * 完全にシングルスレッドなので SharedArrayBuffer も COOP/COEP も不要。
 */

import init, { Solver } from "../wasm/enigma_decoder.js";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { REFLECTOR_B } from "./types";

/** wasm 本体は public/ から配信する。バンドラの wasm 解決に依存しないため。 */
const WASM_URL = "/wasm/enigma_decoder_bg.wasm";

let solver: Solver | null = null;
let wasmReady: Promise<unknown> | null = null;

function requireSolver(): Solver {
  if (!solver) throw new Error("solver is not initialized");
  return solver;
}

async function handle(task: WorkerRequest): Promise<unknown> {
  if (task.kind === "init") {
    wasmReady ??= init({ module_or_path: WASM_URL });
    await wasmReady;
    solver?.free();
    solver = new Solver(task.assets.ngramText, task.assets.romajiCorpus, task.assets.wordlistText);
    return null;
  }

  const s = requireSolver();
  switch (task.kind) {
    case "phase1":
      return s.phase1_shard(task.ct, task.rotorPerms, REFLECTOR_B, task.topN);
    case "phase1Known":
      return s.phase1_known_shard(
        task.ct, task.rotorPerms, REFLECTOR_B, task.plugboard,
        task.useEn, task.useJa, task.topN);
    case "phase2Staged":
      return s.phase2_staged_shard(
        task.ct, task.candidates, task.baseIndex, REFLECTOR_B,
        task.useEn, task.useJa, task.params);
    case "refineRings":
      return s.refine_rings_shard(task.ct, task.rows, task.accuracy, REFLECTOR_B);
    case "refineRingsFixedPb":
      return s.refine_rings_fixed_pb_shard(
        task.ct, task.rows, task.plugboard, task.accuracy, REFLECTOR_B);
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const task = event.data;
  let response: WorkerResponse;
  try {
    response = { id: task.id, ok: true, data: await handle(task) };
  } catch (err) {
    response = { id: task.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
