//! プラットフォーム非依存の解読コア。
//!
//! PyO3 / wasm-bindgen のどちらにも依存しない。並列化もここでは行わず、
//! 「1 ローター順を処理する」「1 候補を処理する」単位の関数を公開する。
//! ネイティブ版は Rayon で、ブラウザ版は Web Worker プールでこれらを束ねる。

use std::cell::Cell;

use rand::rngs::SmallRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};

pub const ROTORS: [&str; 5] = [
    "EKMFLGDQVZNTOWYHXUSPAIBRCJ", // I
    "AJDKSIRUXBLHWTMCQGZNPYFVOE", // II
    "BDFHJLCPRTXVZNYEIWGAKMUSQO", // III
    "ESOVPZJAYQUIRHXLNFTGKDCMWB", // IV
    "VZBRGITYUPSDNHLXAWMJQOFECK", // V
];

pub const NOTCHES: [u8; 5] = [
    16, // Q (I)
    4,  // E (II)
    21, // V (III)
    9,  // J (IV)
    25, // Z (V)
];

pub const REFLECTORS: [&str; 2] = [
    "YRUHQSLDPXNGOKMIEBFZCWVJAT", // B
    "FVPJIAOYEDRZXWGCTKUQSBNMHL", // C
];

/// SA のシード生成に使う黄金比定数。候補ごとに独立な乱数列を得るため。
const SEED_STRIDE: u64 = 0x9E37_79B9_7F4A_7C15;

#[derive(Clone)]
pub struct EnigmaCore {
    fwd: [[u8; 26]; 3],
    bwd: [[u8; 26]; 3],
    notches: [u8; 3],
    refl: [u8; 26],
}

impl EnigmaCore {
    pub fn new(rotor_indices: [usize; 3], reflector_idx: usize) -> Self {
        let mut fwd = [[0u8; 26]; 3];
        let mut bwd = [[0u8; 26]; 3];
        let mut notches = [0u8; 3];

        for i in 0..3 {
            let ri = rotor_indices[i];
            let wiring = ROTORS[ri].as_bytes();
            for j in 0..26 {
                let v = wiring[j] - 65;
                fwd[i][j] = v;
                bwd[i][v as usize] = j as u8;
            }
            notches[i] = NOTCHES[ri];
        }

        let mut refl = [0u8; 26];
        let r_wiring = REFLECTORS[reflector_idx].as_bytes();
        for j in 0..26 {
            refl[j] = r_wiring[j] - 65;
        }

        Self { fwd, bwd, notches, refl }
    }

    /// Decrypt ciphertext bytes into `out`, which is cleared first.
    #[inline]
    pub fn decrypt(&self, ct: &[u8], rings: [u8; 3], pos: [u8; 3], pb: &[u8; 26], out: &mut Vec<u8>) {
        out.clear();
        let mut p0 = pos[0];
        let mut p1 = pos[1];
        let mut p2 = pos[2];
        let r0 = rings[0];
        let r1 = rings[1];
        let r2 = rings[2];

        for &c in ct.iter() {
            // Double-stepping anomaly
            if p1 == self.notches[1] {
                p0 = (p0 + 1) % 26;
                p1 = (p1 + 1) % 26;
            } else if p2 == self.notches[2] {
                p1 = (p1 + 1) % 26;
            }
            p2 = (p2 + 1) % 26;

            let mut x = pb[c as usize];
            // Right to left through rotors
            x = self.fwd[2][((x + p2 + 26 - r2) % 26) as usize];
            x = (x + 26 - p2 + r2) % 26;
            x = self.fwd[1][((x + p1 + 26 - r1) % 26) as usize];
            x = (x + 26 - p1 + r1) % 26;
            x = self.fwd[0][((x + p0 + 26 - r0) % 26) as usize];
            x = (x + 26 - p0 + r0) % 26;
            // Reflector
            x = self.refl[x as usize];
            // Left to right back through rotors
            x = self.bwd[0][((x + p0 + 26 - r0) % 26) as usize];
            x = (x + 26 - p0 + r0) % 26;
            x = self.bwd[1][((x + p1 + 26 - r1) % 26) as usize];
            x = (x + 26 - p1 + r1) % 26;
            x = self.bwd[2][((x + p2 + 26 - r2) % 26) as usize];
            x = (x + 26 - p2 + r2) % 26;
            out.push(pb[x as usize]);
        }
    }
}

// ------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------

/// Unigram Index of Coincidence (IC).
/// English ≈ 0.065, random ≈ 0.038. Invariant under plugboard substitution.
#[inline]
pub fn score_ic(text: &[u8]) -> f64 {
    let n = text.len();
    if n < 2 { return 0.0; }
    let mut counts = [0u32; 26];
    for &c in text { counts[c as usize] += 1; }
    let mut sum = 0u64;
    for &c in &counts {
        let c = c as u64;
        sum += c * c.saturating_sub(1);
    }
    (sum as f64) / ((n as f64) * (n as f64 - 1.0))
}

