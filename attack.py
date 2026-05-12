"""
Gillogly法による二段階の暗号文単独攻撃。

Phase 1: ローター順 × 初期位置を全探索。プラグボード無しで一致指数(IC)を
        スコアとする。上位候補を残す。
Phase 2: 各候補について山登り法でプラグボードを推定。スコアは trigram
        対数確率。

リング設定は Phase 1 では全て0に固定。Phase 1 終了後に右ローターのリング
だけ26通り再探索する（ノッチを跨ぐと結果が変わるため）。
"""

import time
from itertools import permutations, product

try:
    import enigma_decoder
    HAS_RUST = True
except ImportError:
    HAS_RUST = False

from enigma import (ROTORS, REFLECTORS, decrypt_with_settings,
                    precompute_rotor_arrays, decrypt_fast)
from scoring import (index_of_coincidence, english_model, romaji_model,
                     best_language_score)


def text_to_ints(text):
    return [ord(c) - 65 for c in text.upper() if 'A' <= c <= 'Z']


def ints_to_text(ints):
    return ''.join(chr(i + 65) for i in ints)


def identity_plugboard():
    return list(range(26))


def apply_plugboard_swap(pb, a, b):
    """プラグボードを破壊的に変更（ペアの追加/削除）。"""
    # 既存の接続を解除
    pa, pb_ = pb[a], pb[b]
    pb[pa] = pa
    pb[pb_] = pb_
    # aとbを入れ替え
    if a != b:
        pb[a] = b
        pb[b] = a


