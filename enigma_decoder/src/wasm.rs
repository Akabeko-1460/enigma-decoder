//! ブラウザ向け wasm-bindgen バインディング。
//!
//! 並列化は行わない。JS 側が CPU コア数だけ Web Worker を起動し、各ワーカーが
//! この `Solver` を 1 つ持って「担当分（シャード）」だけを処理する。
//! ネイティブ版が Rayon の par_iter で回している単位と同じ粒度なので、
//! 分割の仕方によらず結果は一致する。
//!
//! 候補の通し番号（`base_index`）だけは注意が必要で、SA の乱数シードに
//! 使われるため、シャードに切っても**全体での位置**を渡す必要がある。

use crate::core::*;
use crate::langmodel::{ints_to_text, text_to_ints, LanguageModel, Models, WordList};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Phase 1 の 1 行を平坦配列で表したときの要素数。
/// 並びは [score, r0, r1, r2, p0, p1, p2]。
///
/// Phase 1 は数千〜数万件を返すため、オブジェクトの配列にすると
/// JS への変換が支配的なコストになる。Float64Array 1 本で受け渡す。
pub const RANKED_STRIDE: usize = 7;

/// 解読結果 1 件。Python 側の 7 要素タプルと同じ内容。
#[derive(Serialize, Deserialize, Clone)]
pub struct ResultRow {
    pub score: f64,
    pub rotors: [usize; 3],
    pub pos: [u8; 3],
    pub rings: [u8; 3],
    pub pb: Vec<u8>,
    pub lang: String,
    pub text: String,
}

/// `score_text` の戻り値。
#[derive(Serialize)]
pub struct ScoredText {
    pub lang: String,
    pub score: f64,
}

/// 段階スコア Phase 2 のパラメータ。
#[derive(Serialize, Deserialize)]
pub struct StagedParams {
    pub max_pairs: usize,
    pub n_restarts: usize,
    pub sa_steps: usize,
    pub t_start: f64,
    pub t_end: f64,
}

/// リング再探索でプラグボードを再最適化する際の反復上限。
/// Python 側 `refine_rings` の `max_iterations=15` に対応。
const REFINE_HC_MAX_ITERATIONS: usize = 15;
/// リング再探索でプラグボード再最適化を試す候補のスコア許容差。
const REFINE_SCORE_TOLERANCE: f64 = 0.3;
/// リング候補のうち、プラグボード再最適化まで進める上位件数。
const REFINE_TOP_RING_CANDIDATES: usize = 5;
/// リング再探索時のプラグボード最大ペア数。
const REFINE_MAX_PAIRS: usize = 10;

fn to_pb_array(pb: &[u8]) -> [u8; 26] {
    let mut out = identity_pb();
    if pb.len() >= 26 {
        out.copy_from_slice(&pb[..26]);
    }
    out
}

/// Phase 1 の結果を [score, r0, r1, r2, p0, p1, p2] の平坦配列へ。
fn flatten_ranked(rows: &[Ranked]) -> Vec<f64> {
    let mut out = Vec::with_capacity(rows.len() * RANKED_STRIDE);
    for &(score, rotors, pos) in rows {
        out.push(score);
        out.extend(rotors.iter().map(|&r| r as f64));
        out.extend(pos.iter().map(|&p| p as f64));
    }
    out
}

/// 平坦化された u32 配列を 3 要素ずつのローター順へ。
fn unflatten_rotors(flat: &[u32]) -> Vec<[usize; 3]> {
    flat.chunks_exact(3)
        .map(|c| [c[0] as usize, c[1] as usize, c[2] as usize])
        .collect()
}

/// 平坦化された u32 配列を (ローター順, 初期位置) の組へ。6 要素で 1 組。
fn unflatten_candidates(flat: &[u32]) -> Vec<([usize; 3], [u8; 3])> {
    flat.chunks_exact(6)
        .map(|c| {
            (
                [c[0] as usize, c[1] as usize, c[2] as usize],
                [c[3] as u8, c[4] as u8, c[5] as u8],
            )
        })
        .collect()
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsError::new(&e.to_string()))
}

fn from_js<T: for<'de> Deserialize<'de>>(value: JsValue) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(value).map_err(|e| JsError::new(&e.to_string()))
}

