/**
 * PB未知解読の精度レベル定義。
 *
 * Python 側 `decrypt_plugboard.MODE_PARAMS` / `_scale_params_for_length` の
 * 移植。ブラウザ版（WASM）とローカル版（Python）で同じ探索幅になるよう、
 * 数値と短文時の拡大ルールを一対一で対応させている。
 * 片方だけ変えると結果がずれるので、変更時は両方を直すこと。
 */

export const BREAK_LEVELS = ["normal", "accuracy", "thorough"] as const;
export type BreakLevel = (typeof BREAK_LEVELS)[number];

export const DEFAULT_BREAK_LEVEL: BreakLevel = "accuracy";

export function isBreakLevel(v: unknown): v is BreakLevel {
  return BREAK_LEVELS.includes(v as BreakLevel);
}

/** 探索の広さを決めるパラメータ一式。 */
export interface SearchParams {
  /**
   * Phase A で残し、そのまま Phase C にかける候補数。
   *
   * Python 版は Phase A の保持数（top_n）と Phase C の実行数（max_candidates）が
   * 別々で、後者が小さいぶん「捕捉できていたのに評価されない候補」が出る。
   * 実測: 131字・3ペアで正解は Phase A の 537 位に居たが、max_candidates=200 で
   * 捨てられ解読に失敗した（その候補だけを Phase C に通すと完全復元する）。
   * ブラウザ版はサーバーの実行時間上限が無く並列度も上げられるので、
   * 2 つを 1 本化して「残した候補は全部評価する」ことにしている。
   */
  breadth: number;
  /** 山登りのマルチスタート回数 */
  nRestarts: number;
  /** SA 磨き上げのステップ数 */
  saSteps: number;
  /** Phase B のリング探索を 676 通り（true）か 26 通り（false）か */
  refineAccuracy: boolean;
}

/** 短文で探索幅を自動拡大するときの倍率。 */
const WIDTH_SCALE: Record<BreakLevel, number> = {
  normal: 0.3,
  accuracy: 1.0,
  thorough: 3.0,
};

const BASE_PARAMS: Record<BreakLevel, SearchParams> = {
  normal: { breadth: 300, nRestarts: 2, saSteps: 15000, refineAccuracy: false },
  accuracy: { breadth: 1000, nRestarts: 4, saSteps: 40000, refineAccuracy: true },
  thorough: { breadth: 3000, nRestarts: 8, saSteps: 120000, refineAccuracy: true },
};

/**
 * 暗号文長に応じて探索幅を広げる。
 *
 * 短文では正解が Phase A の上位から落ちやすいため下限を設ける。下限は
 * レベルごとの倍率に比例させるが、再スタート回数だけは倍率を掛けない
 * （徹底モードで跳ね上がると所要時間が桁で変わるため）。
 */
export function searchParamsFor(level: BreakLevel, ctLength: number): SearchParams {
  const base = BASE_PARAMS[level];
  const scale = WIDTH_SCALE[level];

  let floorBreadth: number;
  let floorRestarts: number;
  if (ctLength < 80) {
    [floorBreadth, floorRestarts] = [3000, 6];
  } else if (ctLength < 150) {
    [floorBreadth, floorRestarts] = [1000, 4];
  } else {
    return { ...base };
  }

  return {
    ...base,
    breadth: Math.max(base.breadth, Math.trunc(floorBreadth * scale)),
    nRestarts: Math.max(base.nRestarts, floorRestarts),
  };
}

export interface BreakLevelInfo {
  /** セレクトボックスに出す名前 */
  label: string;
  /** 所要時間の目安（ブラウザ実行・並列あり） */
  estimate: string;
  /** どういうときに選ぶか */
  hint: string;
}

export const BREAK_LEVEL_INFO: Record<BreakLevel, BreakLevelInfo> = {
  normal: {
    label: "通常（速い）",
    estimate: "10 秒〜1 分",
    hint: "150 文字以上の長文・プラグボードが少なめ（0〜3ペア）のとき。まずはこれで十分。",
  },
  accuracy: {
    label: "精度（既定）",
    estimate: "1〜3 分",
    hint: "迷ったらこれ。短文では探索幅を自動で拡大する。",
  },
  thorough: {
    label: "徹底（非常に遅い）",
    estimate: "10 分〜1 時間",
    hint: "100 文字未満＋4ペア以上など、精度モードで解けなかったときの最後の手段。タブを開いたままにすること。",
  },
};