/// Bigram Index of Coincidence.
/// English BiIC ≈ 0.0060, random ≈ 0.0015 — ratio ≈4× (vs IC ratio ≈1.7×).
/// Also invariant under plugboard because plugboard is a consistent substitution.
#[inline]
pub fn score_bigram_ic(text: &[u8]) -> f64 {
    let n = text.len();
    if n < 3 { return 0.0; }
    let nb = (n - 1) as f64;
    let mut counts = [0u32; 676];
    for i in 0..n - 1 {
        counts[text[i] as usize * 26 + text[i + 1] as usize] += 1;
    }
    let mut sum = 0.0f64;
    for &c in &counts {
        let cf = c as f64;
        if cf > 1.0 { sum += cf * (cf - 1.0); }
    }
    sum / (nb * (nb - 1.0))
}

/// Combined Phase 1 score.
/// IC + 6×BiIC so both components contribute equally to the discrimination signal.
#[inline]
pub fn score_phase1(text: &[u8]) -> f64 {
    score_ic(text) + 6.0 * score_bigram_ic(text)
}

/// bigram log-probability score of `text` against a 676-entry table.
#[inline]
pub fn bigram_logscore(text: &[u8], bi: &[f64], floor: f64) -> f64 {
    let len = text.len();
    if len < 2 { return -1e9; }
    let mut s = 0.0f64;
    for i in 0..len - 1 {
        let idx = (text[i] as usize) * 26 + text[i + 1] as usize;
        let v = bi[idx];
        s += if v != 0.0 { v } else { floor };
    }
    s
}

pub struct Scorer<'a> {
    tri: &'a [f64],
    tri_floor: f64,
    quad: &'a [f64],
    quad_floor: f64,
    has_quad: bool,
}

impl<'a> Scorer<'a> {
    pub fn new(tri: &'a [f64], tri_floor: f64, quad: &'a [f64], quad_floor: f64) -> Self {
        let has_quad = quad.len() > 1;
        Self { tri, tri_floor, quad, quad_floor, has_quad }
    }

    /// Trigram + quadgram mixed score used in Phase 2 hill climbing.
    /// Quadgrams are weighted at 0.5 to avoid overwhelming the trigram signal
    /// on short texts where quadgram coverage is sparse.
    #[inline]
    pub fn score(&self, text: &[u8]) -> f64 {
        let len = text.len();
        if len < 3 { return -1e9; }
        let mut s = 0.0f64;
        for i in 0..len - 2 {
            let idx = (text[i] as usize) * 676
                + (text[i + 1] as usize) * 26
                + text[i + 2] as usize;
            let v = self.tri[idx];
            s += if v != 0.0 { v } else { self.tri_floor };
        }
        if self.has_quad && len >= 4 {
            for i in 0..len - 3 {
                let idx = (text[i] as usize) * 17576
                    + (text[i + 1] as usize) * 676
                    + (text[i + 2] as usize) * 26
                    + text[i + 3] as usize;
                let v = self.quad[idx];
                s += 0.5 * if v != 0.0 { v } else { self.quad_floor };
            }
        }
        s
    }

    /// trigram のみの素のスコア（正規化なし）。
    /// Python 側 `LanguageModel.score_raw` と同じ定義で、リング再探索時の
    /// プラグボード再最適化に使う。
    #[inline]
    pub fn score_raw(&self, text: &[u8]) -> f64 {
        let len = text.len();
        if len < 3 { return self.tri_floor * (len.max(1) as f64); }
        let mut s = 0.0f64;
        for i in 0..len - 2 {
            let idx = (text[i] as usize) * 676
                + (text[i + 1] as usize) * 26
                + text[i + 2] as usize;
            let v = self.tri[idx];
            s += if v != 0.0 { v } else { self.tri_floor };
        }
        s
    }
}

// ------------------------------------------------------------------
// Plugboard helpers
// ------------------------------------------------------------------

pub fn identity_pb() -> [u8; 26] {
    std::array::from_fn(|i| i as u8)
}

#[inline]
pub fn count_pairs(pb: &[u8; 26]) -> usize {
    (0..26usize).filter(|&i| pb[i] as usize > i).count()
}

/// SET 操作（a↔b を繋ぎ、既存の相手は切る）を適用した plugboard を返す。
/// 既に a↔b なら None。
#[inline]
fn apply_set(pb: &[u8; 26], a: u8, b: u8) -> Option<[u8; 26]> {
    if pb[a as usize] == b { return None; }
    let mut trial = *pb;
    let old_a = trial[a as usize];
    let old_b = trial[b as usize];
    if old_a != a { trial[old_a as usize] = old_a; }
    if old_b != b { trial[old_b as usize] = old_b; }
    trial[a as usize] = b;
    trial[b as usize] = a;
    Some(trial)
}

/// REMOVE 操作（a とその相手を切る）を適用した plugboard を返す。
#[inline]
fn apply_remove(pb: &[u8; 26], a: u8) -> [u8; 26] {
    let mut trial = *pb;
    let b = trial[a as usize];
    trial[a as usize] = a;
    trial[b as usize] = b;
    trial
}

