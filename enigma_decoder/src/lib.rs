//! エニグマ解読の高速コア。
//!
//! - `core`      … プラットフォーム非依存のアルゴリズム本体
//! - `langmodel` … n-gram 言語モデルと単語照合（ブラウザ版で必要）
//! - `python`    feature … PyO3 + Rayon バインディング（ローカルの CLI 用・既定）
//! - `wasm`      feature … wasm-bindgen バインディング（ブラウザ用・並列は JS 側）
//!
//! アルゴリズムは `core` に一本化してあるので、ネイティブ版とブラウザ版で
//! 結果が食い違うことはない（並列化の方法だけが違う）。

pub mod core;
pub mod langmodel;

#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "python")]
mod python_bindings {
    use crate::core::*;
    use pyo3::prelude::*;
    use rayon::prelude::*;

    /// Python から渡ってくる n-gram 配列一式。引数の数を抑えるための束ね。
    struct NgramArgs {
        en_tri: Vec<f64>,
        en_tri_floor: f64,
        en_quad: Vec<f64>,
        en_quad_floor: f64,
        ja_tri: Vec<f64>,
        ja_tri_floor: f64,
        ja_quad: Vec<f64>,
        ja_quad_floor: f64,
    }

    impl NgramArgs {
        fn scorers(&self) -> (Scorer<'_>, Scorer<'_>) {
            (
                Scorer::new(&self.en_tri, self.en_tri_floor, &self.en_quad, self.en_quad_floor),
                Scorer::new(&self.ja_tri, self.ja_tri_floor, &self.ja_quad, self.ja_quad_floor),
            )
        }
    }

    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<Ranked>> {
        // n-gram arrays are received for API stability but not used here —
        // Phase 1 scoring is IC-based (plugboard-invariant).
        let _ = (use_en, use_ja, en_tri, en_tri_floor, en_quad, en_quad_floor,
                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor);

        let mut all: Vec<Ranked> = rotor_perms
            .par_iter()
            .flat_map(|&rotors| phase1_rotor_block(&ct, rotors, reflector_idx, top_n))
            .collect();
        sort_desc_truncate(&mut all, top_n);
        Ok(all)
    }

    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
    fn phase1_known_pb(
        ct: Vec<u8>,
        rotor_perms: Vec<[usize; 3]>,
        reflector_idx: usize,
        plugboard: Vec<u8>,
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
    ) -> PyResult<Vec<Ranked>> {
        let mut pb = [0u8; 26];
        pb.copy_from_slice(&plugboard[..26]);

        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let mut all: Vec<Ranked> = rotor_perms
            .par_iter()
            .flat_map(|&rotors| {
                phase1_known_rotor_block(&ct, rotors, reflector_idx, &pb,
                                         use_en, use_ja, &en_sc, &ja_sc, top_n)
            })
            .collect();
        sort_desc_truncate(&mut all, top_n);
        Ok(all)
    }

