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
           rotor_choices=('I', 'II', 'III', 'IV', 'V'), verbose=True):
    """
    Phase 1: ローター順 × 初期位置を全探索。
    各設定でプラグボード無しの状態で復号し、両言語の trigram スコアの
    最大値でランク付けする（IC は短文＆多ペアプラグボードでは不十分）。
    sample_len 文字だけ復号して計算量を抑える。
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
              f'= {total} trials (trigram scoring)')

    results = []
    t0 = time.time()
    done = 0
    progress_step = max(1, total // 20)

    en_tri, en_floor = en.tri, en.tri_floor
    ja_tri, ja_floor = ja.tri, ja.tri_floor

    for rotors in perms:
        fwd, bwd, notches, refl = precompute_rotor_arrays(rotors, reflector)
        for p1, p2, p3 in product(range(26), repeat=3):
            decrypted = decrypt_fast(
                sample, fwd, bwd, notches, refl,
                (0, 0, 0), (p1, p2, p3), pb_id,
            )
            text = ''.join(chr(i + 65) for i in decrypted)
            # 両言語のtrigramスコアの最大値
            en_s = 0.0
            ja_s = 0.0
            for i in range(len(text) - 2):
                tg = text[i:i+3]
                en_s += en_tri.get(tg, en_floor)
                ja_s += ja_tri.get(tg, ja_floor)
            score = max(en_s, ja_s)
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


def hill_climb_plugboard(ct_ints, rotors, reflector, ring_settings,
                         positions, scorer, max_pairs=10):
    """
    プラグボードの山登り法。
    1ペアずつ追加し、追加後のスコアが最大になるペアを選ぶ。
    既存ペアの解除も含めて全 (a,b) 組合せを毎回試す。
    """
    pb = identity_plugboard()

    def decrypt_and_score(plugboard):
        out = decrypt_with_settings(ct_ints, rotors, reflector,
                                    ring_settings, positions, plugboard)
        return scorer.score_raw(ints_to_text(out))

    best_score = decrypt_and_score(pb)

    for _ in range(max_pairs):
        improved = False
        best_pair = None
        # 各 (a, b) ペアについてスコアを計算
        for a in range(26):
            for b in range(a + 1, 26):
                # 一時的にスワップ
                old_pa, old_pb = pb[a], pb[b]
                apply_plugboard_swap(pb, a, b)
                score = decrypt_and_score(pb)
                # 元に戻す
                pb[old_pa] = old_pa
                pb[old_pb] = old_pb
                pb[a] = a
                pb[b] = b
                if old_pa != a:
                    pb[a] = old_pa
                    pb[old_pa] = a
                if old_pb != b:
                    pb[b] = old_pb
                    pb[old_pb] = b
                # 改善ならメモ
                if score > best_score:
                    best_score = score
                    best_pair = (a, b)
                    improved = True
        if not improved:
            break
        # 確定: best_pair をスワップ
        apply_plugboard_swap(pb, *best_pair)

    return pb, best_score


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


def phase2(ciphertext, candidates, language='auto', max_candidates=80,
           top_results=5, verbose=True):
    """
    Phase 1 の上位候補それぞれに対してプラグボードを山登り。
    両言語のスコアラーで評価し、上位 top_results 個を返す。
    """
    ct_ints = text_to_ints(ciphertext)
    n = min(len(candidates), max_candidates)
    if verbose:
        print(f'[Phase 2] hill-climbing plugboard for top {n} candidates')

    en = english_model()
    ja = romaji_model()
    if language == 'english':
        scorers = [en]
    elif language == 'romaji':
        scorers = [ja]
    else:
        scorers = [en, ja]

    all_results = []  # [(final_score, rotors, positions, rings, pb, lang, text), ...]
    t0 = time.time()
    for idx, (ic, rotors, positions) in enumerate(candidates[:n]):
        for scorer in scorers:
            pb, _ = hill_climb_plugboard_fast(
                ct_ints, rotors, 'B',
                ring_settings=(0, 0, 0),
                positions=positions,
                scorer=scorer,
                max_pairs=8,
            )
            decrypted = decrypt_with_settings(
                ct_ints, rotors, 'B', (0, 0, 0), positions, pb)
            text = ints_to_text(decrypted)
            lang, score = best_language_score(text)
            all_results.append((score, rotors, positions, (0, 0, 0), pb, lang, text))
        if verbose and (idx + 1) % 10 == 0:
            best_so_far = max(all_results, key=lambda r: r[0])
            print(f'  {idx+1}/{n}  best so far: {best_so_far[0]:+.3f} '
                  f'({best_so_far[5]})  elapsed {time.time()-t0:.0f}s')

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


def refine_right_ring(ciphertext, results, verbose=True):
    """
    各上位候補について、右ローターのリング設定を 26 通り再探索。
    リング変更時は初期位置も同じだけシフトする必要がある。
    """
    ct_ints = text_to_ints(ciphertext)
    if verbose:
        print(f'[Refine] testing 26 right-rotor ring settings '
              f'for {len(results)} candidates')
    refined = []
    for result in results:
        score, rotors, positions, rings, pb, lang, _ = result
        best = result
        for r in range(26):
            new_rings = (rings[0], rings[1], r)
            new_positions = (positions[0], positions[1], (positions[2] + r) % 26)
            decrypted = decrypt_with_settings(
                ct_ints, rotors, 'B', new_rings, new_positions, pb)
            text = ints_to_text(decrypted)
            lang2, score2 = best_language_score(text)
            if score2 > best[0]:
                best = (score2, rotors, new_positions, new_rings, pb, lang2, text)
        refined.append(best)
    refined.sort(reverse=True, key=lambda r: r[0])
    return refined


def attack(ciphertext, language='auto', top_n=200, max_candidates=80,
           sample_len=100, top_results=5, verbose=True):
    """
    完全な攻撃シーケンス。上位 top_results 個の候補を返す。
    """
    ct_ints = text_to_ints(ciphertext)
    if len(ct_ints) < 30:
        print('警告: 暗号文が30文字未満です。統計的解読は信頼できません。')

    candidates = phase1(ciphertext, top_n=top_n, sample_len=sample_len,
                        verbose=verbose)
    results = phase2(ciphertext, candidates, language=language,
                     max_candidates=max_candidates,
                     top_results=top_results, verbose=verbose)
    results = refine_right_ring(ciphertext, results, verbose=verbose)
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