/// 繋がっているペアの小さい方の文字を昇順に並べる。
#[inline]
fn pair_heads(pb: &[u8; 26]) -> Vec<u8> {
    (0u8..26).filter(|&i| pb[i as usize] > i).collect()
}

/// SA の近傍と GA の突然変異で共用する、ランダムな 1 手。
///
/// 手の種類（確率）:
///   1. ADD/SWAP 60%     — ランダムな a↔b を繋ぐ（既存の相手は切る）
///   2. REMOVE 15%       — 既存ペアを 1 本切る
///   3. PARTNER-SWAP 25% — 既存ペア a↔b, c↔d を a↔c, b↔d（または a↔d, b↔c）に組み替える
///
/// PARTNER-SWAP は多ペア時の局所最適からの脱出に効く。貪欲 HC では
/// 「相手の同時交換」でしか到達できない状態に届かないため。
///
/// 手が成立しない（ペア数の上限超過など）ときは None。乱数の消費順は
/// 切り出し前の `sa_plugboard` と同一に保ってある（結果を変えないため）。
fn propose_move<R: Rng>(rng: &mut R, pb: &[u8; 26], max_pairs: usize) -> Option<[u8; 26]> {
    let mv = rng.gen_range(0..100);

    if mv < 60 {
        let a = rng.gen_range(0u8..26);
        let mut b = rng.gen_range(0u8..26);
        while b == a { b = rng.gen_range(0u8..26); }
        let trial = apply_set(pb, a, b)?;
        return if count_pairs(&trial) > max_pairs { None } else { Some(trial) };
    }

    let existing = pair_heads(pb);
    if mv < 75 {
        if existing.is_empty() { return None; }
        let idx = rng.gen_range(0..existing.len());
        return Some(apply_remove(pb, existing[idx]));
    }

    if existing.len() < 2 { return None; }
    let i = rng.gen_range(0..existing.len());
    let mut j = rng.gen_range(0..existing.len());
    while j == i { j = rng.gen_range(0..existing.len()); }
    let a = existing[i];
    let b = pb[a as usize];
    let c = existing[j];
    let d = pb[c as usize];
    let mut trial = *pb;
    if rng.gen::<bool>() {
        trial[a as usize] = c; trial[c as usize] = a;
        trial[b as usize] = d; trial[d as usize] = b;
    } else {
        trial[a as usize] = d; trial[d as usize] = a;
        trial[b as usize] = c; trial[c as usize] = b;
    }
    Some(trial)
}

// ------------------------------------------------------------------
// 適応度評価の回数（手法比較の予算）
// ------------------------------------------------------------------

/// 適応度評価（＝1 回の復号＋採点）の回数を数え、上限に達したら打ち切らせる。
///
/// 手法比較で「評価回数」をそろえるためのもの。既定の解読経路は
/// `unlimited()` を渡すので、数えるだけで探索結果は変わらない。
pub struct EvalBudget {
    used: Cell<u64>,
    limit: u64,
}

impl EvalBudget {
    pub fn new(limit: u64) -> Self {
        Self { used: Cell::new(0), limit }
    }

    pub fn unlimited() -> Self {
        Self::new(u64::MAX)
    }

    pub fn used(&self) -> u64 {
        self.used.get()
    }

    pub fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.used.get())
    }

    pub fn exhausted(&self) -> bool {
        self.used.get() >= self.limit
    }

    /// 予算が残っていれば 1 回分を数えて `fit(text)` を返す。尽きていれば -∞。
    /// -∞ はどの探索でも「改善しない手」として扱われるので、探索が自然に止まる。
    #[inline]
    pub fn try_eval<F: Fn(&[u8]) -> f64>(&self, fit: &F, text: &[u8]) -> f64 {
        if self.exhausted() { return f64::NEG_INFINITY; }
        self.eval(fit, text)
    }

    /// 予算に関係なく 1 回分を数えて評価する。探索の結果を記録するための
    /// 最終採点に使う（尽きていても結果のスコアは要るため）。
    #[inline]
    pub fn eval<F: Fn(&[u8]) -> f64>(&self, fit: &F, text: &[u8]) -> f64 {
        self.used.set(self.used.get() + 1);
        fit(text)
    }

    /// 下位の予算で使った回数をこちらに合算する。
    pub fn absorb(&self, sub: &EvalBudget) {
        self.used.set(self.used.get() + sub.used());
    }
}

/// `pb` で復号した文を、予算に数えたうえで採点する。
fn score_pb<F: Fn(&[u8]) -> f64>(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    pb: &[u8; 26],
    fit: &F,
    budget: &EvalBudget,
) -> f64 {
    let mut out = Vec::with_capacity(ct.len());
    core.decrypt(ct, rings, pos, pb, &mut out);
    budget.eval(fit, &out)
}

// ------------------------------------------------------------------
// Hill climbing
// ------------------------------------------------------------------