/// 1 ワーカー分の解読エンジン。言語モデルを保持する。
#[wasm_bindgen]
pub struct Solver {
    models: Models,
}

#[wasm_bindgen]
impl Solver {
    /// 言語モデルを構築する。
    ///
    /// - `ngram_text`: `ngrams_en.txt.gz` を展開したテキスト（英語モデル）
    /// - `romaji_corpus`: ローマ字コーパス。空文字ならローマ字モデルを作らない
    ///   （英語のみで解読するときはメモリと初期化時間を節約できる）
    /// - `wordlist_text`: 1 行 1 単語の英単語リスト
    #[wasm_bindgen(constructor)]
    pub fn new(
        ngram_text: &str,
        romaji_corpus: &str,
        wordlist_text: &str,
    ) -> Result<Solver, JsError> {
        let english = LanguageModel::from_ngram_counts(ngram_text)
            .map_err(|e| JsError::new(&format!("english model: {e}")))?;
        let romaji = if romaji_corpus.trim().is_empty() {
            None
        } else {
            Some(
                LanguageModel::from_corpus(romaji_corpus)
                    .map_err(|e| JsError::new(&format!("romaji model: {e}")))?,
            )
        };
        let words = WordList::from_text(wordlist_text);
        Ok(Solver { models: Models { english, romaji, words } })
    }

    /// 読み込んだ単語リストの語数（初期化の健全性確認用）。
    #[wasm_bindgen(getter)]
    pub fn word_count(&self) -> usize {
        self.models.words.len()
    }

    /// ローマ字モデルを構築したかどうか。
    #[wasm_bindgen(getter)]
    pub fn has_romaji(&self) -> bool {
        self.models.romaji.is_some()
    }

    fn scorers(&self) -> (Scorer<'_>, Scorer<'_>) {
        let en = &self.models.english;
        let en_sc = Scorer::new(&en.tri, en.tri_floor, &en.quad, en.quad_floor);
        // ローマ字モデルが無いときは英語モデルを差し替える。呼び出し側は
        // use_ja=false にしているので参照されない。
        let ja = self.models.romaji.as_ref().unwrap_or(en);
        let ja_sc = Scorer::new(&ja.tri, ja.tri_floor, &ja.quad, ja.quad_floor);
        (en_sc, ja_sc)
    }

    /// Phase A: 担当分のローター順について 26³ の初期位置を全探索する。
    /// 戻り値は [score, r0, r1, r2, p0, p1, p2] × N の平坦配列。
    pub fn phase1_shard(
        &self,
        ct: &[u8],
        rotor_perms_flat: &[u32],
        reflector_idx: usize,
        top_n: usize,
    ) -> Vec<f64> {
        let mut rows: Vec<Ranked> = Vec::new();
        for rotors in unflatten_rotors(rotor_perms_flat) {
            rows.extend(phase1_rotor_block(ct, rotors, reflector_idx, top_n));
        }
        sort_desc_truncate(&mut rows, top_n);
        flatten_ranked(&rows)
    }

    /// Phase A（プラグボード既知）: 既知 PB で復号して n-gram スコアで順位付け。
    /// 戻り値の形式は `phase1_shard` と同じ。
    pub fn phase1_known_shard(
        &self,
        ct: &[u8],
        rotor_perms_flat: &[u32],
        reflector_idx: usize,
        plugboard: &[u8],
        use_en: bool,
        use_ja: bool,
        top_n: usize,
    ) -> Vec<f64> {
        let pb = to_pb_array(plugboard);
        let (en_sc, ja_sc) = self.scorers();

        let mut rows: Vec<Ranked> = Vec::new();
        for rotors in unflatten_rotors(rotor_perms_flat) {
            rows.extend(phase1_known_rotor_block(
                ct, rotors, reflector_idx, &pb, use_en, use_ja, &en_sc, &ja_sc, top_n));
        }
        sort_desc_truncate(&mut rows, top_n);
        flatten_ranked(&rows)
    }

