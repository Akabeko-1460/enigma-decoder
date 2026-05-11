use pyo3::prelude::*;
use rayon::prelude::*;
use std::collections::HashSet;
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

fn char_to_int(c: char) -> u8 {
    (c as u8) - 65
}

// 構造体として定義し、事前計算しておく
#[derive(Clone)]
struct EnigmaCore {
    fwd: [[u8; 26]; 3],
    bwd: [[u8; 26]; 3],
    notches: [u8; 3],
    refl: [u8; 26],
}

impl EnigmaCore {
    fn new(rotor_indices: [usize; 3], reflector_idx: usize) -> Self {
        let mut fwd = [[0; 26]; 3];
        let mut bwd = [[0; 26]; 3];
        let mut notches = [0; 3];

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

        let mut refl = [0; 26];
        let r_wiring = REFLECTORS[reflector_idx].as_bytes();
        for j in 0..26 {
            refl[j] = r_wiring[j] - 65;
        }

        Self { fwd, bwd, notches, refl }
    }

    #[inline(always)]
    fn decrypt_fast(&self, ct: &[u8], rings: [u8; 3], pos: [u8; 3], pb: &[u8; 26], out: &mut [u8]) {
        let mut p0 = pos[0];
        let mut p1 = pos[1];
        let mut p2 = pos[2];

        let r0 = rings[0];
        let r1 = rings[1];
        let r2 = rings[2];

        for (i, &c) in ct.iter().enumerate() {
            // Double stepping
            if p1 == self.notches[1] {
                p0 = (p0 + 1) % 26;
                p1 = (p1 + 1) % 26;
            } else if p2 == self.notches[2] {
                p1 = (p1 + 1) % 26;
            }
            p2 = (p2 + 1) % 26;

            let mut x = pb[c as usize];

            // Right to Left
            x = self.fwd[2][((x + p2 + 26 - r2) % 26) as usize];
            x = (x + 26 - p2 + r2) % 26;
            
            x = self.fwd[1][((x + p1 + 26 - r1) % 26) as usize];
            x = (x + 26 - p1 + r1) % 26;
            
            x = self.fwd[0][((x + p0 + 26 - r0) % 26) as usize];
            x = (x + 26 - p0 + r0) % 26;

            // Reflector
            x = self.refl[x as usize];

            // Left to Right
            x = self.bwd[0][((x + p0 + 26 - r0) % 26) as usize];
            x = (x + 26 - p0 + r0) % 26;

            x = self.bwd[1][((x + p1 + 26 - r1) % 26) as usize];
            x = (x + 26 - p1 + r1) % 26;

            x = self.bwd[2][((x + p2 + 26 - r2) % 26) as usize];
            x = (x + 26 - p2 + r2) % 26;

            out[i] = pb[x as usize];
        }
    }
}

// ICスコアの計算
fn score_ic(text: &[u8]) -> f64 {
    let n = text.len();
    if n < 2 { return 0.0; }
    let mut counts = [0u32; 26];
    for &c in text {
        counts[c as usize] += 1;
    }
    let mut sum = 0;
    for &c in &counts {
        sum += c * c.saturating_sub(1);
    }
    (sum as f64) / ((n * (n - 1)) as f64)
}

// --- Scoring ---
struct Scorer<'a> {
    tri: &'a [f64],
    tri_floor: f64,
    quad: &'a [f64],
    quad_floor: f64,
}

impl<'a> Scorer<'a> {
    fn new(tri: &'a [f64], tri_floor: f64, quad: &'a [f64], quad_floor: f64) -> Self {
        Self { tri, tri_floor, quad, quad_floor }
    }

    fn score_mixed(&self, text: &[u8]) -> f64 {
        let len = text.len();
        if len < 3 { return -1e9; }
        
        let mut s_tri = 0.0;
        for i in 0..len.saturating_sub(2) {
            let idx = (text[i] as usize) * 676 + (text[i+1] as usize) * 26 + (text[i+2] as usize);
            let val = self.tri[idx];
            s_tri += if val != 0.0 { val } else { self.tri_floor };
        }
        
        let mut s_quad = 0.0;
        for i in 0..len.saturating_sub(3) {
            let idx = (text[i] as usize) * 17576 + (text[i+1] as usize) * 676 + (text[i+2] as usize) * 26 + (text[i+3] as usize);
            let val = self.quad[idx];
            s_quad += if val != 0.0 { val } else { self.quad_floor };
        }
        
        // Return a weighted score (Phase 1 uses tri+quad, bi is omitted for speed or we can add it later if needed)
        // Actually, Python Phase 1 uses sum without normalization if I remember correctly. Let's emulate Python Phase 1.
        s_tri + s_quad
    }