/// Greedy Gillogly-style hill climb parameterized by an arbitrary fitness
/// function. Each outer iteration evaluates every SET and REMOVE operation and
/// applies the single greatest improvement, terminating at a local optimum.
///
/// `max_iterations` が Some(n) なら n 反復で打ち切る（Python 側
/// `hill_climb_plugboard_full(max_iterations=...)` との対応）。
pub fn hc_generic<F: Fn(&[u8]) -> f64>(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    fit: &F,
    max_pairs: usize,
    initial_pb: [u8; 26],
    max_iterations: Option<usize>,
) -> ([u8; 26], f64) {
    let mut pb = initial_pb;
    let mut out = Vec::with_capacity(ct.len());
    core.decrypt(ct, rings, pos, &pb, &mut out);
    let mut best_score = fit(&out);

    let mut iteration = 0usize;
    loop {
        if let Some(limit) = max_iterations {
            if iteration >= limit { break; }
        }
        iteration += 1;

        let mut best_delta = 0.0f64;
        let mut best_op: Option<(u8, u8, bool)> = None; // (a, b, is_remove)

        // SET: connect a↔b (disconnects their existing partners)
        for a in 0u8..26 {
            for b in (a + 1)..26 {
                let trial = match apply_set(&pb, a, b) {
                    Some(t) => t,
                    None => continue,
                };
                if count_pairs(&trial) > max_pairs { continue; }
                core.decrypt(ct, rings, pos, &trial, &mut out);
                let delta = fit(&out) - best_score;
                if delta > best_delta {
                    best_delta = delta;
                    best_op = Some((a, b, false));
                }
            }
        }

        // REMOVE: disconnect existing pair a↔b
        for a in 0u8..26 {
            if pb[a as usize] > a {
                let b = pb[a as usize];
                let trial = apply_remove(&pb, a);
                core.decrypt(ct, rings, pos, &trial, &mut out);
                let delta = fit(&out) - best_score;
                if delta > best_delta {
                    best_delta = delta;
                    best_op = Some((a, b, true));
                }
            }
        }

        match best_op {
            None => break,
            Some((a, _b, true)) => {
                pb = apply_remove(&pb, a);
                best_score += best_delta;
            }
            Some((a, b, false)) => {
                pb = apply_set(&pb, a, b).expect("SET op was validated above");
                best_score += best_delta;
            }
        }
    }

    (pb, best_score)
}

/// 三段階スコア用の `Scorer::score` 固定版ヒルクライム。
pub fn hill_climb_greedy(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    initial_pb: [u8; 26],
) -> ([u8; 26], f64) {
    hc_generic(ct, core, pos, rings, &|t: &[u8]| scorer.score(t),
               max_pairs, initial_pb, None)
}

/// ランダムな初期 plugboard を作る（3〜min(6,max_pairs) ペア）。
fn random_initial_pb<R: Rng>(rng: &mut R, max_pairs: usize) -> [u8; 26] {
    let mut init = identity_pb();
    let mut letters: Vec<u8> = (0u8..26).collect();
    letters.shuffle(rng);
    let n_init = rng.gen_range(3..=std::cmp::min(6, max_pairs));
    for k in 0..n_init {
        let a = letters[2 * k];
        let b = letters[2 * k + 1];
        init[a as usize] = b;
        init[b as usize] = a;
    }
    init
}

/// Multi-start hill climber: empty plugboard + n_restarts random starts.
/// ネイティブ版 `phase2_fast` / `phase2_full` からのみ使う（thread_rng 依存）。
#[cfg(feature = "python")]
pub fn hill_climb_multi(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    n_restarts: usize,
) -> ([u8; 26], f64) {
    let mut best_pb = identity_pb();
    let mut best_score = f64::NEG_INFINITY;

    let (pb, s) = hill_climb_greedy(ct, core, pos, rings, scorer, max_pairs, identity_pb());
    if s > best_score { best_score = s; best_pb = pb; }

    let mut rng = rand::thread_rng();
    for _ in 0..n_restarts {
        let init = random_initial_pb(&mut rng, max_pairs);
        let (pb, s) = hill_climb_greedy(ct, core, pos, rings, scorer, max_pairs, init);
        if s > best_score { best_score = s; best_pb = pb; }
    }

    (best_pb, best_score)
}

// ------------------------------------------------------------------
// Staged-scoring plugboard recovery (Ostwald–Weierud 2017).
//
// The plugboard is recovered by hill-climbing three times, escalating the
// fitness function as more plugs get placed:
//     pass 1: IC + bigram-IC   (robust when the text is still mostly garbled)
//     pass 2: bigram log-weight (word structure begins to appear)
//     pass 3: trigram+quadgram  (text nearly restored — sharpest signal)
// Each pass carries the plugboard forward as the starting point of the next.
// ------------------------------------------------------------------