    /// Phase C: 担当分の候補についてプラグボードを段階スコアで復元する。
    ///
    /// `base_index` は担当分の先頭が全体で何番目かを示す。SA のシードに
    /// 使うため、これを間違えるとネイティブ版と結果が変わる。
    pub fn phase2_staged_shard(
        &self,
        ct: &[u8],
        candidates_flat: &[u32],
        base_index: usize,
        reflector_idx: usize,
        use_en: bool,
        use_ja: bool,
        params: JsValue,
    ) -> Result<JsValue, JsError> {
        let params: StagedParams = from_js(params)?;
        let (en_sc, ja_sc) = self.scorers();
        let en = &self.models.english;
        let ja = self.models.romaji.as_ref().unwrap_or(en);
        let models = StagedModels {
            use_en,
            use_ja,
            en_bi: &en.bi,
            en_bi_floor: en.bi_floor,
            ja_bi: &ja.bi,
            ja_bi_floor: ja.bi_floor,
            en_sc: &en_sc,
            ja_sc: &ja_sc,
        };

        let mut out: Vec<ResultRow> = Vec::new();
        for (offset, (rotors, pos)) in unflatten_candidates(candidates_flat).into_iter().enumerate() {
            let (_score, rotors, pos, pb) = phase2_staged_one(
                ct, base_index + offset, rotors, pos, reflector_idx, &models,
                params.max_pairs, params.n_restarts, params.sa_steps,
                params.t_start, params.t_end);
            out.push(self.build_row(ct, rotors, pos, [0, 0, 0], &pb, reflector_idx));
        }
        to_js(&out)
    }

    /// Phase B: 担当分の候補についてリング設定を再探索する（PB未知経路）。
    ///
    /// Python 側 `attack.refine_rings` の移植。リング候補の上位について
    /// プラグボードを再最適化し、改善したものだけを採用する。
    pub fn refine_rings_shard(
        &self,
        ct: &[u8],
        rows: JsValue,
        accuracy: bool,
        reflector_idx: usize,
    ) -> Result<JsValue, JsError> {
        let rows: Vec<ResultRow> = from_js(rows)?;
        let (en_sc, ja_sc) = self.scorers();

        let refined: Vec<ResultRow> = rows
            .into_iter()
            .map(|row| self.refine_one(ct, row, accuracy, reflector_idx, &en_sc, &ja_sc))
            .collect();
        to_js(&refined)
    }

    /// Phase B（プラグボード固定）: リング設定だけを再探索する。
    ///
    /// Python 側 `decrypt_known_plugboard.refine_rings_fixed_plugboard` の移植。
    /// プラグボードが確定しているので再最適化は不要で、評価は一貫して
    /// 単語照合込みの短文スコアで行う。
    pub fn refine_rings_fixed_pb_shard(
        &self,
        ct: &[u8],
        rows: JsValue,
        plugboard: &[u8],
        accuracy: bool,
        reflector_idx: usize,
    ) -> Result<JsValue, JsError> {
        let rows: Vec<ResultRow> = from_js(rows)?;
        let pb = to_pb_array(plugboard);

        let refined: Vec<ResultRow> = rows
            .into_iter()
            .map(|row| {
                let core = EnigmaCore::new(row.rotors, reflector_idx);
                let mut best = self.score_setting(&core, ct, row.rotors, row.pos, row.rings, &pb, true);

                for (rings, pos) in ring_variants(row.rings, row.pos, accuracy) {
                    let cand = self.score_setting(&core, ct, row.rotors, pos, rings, &pb, true);
                    if cand.score > best.score {
                        best = cand;
                    }
                }
                best
            })
            .collect();
        to_js(&refined)
    }

    /// 与えた設定で復号し、単語照合込みの短文スコアで評価した 1 行を作る。
    fn score_setting(
        &self,
        core: &EnigmaCore,
        ct: &[u8],
        rotors: [usize; 3],
        pos: [u8; 3],
        rings: [u8; 3],
        pb: &[u8; 26],
        short: bool,
    ) -> ResultRow {
        let mut out = Vec::with_capacity(ct.len());
        core.decrypt(ct, rings, pos, pb, &mut out);
        let scored = if short {
            self.models.best_language_score_short(&out)
        } else {
            self.models.best_language_score(&out)
        };
        ResultRow {
            score: scored.score,
            rotors,
            pos,
            rings,
            pb: pb.to_vec(),
            lang: scored.lang.to_string(),
            text: ints_to_text(&out),
        }
    }