    fn score_raw_tri(&self, text: &[u8]) -> f64 {
        let len = text.len();
        if len < 3 { return -1e9; }
        let mut s_tri = 0.0;
        for i in 0..len.saturating_sub(2) {
            let idx = (text[i] as usize) * 676 + (text[i+1] as usize) * 26 + (text[i+2] as usize);
            let val = self.tri[idx];
            s_tri += if val != 0.0 { val } else { self.tri_floor };
        }
        s_tri
    }
}

// --- Phase 1 ---

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
    
    // We will collect results using Rayon.
    // Instead of keeping millions, we can keep the best ones locally in each thread, 
    // then merge.

    let en_scorer = Scorer::new(&en_tri, en_tri_floor, &en_quad, en_quad_floor);
    let ja_scorer = Scorer::new(&ja_tri, ja_tri_floor, &ja_quad, ja_quad_floor);

    let mut all_results: Vec<(f64, [usize; 3], [u8; 3])> = rotor_perms.par_iter().flat_map(|&rotors| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let mut local_results = Vec::with_capacity(17576);
        let pb = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
        let mut out = vec![0; ct.len()];

        for p0 in 0..26 {
            for p1 in 0..26 {
                for p2 in 0..26 {
                    core.decrypt_fast(&ct, [0, 0, 0], [p0, p1, p2], &pb, &mut out);
                    
                    let s = score_ic(&out);
                    local_results.push((s, rotors, [p0, p1, p2]));
                }
            }
        }
        // local sort and keep top_n to reduce memory
        local_results.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        local_results.truncate(top_n);
        local_results
    }).collect();

    all_results.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    all_results.truncate(top_n);

    Ok(all_results)
}

// --- Phase 2: Hill Climbing ---

fn hill_climb_fast_single(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
) -> ([u8; 26], f64) {
    let mut pb: [u8; 26] = std::array::from_fn(|i| i as u8);
    let mut used = [false; 26];
    let mut out = vec![0; ct.len()];

    core.decrypt_fast(ct, [0, 0, 0], pos, &pb, &mut out);
    let mut best_score = scorer.score_raw_tri(&out);

    for _ in 0..max_pairs {
        let mut best_pair = None;
        let mut best_new_score = best_score;

        for a in 0..26 {
            if used[a as usize] { continue; }
            for b in (a+1)..26 {
                if used[b as usize] { continue; }

                pb[a as usize] = b;
                pb[b as usize] = a;

                core.decrypt_fast(ct, [0, 0, 0], pos, &pb, &mut out);
                let score = scorer.score_raw_tri(&out);

                pb[a as usize] = a;
                pb[b as usize] = b;

                if score > best_new_score {
                    best_new_score = score;
                    best_pair = Some((a, b));
                }
            }
        }

        if let Some((a, b)) = best_pair {
            pb[a as usize] = b;
            pb[b as usize] = a;
            used[a as usize] = true;
            used[b as usize] = true;
            best_score = best_new_score;
        } else {
            break;
        }
    }

    (pb, best_score)
}

fn hill_climb_full_single(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    _max_iterations: usize,
    initial_pb: [u8; 26],
) -> ([u8; 26], f64) {
    let mut rng = rand::thread_rng();
    let mut pb = initial_pb;
    let mut out = vec![0; ct.len()];

    core.decrypt_fast(ct, [0, 0, 0], pos, &pb, &mut out);
    let mut current_score = scorer.score_raw_tri(&out);
    let mut best_pb = pb;
    let mut best_score = current_score;

    let mut t = 2.0;
    let t_min = 0.005;
    let alpha = 0.98;

    let count_pairs = |p: &[u8; 26]| p.iter().enumerate().filter(|(i, &v)| v > *i as u8).count();

    while t > t_min {
        for _ in 0..150 {
            let mut trial = pb;
            let op = rng.gen_range(0..2);
            let mut changed = false;

            if op == 0 {
                let a = rng.gen_range(0..26) as usize;
                let b = rng.gen_range(0..26) as usize;
                if a != b {
                    let old_pa = trial[a];
                    let old_pb = trial[b];
                    if old_pa != a as u8 { trial[old_pa as usize] = old_pa; }
                    if old_pb != b as u8 { trial[old_pb as usize] = old_pb; }
                    trial[a] = b as u8;
                    trial[b] = a as u8;
                    changed = true;
                }
            } else {
                let a = rng.gen_range(0..26) as usize;
                let pa = trial[a];
                if pa != a as u8 {
                    trial[a] = a as u8;
                    trial[pa as usize] = pa;
                    changed = true;
                }
            }

            if changed && count_pairs(&trial) <= max_pairs {
                core.decrypt_fast(ct, [0, 0, 0], pos, &trial, &mut out);
                let new_score = scorer.score_raw_tri(&out);
                let diff = new_score - current_score;

                if diff > 0.0 || rng.gen::<f64>() < (diff / t).exp() {
                    pb = trial;
                    current_score = new_score;
                    if current_score > best_score {
                        best_score = current_score;
                        best_pb = pb;
                    }
                }
            }
        }
        t *= alpha;
    }

    (best_pb, best_score)
}