def phase1_rust(ciphertext, reflector='B', top_n=200, sample_len=100,
                rotor_choices=('I', 'II', 'III', 'IV', 'V'),
                language='auto', verbose=True):
    ct_ints = text_to_ints(ciphertext)[:sample_len]
    en = english_model()
    ja = romaji_model()
    
    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    rotor_names = ['I', 'II', 'III', 'IV', 'V']
    rotor_idx = {name: i for i, name in enumerate(rotor_names)}
    
    perms = list(permutations(rotor_choices, 3))
    rust_perms = [[rotor_idx[r] for r in p] for p in perms]
    
    refl_idx = 0 if reflector == 'B' else 1
    
    t0 = time.time()
    if verbose:
        print(f'[Phase 1] {len(perms)} rotor perms × 17576 positions (lang={language}, sample={sample_len})')
    
    raw_results = []
    chunk_size = max(1, len(rust_perms) // 10)
    for i in range(0, len(rust_perms), chunk_size):
        chunk = rust_perms[i:i+chunk_size]
        res = enigma_decoder.phase1(
            ct_ints, chunk, refl_idx, use_en, use_ja,
            en.tri_array, en.tri_floor, en.quad_array, en.quad_floor,
            ja.tri_array, ja.tri_floor, ja.quad_array, ja.quad_floor, top_n
        )
        raw_results.extend(res)
        if verbose:
            done = min(len(rust_perms), i + chunk_size)
            pct = 100.0 * done / len(rust_perms)
            print(f'  {pct:5.1f}%  ({done}/{len(rust_perms)} perms)')
            
    raw_results.sort(reverse=True, key=lambda x: x[0])
    raw_results = raw_results[:top_n]
    
    results = []
    for score, r_idx, p_idx in raw_results:
        rotors = (rotor_names[r_idx[0]], rotor_names[r_idx[1]], rotor_names[r_idx[2]])
        pos = (p_idx[0], p_idx[1], p_idx[2])
        results.append((score, rotors, pos))
        
    if verbose:
        print(f'[Phase 1] done in {time.time()-t0:.2f}s')
        if results:
            print(f'  top score: {results[0][0]:.2f} (rotors={results[0][1]} pos={results[0][2]})')

    return results


def phase1b_sa_rerank(ciphertext, candidates, language='auto', top_k=2000,
                      sample_len=100, sa_steps=5000, t_start=12.0, t_end=0.5,
                      max_pairs=10, verbose=True):
    """
    Phase 1B v2: rerank Phase-1A candidates by running a short SA per
    candidate. Discriminates correct rotor+position better than 1-pair scoring
    for ≥6 plugboard pairs, but is much slower (~200ms per 1000 cands at n=80).
    """
    if not HAS_RUST or not candidates:
        return candidates[:top_k]

    ct_ints = text_to_ints(ciphertext)[:sample_len]
    en = english_model()
    ja = romaji_model()
    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    rotor_names = ['I', 'II', 'III', 'IV', 'V']
    rotor_idx = {name: i for i, name in enumerate(rotor_names)}

    rust_cands = [([rotor_idx[r] for r in c[1]], list(c[2])) for c in candidates]

    t0 = time.time()
    if verbose:
        print(f'[Phase 1B-SA] reranking {len(rust_cands)} candidates via light SA '
              f'(steps={sa_steps}, sample={sample_len})')

    raw = []
    chunk_size = max(1, len(rust_cands) // 10)
    for i in range(0, len(rust_cands), chunk_size):
        chunk = rust_cands[i:i + chunk_size]
        res = enigma_decoder.phase1b_sa(
            ct_ints, chunk, 0, use_en, use_ja,
            en.tri_array, en.tri_floor, en.quad_array, en.quad_floor,
            ja.tri_array, ja.tri_floor, ja.quad_array, ja.quad_floor,
            top_k, max_pairs, sa_steps, t_start, t_end,
        )
        raw.extend(res)
        if verbose:
            done = min(len(rust_cands), i + chunk_size)
            print(f'  {100.0*done/len(rust_cands):5.1f}%  ({done}/{len(rust_cands)})')

    raw.sort(reverse=True, key=lambda x: x[0])
    raw = raw[:top_k]

    results = []
    for score, r_idx, p_idx in raw:
        rotors = (rotor_names[r_idx[0]], rotor_names[r_idx[1]], rotor_names[r_idx[2]])
        pos = (p_idx[0], p_idx[1], p_idx[2])
        results.append((score, rotors, pos))

    if verbose:
        print(f'[Phase 1B-SA] done in {time.time()-t0:.1f}s  '
              f'top score: {results[0][0]:.2f}')
    return results


def phase1b_rerank(ciphertext, candidates, language='auto', top_k=2000,
                   sample_len=100, verbose=True):
    """
    Phase 1B: rerank Phase-1A candidates by trying all 325 single-pair plugboards.

    For the correct rotor+position the best single pair will be (or approach)
    a true plugboard pair, yielding a noticeably higher trigram score than any
    random pair on a wrong rotor position.  This collapses a Phase-1A rank of
    >100k down to a top-few-hundred rank, enabling Phase 2 to succeed.
    """
    if not HAS_RUST or not candidates:
        return candidates[:top_k]

    ct_ints = text_to_ints(ciphertext)[:sample_len]
    en = english_model()
    ja = romaji_model()
    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    rotor_names = ['I', 'II', 'III', 'IV', 'V']
    rotor_idx = {name: i for i, name in enumerate(rotor_names)}

    rust_cands = [([rotor_idx[r] for r in c[1]], list(c[2])) for c in candidates]

    t0 = time.time()
    if verbose:
        print(f'[Phase 1B] reranking {len(rust_cands)} candidates via 1-pair n-gram '
              f'(sample={sample_len})')

    raw = []
    chunk_size = max(1, len(rust_cands) // 10)
    for i in range(0, len(rust_cands), chunk_size):
        chunk = rust_cands[i:i + chunk_size]
        res = enigma_decoder.phase1b(
            ct_ints, chunk, 0, use_en, use_ja,
            en.tri_array, en.tri_floor, en.quad_array, en.quad_floor,
            ja.tri_array, ja.tri_floor, ja.quad_array, ja.quad_floor,
            top_k,
        )
        raw.extend(res)
        if verbose:
            done = min(len(rust_cands), i + chunk_size)
            print(f'  {100.0*done/len(rust_cands):5.1f}%  ({done}/{len(rust_cands)})')

    raw.sort(reverse=True, key=lambda x: x[0])
    raw = raw[:top_k]

    results = []
    for score, r_idx, p_idx in raw:
        rotors = (rotor_names[r_idx[0]], rotor_names[r_idx[1]], rotor_names[r_idx[2]])
        pos = (p_idx[0], p_idx[1], p_idx[2])
        results.append((score, rotors, pos))

    if verbose:
        print(f'[Phase 1B] done in {time.time()-t0:.1f}s  '
              f'top score: {results[0][0]:.2f}')
    return results


def phase1(ciphertext, reflector='B', top_n=200, sample_len=100,
           rotor_choices=('I', 'II', 'III', 'IV', 'V'),
           language='auto', verbose=True):
    """
    Phase 1: ローター順 × 初期位置を全探索。
    各設定でプラグボード無しの状態で復号し、trigram スコアでランク付け。

    language='auto'  → 両言語スコアの max を採用
    language='english' → 英語のみ
    language='romaji' → ローマ字のみ
    sample_len: Phase 1 で評価する文字数（少ないほど高速、多いほど精密）。
    """
    if HAS_RUST:
        return phase1_rust(ciphertext, reflector, top_n, sample_len, rotor_choices, language, verbose)

    ct_ints = text_to_ints(ciphertext)
    sample = ct_ints[:sample_len]
    pb_id = identity_plugboard()
    en = english_model()
    ja = romaji_model()

    perms = list(permutations(rotor_choices, 3))
    total = len(perms) * 26 ** 3
    if verbose:
        print(f'[Phase 1] {len(perms)} rotor perms × 17576 positions '
              f'= {total} trials (lang={language}, sample={sample_len})')

    results = []
    t0 = time.time()
    done = 0
    progress_step = max(1, total // 20)

    en_tri, en_floor = en.tri, en.tri_floor
    ja_tri, ja_floor = ja.tri, ja.tri_floor
    en_quad, en_qfloor = en.quad, en.quad_floor
    ja_quad, ja_qfloor = ja.quad, ja.quad_floor

    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    for rotors in perms:
        fwd, bwd, notches, refl = precompute_rotor_arrays(rotors, reflector)
        for p1, p2, p3 in product(range(26), repeat=3):
            decrypted = decrypt_fast(
                sample, fwd, bwd, notches, refl,
                (0, 0, 0), (p1, p2, p3), pb_id,
            )
            text = ''.join(chr(i + 65) for i in decrypted)
            # trigram + quadgram の混合スコア
            score = -float('inf')
            if use_en:
                s = 0.0
                for i in range(len(text) - 2):
                    s += en_tri.get(text[i:i+3], en_floor)
                for i in range(len(text) - 3):
                    s += en_quad.get(text[i:i+4], en_qfloor)
                if s > score:
                    score = s
            if use_ja:
                s = 0.0
                for i in range(len(text) - 2):
                    s += ja_tri.get(text[i:i+3], ja_floor)
                for i in range(len(text) - 3):
                    s += ja_quad.get(text[i:i+4], ja_qfloor)
                if s > score:
                    score = s
            results.append((score, rotors, (p1, p2, p3)))
            done += 1
            if verbose and done % progress_step == 0:
                pct = 100.0 * done / total
                elapsed = time.time() - t0
                eta = elapsed * (total - done) / max(1, done)
                print(f'  {pct:5.1f}%  elapsed {elapsed:5.0f}s  '
                      f'ETA {eta:5.0f}s')

    results.sort(reverse=True, key=lambda x: x[0])
    if verbose:
        print(f'[Phase 1] done in {time.time()-t0:.1f}s')
        print(f'  top score: {results[0][0]:.2f} '
              f'(rotors={results[0][1]} pos={results[0][2]})')
    return results[:top_n]


def hill_climb_plugboard_fast(ct_ints, rotors, reflector, ring_settings,
                              positions, scorer, max_pairs=10):
    """
    高速版: 各反復で a と b の独立な追加スワップだけ試す。
    （既存ペアの再アレンジは行わない簡易版だが、十分実用的。）
    """
    fwd, bwd, notches, refl = precompute_rotor_arrays(rotors, reflector)
    pb = identity_plugboard()
    used = [False] * 26

    def decrypt_and_score(plugboard):
        out = decrypt_fast(ct_ints, fwd, bwd, notches, refl,
                           ring_settings, positions, plugboard)
        return scorer.score_raw(ints_to_text(out))

    best_score = decrypt_and_score(pb)

    for _ in range(max_pairs):
        best_pair = None
        best_new_score = best_score
        for a in range(26):
            if used[a]:
                continue
            for b in range(a + 1, 26):
                if used[b]:
                    continue
                pb[a] = b
                pb[b] = a
                score = decrypt_and_score(pb)
                pb[a] = a
                pb[b] = b
                if score > best_new_score:
                    best_new_score = score
                    best_pair = (a, b)
        if best_pair is None:
            break
        a, b = best_pair
        pb[a] = b
        pb[b] = a
        used[a] = True
        used[b] = True
        best_score = best_new_score

    return pb, best_score


def hill_climb_plugboard_full(ct_ints, rotors, reflector, ring_settings,
                              positions, scorer, max_pairs=10,
                              max_iterations=30, initial_pb=None):
    """
    完全な Gillogly 流山登り。各反復で 325 通りすべての (a, b) ペアを試し、
    「a と b を組ませる（既存ペアは解除される）」 + 「既存ペアを解除する」の
    全操作のうち最良を適用。局所最適への耐性が高い。

    initial_pb: 開始時のプラグボード（None なら空）。ランダム再開用。
    """
    fwd, bwd, notches, refl = precompute_rotor_arrays(rotors, reflector)
    if initial_pb is None:
        pb = identity_plugboard()
    else:
        pb = list(initial_pb)

    def decrypt_pb(plugboard):
        out = decrypt_fast(ct_ints, fwd, bwd, notches, refl,
                           ring_settings, positions, plugboard)
        return scorer.score_raw(ints_to_text(out))

    def count_pairs(plugboard):
        return sum(1 for i in range(26) if plugboard[i] > i)

    best_score = decrypt_pb(pb)

    for _ in range(max_iterations):
        best_op = None  # ('set', a, b) or ('remove', a, b)
        best_new_score = best_score

        # 操作1: a と b を組ませる（既存ペアは解除される）
        for a in range(26):
            for b in range(a + 1, 26):
                if pb[a] == b:
                    continue  # 既にこのペア
                trial = pb.copy()
                old_pa = trial[a]
                old_pb = trial[b]
                if old_pa != a:
                    trial[old_pa] = old_pa
                if old_pb != b:
                    trial[old_pb] = old_pb
                trial[a] = b
                trial[b] = a
                if count_pairs(trial) > max_pairs:
                    continue
                score = decrypt_pb(trial)
                if score > best_new_score:
                    best_new_score = score
                    best_op = ('set', a, b)

        # 操作2: 既存ペアを解除
        for a in range(26):
            if pb[a] > a:
                trial = pb.copy()
                trial[pb[a]] = pb[a]
                trial[a] = a
                score = decrypt_pb(trial)
                if score > best_new_score:
                    best_new_score = score
                    best_op = ('remove', a, pb[a])

        if best_op is None:
            break

        # 最良操作を適用
        kind, a, b = best_op
        if kind == 'set':
            old_pa = pb[a]
            old_pb = pb[b]
            if old_pa != a:
                pb[old_pa] = old_pa
            if old_pb != b:
                pb[old_pb] = old_pb
            pb[a] = b
            pb[b] = a
        else:
            pb[a] = a
            pb[b] = b
        best_score = best_new_score

    return pb, best_score


def hill_climb_plugboard_multi(ct_ints, rotors, reflector, ring_settings,
                               positions, scorer, max_pairs=10,
                               n_restarts=3, random_seed=None):
    """
    複数開始点からの山登り。空プラグボード + ランダム初期プラグボードで再開し、
    最良を返す。局所最適からの脱出能力をさらに高める。
    """
    import random
    if random_seed is not None:
        random.seed(random_seed)

    best_pb = None
    best_score = -float('inf')

    # 開始点1: 空プラグボード
    pb, score = hill_climb_plugboard_full(
        ct_ints, rotors, reflector, ring_settings, positions,
        scorer, max_pairs=max_pairs)
    if score > best_score:
        best_score = score
        best_pb = pb

    # 開始点2..N: ランダム初期プラグボード（3〜5ペア）
    for _ in range(n_restarts):
        init_pb = identity_plugboard()
        letters = list(range(26))
        random.shuffle(letters)
        n_init = random.randint(3, 5)
        for k in range(n_init):
            a, b = letters[2*k], letters[2*k+1]
            init_pb[a] = b
            init_pb[b] = a
        pb, score = hill_climb_plugboard_full(
            ct_ints, rotors, reflector, ring_settings, positions,
            scorer, max_pairs=max_pairs, initial_pb=init_pb)
        if score > best_score:
            best_score = score
            best_pb = pb

    return best_pb, best_score


def _rust_phase2_call(fn, ct_ints, chunk, use_en, use_ja, en, ja, *extra):
    """Thin wrapper that always passes quadgram arrays to Rust phase2 functions."""
    return fn(
        ct_ints, chunk, 0, use_en, use_ja,
        en.tri_array, en.tri_floor, en.quad_array, en.quad_floor,
        ja.tri_array, ja.tri_floor, ja.quad_array, ja.quad_floor,
        *extra,
    )


def _sa_params_for(ct_len, max_pairs):
    """
    Choose SA (n_steps, t_start, t_end, n_restarts) based on ct length and
    expected plugboard complexity.  More pairs → more steps + more restarts
    so SA explores the wider permutation space.
    Rust SA is fast (~1µs per step at ct_len=80), so 50k–150k steps is cheap.
    """
    if ct_len < 80:
        return (40000, 12.0, 0.3, 3)
    if ct_len < 130:
        return (60000, 14.0, 0.3, 4)
    if ct_len < 200:
        return (80000, 14.0, 0.3, 4)
    return (100000, 15.0, 0.3, 5)


def phase2_rust(ciphertext, candidates, language='auto', max_candidates=80,
                top_results=5, accuracy=False, n_restarts=3, max_pairs=10,
                tier2_n=300, verbose=True):
    ct_ints = text_to_ints(ciphertext)
    n = min(len(candidates), max_candidates)

    en = english_model()
    ja = romaji_model()
    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    rotor_names = ['I', 'II', 'III', 'IV', 'V']
    rotor_idx = {name: i for i, name in enumerate(rotor_names)}

    t0 = time.time()

    def decode_raw(raw):
        results = []
        for s, r_idx, p_idx, pb in raw:
            rotors = (rotor_names[r_idx[0]], rotor_names[r_idx[1]], rotor_names[r_idx[2]])
            pos = (p_idx[0], p_idx[1], p_idx[2])
            decrypted = decrypt_with_settings(ct_ints, rotors, 'B', (0, 0, 0), pos, list(pb))
            text = ints_to_text(decrypted)
            lang, final_score = best_language_score(text)
            results.append((final_score, rotors, pos, (0, 0, 0), list(pb), lang, text))
        return results

    def run_chunks(fn, rust_cands, extra, label, verbose):
        raw = []
        chunk_size = max(1, len(rust_cands) // 10)
        for i in range(0, len(rust_cands), chunk_size):
            chunk = rust_cands[i:i + chunk_size]
            raw.extend(_rust_phase2_call(fn, ct_ints, chunk, use_en, use_ja, en, ja, *extra))
            if verbose:
                done = min(len(rust_cands), i + chunk_size)
                print(f'  {label} {100.0*done/len(rust_cands):5.1f}%  ({done}/{len(rust_cands)} cands)')
        return raw

    if accuracy:
        # Tier 1 = light SA screening (5000 steps × 1 restart).
        # Replaces greedy-HC tier1 which overfit on wrong rotors with many
        # plugboard pairs — light SA is more robust as a discriminator.
        # For very short ciphertexts where greedy HC is sufficient and faster,
        # we still use phase2_fast.
        ct_len = len(ct_ints)
        use_sa_tier1 = ct_len >= 80 and n > 1000

        rust_cands = [([rotor_idx[r] for r in c[1]], list(c[2])) for c in candidates[:n]]

        if use_sa_tier1:
            tier1_steps = 5000 if ct_len < 200 else 8000
            if verbose:
                print(f'[Phase 2-1] light SA screening on top {n} candidates '
                      f'(tier1, n_steps={tier1_steps})')
            raw_t1 = run_chunks(
                enigma_decoder.phase2_sa, rust_cands,
                (max_pairs, 1, tier1_steps, 12.0, 0.5),
                'tier1-sa', verbose)
        else:
            if verbose:
                print(f'[Phase 2-1] fast screening on top {n} candidates (tier1, max_pairs=8)')
            raw_t1 = run_chunks(enigma_decoder.phase2_fast, rust_cands, (8,), 'tier1', verbose)

        tier1 = decode_raw(raw_t1)
        tier1.sort(reverse=True, key=lambda r: r[0])

        seen_pos = set()
        tier2_input = []
        for r in tier1:
            key = (r[1], r[2])
            if key not in seen_pos:
                seen_pos.add(key)
                tier2_input.append(r)
                if len(tier2_input) >= tier2_n:
                    break

        if verbose:
            print(f'[Phase 2-1] done in {time.time()-t0:.1f}s  '
                  f'top tier1 score {tier1[0][0]:+.3f}')

        t2 = time.time()
        sa_steps, t_start, t_end, sa_restarts = _sa_params_for(len(ct_ints), max_pairs)
        sa_restarts = max(sa_restarts, n_restarts)
        if verbose:
            print(f'[Phase 2-2] SA+HC on {len(tier2_input)} candidates '
                  f'(max_pairs={max_pairs}, restarts={sa_restarts}, '
                  f'n_steps={sa_steps}, t={t_start}→{t_end})')

        rust_t2 = [([rotor_idx[r] for r in c[1]], list(c[2])) for c in tier2_input]
        raw_t2 = run_chunks(
            enigma_decoder.phase2_sa, rust_t2,
            (max_pairs, sa_restarts, sa_steps, t_start, t_end),
            'tier2', verbose)
        all_results = decode_raw(raw_t2)

        if verbose:
            print(f'[Phase 2-2] done in {time.time()-t2:.1f}s')

    else:
        if verbose:
            print(f'[Phase 2] greedy hill-climb on top {n} candidates '
                  f'(max_pairs={max_pairs}, restarts={n_restarts})')

        rust_cands = [([rotor_idx[r] for r in c[1]], list(c[2])) for c in candidates[:n]]
        raw = run_chunks(enigma_decoder.phase2_full, rust_cands,
                         (max_pairs, n_restarts), '', verbose)
        all_results = decode_raw(raw)

        if verbose:
            print(f'[Phase 2] done in {time.time()-t0:.1f}s')

    all_results.sort(reverse=True, key=lambda r: r[0])
    seen = set()
    unique = []
    for r in all_results:
        if r[6] not in seen:
            seen.add(r[6])
            unique.append(r)
            if len(unique) >= top_results:
                break
    return unique

def phase2(ciphertext, candidates, language='auto', max_candidates=80,
           top_results=5, accuracy=False, n_restarts=3, max_pairs=10,
           tier2_n=300, verbose=True):
    """
    Phase 1 の上位候補それぞれに対してプラグボードを山登り。
    両言語のスコアラーで評価し、上位 top_results 個を返す。

    accuracy=False: 高速山登り（追加のみ、開始点1つ）を全 max_candidates に適用。
    accuracy=True:  二段階方式。
        Tier 1: 高速山登りで max_candidates をふるい分け
        Tier 2: ふるい分け上位 tier2_n に完全山登り（既存ペア再配置）×複数開始点
    """
    if HAS_RUST:
        return phase2_rust(ciphertext, candidates, language, max_candidates, top_results, accuracy, n_restarts, max_pairs, tier2_n, verbose)

    ct_ints = text_to_ints(ciphertext)
    n = min(len(candidates), max_candidates)

    en = english_model()
    ja = romaji_model()
    if language == 'english':
        scorers = [en]
    elif language == 'romaji':
        scorers = [ja]
    else:
        scorers = [en, ja]

    t0 = time.time()

    if accuracy:
        # === Tier 1: 高速ふるい分け ===
        if verbose:
            print(f'[Phase 2-1] fast screening on top {n} candidates '
                  f'(tier1, max_pairs=8)')
        tier1_results = []
        progress_step = max(1, n // 20)
        for idx, (ic, rotors, positions) in enumerate(candidates[:n]):
            for scorer in scorers:
                pb, _ = hill_climb_plugboard_fast(
                    ct_ints, rotors, 'B', (0, 0, 0), positions,
                    scorer, max_pairs=8,
                )
                decrypted = decrypt_with_settings(
                    ct_ints, rotors, 'B', (0, 0, 0), positions, pb)
                text = ints_to_text(decrypted)
                lang, score = best_language_score(text)
                tier1_results.append(
                    (score, rotors, positions, (0, 0, 0), pb, lang, text))
            if verbose and (idx + 1) % progress_step == 0:
                best_now = max(r[0] for r in tier1_results)
                elapsed = time.time() - t0
                eta = elapsed * (n - idx - 1) / max(1, idx + 1)
                print(f'  tier1 {idx+1}/{n}  best so far: {best_now:+.3f}  '
                      f'elapsed {elapsed:.0f}s  ETA {eta:.0f}s')
        # 上位 tier2_n を Tier 2 へ
        tier1_results.sort(reverse=True, key=lambda r: r[0])
        # ローター+ポジションの組合せで重複除去
        seen_pos = set()
        tier2_input = []
        for r in tier1_results:
            key = (r[1], r[2])
            if key not in seen_pos:
                seen_pos.add(key)
                tier2_input.append(r)
                if len(tier2_input) >= tier2_n:
                    break
        if verbose:
            t1 = time.time() - t0
            print(f'[Phase 2-1] done in {t1:.0f}s, top tier1 score '
                  f'{tier1_results[0][0]:+.3f}')

        # === Tier 2: 完全山登り＋複数開始点 ===
        if verbose:
            print(f'[Phase 2-2] full hill-climb with restarts on '
                  f'{len(tier2_input)} promising candidates '
                  f'(max_pairs={max_pairs}, restarts={n_restarts})')
        all_results = []
        t2_start = time.time()
        progress_step2 = max(1, len(tier2_input) // 20)
        for idx, (s_tier1, rotors, positions, _, _, _, _) in enumerate(tier2_input):
            for scorer in scorers:
                pb, _ = hill_climb_plugboard_multi(
                    ct_ints, rotors, 'B', (0, 0, 0), positions,
                    scorer, max_pairs=max_pairs, n_restarts=n_restarts,
                )
                decrypted = decrypt_with_settings(
                    ct_ints, rotors, 'B', (0, 0, 0), positions, pb)
                text = ints_to_text(decrypted)
                lang, score = best_language_score(text)
                all_results.append(
                    (score, rotors, positions, (0, 0, 0), pb, lang, text))
            if verbose and (idx + 1) % progress_step2 == 0:
                best_now = max(r[0] for r in all_results)
                elapsed = time.time() - t2_start
                eta = elapsed * (len(tier2_input) - idx - 1) / max(1, idx + 1)
                print(f'  tier2 {idx+1}/{len(tier2_input)}  '
                      f'best so far: {best_now:+.3f}  '
                      f'elapsed {elapsed:.0f}s  ETA {eta:.0f}s')
        if verbose:
            print(f'[Phase 2-2] done in {time.time()-t2_start:.0f}s')

    else:
        # === 通常モード: シンプルな1段階 ===
        if verbose:
            print(f'[Phase 2] hill-climbing plugboard for top {n} candidates '
                  f'(fast mode)')
        all_results = []
        progress_step = max(1, n // 20)
        for idx, (ic, rotors, positions) in enumerate(candidates[:n]):
            for scorer in scorers:
                pb, _ = hill_climb_plugboard_fast(
                    ct_ints, rotors, 'B', (0, 0, 0), positions,
                    scorer, max_pairs=8,
                )
                decrypted = decrypt_with_settings(
                    ct_ints, rotors, 'B', (0, 0, 0), positions, pb)
                text = ints_to_text(decrypted)
                lang, score = best_language_score(text)
                all_results.append(
                    (score, rotors, positions, (0, 0, 0), pb, lang, text))
            if verbose and (idx + 1) % progress_step == 0:
                best_now = max(r[0] for r in all_results)
                elapsed = time.time() - t0
                eta = elapsed * (n - idx - 1) / max(1, idx + 1)
                print(f'  {idx+1}/{n}  best so far: {best_now:+.3f}  '
                      f'elapsed {elapsed:.0f}s  ETA {eta:.0f}s')
        if verbose:
            print(f'[Phase 2] done in {time.time()-t0:.1f}s')

    all_results.sort(reverse=True, key=lambda r: r[0])
    # 重複除去（同じ復号文は1つだけ）
    seen = set()
    unique = []
    for r in all_results:
        if r[6] not in seen:
            seen.add(r[6])
            unique.append(r)
            if len(unique) >= top_results:
                break
    return unique


def refine_rings(ciphertext, results, accuracy=False, verbose=True):
    """
    各上位候補についてリング設定を再探索し、改善が見つかった場合のみ
    プラグボードを再最適化する。

    通常モード: 右ローターのみ（26通り）
    精度モード: 中・右両方（676通り）
    """
    ct_ints = text_to_ints(ciphertext)
    en = english_model()
    ja = romaji_model()
    n_trials = 26 * 26 if accuracy else 26
    if verbose:
        print(f'[Refine] testing {n_trials} ring settings '
              f'for {len(results)} candidates')
    refined = []
    for result in results:
        score, rotors, positions, rings, pb, lang, _ = result
        best = result
        # 各リング設定でスコアを評価し、上位 top_k 候補を収集してから
        # プラグボード再最適化（計算量を抑制）
        ring_candidates = []

        if accuracy:
            for rm in range(26):
                for rr in range(26):
                    nr = (rings[0], rm, rr)
                    np_ = (positions[0], (positions[1] + rm) % 26, (positions[2] + rr) % 26)
                    dec = decrypt_with_settings(ct_ints, rotors, 'B', nr, np_, pb)
                    text = ints_to_text(dec)
                    lang2, s2 = best_language_score(text)
                    ring_candidates.append((s2, nr, np_, pb, lang2, text))
        else:
            for rr in range(26):
                nr = (rings[0], rings[1], rr)
                np_ = (positions[0], positions[1], (positions[2] + rr) % 26)
                dec = decrypt_with_settings(ct_ints, rotors, 'B', nr, np_, pb)
                text = ints_to_text(dec)
                lang2, s2 = best_language_score(text)
                ring_candidates.append((s2, nr, np_, pb, lang2, text))

        ring_candidates.sort(reverse=True, key=lambda x: x[0])

        # 現在のベストとの比較 + 上位 5 候補でプラグボード再最適化
        for s2, nr, np_, pb2, lang2, text2 in ring_candidates[:5]:
            if s2 > best[0]:
                best = (s2, rotors, np_, nr, pb2, lang2, text2)
            # プラグボード再最適化（スコアが現ベストに近い候補のみ）
            if s2 >= best[0] - 0.3:
                scorer = en if lang2 == 'english' else ja
                pb3, _ = hill_climb_plugboard_full(
                    ct_ints, rotors, 'B', nr, np_,
                    scorer, max_pairs=10, max_iterations=15, initial_pb=pb2)
                dec3 = decrypt_with_settings(ct_ints, rotors, 'B', nr, np_, pb3)
                text3 = ints_to_text(dec3)
                lang3, s3 = best_language_score(text3)
                if s3 > best[0]:
                    best = (s3, rotors, np_, nr, pb3, lang3, text3)

        refined.append(best)
    refined.sort(reverse=True, key=lambda r: r[0])
    return refined


# 既存名で互換性維持
refine_right_ring = refine_rings


def _auto_scale(ct_len, top_n, max_candidates, n_restarts, accuracy, tier2_n):
    """
    文字数に応じて探索幅を自動拡大する。

    統計的根拠:
      Phase 1A の IC ベース順位は plugboard ペア数が増えるにつれ悪化する。
      実測値 (自然英語コーパス):
        4pb / 60chars  → Phase1A rank ≈  34,000
        6pb / 80chars  → Phase1A rank ≈  74,000
        8pb /120chars  → Phase1A rank ≈ 104,000
       10pb /200chars  → Phase1A rank > 200,000
      → Phase 1B (best-1-pair n-gram rerank) でこれを top-2000 に引き込む。
      → top_n は Phase1B への入力を確実に正解含む値に設定する。
    """
    # Phase 1B を有効にするかどうか (top_n が大きい場合のみ)
    use_phase1b = HAS_RUST

    if not accuracy:
        if ct_len < 80:
            top_n          = max(top_n, 90000)
            n_restarts     = max(n_restarts, 4)
            accuracy       = True
            tier2_n        = max(tier2_n, 200)
        elif ct_len < 110:
            top_n          = max(top_n, 120000)   # covers rank~74k (6pb)
            n_restarts     = max(n_restarts, 3)
            accuracy       = True
            tier2_n        = max(tier2_n, 200)
        elif ct_len < 160:
            top_n          = max(top_n, 150000)   # covers rank~104k (8pb)
            n_restarts     = max(n_restarts, 2)
            accuracy       = True
            tier2_n        = max(tier2_n, 200)
        elif ct_len < 250:
            top_n          = max(top_n, 300000)   # covers rank>200k (10pb)
            n_restarts     = max(n_restarts, 2)
            accuracy       = True
            tier2_n        = max(tier2_n, 200)
        else:
            top_n          = max(top_n, 5000)
            n_restarts     = max(n_restarts, 2)
    else:
        if ct_len < 80:
            top_n          = max(top_n, 200000)
            n_restarts     = max(n_restarts, 5)
            tier2_n        = max(tier2_n, 500)
        elif ct_len < 110:
            top_n          = max(top_n, 200000)
            n_restarts     = max(n_restarts, 4)
            tier2_n        = max(tier2_n, 300)
        elif ct_len < 160:
            top_n          = max(top_n, 200000)
            n_restarts     = max(n_restarts, 3)
            tier2_n        = max(tier2_n, 200)
        elif ct_len < 250:
            top_n          = max(top_n, 400000)
            n_restarts     = max(n_restarts, 3)
            tier2_n        = max(tier2_n, 200)

    # When Phase 1B is active, max_candidates = Phase1B output size.
    # For longer/harder cases we keep a much larger Phase-1B pool because
    # 1-pair scoring is a weak discriminator at 6+ plugboard pairs:
    #   80 chars  / 6 pairs → Phase1B rank ≈ 20k
    #  120 chars  / 8 pairs → Phase1B rank > 50k (essentially random)
    #  200 chars  /10 pairs → Phase1B rank > 100k
    # Light SA tier-1 then re-screens this larger pool down to tier2_n.
    if use_phase1b and top_n > 5000:
        if ct_len < 80:
            max_candidates = 2000
        elif ct_len < 130:
            max_candidates = 25000  # covers 80/6pb (rank ~20k)
        elif ct_len < 200:
            max_candidates = 50000  # 120/8pb is barely separable
        else:
            max_candidates = 50000  # 200/10pb — see Phase 1B-SA tier1
    else:
        max_candidates = max(max_candidates, top_n)

    return top_n, max_candidates, n_restarts, accuracy, tier2_n


def attack(ciphertext, language='auto', top_n=200, max_candidates=300,
           sample_len=100, top_results=5, accuracy=False,
           n_restarts=2, max_pairs=10, tier2_n=0, verbose=True):
    """
    完全な攻撃シーケンス。上位 top_results 個の候補を返す。

    accuracy=True で精度モード（時間無制限・二段階Phase 2）。
    短文では探索幅を自動拡大する。
    """
    ct_ints = text_to_ints(ciphertext)
    ct_len = len(ct_ints)
    if ct_len < 30:
        print('警告: 暗号文が30文字未満です。統計的解読は信頼できません。')

    top_n, max_candidates, n_restarts, accuracy, tier2_n = _auto_scale(
        ct_len, top_n, max_candidates, n_restarts, accuracy, tier2_n)

    candidates = phase1(ciphertext, top_n=top_n, sample_len=sample_len,
                        language=language, verbose=verbose)

    # Phase 1B: rerank large candidate lists using best-1-pair n-gram score.
    # For very long ciphertexts (≥200 chars) the SA-based Phase 1B is more
    # discriminating for 10+ plugboard pairs (it found the correct rank at
    # 36k vs IC's 291k for 200/10pb).
    if HAS_RUST and top_n > 5000:
        p1b_top_k = max_candidates
        p1b_sample = min(sample_len, ct_len)
        if ct_len >= 200:
            candidates = phase1b_sa_rerank(
                ciphertext, candidates, language=language,
                top_k=p1b_top_k, sample_len=p1b_sample,
                sa_steps=5000, t_start=12.0, t_end=0.5,
                max_pairs=max_pairs, verbose=verbose)
        else:
            candidates = phase1b_rerank(
                ciphertext, candidates, language=language,
                top_k=p1b_top_k, sample_len=p1b_sample, verbose=verbose)

    results = phase2(ciphertext, candidates, language=language,
                     max_candidates=max_candidates,
                     top_results=top_results,
                     accuracy=accuracy, n_restarts=n_restarts,
                     max_pairs=max_pairs, tier2_n=tier2_n, verbose=verbose)
    results = refine_rings(ciphertext, results,
                           accuracy=accuracy, verbose=verbose)
    return results


def format_plugboard(pb):
    pairs = []
    seen = set()
    for i in range(26):
        if pb[i] != i and i not in seen:
            pairs.append(chr(i + 65) + chr(pb[i] + 65))
            seen.add(i)
            seen.add(pb[i])
    return ' '.join(pairs) if pairs else '(none)'


def format_result(result):
    score, rotors, positions, rings, pb, lang, text = result
    pos_str = ''.join(chr(p + 65) for p in positions)
    ring_str = ''.join(chr(r + 65) for r in rings)
    return (
        f'Score:     {score:+.4f} ({lang})\n'
        f'Rotors:    {" ".join(rotors)} (reflector B)\n'
        f'Positions: {pos_str}\n'
        f'Rings:     {ring_str}\n'
        f'Plugboard: {format_plugboard(pb)}\n'
        f'Plaintext: {text}\n'
    )
