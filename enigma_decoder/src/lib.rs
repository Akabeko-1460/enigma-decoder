use pyo3::prelude::*;
use rayon::prelude::*;
use rand::seq::SliceRandom;
use rand::Rng;

const ROTORS: [&str; 5] = [
    "EKMFLGDQVZNTOWYHXUSPAIBRCJ", // I
    "AJDKSIRUXBLHWTMCQGZNPYFVOE", // II
    "BDFHJLCPRTXVZNYEIWGAKMUSQO", // III
    "ESOVPZJAYQUIRHXLNFTGKDCMWB", // IV
    "VZBRGITYUPSDNHLXAWMJQOFECK", // V
];

const NOTCHES: [u8; 5] = [
    16, // Q (I)
    4,  // E (II)
    21, // V (III)
    9,  // J (IV)
    25, // Z (V)
];

const REFLECTORS: [&str; 2] = [
    "YRUHQSLDPXNGOKMIEBFZCWVJAT", // B
    "FVPJIAOYEDRZXWGCTKUQSBNMHL", // C
];

#[derive(Clone)]
struct EnigmaCore {
    fwd: [[u8; 26]; 3],
    bwd: [[u8; 26]; 3],
    notches: [u8; 3],
    refl: [u8; 26],
}

impl EnigmaCore {
    fn new(rotor_indices: [usize; 3], reflector_idx: usize) -> Self {
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
    fn decrypt(&self, ct: &[u8], rings: [u8; 3], pos: [u8; 3], pb: &[u8; 26], out: &mut Vec<u8>) {
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
fn score_ic(text: &[u8]) -> f64 {
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
/// This provides stronger discrimination than IC alone, especially for short texts.
#[inline]
fn score_bigram_ic(text: &[u8]) -> f64 {
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
/// (Signal amplitudes: IC=0.027, BiIC=0.0045; ratio≈6)
#[inline]
fn score_phase1(text: &[u8]) -> f64 {
    score_ic(text) + 6.0 * score_bigram_ic(text)
}

struct Scorer<'a> {
    tri: &'a [f64],
    tri_floor: f64,
    quad: &'a [f64],
    quad_floor: f64,
    has_quad: bool,
}

impl<'a> Scorer<'a> {
    fn new(tri: &'a [f64], tri_floor: f64, quad: &'a [f64], quad_floor: f64) -> Self {
        let has_quad = quad.len() > 1;
        Self { tri, tri_floor, quad, quad_floor, has_quad }
    }

    /// Trigram + quadgram mixed score used in Phase 2 hill climbing.
    /// Quadgrams are weighted at 0.5 to avoid overwhelming the trigram signal
    /// on short texts where quadgram coverage is sparse.
    #[inline]
    fn score(&self, text: &[u8]) -> f64 {
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
}

// ------------------------------------------------------------------
// Phase 1: exhaustive rotor + position search
// ------------------------------------------------------------------

#[pyfunction]
fn phase1(
    ct: Vec<u8>,
    rotor_perms: Vec<[usize; 3]>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    top_n: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3])>> {
    // n-gram arrays are received for API stability but not used here —
    // Phase 1 scoring is IC-based (plugboard-invariant).
    let _ = (use_en, use_ja, en_tri, en_tri_floor, en_quad, en_quad_floor,
             ja_tri, ja_tri_floor, ja_quad, ja_quad_floor);

    let mut all_results: Vec<(f64, [usize; 3], [u8; 3])> =
        rotor_perms.par_iter().flat_map(|&rotors| {
            let core = EnigmaCore::new(rotors, reflector_idx);
            let pb: [u8; 26] = std::array::from_fn(|i| i as u8);
            let mut out = Vec::with_capacity(ct.len());
            let mut local: Vec<(f64, [usize; 3], [u8; 3])> = Vec::with_capacity(17576);

            for p0 in 0u8..26 {
                for p1 in 0u8..26 {
                    for p2 in 0u8..26 {
                        core.decrypt(&ct, [0, 0, 0], [p0, p1, p2], &pb, &mut out);
                        let s = score_phase1(&out);
                        local.push((s, rotors, [p0, p1, p2]));
                    }
                }
            }
            local.sort_unstable_by(|a, b|
                b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            local.truncate(top_n);
            local
        }).collect();

    all_results.sort_unstable_by(|a, b|
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    all_results.truncate(top_n);

    Ok(all_results)
}

// ------------------------------------------------------------------
// Phase 2: plugboard hill climbing
// ------------------------------------------------------------------

fn identity_pb() -> [u8; 26] {
    std::array::from_fn(|i| i as u8)
}

#[inline]
fn count_pairs(pb: &[u8; 26]) -> usize {
    (0..26usize).filter(|&i| pb[i] as usize > i).count()
}

/// Deterministic Gillogly-style greedy hill climber.
///
/// Each outer iteration evaluates every possible SET (add/swap) and REMOVE
/// operation and applies the single greatest improvement. Terminates at a
/// local optimum. No randomness — use `hill_climb_multi` for multi-start.
fn hill_climb_greedy(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    rings: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    initial_pb: [u8; 26],
) -> ([u8; 26], f64) {
    let mut pb = initial_pb;
    let mut out = Vec::with_capacity(ct.len());

    core.decrypt(ct, rings, pos, &pb, &mut out);
    let mut best_score = scorer.score(&out);

    loop {
        let mut best_delta = 0.0f64;
        let mut best_op: Option<(u8, u8, bool)> = None; // (a, b, is_remove)

        // SET: connect a↔b (disconnects their existing partners)
        for a in 0u8..26 {
            for b in (a + 1)..26 {
                if pb[a as usize] == b { continue; }

                let mut trial = pb;
                let old_a = trial[a as usize];
                let old_b = trial[b as usize];
                if old_a != a { trial[old_a as usize] = old_a; }
                if old_b != b { trial[old_b as usize] = old_b; }
                trial[a as usize] = b;
                trial[b as usize] = a;

                if count_pairs(&trial) > max_pairs { continue; }

                core.decrypt(ct, rings, pos, &trial, &mut out);
                let delta = scorer.score(&out) - best_score;
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
                let mut trial = pb;
                trial[b as usize] = b;
                trial[a as usize] = a;

                core.decrypt(ct, rings, pos, &trial, &mut out);
                let delta = scorer.score(&out) - best_score;
                if delta > best_delta {
                    best_delta = delta;
                    best_op = Some((a, b, true));
                }
            }
        }

        match best_op {
            None => break,
            Some((a, _b, true)) => {
                let partner = pb[a as usize];
                pb[partner as usize] = partner;
                pb[a as usize] = a;
                best_score += best_delta;
            }
            Some((a, b, false)) => {
                let old_a = pb[a as usize];
                let old_b = pb[b as usize];
                if old_a != a { pb[old_a as usize] = old_a; }
                if old_b != b { pb[old_b as usize] = old_b; }
                pb[a as usize] = b;
                pb[b as usize] = a;
                best_score += best_delta;
            }
        }
    }

    (pb, best_score)
}

/// Multi-start hill climber: empty plugboard + n_restarts random starts.
fn hill_climb_multi(
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
        let mut init = identity_pb();
        let mut letters: Vec<u8> = (0u8..26).collect();
        letters.shuffle(&mut rng);
        let n_init = rng.gen_range(3..=std::cmp::min(6, max_pairs));
        for k in 0..n_init {
            let a = letters[2 * k];
            let b = letters[2 * k + 1];
            init[a as usize] = b;
            init[b as usize] = a;
        }
        let (pb, s) = hill_climb_greedy(ct, core, pos, rings, scorer, max_pairs, init);
        if s > best_score { best_score = s; best_pb = pb; }
    }

    (best_pb, best_score)
}

/// Simulated Annealing for plugboard optimization.
///
/// Three move types per step (random choice):
///   1. ADD/SWAP   — connect random a↔b (disconnects their existing partners)
///   2. REMOVE     — disconnect an existing pair
///   3. PARTNER-SWAP — given two existing pairs a↔b and c↔d, reform as a↔c, b↔d
///
/// Temperature cools exponentially: t = t_start * (t_end/t_start)^(step/n_steps).
/// PARTNER-SWAP is critical for escaping local optima when many pairs are present —
/// greedy HC cannot reach states reachable only via simultaneous partner exchange.
fn sa_plugboard(
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
    use rand::SeedableRng;
    use rand::rngs::SmallRng;

    let mut rng = SmallRng::seed_from_u64(seed);
    let mut pb = initial_pb;
    let mut out = Vec::with_capacity(ct.len());

    core.decrypt(ct, rings, pos, &pb, &mut out);
    let mut cur_score = scorer.score(&out);

    let mut best_pb = pb;
    let mut best_score = cur_score;

    let cooling_ratio = t_end / t_start;

    for step in 0..n_steps {
        let t = t_start * cooling_ratio.powf(step as f64 / n_steps as f64);

        // Pick a move type. Weights: ADD/SWAP 60%, REMOVE 15%, PARTNER 25%.
        let mv = rng.gen_range(0..100);
        let mut trial = pb;
        let mut valid = true;

        if mv < 60 {
            // ADD/SWAP — pick two random distinct letters and pair them.
            let a = rng.gen_range(0u8..26);
            let mut b = rng.gen_range(0u8..26);
            while b == a { b = rng.gen_range(0u8..26); }
            if trial[a as usize] == b { valid = false; }
            else {
                let old_a = trial[a as usize];
                let old_b = trial[b as usize];
                if old_a != a { trial[old_a as usize] = old_a; }
                if old_b != b { trial[old_b as usize] = old_b; }
                trial[a as usize] = b;
                trial[b as usize] = a;
                if count_pairs(&trial) > max_pairs { valid = false; }
            }
        } else if mv < 75 {
            // REMOVE — pick an existing pair and disconnect it.
            let existing: Vec<u8> = (0u8..26)
                .filter(|&i| trial[i as usize] > i)
                .collect();
            if existing.is_empty() { valid = false; }
            else {
                let idx = rng.gen_range(0..existing.len());
                let a = existing[idx];
                let b = trial[a as usize];
                trial[a as usize] = a;
                trial[b as usize] = b;
            }
        } else {
            // PARTNER-SWAP — pick two existing pairs (a,b) and (c,d), reform as (a,c)(b,d).
            let existing: Vec<u8> = (0u8..26)
                .filter(|&i| trial[i as usize] > i)
                .collect();
            if existing.len() < 2 { valid = false; }
            else {
                let i = rng.gen_range(0..existing.len());
                let mut j = rng.gen_range(0..existing.len());
                while j == i { j = rng.gen_range(0..existing.len()); }
                let a = existing[i];
                let b = trial[a as usize];
                let c = existing[j];
                let d = trial[c as usize];
                // Randomize which way we re-pair (a-c,b-d) vs (a-d,b-c)
                if rng.gen::<bool>() {
                    trial[a as usize] = c; trial[c as usize] = a;
                    trial[b as usize] = d; trial[d as usize] = b;
                } else {
                    trial[a as usize] = d; trial[d as usize] = a;
                    trial[b as usize] = c; trial[c as usize] = b;
                }
            }
        }

        if !valid { continue; }

        core.decrypt(ct, rings, pos, &trial, &mut out);
        let trial_score = scorer.score(&out);
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

/// SA followed by deterministic greedy HC to polish — combines exploration
/// (SA escapes local optima) with exploitation (HC converges to the nearest peak).
fn sa_then_hc(
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
// Public Phase 2 functions (called from Python)
// ------------------------------------------------------------------

/// Tier-1 fast screening: single greedy HC from empty plugboard.
#[pyfunction]
fn phase2_fast(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    max_pairs: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3], [u8; 26])>> {
    let en_sc = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_sc = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let results: Vec<_> = candidates.par_iter().flat_map(|&(rotors, pos)| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let mut res = Vec::new();
        if use_en {
            let (pb, s) = hill_climb_greedy(&ct, &core, pos, [0,0,0], &en_sc, max_pairs, identity_pb());
            res.push((s, rotors, pos, pb));
        }
        if use_ja {
            let (pb, s) = hill_climb_greedy(&ct, &core, pos, [0,0,0], &ja_sc, max_pairs, identity_pb());
            res.push((s, rotors, pos, pb));
        }
        res
    }).collect();

    Ok(results)
}

/// Tier-2 full search: multi-start greedy HC.
#[pyfunction]
fn phase2_full(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    max_pairs: usize,
    n_restarts: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3], [u8; 26])>> {
    let en_sc = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_sc = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let results: Vec<_> = candidates.par_iter().flat_map(|&(rotors, pos)| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let mut res = Vec::new();
        if use_en {
            let (pb, s) = hill_climb_multi(&ct, &core, pos, [0,0,0], &en_sc, max_pairs, n_restarts);
            res.push((s, rotors, pos, pb));
        }
        if use_ja {
            let (pb, s) = hill_climb_multi(&ct, &core, pos, [0,0,0], &ja_sc, max_pairs, n_restarts);
            res.push((s, rotors, pos, pb));
        }
        res
    }).collect();

    Ok(results)
}

/// Tier-2 SA search: simulated annealing × n_restarts, polished by greedy HC.
///
/// Far more reliable than `phase2_full` for ≥6 plugboard pairs, since SA's
/// PARTNER-SWAP move can reach states unreachable by greedy single-step climbs.
#[pyfunction]
fn phase2_sa(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    max_pairs: usize,
    n_restarts: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3], [u8; 26])>> {
    let en_sc = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_sc = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let results: Vec<_> = candidates.par_iter().enumerate().flat_map(|(cand_i, &(rotors, pos))| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let base_seed = (cand_i as u64).wrapping_mul(0x9E3779B97F4A7C15);

        let mut run = |sc: &Scorer| -> (f64, [u8; 26]) {
            let mut best_pb = identity_pb();
            let mut best_score = f64::NEG_INFINITY;
            for r in 0..n_restarts {
                let seed = base_seed.wrapping_add(r as u64);
                let (pb, s) = sa_then_hc(&ct, &core, pos, [0,0,0], sc, max_pairs,
                                         n_steps, t_start, t_end, identity_pb(), seed);
                if s > best_score { best_score = s; best_pb = pb; }
            }
            (best_score, best_pb)
        };

        let mut res = Vec::new();
        if use_en {
            let (s, pb) = run(&en_sc);
            res.push((s, rotors, pos, pb));
        }
        if use_ja {
            let (s, pb) = run(&ja_sc);
            res.push((s, rotors, pos, pb));
        }
        res
    }).collect();

    Ok(results)
}

/// Phase 1B-SA: rerank Phase-1A candidates by running a short Simulated
/// Annealing on each.  For candidates with many true plugboard pairs (≥6),
/// single-pair scoring is insufficient — light SA finds enough true pairs
/// to make the correct rotor+position score discernibly higher than wrong ones.
///
/// `n_steps` should be small (1000–3000); this is screening, not full search.
#[pyfunction]
fn phase1b_sa(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    top_k: usize,
    max_pairs: usize,
    n_steps: usize,
    t_start: f64,
    t_end: f64,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3])>> {
    let en_sc = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_sc = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let mut results: Vec<(f64, [usize; 3], [u8; 3])> = candidates
        .par_iter()
        .enumerate()
        .map(|(idx, &(rotors, pos))| {
            let core = EnigmaCore::new(rotors, reflector_idx);
            let seed = (idx as u64).wrapping_mul(0x9E3779B97F4A7C15);
            let mut best = f64::NEG_INFINITY;
            if use_en {
                let (_, s) = sa_plugboard(&ct, &core, pos, [0,0,0], &en_sc, max_pairs,
                                          n_steps, t_start, t_end, identity_pb(), seed);
                if s > best { best = s; }
            }
            if use_ja {
                let (_, s) = sa_plugboard(&ct, &core, pos, [0,0,0], &ja_sc, max_pairs,
                                          n_steps, t_start, t_end, identity_pb(), seed ^ 0xCAFEBABE);
                if s > best { best = s; }
            }
            (best, rotors, pos)
        })
        .collect();

    results.sort_unstable_by(|a, b|
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    Ok(results)
}

/// Phase 1B: rerank Phase-1A candidates by trying every single-pair plugboard.
///
/// For the correct rotor+position, one of the 325 single pairs will be (or
/// be close to) a true plugboard pair, giving a noticeably higher n-gram
/// score than any random pair on a wrong rotor position.  This dramatically
/// reranks the candidate list even when IC-based Phase 1A placed the correct
/// settings deep in the list (rank > 50k).
///
/// Cost: O(candidates × 326 × |ct|) — fully parallelised.
#[pyfunction]
fn phase1b(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    en_quad: Vec<f64>,
    en_quad_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    ja_quad: Vec<f64>,
    ja_quad_floor: f64,
    top_k: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3])>> {
    let en_sc = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_sc = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let mut results: Vec<(f64, [usize; 3], [u8; 3])> = candidates
        .par_iter()
        .map(|&(rotors, pos)| {
            let core = EnigmaCore::new(rotors, reflector_idx);
            let mut out = Vec::with_capacity(ct.len());
            let mut best = f64::NEG_INFINITY;

            // identity plugboard baseline
            let id = identity_pb();
            core.decrypt(&ct, [0, 0, 0], pos, &id, &mut out);
            if use_en { best = best.max(en_sc.score(&out)); }
            if use_ja { best = best.max(ja_sc.score(&out)); }

            // all 325 single-pair plugboard additions
            for a in 0u8..26 {
                for b in (a + 1)..26 {
                    let mut pb = identity_pb();
                    pb[a as usize] = b;
                    pb[b as usize] = a;
                    core.decrypt(&ct, [0, 0, 0], pos, &pb, &mut out);
                    if use_en { best = best.max(en_sc.score(&out)); }
                    if use_ja { best = best.max(ja_sc.score(&out)); }
                }
            }

            (best, rotors, pos)
        })
        .collect();

    results.sort_unstable_by(|a, b|
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_k);
    Ok(results)
}

#[pymodule]
fn enigma_decoder(m: &Bound<'_, pyo3::types::PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(phase1, m)?)?;
    m.add_function(wrap_pyfunction!(phase1b, m)?)?;
    m.add_function(wrap_pyfunction!(phase1b_sa, m)?)?;
    m.add_function(wrap_pyfunction!(phase2_fast, m)?)?;
    m.add_function(wrap_pyfunction!(phase2_full, m)?)?;
    m.add_function(wrap_pyfunction!(phase2_sa, m)?)?;
    Ok(())
}
