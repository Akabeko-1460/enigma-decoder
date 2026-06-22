"""
プラグボード既知エニグマ解読ツール。

プラグボードの設定が事前に判明している場合に特化した解読機。
Phase 2（山登り法によるプラグボード推定）が不要になるため、
通常の暗号文単独攻撃と比べて大幅に高速・高精度。

使い方:
    python decrypt_known_plugboard.py             # 対話モード
    python decrypt_known_plugboard.py <ciphertext>
    python decrypt_known_plugboard.py --lang english <ct>
    python decrypt_known_plugboard.py --accuracy <ct>
    python decrypt_known_plugboard.py --selftest  # 動作確認

探索の仕組み:
    ローター選択（60通り）× 初期位置（26^3 ≈ 1万7千通り）≒ 105万通りを
    既知プラグボードで直接復号し、n-gram スコアで順位付けする。
    正しいプラグボードを最初から使えるため Phase 1 の段階で正解が
    圧倒的スコアで浮き上がり、Phase 2 なしで解読できる。

    通常モード（--accuracy なし）との比較:
        通常: Phase1（IC, ~100万試行）→ Phase2（山登り, 最大の計算コスト）
        本ツール: Phase1（n-gram, ~105万試行）→ 完了（Phase2 不要）
"""

import argparse
import time
from itertools import permutations, product

from enigma import (Enigma, precompute_rotor_arrays, decrypt_fast,
                    decrypt_with_settings)
from scoring import (english_model, romaji_model,
                     best_language_score, best_language_score_short,
                     word_fitness)
from attack import text_to_ints, ints_to_text, format_result

# ================================================================
# ハードコードされたプラグボード設定
# 解読対象の通信に使われた設定が判明している場合はここを変更してください。
#
# 書式: 'XY AB CD ...' のように大文字2文字のペアをスペース区切りで並べる。
#   例: 'AB CD EF'      A↔B, C↔D, E↔F の3ペア
#   例: 'QW ER TY UI'   4ペア
# ================================================================
KNOWN_PLUGBOARD = 'AB CD EF GH IJ'
# ================================================================


def parse_plugboard(s):
    """プラグボード文字列を int[26] の配列に変換する。"""
    pb = list(range(26))
    for pair in s.upper().split():
        if len(pair) == 2:
            a, b = ord(pair[0]) - 65, ord(pair[1]) - 65
            pb[a], pb[b] = b, a
    return pb


