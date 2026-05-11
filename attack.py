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
    各上位候補について、リング設定を再探索。
    通常モード: 右ローターのみ（26通り）。
    精度モード: 中・右両方（26x26 = 676通り）。
    リング変更時は初期位置も同じだけシフトする必要がある。
    """
    ct_ints = text_to_ints(ciphertext)
    if verbose:
        n_trials = 26 * 26 if accuracy else 26
        print(f'[Refine] testing {n_trials} ring settings '
              f'for {len(results)} candidates')
    refined = []
    for result in results:
        score, rotors, positions, rings, pb, lang, _ = result
        best = result
        if accuracy:
            for rm in range(26):
                for rr in range(26):
                    new_rings = (rings[0], rm, rr)
                    new_positions = (
                        positions[0],
                        (positions[1] + rm) % 26,
                        (positions[2] + rr) % 26,
                    )
                    decrypted = decrypt_with_settings(
                        ct_ints, rotors, 'B', new_rings, new_positions, pb)
                    text = ints_to_text(decrypted)
                    lang2, score2 = best_language_score(text)
                    if score2 > best[0]:
                        best = (score2, rotors, new_positions, new_rings,
                                pb, lang2, text)
        else:
            for r in range(26):
                new_rings = (rings[0], rings[1], r)
                new_positions = (positions[0], positions[1],
                                 (positions[2] + r) % 26)
                decrypted = decrypt_with_settings(
                    ct_ints, rotors, 'B', new_rings, new_positions, pb)
                text = ints_to_text(decrypted)
                lang2, score2 = best_language_score(text)
                if score2 > best[0]:
                    best = (score2, rotors, new_positions, new_rings,
                            pb, lang2, text)
        refined.append(best)
    refined.sort(reverse=True, key=lambda r: r[0])
    return refined


# 既存名で互換性維持
refine_right_ring = refine_rings


def attack(ciphertext, language='auto', top_n=200, max_candidates=80,
           sample_len=100, top_results=5, accuracy=False,
           n_restarts=3, max_pairs=10, tier2_n=300, verbose=True):
    """
    完全な攻撃シーケンス。上位 top_results 個の候補を返す。

    accuracy=True で精度モード（時間無制限・二段階Phase 2）。
    """
    ct_ints = text_to_ints(ciphertext)
    if len(ct_ints) < 30:
        print('警告: 暗号文が30文字未満です。統計的解読は信頼できません。')

    candidates = phase1(ciphertext, top_n=top_n, sample_len=sample_len,
                        language=language, verbose=verbose)
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