/// 段階スコアで使う言語モデル参照のまとめ。引数の数を抑えるためのバンドル。
pub struct StagedModels<'a> {
    pub use_en: bool,
    pub use_ja: bool,
    pub en_bi: &'a [f64],
    pub en_bi_floor: f64,
    pub ja_bi: &'a [f64],
    pub ja_bi_floor: f64,
    pub en_sc: &'a Scorer<'a>,
    pub ja_sc: &'a Scorer<'a>,
}

impl<'a> StagedModels<'a> {
    /// 有効な言語の bigram 対数スコアの最大値。
    #[inline]
    fn bigram_fit(&self, t: &[u8]) -> f64 {
        let mut s = f64::NEG_INFINITY;
        if self.use_en {
            let v = bigram_logscore(t, self.en_bi, self.en_bi_floor);
            if v > s { s = v; }
        }
        if self.use_ja {
            let v = bigram_logscore(t, self.ja_bi, self.ja_bi_floor);
            if v > s { s = v; }
        }
        s
    }

    /// 有効な言語の trigram+quadgram スコアの最大値。
    #[inline]
    pub fn trigram_fit(&self, t: &[u8]) -> f64 {
        let mut s = f64::NEG_INFINITY;
        if self.use_en {
            let v = self.en_sc.score(t);
            if v > s { s = v; }
        }
        if self.use_ja {
            let v = self.ja_sc.score(t);
            if v > s { s = v; }
        }
        s
    }
}

/// One staged (IC → bigram → trigram) climb from a given starting plugboard.
/// Returns the plugboard and its final trigram+quadgram score.
pub fn staged_climb(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    models: &StagedModels,
    max_pairs: usize,
    initial_pb: [u8; 26],
) -> ([u8; 26], f64) {
    staged_climb_budgeted(ct, core, pos, rings, models, max_pairs, initial_pb,
                          &EvalBudget::unlimited())
}

/// `staged_climb` の評価回数を数える版。予算が尽きた時点で山登りを止める。
pub fn staged_climb_budgeted(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    models: &StagedModels,
    max_pairs: usize,
    initial_pb: [u8; 26],
    budget: &EvalBudget,
) -> ([u8; 26], f64) {
    let ic_fit = |t: &[u8]| score_phase1(t);
    let bigram_fit = |t: &[u8]| models.bigram_fit(t);
    let trigram_fit = |t: &[u8]| models.trigram_fit(t);

    // pass 1: IC + bigram-IC (language-agnostic, plugboard-robust)
    let (pb, _) = hc_generic(ct, core, pos, rings, &|t: &[u8]| budget.try_eval(&ic_fit, t),
                             max_pairs, initial_pb, None);
    // pass 2: bigram log-weight (max over enabled languages)
    let (pb, _) = hc_generic(ct, core, pos, rings, &|t: &[u8]| budget.try_eval(&bigram_fit, t),
                             max_pairs, pb, None);
    // pass 3: trigram + quadgram (max over enabled languages)
    let (pb, _) = hc_generic(ct, core, pos, rings, &|t: &[u8]| budget.try_eval(&trigram_fit, t),
                             max_pairs, pb, None);

    let final_score = score_pb(ct, core, pos, rings, &pb, &trigram_fit, budget);
    (pb, final_score)
}

// ------------------------------------------------------------------
// Simulated annealing
// ------------------------------------------------------------------

/// Simulated Annealing for plugboard optimization.
///
/// 1 ステップごとに `propose_move` の 3 種類の手（ADD/SWAP・REMOVE・
/// PARTNER-SWAP）から 1 つを試す。
pub fn sa_plugboard(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
    initial_pb: [u8; 26],
    seed: u64,
) -> ([u8; 26], f64) {
    sa_budgeted(ct, core, pos, rings, &|t: &[u8]| scorer.score(t), max_pairs,
                n_steps, t_start, t_end, initial_pb, seed, &EvalBudget::unlimited())
}

/// `sa_plugboard` の適応度関数を差し替えられ、評価回数を数える版。
/// 予算が尽きたら冷却の途中でも止め、それまでの最良解を返す。
pub fn sa_budgeted<F: Fn(&[u8]) -> f64>(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    fit: &F,
    max_pairs: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
    initial_pb: [u8; 26],
    seed: u64,
    budget: &EvalBudget,
) -> ([u8; 26], f64) {
    let mut rng = SmallRng::seed_from_u64(seed);
    let mut pb = initial_pb;
    let mut out = Vec::with_capacity(ct.len());

    core.decrypt(ct, rings, pos, &pb, &mut out);
    let mut cur_score = budget.eval(fit, &out);

    let mut best_pb = pb;
    let mut best_score = cur_score;

    let cooling_ratio = t_end / t_start;

    for step in 0..n_steps {
        if budget.exhausted() { break; }
        let t = t_start * cooling_ratio.powf(step as f64 / n_steps as f64);

        let trial = match propose_move(&mut rng, &pb, max_pairs) {
            Some(trial) => trial,
            None => continue,
        };

        core.decrypt(ct, rings, pos, &trial, &mut out);
        let trial_score = budget.eval(fit, &out);
        let delta = trial_score - cur_score;

        let accept = delta > 0.0 || {
            let p: f64 = rng.gen();
            p < (delta / t).exp()
        };

        if accept {
            pb = trial;
            cur_score = trial_score;
            if cur_score > best_score {
                best_score = cur_score;
                best_pb = pb;
            }
        }
    }

    (best_pb, best_score)
}