def phase1_known_plugboard(ciphertext, plugboard_array, reflector='B',
                           top_n=20, sample_len=200,
                           rotor_choices=('I', 'II', 'III', 'IV', 'V'),
                           language='auto', verbose=True):
    """
    プラグボード既知版 Phase 1。

    通常の Phase 1 はプラグボード無し（恒等変換）で IC スコアを使うが、
    プラグボードが既知の場合は正しいプラグボードで復号したうえで
    n-gram スコアを直接計算できる。これにより：
      - 正解候補のスコアが誤り候補より圧倒的に高くなる
      - top_n を小さく保っても正解候補を確実に捕捉できる
      - 後段の Phase 2（山登り）が不要になる

    戻り値: [(score, rotors, positions), ...] 上位 top_n 件
    """
    ct_ints = text_to_ints(ciphertext)
    sample = ct_ints[:sample_len]
    en = english_model()
    ja = romaji_model()

    perms = list(permutations(rotor_choices, 3))
    total = len(perms) * 26 ** 3
    if verbose:
        print(f'[Phase 1] {len(perms)} rotor perms × 17576 positions = {total} trials')
        print(f'          既知プラグボード適用 / lang={language} / sample={sample_len}')

    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    en_tri, en_floor = en.tri, en.tri_floor
    ja_tri, ja_floor = ja.tri, ja.tri_floor
    en_quad, en_qfloor = en.quad, en.quad_floor
    ja_quad, ja_qfloor = ja.quad, ja.quad_floor

    results = []
    t0 = time.time()
    done = 0
    progress_step = max(1, total // 20)

    for rotors in perms:
        fwd, bwd, notches, refl = precompute_rotor_arrays(rotors, reflector)
        for p1, p2, p3 in product(range(26), repeat=3):
            decrypted = decrypt_fast(
                sample, fwd, bwd, notches, refl,
                (0, 0, 0), (p1, p2, p3), plugboard_array,
            )
            text = ''.join(chr(i + 65) for i in decrypted)
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
                print(f'  {pct:5.1f}%  elapsed {elapsed:5.0f}s  ETA {eta:5.0f}s')

    results.sort(reverse=True, key=lambda x: x[0])
    if verbose:
        print(f'[Phase 1] 完了 ({time.time()-t0:.1f}s)')
        if results:
            r = results[0]
            print(f'  top score: {r[0]:.2f} (rotors={r[1]} pos={r[2]})')
    return results[:top_n]


def refine_rings_fixed_plugboard(ciphertext, results, plugboard_array,
                                 accuracy=False, verbose=True):
    """
    プラグボード固定でリング設定のみを再探索する。

    通常の refine_rings はリング探索後にプラグボードも再最適化するが、
    プラグボードが確定している場合はその必要がない。

    評価関数として best_language_score_short（n-gram + 単語リスト照合）を
    使用する。短文（40〜80字）では n-gram のノイズが大きく、実在英単語の
    有無を加味しないと正しいリング設定を選べない場合がある。
    """
    ct_ints = text_to_ints(ciphertext)
    n_trials = 26 * 26 if accuracy else 26
    if verbose:
        print(f'[Refine] {n_trials} ring settings × {len(results)} 候補'
              f'（プラグボード固定 / n-gram + 単語リスト照合）')

    refined = []
    for result in results:
        score, rotors, positions, rings, pb, lang, _ = result
        # 初期スコアも best_language_score_short で統一して比較する
        dec0 = decrypt_with_settings(ct_ints, rotors, 'B', rings, positions, plugboard_array)
        text0 = ints_to_text(dec0)
        lang0, s0 = best_language_score_short(text0)
        best = (s0, rotors, positions, rings, plugboard_array, lang0, text0)

        if accuracy:
            for rm in range(26):
                for rr in range(26):
                    nr = (rings[0], rm, rr)
                    np_ = (positions[0], (positions[1] + rm) % 26,
                           (positions[2] + rr) % 26)
                    dec = decrypt_with_settings(
                        ct_ints, rotors, 'B', nr, np_, plugboard_array)
                    text = ints_to_text(dec)
                    lang2, s2 = best_language_score_short(text)
                    if s2 > best[0]:
                        best = (s2, rotors, np_, nr, plugboard_array, lang2, text)
        else:
            for rr in range(26):
                nr = (rings[0], rings[1], rr)
                np_ = (positions[0], positions[1], (positions[2] + rr) % 26)
                dec = decrypt_with_settings(
                    ct_ints, rotors, 'B', nr, np_, plugboard_array)
                text = ints_to_text(dec)
                lang2, s2 = best_language_score_short(text)
                if s2 > best[0]:
                    best = (s2, rotors, np_, nr, plugboard_array, lang2, text)

        refined.append(best)

    refined.sort(reverse=True, key=lambda r: r[0])
    return refined


def attack_known_plugboard(ciphertext, plugboard_str=KNOWN_PLUGBOARD,
                           language='auto', top_n=20, sample_len=None,
                           top_results=5, accuracy=False, verbose=True):
    """
    プラグボード既知の完全解読シーケンス。上位 top_results 候補を返す。

    Phase 1: 既知プラグボードで全ローター×位置を n-gram スコア探索
    Phase 2: 不要（プラグボード確定済み）
    Refine:  リング設定のみ再探索
    """
    ct_ints = text_to_ints(ciphertext)
    ct_len = len(ct_ints)
    if ct_len < 20:
        print('警告: 暗号文が20文字未満です。統計的解読は信頼できません。')
    if sample_len is None:
        sample_len = min(200, ct_len)

    pb_array = parse_plugboard(plugboard_str)

    candidates = phase1_known_plugboard(
        ciphertext, pb_array,
        top_n=top_n, sample_len=sample_len,
        language=language, verbose=verbose,
    )

    # Phase 1 上位候補を結果フォーマット (score, rotors, pos, rings, pb, lang, text) に変換
    # best_language_score_short を使うことで短文でも正しい候補が上位に来やすくなる
    results = []
    for _p1_score, rotors, positions in candidates:
        dec = decrypt_with_settings(
            ct_ints, rotors, 'B', (0, 0, 0), positions, pb_array)
        text = ints_to_text(dec)
        lang, final_score = best_language_score_short(text)
        results.append((final_score, rotors, positions, (0, 0, 0),
                        pb_array, lang, text))

    results.sort(reverse=True, key=lambda r: r[0])
    results = results[:top_results]

    results = refine_rings_fixed_plugboard(
        ciphertext, results, pb_array, accuracy=accuracy, verbose=verbose)
    return results


def selftest():
    """既知平文を KNOWN_PLUGBOARD で暗号化し、正しく解読できるか確認。"""
    print('=' * 60)
    print('  セルフテスト: 既知プラグボードでの解読確認')
    print(f'  プラグボード: {KNOWN_PLUGBOARD}')
    print('=' * 60)

    plaintext = (
        'HELLOMYFRIENDIHOPEYOUAREDOINGWELLTODAYIWASTHINKINGABOUT'
        'OURCONVERSATIONFROMLASTWEEKABOUTTHENEWPROJECTANDIWANTED'
        'TOSHAREAFEWMORETHOUGHTSWITHYOUWHENYOUHAVETIMETOREADTHIS'
    )
    rotors = ('III', 'I', 'IV')
    positions = (7, 22, 3)
    rings = (0, 0, 0)

    enc = Enigma(rotors, 'B', rings, positions, KNOWN_PLUGBOARD)
    ciphertext = enc.encrypt(plaintext)

    print(f'真の設定: rotors={rotors}  positions={positions}')
    print(f'平文長: {len(plaintext)}')
    print(f'暗号文: {ciphertext[:60]}...')
    print()

    results = attack_known_plugboard(
        ciphertext, plugboard_str=KNOWN_PLUGBOARD,
        language='english', top_n=20, top_results=3, verbose=True)

    print()
    print('=' * 60)
    print(f'  上位 {len(results)} 候補')
    print('=' * 60)
    for i, r in enumerate(results):
        print(f'\n--- 候補 {i+1} ---')
        print(format_result(r))

    _score, _rotors, _pos, _rings, _pb, _lang, text = results[0]
    if text == plaintext:
        print('[PASS] 完全一致で解読成功')
    else:
        matches = sum(1 for a, b in zip(text, plaintext) if a == b)
        pct = 100 * matches / len(plaintext)
        print(f'[INFO] 第1候補一致率 {matches}/{len(plaintext)} = {pct:.1f}%')


def run_attack(ciphertext, language='auto', accuracy=False):
    """攻撃を実行し上位候補を表示する。"""
    cleaned_count = sum(1 for c in ciphertext.upper() if 'A' <= c <= 'Z')

    print()
    print(f'プラグボード: {KNOWN_PLUGBOARD}')
    print(f'文字数: {cleaned_count}')
    print(f'言語: {language}')
    print(f'モード: {"精度" if accuracy else "通常"}')
    if cleaned_count < 20:
        print('警告: 20文字未満では復号は信頼できません。')
    print('（推定時間: 1〜5分。途中で止めるには Ctrl+C）')
    print('=' * 60)

    results = attack_known_plugboard(
        ciphertext, plugboard_str=KNOWN_PLUGBOARD,
        language=language, top_n=20, top_results=5,
        accuracy=accuracy, verbose=True)

    print()
    print('=' * 60)
    print(f'  上位 {len(results)} 候補')
    print('=' * 60)
    for i, r in enumerate(results):
        print(f'\n--- 候補 {i+1} ---')
        print(format_result(r))

    if len(results) >= 2:
        gap = results[0][0] - results[1][0]
        if gap > 0.5:
            print('[INFO] スコア差が大きいので第1候補がほぼ確実に正解です。')
        elif gap > 0.2:
            print('[INFO] 第1候補が有力ですが、第2候補も念のため確認してください。')
        else:
            print('[INFO] スコア差が小さいです。複数候補を目視で確認してください。')


def main():
    p = argparse.ArgumentParser(
        description=(
            f'エニグマ解読（プラグボード既知版）  '
            f'ハードコード済みプラグボード: {KNOWN_PLUGBOARD}'
        )
    )
    p.add_argument('ciphertext', nargs='?',
                   help='復号する暗号文（A-Zのみ。空白等は無視）')
    p.add_argument('--lang', choices=['english', 'romaji', 'auto'],
                   default=None, help='平文言語の指定')
    p.add_argument('--accuracy', action='store_true',
                   help='精度モード（リング設定を 676 通り探索）')
    p.add_argument('--selftest', action='store_true',
                   help='既知平文で動作確認')
    args = p.parse_args()

    if args.selftest:
        selftest()
        return

    ciphertext = args.ciphertext
    interactive = ciphertext is None

    if interactive:
        print('=' * 60)
        print('  エニグマ解読ツール（プラグボード既知版）')
        print(f'  プラグボード: {KNOWN_PLUGBOARD}')
        print('=' * 60)
        print('暗号文を入力して Enter を押してください。')
        print('（A-Z以外の文字は自動的に無視されます）')
        print()
        try:
            ciphertext = input('暗号文 > ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not ciphertext:
            print('暗号文が入力されませんでした。終了します。')
            return

    language = args.lang
    if language is None:
        if interactive:
            print()
            print('平文の言語を選んでください:')
            print('  [1] auto     自動判定')
            print('  [2] english  英文')
            print('  [3] romaji   ローマ字日本語')
            while True:
                try:
                    choice = input('言語 [1-3, デフォルト 1] > ').strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    language = 'auto'
                    break
                if choice in ('', '1'):
                    language = 'auto'
                    break
                if choice == '2' or choice.lower() in ('english', 'en'):
                    language = 'english'
                    break
                if choice == '3' or choice.lower() in ('romaji', 'ja', 'jp'):
                    language = 'romaji'
                    break
                print('  → 1, 2, 3 のいずれかを入力してください。')
        else:
            language = 'auto'

    run_attack(ciphertext, language=language, accuracy=args.accuracy)


if __name__ == '__main__':
    main()