fn identity_pb() -> [u8; 26] {
    std::array::from_fn(|i| i as u8)
}

fn hill_climb_multi(
    ct: &[u8],
    core: &EnigmaCore,
    pos: [u8; 3],
    scorer: &Scorer,
    max_pairs: usize,
    n_restarts: usize,
) -> ([u8; 26], f64) {
    let mut best_pb = None;
    let mut best_score = std::f64::NEG_INFINITY;

    let (pb, score) = hill_climb_full_single(ct, core, pos, scorer, max_pairs, 30, identity_pb());
    if score > best_score {
        best_score = score;
        best_pb = Some(pb);
    }

    let mut rng = rand::thread_rng();

    for _ in 0..n_restarts {
        let mut init_pb = identity_pb();
        let mut letters: Vec<u8> = (0..26).collect();
        letters.shuffle(&mut rng);
        let n_init = rng.gen_range(3..=5);
        for k in 0..n_init {
            let a = letters[2*k as usize];
            let b = letters[2*k as usize + 1];
            init_pb[a as usize] = b;
            init_pb[b as usize] = a;
        }

        let (pb, score) = hill_climb_full_single(ct, core, pos, scorer, max_pairs, 30, init_pb);
        if score > best_score {
            best_score = score;
            best_pb = Some(pb);
        }
    }

    (best_pb.unwrap(), best_score)
}

#[pyfunction]
fn phase2_fast(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    max_pairs: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3], [u8; 26])>> {
    let dummy_quad = vec![0.0];
    let en_scorer = Scorer::new(&en_tri, en_tri_floor, &dummy_quad, 0.0);
    let ja_scorer = Scorer::new(&ja_tri, ja_tri_floor, &dummy_quad, 0.0);

    let results: Vec<_> = candidates.par_iter().flat_map(|&(rotors, pos)| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let mut res = Vec::new();

        if use_en {
            let (pb, s) = hill_climb_fast_single(&ct, &core, pos, &en_scorer, max_pairs);
            res.push((s, rotors, pos, pb));
        }
        if use_ja {
            let (pb, s) = hill_climb_fast_single(&ct, &core, pos, &ja_scorer, max_pairs);
            res.push((s, rotors, pos, pb));
        }
        res
    }).collect();

    Ok(results)
}

#[pyfunction]
fn phase2_full(
    ct: Vec<u8>,
    candidates: Vec<([usize; 3], [u8; 3])>,
    reflector_idx: usize,
    use_en: bool,
    use_ja: bool,
    en_tri: Vec<f64>,
    en_tri_floor: f64,
    ja_tri: Vec<f64>,
    ja_tri_floor: f64,
    max_pairs: usize,
    n_restarts: usize,
) -> PyResult<Vec<(f64, [usize; 3], [u8; 3], [u8; 26])>> {
    let dummy_quad = vec![0.0];
    let en_scorer = Scorer::new(&en_tri, en_tri_floor, &dummy_quad, 0.0);
    let ja_scorer = Scorer::new(&ja_tri, ja_tri_floor, &dummy_quad, 0.0);

    let results: Vec<_> = candidates.par_iter().flat_map(|&(rotors, pos)| {
        let core = EnigmaCore::new(rotors, reflector_idx);
        let mut res = Vec::new();

        if use_en {
            let (pb, s) = hill_climb_multi(&ct, &core, pos, &en_scorer, max_pairs, n_restarts);
            res.push((s, rotors, pos, pb));
        }
        if use_ja {
            let (pb, s) = hill_climb_multi(&ct, &core, pos, &ja_scorer, max_pairs, n_restarts);
            res.push((s, rotors, pos, pb));
        }
        res
    }).collect();

    Ok(results)
}


#[pymodule]
fn enigma_decoder(m: &Bound<'_, pyo3::types::PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(phase1, m)?)?;
    m.add_function(wrap_pyfunction!(phase2_fast, m)?)?;
    m.add_function(wrap_pyfunction!(phase2_full, m)?)?;
    Ok(())
}