    /// Tier-1 fast screening: single greedy HC from empty plugboard.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<RankedWithPb>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let results = candidates
            .par_iter()
            .flat_map(|&(rotors, pos)| {
                let core = EnigmaCore::new(rotors, reflector_idx);
                let mut res = Vec::new();
                if use_en {
                    let (pb, s) = hill_climb_greedy(&ct, &core, pos, [0, 0, 0],
                                                    &en_sc, max_pairs, identity_pb());
                    res.push((s, rotors, pos, pb));
                }
                if use_ja {
                    let (pb, s) = hill_climb_greedy(&ct, &core, pos, [0, 0, 0],
                                                    &ja_sc, max_pairs, identity_pb());
                    res.push((s, rotors, pos, pb));
                }
                res
            })
            .collect();
        Ok(results)
    }

    /// Tier-2 full search: multi-start greedy HC.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<RankedWithPb>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let results = candidates
            .par_iter()
            .flat_map(|&(rotors, pos)| {
                let core = EnigmaCore::new(rotors, reflector_idx);
                let mut res = Vec::new();
                if use_en {
                    let (pb, s) = hill_climb_multi(&ct, &core, pos, [0, 0, 0],
                                                   &en_sc, max_pairs, n_restarts);
                    res.push((s, rotors, pos, pb));
                }
                if use_ja {
                    let (pb, s) = hill_climb_multi(&ct, &core, pos, [0, 0, 0],
                                                   &ja_sc, max_pairs, n_restarts);
                    res.push((s, rotors, pos, pb));
                }
                res
            })
            .collect();
        Ok(results)
    }

    /// Tier-2 SA search: simulated annealing × n_restarts, polished by greedy HC.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<RankedWithPb>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let results = candidates
            .par_iter()
            .enumerate()
            .flat_map(|(cand_i, &(rotors, pos))| {
                let core = EnigmaCore::new(rotors, reflector_idx);
                let base_seed = (cand_i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);

                let run = |sc: &Scorer| -> (f64, [u8; 26]) {
                    let mut best_pb = identity_pb();
                    let mut best_score = f64::NEG_INFINITY;
                    for r in 0..n_restarts {
                        let seed = base_seed.wrapping_add(r as u64);
                        let (pb, s) = sa_then_hc(&ct, &core, pos, [0, 0, 0], sc, max_pairs,
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
            })
            .collect();
        Ok(results)
    }

    /// Phase 1B-SA: rerank Phase-1A candidates with a short SA on each.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<Ranked>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let mut results: Vec<Ranked> = candidates
            .par_iter()
            .enumerate()
            .map(|(idx, &(rotors, pos))| {
                phase1b_sa_one(&ct, idx, rotors, pos, reflector_idx,
                               use_en, use_ja, &en_sc, &ja_sc,
                               max_pairs, n_steps, t_start, t_end)
            })
            .collect();
        sort_desc_truncate(&mut results, top_k);
        Ok(results)
    }

    /// Phase 1B: rerank Phase-1A candidates by trying every single-pair plugboard.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
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
    ) -> PyResult<Vec<Ranked>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();

        let mut results: Vec<Ranked> = candidates
            .par_iter()
            .map(|&(rotors, pos)| {
                phase1b_one(&ct, rotors, pos, reflector_idx, use_en, use_ja, &en_sc, &ja_sc)
            })
            .collect();
        sort_desc_truncate(&mut results, top_k);
        Ok(results)
    }

    /// Phase 2 (staged): highest-accuracy plugboard recovery.
    #[pyfunction]
    #[allow(clippy::too_many_arguments)]
    fn phase2_staged(
        ct: Vec<u8>,
        candidates: Vec<([usize; 3], [u8; 3])>,
        reflector_idx: usize,
        use_en: bool,
        use_ja: bool,
        en_bi: Vec<f64>,
        en_bi_floor: f64,
        ja_bi: Vec<f64>,
        ja_bi_floor: f64,
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
        sa_steps: usize,
        t_start: f64,
        t_end: f64,
    ) -> PyResult<Vec<RankedWithPb>> {
        let ngrams = NgramArgs { en_tri, en_tri_floor, en_quad, en_quad_floor,
                                 ja_tri, ja_tri_floor, ja_quad, ja_quad_floor };
        let (en_sc, ja_sc) = ngrams.scorers();
        let models = StagedModels {
            use_en, use_ja,
            en_bi: &en_bi, en_bi_floor,
            ja_bi: &ja_bi, ja_bi_floor,
            en_sc: &en_sc, ja_sc: &ja_sc,
        };

        let results = candidates
            .par_iter()
            .enumerate()
            .map(|(cand_i, &(rotors, pos))| {
                phase2_staged_one(&ct, cand_i, rotors, pos, reflector_idx, &models,
                                  max_pairs, n_restarts, sa_steps, t_start, t_end)
            })
            .collect();
        Ok(results)
    }

    #[pymodule]
    fn enigma_decoder(m: &Bound<'_, pyo3::types::PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(phase1, m)?)?;
        m.add_function(wrap_pyfunction!(phase1_known_pb, m)?)?;
        m.add_function(wrap_pyfunction!(phase2_staged, m)?)?;
        m.add_function(wrap_pyfunction!(phase1b, m)?)?;
        m.add_function(wrap_pyfunction!(phase1b_sa, m)?)?;
        m.add_function(wrap_pyfunction!(phase2_fast, m)?)?;
        m.add_function(wrap_pyfunction!(phase2_full, m)?)?;
        m.add_function(wrap_pyfunction!(phase2_sa, m)?)?;
        Ok(())
    }
}
