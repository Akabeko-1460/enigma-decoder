/**
 * 解読ワーカーのプール。
 *
 * ネイティブ版が Rayon で並列化していた粒度（ローター順ごと・候補ごと）を、
 * そのままワーカーへ配る。各ワーカーは独立した WASM インスタンスと言語モデルを
 * 持つため、共有メモリも SharedArrayBuffer も不要。
 */

import type { WorkerRequest, WorkerResponse, WorkerTask } from "./protocol";
import { loadAssets } from "./assets";

/**
 * ワーカー数の上限。1 ワーカーあたり言語モデルで数 MB 使うので、
 * コア数が多い環境でも無制限には増やさない。
 */
const MAX_WORKERS = 8;

interface Job {
  task: WorkerTask;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  current: Job | null;
}

export function defaultWorkerCount(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  return Math.max(1, Math.min(cores || 4, MAX_WORKERS));
}

class SolverPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;

  constructor(readonly size: number, readonly withRomaji: boolean) {
    for (let i = 0; i < size; i++) {
      this.slots.push(this.spawn());
    }
  }

  private spawn(): Slot {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, current: null };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const job = slot.current;
      slot.current = null;
      if (job) {
        const res = event.data;
        if (res.ok) job.resolve(res.data);
        else job.reject(new Error(res.error));
      }
      this.pump();
    };
    worker.onerror = (event) => {
      const job = slot.current;
      slot.current = null;
      job?.reject(new Error(event.message || "worker error"));
      this.pump();
    };
    return slot;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.current || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      slot.current = job;
      const request: WorkerRequest = { ...job.task, id: this.nextId++ };
      slot.worker.postMessage(request);
    }
  }

  submit(task: WorkerTask): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  /**
   * 全ワーカーへ言語モデルを配って初期化する。
   *
   * init は「どれか 1 つ」ではなく「全ワーカーが 1 回ずつ」実行する必要が
   * あるため、キューを介さずスロットへ直接投げる。生成直後にしか呼ばないので
   * この時点では全スロットが空いている。
   */
  async init(): Promise<void> {
    const assets = await loadAssets(this.withRomaji);
    const task: WorkerTask = { kind: "init", assets };

    await Promise.all(
      this.slots.map(
        (slot) =>
          new Promise<void>((resolve, reject) => {
            slot.current = { task, resolve: () => resolve(), reject };
            slot.worker.postMessage({ ...task, id: this.nextId++ } as WorkerRequest);
          })
      )
    );
  }

  /**
   * タスク群を投入し、完了順ではなく**投入順**の結果配列を返す。
   * `onDone` は 1 件終わるごとに呼ばれる（進捗表示用）。
   */
  async runAll(tasks: WorkerTask[], onDone?: (done: number, total: number) => void): Promise<unknown[]> {
    let done = 0;
    return Promise.all(
      tasks.map(async (task) => {
        const result = await this.submit(task);
        done += 1;
        onDone?.(done, tasks.length);
        return result;
      })
    );
  }

  terminate(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    this.queue = [];
  }
}

let pool: SolverPool | null = null;
let poolReady: Promise<SolverPool> | null = null;

/**
 * プールを取得する（初回は生成と初期化を行う）。
 * ローマ字モデルの要否が変わったときは作り直す。
 */
export function getPool(withRomaji: boolean): Promise<SolverPool> {
  if (pool && pool.withRomaji === withRomaji && poolReady) return poolReady;
  pool?.terminate();
  const created = new SolverPool(defaultWorkerCount(), withRomaji);
  pool = created;
  poolReady = created.init().then(() => created);
  return poolReady;
}

export function terminatePool(): void {
  pool?.terminate();
  pool = null;
  poolReady = null;
}

export type { SolverPool };