/// SA followed by deterministic greedy HC to polish.
pub fn sa_then_hc(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
    initial_pb: [u8; 26],
    seed: u64,
) -> ([u8; 26], f64) {
    let (pb, _) = sa_plugboard(ct, core, pos, rings, scorer, max_pairs,
                               n_steps, t_start, t_end, initial_pb, seed);
    hill_climb_greedy(ct, core, pos, rings, scorer, max_pairs, pb)
}

// ------------------------------------------------------------------
// 並列化の単位となるブロック関数
//
// ネイティブ版は Rayon の par_iter からこれらを呼び、ブラウザ版は
// Web Worker が担当分だけを呼ぶ。どちらも同じ結果になる。
// ------------------------------------------------------------------

pub type Ranked = (f64, [usize; 3], [u8; 3]);
pub type RankedWithPb = (f64, [usize; 3], [u8; 3], [u8; 26]);

/// Phase 1: 1 つのローター順について 26³ の初期位置を全探索し、上位 top_n を返す。
/// スコアはプラグボード不変な IC ベース。
pub fn phase1_rotor_block(
    ct: &[u8],
    rotors: [usize; 3],
    reflector_idx: usize,
    top_n: usize,
) -> Vec<Ranked> {
    let core = EnigmaCore::new(rotors, reflector_idx);
    let pb = identity_pb();
    let mut out = Vec::with_capacity(ct.len());
    let mut local: Vec<Ranked> = Vec::with_capacity(17576);

    for p0 in 0u8..26 {
        for p1 in 0u8..26 {
            for p2 in 0u8..26 {
                core.decrypt(ct, [0, 0, 0], [p0, p1, p2], &pb, &mut out);
                local.push((score_phase1(&out), rotors, [p0, p1, p2]));
            }
        }
    }
    sort_desc_truncate(&mut local, top_n);
    local
}

/// Phase 1（プラグボード既知）: 既知 PB で復号して n-gram スコアで順位付け。
pub fn phase1_known_rotor_block(
    ct: &[u8],
    rotors: [usize; 3],
    reflector_idx: usize,
    pb: &[u8; 26],
    use_en: bool,
    use_ja: bool,
    en_sc: &Scorer,
    ja_sc: &Scorer,
    top_n: usize,
) -> Vec<Ranked> {
    let core = EnigmaCore::new(rotors, reflector_idx);
    let mut out = Vec::with_capacity(ct.len());
    let mut local: Vec<Ranked> = Vec::with_capacity(17576);

    for p0 in 0u8..26 {
        for p1 in 0u8..26 {
            for p2 in 0u8..26 {
                core.decrypt(ct, [0, 0, 0], [p0, p1, p2], pb, &mut out);
                // language='auto' → max over enabled languages
                let mut s = f64::NEG_INFINITY;
                if use_en {
                    let se = en_sc.score(&out);
                    if se > s { s = se; }
                }
                if use_ja {
                    let sj = ja_sc.score(&out);
                    if sj > s { s = sj; }
                }
                local.push((s, rotors, [p0, p1, p2]));
            }
        }
    }
    sort_desc_truncate(&mut local, top_n);
    local
}

/// Phase 1B: 325 通りの単一ペア plugboard を試して 1 候補を再スコアする。
pub fn phase1b_one(
    ct: &[u8],
    rotors: [usize; 3],
    pos: [u8; 3],
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_sc: &Scorer,
    ja_sc: &Scorer,
) -> Ranked {
    let core = EnigmaCore::new(rotors, reflector_idx);
    let mut out = Vec::with_capacity(ct.len());
    let mut best = f64::NEG_INFINITY;

    let id = identity_pb();
    core.decrypt(ct, [0, 0, 0], pos, &id, &mut out);
    if use_en { best = best.max(en_sc.score(&out)); }
    if use_ja { best = best.max(ja_sc.score(&out)); }

    for a in 0u8..26 {
        for b in (a + 1)..26 {
            let mut pb = identity_pb();
            pb[a as usize] = b;
            pb[b as usize] = a;
            core.decrypt(ct, [0, 0, 0], pos, &pb, &mut out);
            if use_en { best = best.max(en_sc.score(&out)); }
            if use_ja { best = best.max(ja_sc.score(&out)); }
        }
    }
    (best, rotors, pos)
}

