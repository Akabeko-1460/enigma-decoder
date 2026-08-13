/* tslint:disable */
/* eslint-disable */

/**
 * 1 ワーカー分の解読エンジン。言語モデルを保持する。
 */
export class Solver {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 任意の設定で復号したテキストを返す（デバッグ・検証用）。
     */
    decrypt(ct: Uint8Array, rotors: Uint32Array, reflector_idx: number, rings: Uint8Array, pos: Uint8Array, plugboard: Uint8Array): string;
    /**
     * 言語モデルを構築する。
     *
     * - `ngram_text`: `ngrams_en.txt.gz` を展開したテキスト（英語モデル）
     * - `romaji_corpus`: ローマ字コーパス。空文字ならローマ字モデルを作らない
     *   （英語のみで解読するときはメモリと初期化時間を節約できる）
     * - `wordlist_text`: 1 行 1 単語の英単語リスト
     */
    constructor(ngram_text: string, romaji_corpus: string, wordlist_text: string);
    /**
     * Phase A（プラグボード既知）: 既知 PB で復号して n-gram スコアで順位付け。
     * 戻り値の形式は `phase1_shard` と同じ。
     */
    phase1_known_shard(ct: Uint8Array, rotor_perms_flat: Uint32Array, reflector_idx: number, plugboard: Uint8Array, use_en: boolean, use_ja: boolean, top_n: number): Float64Array;
    /**
     * Phase A: 担当分のローター順について 26³ の初期位置を全探索する。
     * 戻り値は [score, r0, r1, r2, p0, p1, p2] × N の平坦配列。
     */
    phase1_shard(ct: Uint8Array, rotor_perms_flat: Uint32Array, reflector_idx: number, top_n: number): Float64Array;
    /**
     * Phase C: 担当分の候補についてプラグボードを段階スコアで復元する。
     *
     * `base_index` は担当分の先頭が全体で何番目かを示す。SA のシードに
     * 使うため、これを間違えるとネイティブ版と結果が変わる。
     */
    phase2_staged_shard(ct: Uint8Array, candidates_flat: Uint32Array, base_index: number, reflector_idx: number, use_en: boolean, use_ja: boolean, params: any): any;
    /**
     * Phase B（プラグボード固定）: リング設定だけを再探索する。
     *
     * Python 側 `decrypt_known_plugboard.refine_rings_fixed_plugboard` の移植。
     * プラグボードが確定しているので再最適化は不要で、評価は一貫して
     * 単語照合込みの短文スコアで行う。
     */
    refine_rings_fixed_pb_shard(ct: Uint8Array, rows: any, plugboard: Uint8Array, accuracy: boolean, reflector_idx: number): any;
    /**
     * Phase B: 担当分の候補についてリング設定を再探索する（PB未知経路）。
     *
     * Python 側 `attack.refine_rings` の移植。リング候補の上位について
     * プラグボードを再最適化し、改善したものだけを採用する。
     */
    refine_rings_shard(ct: Uint8Array, rows: any, accuracy: boolean, reflector_idx: number): any;
    /**
     * テキストの最終スコア（言語判定込み）。Python の
     * `best_language_score_short` と同じ値を返す。Python との一致検証用。
     */
    score_text(text: string): any;
    /**
     * ローマ字モデルを構築したかどうか。
     */
    readonly has_romaji: boolean;
    /**
     * 読み込んだ単語リストの語数（初期化の健全性確認用）。
     */
    readonly word_count: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_solver_free: (a: number, b: number) => void;
    readonly solver_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly solver_has_romaji: (a: number) => number;
    readonly solver_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly solver_phase1_known_shard: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly solver_phase1_shard: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly solver_phase2_staged_shard: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: any) => [number, number, number];
    readonly solver_refine_rings_fixed_pb_shard: (a: number, b: number, c: number, d: any, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly solver_refine_rings_shard: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number];
    readonly solver_score_text: (a: number, b: number, c: number) => [number, number, number];
    readonly solver_word_count: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
