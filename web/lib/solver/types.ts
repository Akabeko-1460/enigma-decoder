/** WASM 解読エンジンとやり取りするデータ型。Rust 側 `wasm.rs` と対応。 */

/** Phase A / 1B の出力 1 件。 */
export interface RankedRow {
  score: number;
  /** ローター番号（0=I … 4=V）を左・中・右の順で */
  rotors: [number, number, number];
  pos: [number, number, number];
}

/** 解読結果 1 件。Python 側の 7 要素タプルと同じ内容。 */
export interface ResultRow {
  score: number;
  rotors: [number, number, number];
  pos: [number, number, number];
  rings: [number, number, number];
  /** 26 要素の置換表 */
  pb: number[];
  lang: string;
  text: string;
}

/** 段階スコア Phase C のパラメータ。Rust 側 `StagedParams` と対応。 */
export interface StagedParams {
  max_pairs: number;
  n_restarts: number;
  sa_steps: number;
  t_start: number;
  t_end: number;
}

/** 言語モデルの構築に必要なテキスト資産（展開済み）。 */
export interface SolverAssets {
  ngramText: string;
  /** 空文字ならローマ字モデルを作らない */
  romajiCorpus: string;
  wordlistText: string;
}

export type Language = "auto" | "english" | "romaji";

/** 進捗通知。フェーズ内の完了シャード数を伝える。 */
export interface Progress {
  phase: "init" | "phase1" | "phase2" | "refine";
  done: number;
  total: number;
}

export const ROTOR_LABELS = ["I", "II", "III", "IV", "V"] as const;

/** リフレクター B のインデックス（Rust 側 REFLECTORS の並び）。 */
export const REFLECTOR_B = 0;

export function useEnglish(language: Language): boolean {
  return language === "auto" || language === "english";
}

export function useRomaji(language: Language): boolean {
  return language === "auto" || language === "romaji";
}

/** A-Z だけを 0..25 へ。それ以外は捨てる（Python の text_to_ints と同じ）。 */
export function textToInts(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) out.push(code - 65);
  }
  return Uint8Array.from(out);
}

/** 0..25 の並びを "HEW" のような文字列へ。 */
export function intsToText(ints: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < ints.length; i++) s += String.fromCharCode(ints[i] + 65);
  return s;
}

/** 26 要素の置換表を "AB CD" 形式へ。ペアが無ければ空文字。 */
export function formatPlugboard(pb: ArrayLike<number>): string {
  const pairs: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 26; i++) {
    if (pb[i] !== i && !seen.has(i)) {
      pairs.push(String.fromCharCode(65 + i) + String.fromCharCode(65 + pb[i]));
      seen.add(i);
      seen.add(pb[i]);
    }
  }
  return pairs.join(" ");
}

/** "AB CD" 形式を 26 要素の置換表へ。 */
export function parsePlugboard(text: string): Uint8Array {
  const pb = new Uint8Array(26);
  for (let i = 0; i < 26; i++) pb[i] = i;
  for (const pair of text.toUpperCase().split(/\s+/)) {
    if (pair.length !== 2) continue;
    const a = pair.charCodeAt(0) - 65;
    const b = pair.charCodeAt(1) - 65;
    if (a >= 0 && a < 26 && b >= 0 && b < 26 && a !== b) {
      pb[a] = b;
      pb[b] = a;
    }
  }
  return pb;
}

/**
 * 5 本から 3 本を選ぶ順列 60 通りを平坦な Uint32Array で返す。
 *
 * 並び順は Python の `itertools.permutations(range(5), 3)` と同じ辞書順。
 * 同点候補の並びをローカル版と揃えるため、順序を合わせておく。
 */
export function rotorPermutations(): Uint32Array {
  const out: number[] = [];
  for (let a = 0; a < 5; a++) {
    for (let b = 0; b < 5; b++) {
      if (b === a) continue;
      for (let c = 0; c < 5; c++) {
        if (c === a || c === b) continue;
        out.push(a, b, c);
      }
    }
  }
  return Uint32Array.from(out);
}