/// Phase 1B-SA: 短い SA で 1 候補を再スコアする。
pub fn phase1b_sa_one(
    ct: &[u8],
    index: usize,
    rotors: [usize; 3],
    pos: [u8; 3],
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_sc: &Scorer,
    ja_sc: &Scorer,
    max_pairs: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
) -> Ranked {
    let core = EnigmaCore::new(rotors, reflector_idx);
    let seed = (index as u64).wrapping_mul(SEED_STRIDE);
    let mut best = f64::NEG_INFINITY;
    if use_en {
        let (_, s) = sa_plugboard(ct, &core, pos, [0, 0, 0], en_sc, max_pairs,
                                  n_steps, t_start, t_end, identity_pb(), seed);
        if s > best { best = s; }
    }
    if use_ja {
        let (_, s) = sa_plugboard(ct, &core, pos, [0, 0, 0], ja_sc, max_pairs,
                                  n_steps, t_start, t_end, identity_pb(),
                                  seed ^ 0xCAFEBABE);
        if s > best { best = s; }
    }
    (best, rotors, pos)
}

/// Phase 2（段階スコア）: 1 候補についてマルチスタート段階山登り＋SA 磨き上げ。
///
/// `index` は候補の**通し番号**。SA のシードに使うので、ワーカーへ分割しても
/// 全体で一意な番号を渡すこと（そうしないとネイティブ版と結果が変わる）。
pub fn phase2_staged_one(
    ct: &[u8],
    index: usize,
    rotors: [usize; 3],
    pos: [u8; 3],
    reflector_idx: usize,
    models: &StagedModels,
    max_pairs: usize,
    n_restarts: usize,
    sa_steps: usize,
    t_start: f64,
    t_end: f64,
) -> RankedWithPb {
    let params = Phase2Params {
        max_pairs, n_restarts, sa_steps, t_start, t_end,
    };
    phase2_optimize_one(ct, index, rotors, pos, reflector_idx, models,
                        PlugboardOptimizer::Current, &params, 0, &EvalBudget::unlimited())
}

// ------------------------------------------------------------------
// Phase C の最適化手法の切り替え（手法比較・GA のオプトイン用）
// ------------------------------------------------------------------

/// Phase C（プラグボード復元）の最適化手法。既定は `Current`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlugboardOptimizer {
    /// 現行: 段階スコア HC のマルチスタート ＋ SA 磨き上げ。
    Current,
    /// 段階スコア HC だけを、予算が尽きるまでランダム初期値から再スタートする。
    HillClimb,
    /// SA ＋ 貪欲 HC 磨きを、予算が尽きるまで空の plugboard から再スタートする。
    Annealing,
}

impl PlugboardOptimizer {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "current" => Some(Self::Current),
            "hc" => Some(Self::HillClimb),
            "sa" => Some(Self::Annealing),
            _ => None,
        }
    }
}

/// Phase C の探索パラメータ一式。
#[derive(Clone, Copy, Debug)]
pub struct Phase2Params {
    pub max_pairs: usize,
    /// Current: ランダム初期値からの再スタート回数。
    pub n_restarts: usize,
    /// Current: 磨き上げの SA ステップ数 / Annealing: 1 回の SA のステップ数。
    pub sa_steps: usize,
    pub t_start: f64,
    pub t_end: f64,
}

/// 1 候補のプラグボードを指定の手法で復元する。
///
/// `index` は候補の通し番号、`run_seed` は試行ごとの乱数シード
/// （既定の解読経路は 0）。どちらも乱数列の分岐に使う。
/// Current 以外は予算が尽きるまで探索を続けるので、有限の `budget` が要る。
pub fn phase2_optimize_one(
    ct: &[u8],
    index: usize,
    rotors: [usize; 3],
    pos: [u8; 3],
    reflector_idx: usize,
    models: &StagedModels,
    method: PlugboardOptimizer,
    params: &Phase2Params,
    run_seed: u64,
    budget: &EvalBudget,
) -> RankedWithPb {
    let core = EnigmaCore::new(rotors, reflector_idx);
    let base_seed = (index as u64).wrapping_mul(SEED_STRIDE) ^ run_seed;
    let rings = [0, 0, 0];

    let (best_pb, best_score) = match method {
        PlugboardOptimizer::Current =>
            current_search(ct, &core, pos, rings, models, params, base_seed, budget),
        PlugboardOptimizer::HillClimb =>
            hc_until_budget(ct, &core, pos, rings, models, params.max_pairs, base_seed, budget),
        PlugboardOptimizer::Annealing =>
            sa_until_budget(ct, &core, pos, rings, models, params, base_seed, budget),
    };
    (best_score, rotors, pos, best_pb)
}