    fn build_row(
        &self,
        ct: &[u8],
        rotors: [usize; 3],
        pos: [u8; 3],
        rings: [u8; 3],
        pb: &[u8; 26],
        reflector_idx: usize,
    ) -> ResultRow {
        let core = EnigmaCore::new(rotors, reflector_idx);
        self.score_setting(&core, ct, rotors, pos, rings, pb, true)
    }

    /// `refine_rings` の 1 候補分。
    fn refine_one(
        &self,
        ct: &[u8],
        row: ResultRow,
        accuracy: bool,
        reflector_idx: usize,
        en_sc: &Scorer,
        ja_sc: &Scorer,
    ) -> ResultRow {
        let core = EnigmaCore::new(row.rotors, reflector_idx);
        let pb = to_pb_array(&row.pb);
        let mut best = row.clone();

        // 各リング設定を評価して上位だけを残す（全件で山登りすると重すぎるため）
        let mut ring_candidates: Vec<ResultRow> = ring_variants(row.rings, row.pos, accuracy)
            .into_iter()
            .map(|(rings, pos)| self.score_setting(&core, ct, row.rotors, pos, rings, &pb, false))
            .collect();
        ring_candidates.sort_unstable_by(|a, b| {
            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
        });
        ring_candidates.truncate(REFINE_TOP_RING_CANDIDATES);

        for candidate in ring_candidates {
            if candidate.score > best.score {
                best = candidate.clone();
            }
            // 現ベストに肉薄する候補だけプラグボードを再最適化する
            if candidate.score < best.score - REFINE_SCORE_TOLERANCE {
                continue;
            }
            let scorer = if candidate.lang == "english" { en_sc } else { ja_sc };
            let (pb3, _) = hc_generic(
                ct, &core, candidate.pos, candidate.rings,
                &|t: &[u8]| scorer.score_raw(t),
                REFINE_MAX_PAIRS, pb, Some(REFINE_HC_MAX_ITERATIONS));
            let improved = self.score_setting(
                &core, ct, row.rotors, candidate.pos, candidate.rings, &pb3, false);
            if improved.score > best.score {
                best = improved;
            }
        }
        best
    }

    /// 任意の設定で復号したテキストを返す（デバッグ・検証用）。
    pub fn decrypt(
        &self,
        ct: &[u8],
        rotors: &[u32],
        reflector_idx: usize,
        rings: &[u8],
        pos: &[u8],
        plugboard: &[u8],
    ) -> String {
        let core = EnigmaCore::new(
            [rotors[0] as usize, rotors[1] as usize, rotors[2] as usize],
            reflector_idx,
        );
        let pb = to_pb_array(plugboard);
        let mut out = Vec::with_capacity(ct.len());
        core.decrypt(ct, [rings[0], rings[1], rings[2]], [pos[0], pos[1], pos[2]], &pb, &mut out);
        ints_to_text(&out)
    }

    /// テキストの最終スコア（言語判定込み）。Python の
    /// `best_language_score_short` と同じ値を返す。Python との一致検証用。
    pub fn score_text(&self, text: &str) -> Result<JsValue, JsError> {
        let scored = self.models.best_language_score_short(&text_to_ints(text));
        to_js(&ScoredText { lang: scored.lang.to_string(), score: scored.score })
    }
}

/// 再探索するリング設定と、それに対応する初期位置の組を列挙する。
///
/// リングを進めると等価な初期位置もずれるため、`(pos + ring) % 26` で
/// 補正する（Python 側 refine_rings と同じ）。
fn ring_variants(rings: [u8; 3], pos: [u8; 3], accuracy: bool) -> Vec<([u8; 3], [u8; 3])> {
    let mut out = Vec::with_capacity(if accuracy { 676 } else { 26 });
    if accuracy {
        for rm in 0u8..26 {
            for rr in 0u8..26 {
                out.push((
                    [rings[0], rm, rr],
                    [pos[0], (pos[1] + rm) % 26, (pos[2] + rr) % 26],
                ));
            }
        }
    } else {
        for rr in 0u8..26 {
            out.push((
                [rings[0], rings[1], rr],
                [pos[0], pos[1], (pos[2] + rr) % 26],
            ));
        }
    }
    out
}