/// 現行の Phase C: 段階スコア HC（空 + n_restarts 個のランダム初期値）の最良解を
/// trigram の SA で磨く。予算が無制限なら既存の `phase2_staged_one` と同一の結果。
fn current_search(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    models: &StagedModels,
    params: &Phase2Params,
    base_seed: u64,
    budget: &EvalBudget,
) -> ([u8; 26], f64) {
    let max_pairs = params.max_pairs;
    let (mut best_pb, mut best_score) =
        staged_climb_budgeted(ct, core, pos, rings, models, max_pairs, identity_pb(), budget);

    let mut rng = SmallRng::seed_from_u64(base_seed ^ 0xABCDEF);
    for _ in 0..params.n_restarts {
        let init = random_initial_pb(&mut rng, max_pairs);
        let (pb, s) = staged_climb_budgeted(ct, core, pos, rings, models, max_pairs, init, budget);
        if s > best_score { best_score = s; best_pb = pb; }
    }

    if params.sa_steps > 0 {
        let sc = if models.use_en { models.en_sc } else { models.ja_sc };
        let (pb_sa, _) = sa_budgeted(ct, core, pos, rings, &|t: &[u8]| sc.score(t), max_pairs,
                                     params.sa_steps, params.t_start, params.t_end, best_pb,
                                     base_seed ^ 0x1234, budget);
        // re-score under the max-language trigram fitness for fairness
        let s_final = score_pb(ct, core, pos, rings, &pb_sa,
                               &|t: &[u8]| models.trigram_fit(t), budget);
        if s_final > best_score { best_score = s_final; best_pb = pb_sa; }
    }

    (best_pb, best_score)
}

/// HC 単独: 段階スコア HC を空の plugboard から 1 回、以降はランダム初期値から
/// 予算が尽きるまで繰り返す（現行から SA を外し、その分を再スタートに回した形）。
fn hc_until_budget(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    models: &StagedModels,
    max_pairs: usize,
    base_seed: u64,
    budget: &EvalBudget,
) -> ([u8; 26], f64) {
    let (mut best_pb, mut best_score) =
        staged_climb_budgeted(ct, core, pos, rings, models, max_pairs, identity_pb(), budget);

    let mut rng = SmallRng::seed_from_u64(base_seed ^ 0xABCDEF);
    while !budget.exhausted() {
        let init = random_initial_pb(&mut rng, max_pairs);
        let (pb, s) = staged_climb_budgeted(ct, core, pos, rings, models, max_pairs, init, budget);
        if s > best_score { best_score = s; best_pb = pb; }
    }
    (best_pb, best_score)
}

/// SA 単独: 空の plugboard からの SA（trigram+quadgram）＋貪欲 HC 磨きを、
/// 予算が尽きるまで再スタートする（既存の Tier-2 SA `phase2_sa` と同じ形）。
fn sa_until_budget(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    models: &StagedModels,
    params: &Phase2Params,
    base_seed: u64,
    budget: &EvalBudget,
) -> ([u8; 26], f64) {
    let fit = |t: &[u8]| models.trigram_fit(t);
    let mut best_pb = identity_pb();
    let mut best_score = f64::NEG_INFINITY;

    let mut restart = 0u64;
    while !budget.exhausted() {
        let seed = (base_seed ^ 0x1234).wrapping_add(restart);
        let (pb, _) = sa_budgeted(ct, core, pos, rings, &fit, params.max_pairs, params.sa_steps,
                                  params.t_start, params.t_end, identity_pb(), seed, budget);
        let (pb, _) = hc_generic(ct, core, pos, rings, &|t: &[u8]| budget.try_eval(&fit, t),
                                 params.max_pairs, pb, None);
        let s = score_pb(ct, core, pos, rings, &pb, &fit, budget);
        if s > best_score { best_score = s; best_pb = pb; }
        restart += 1;
    }
    (best_pb, best_score)
}

/// スコア降順に並べ替えて上位 n 件に切り詰める。NaN は同順として扱う。
pub fn sort_desc_truncate<T>(items: &mut Vec<T>, n: usize)
where
    T: HasScore,
{
    items.sort_unstable_by(|a, b| {
        b.score().partial_cmp(&a.score()).unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(n);
}

pub trait HasScore {
    fn score(&self) -> f64;
}

impl HasScore for Ranked {
    fn score(&self) -> f64 { self.0 }
}

impl HasScore for RankedWithPb {
    fn score(&self) -> f64 { self.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// enigma.py の既知ベクトル: rotors I,II,III / reflector B / rings 0 / pos 0
    /// で AAAAA → BDZGO。
    #[test]
    fn known_vector_aaaaa() {
        let core = EnigmaCore::new([0, 1, 2], 0);
        let pb = identity_pb();
        let mut out = Vec::new();
        core.decrypt(&[0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], &pb, &mut out);
        let text: String = out.iter().map(|&c| (c + 65) as char).collect();
        assert_eq!(text, "BDZGO");
    }

    /// 同じ設定で 2 回通すと元に戻る（対合性）。
    #[test]
    fn involution() {
        let core = EnigmaCore::new([0, 1, 2], 0);
        let mut pb = identity_pb();
        pb[0] = 1; pb[1] = 0; // A↔B
        let plain: Vec<u8> = "HELLOWORLD".bytes().map(|b| b - 65).collect();
        let mut ct = Vec::new();
        core.decrypt(&plain, [5, 12, 7], [3, 14, 9], &pb, &mut ct);
        let mut back = Vec::new();
        core.decrypt(&ct, [5, 12, 7], [3, 14, 9], &pb, &mut back);
        assert_eq!(back, plain);
    }
}
