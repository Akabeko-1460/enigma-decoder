"""
プラグボード未知エニグマ解読ツール（最高精度・段階スコア版）。

プラグボード設定が分からない状態から、暗号文単独でエニグマ M3 の全設定
（ローター・位置・リング・プラグボード）を復元する。

文献 (Ostwald & Weierud 2017, "Modern breaking of Enigma ciphertexts") の
三段階スコアエスカレーションを実装した最高精度版。

    Phase A  ローター順＋初期位置 … IC + bigram-IC で全探索（プラグボード不変性を利用）
    Phase C  プラグボード復元      … IC → bigram → trigram の三段階山登り
                                     ＋マルチスタート＋SA 磨き上げ（Rust/Rayon 並列）
    Phase B  リング設定            … 右→中ローターのリングを再探索
    Phase D  最終検証              … n-gram＋単語リスト照合で候補確定

なぜ段階スコアが効くのか:
    プラグボードが数本しか合っていない段階では復号文はまだランダムに近く、
    trigram/quadgram はノイズだらけで正しい方向を示せない。この段階では
    頑健な IC/bigram の方が信号が強い。プラグが増えて文が復元されるにつれ、
    より高次の n-gram に切り替えると識別力が最大化される。

探索の広さは3モードから選べる（MODE_PARAMS 参照）。
    normal   … 速いが粗い。長文向け
    accuracy … 既定。短文でも探索幅を自動拡大する
    thorough … 最大探索。極短文・多プラグ向けだが非常に遅い

使い方:
    python decrypt_plugboard.py                 # 対話モード（暗号文とモードを尋ねる）
    python decrypt_plugboard.py <ciphertext>
    python decrypt_plugboard.py --lang english <ct>
    python decrypt_plugboard.py --mode normal <ct>
    python decrypt_plugboard.py --thorough <ct>
    python decrypt_plugboard.py --selftest
"""

import argparse
import time
from itertools import permutations

try:
    import enigma_decoder as _ed
    HAS_RUST = hasattr(_ed, 'phase2_staged')
except ImportError:
    HAS_RUST = False

from enigma import Enigma, decrypt_with_settings
from scoring import english_model, romaji_model, best_language_score_short
from attack import (text_to_ints, ints_to_text, format_result,
                    phase1, refine_rings,
                    hill_climb_plugboard_multi)

ROTOR_NAMES = ['I', 'II', 'III', 'IV', 'V']
_ROTOR_IDX = {n: i for i, n in enumerate(ROTOR_NAMES)}

# 探索モード。decrypt.py の MODE_PARAMS と同じ語彙（normal/accuracy/thorough）。
#   top_n           Phase A で保持するローター×位置の候補数
#   max_candidates  Phase C で段階スコア山登りにかける候補数（支配的なコスト）
#   n_restarts      山登りのマルチスタート回数
#   sa_steps        SA 磨き上げのステップ数（Rust 版のみ）
#   refine_accuracy Phase B のリング探索を 676 通り（True）か 26 通り（False）か
#   width_scale     短文で探索幅を自動拡大する際の倍率（後述の _scale_params_for_length）
MODE_PARAMS = {
    'normal':   dict(top_n=200,  max_candidates=60,  n_restarts=2,
                     sa_steps=15000,  refine_accuracy=False, width_scale=0.3),
    'accuracy': dict(top_n=200,  max_candidates=200, n_restarts=4,
                     sa_steps=40000,  refine_accuracy=True,  width_scale=1.0),
    'thorough': dict(top_n=2000, max_candidates=600, n_restarts=8,
                     sa_steps=120000, refine_accuracy=True,  width_scale=3.0),
}
DEFAULT_MODE = 'accuracy'

MODE_LABELS = {
    'normal':   ('通常', '目安 5〜30 秒。長文（150字以上）・少なめプラグボード向け。'),
    'accuracy': ('精度', '目安 20〜90 秒。既定。短文でも探索幅を自動拡大する。'),
    'thorough': ('徹底', '目安 5〜30 分。極短文・多プラグ向け。Web からは非推奨。'),
}


def _scale_params_for_length(params, ct_len):
    """
    短文では正解が Phase A の上位から落ちやすいので探索幅を広げる。

    拡大幅はモードの width_scale に比例させる。こうすると「通常モードを
    選んだのに徹底モード並みに遅くなる」ということが起きない。
    """
    scaled = dict(params)
    width_scale = scaled.pop('width_scale')
    if ct_len < 80:
        floor_top_n, floor_candidates, floor_restarts = 3000, 300, 6
    elif ct_len < 150:
        floor_top_n, floor_candidates, floor_restarts = 1000, 200, 4
    else:
        return scaled

    scaled['top_n'] = max(scaled['top_n'], int(floor_top_n * width_scale))
    scaled['max_candidates'] = max(scaled['max_candidates'],
                                   int(floor_candidates * width_scale))
    # 再スタート回数だけは width_scale を掛けない。徹底モードで 8→18 のように
    # 跳ね上がると所要時間が桁で変わってしまうため、下限としてのみ使う。
    scaled['n_restarts'] = max(scaled['n_restarts'], floor_restarts)
    return scaled


def phase2_staged_rust(ciphertext, candidates, language='auto',
                       max_candidates=200, max_pairs=10, n_restarts=4,
                       sa_steps=40000, t_start=12.0, t_end=0.3, verbose=True):
    """
    三段階スコア（IC→bigram→trigram）プラグボード復元の Rust + Rayon 並列版。

    candidates: [(ic_score, rotors, positions), ...]（phase1 の出力）
    戻り値: [(score, rotors, positions, rings(0,0,0), pb_array, lang, text), ...]
    """
    ct_ints = text_to_ints(ciphertext)
    n = min(len(candidates), max_candidates)
    en = english_model()
    ja = romaji_model()
    use_en = language in ('auto', 'english')
    use_ja = language in ('auto', 'romaji')

    rust_cands = [([_ROTOR_IDX[r] for r in c[1]], list(c[2])) for c in candidates[:n]]

    t0 = time.time()
    if verbose:
        print(f'[Phase C] 段階スコア山登り(IC→bigram→trigram) on {n} candidates '
              f'[Rust+Rayon 並列]')
        print(f'          max_pairs={max_pairs} restarts={n_restarts} '
              f'sa_steps={sa_steps} t={t_start}→{t_end}')

    raw = _ed.phase2_staged(
        ct_ints, rust_cands, 0, use_en, use_ja,
        en.bi_array, en.bi_floor, ja.bi_array, ja.bi_floor,
        en.tri_array, en.tri_floor, en.quad_array, en.quad_floor,
        ja.tri_array, ja.tri_floor, ja.quad_array, ja.quad_floor,
        max_pairs, n_restarts, sa_steps, t_start, t_end,
    )

    results = []
    for score, r_idx, p_idx, pb in raw:
        rotors = (ROTOR_NAMES[r_idx[0]], ROTOR_NAMES[r_idx[1]], ROTOR_NAMES[r_idx[2]])
        pos = (p_idx[0], p_idx[1], p_idx[2])
        dec = decrypt_with_settings(ct_ints, rotors, 'B', (0, 0, 0), pos, list(pb))
        text = ints_to_text(dec)
        lang, final = best_language_score_short(text)
        results.append((final, rotors, pos, (0, 0, 0), list(pb), lang, text))

    if verbose:
        print(f'[Phase C] 完了 ({time.time()-t0:.1f}s)')
    results.sort(reverse=True, key=lambda r: r[0])
    return results


def phase2_staged_python(ciphertext, candidates, language='auto',
                         max_candidates=60, max_pairs=10, n_restarts=3,
                         verbose=True):
    """
    Rust が無い環境向けの純Pythonフォールバック。

    段階スコアは実装せず、既存の完全山登り（マルチスタート）を trigram で回す。
    結果の精度は Rust 版よりやや劣るが動作は保証される。
    """
    ct_ints = text_to_ints(ciphertext)
    n = min(len(candidates), max_candidates)
    en = english_model()
    ja = romaji_model()
    scorers = []
    if language in ('auto', 'english'):
        scorers.append(en)
    if language in ('auto', 'romaji'):
        scorers.append(ja)

    if verbose:
        print(f'[Phase C] マルチスタート山登り on {n} candidates [純Python]')

    results = []
    t0 = time.time()
    for ic, rotors, positions in candidates[:n]:
        for scorer in scorers:
            pb, _ = hill_climb_plugboard_multi(
                ct_ints, rotors, 'B', (0, 0, 0), positions,
                scorer, max_pairs=max_pairs, n_restarts=n_restarts)
            dec = decrypt_with_settings(ct_ints, rotors, 'B', (0, 0, 0), positions, pb)
            text = ints_to_text(dec)
            lang, score = best_language_score_short(text)
            results.append((score, rotors, positions, (0, 0, 0), pb, lang, text))

    if verbose:
        print(f'[Phase C] 完了 ({time.time()-t0:.1f}s)')
    results.sort(reverse=True, key=lambda r: r[0])
    return results


def _dedupe(results, top_results):
    """同一復号文を除去して上位 top_results 件を返す。"""
    seen = set()
    unique = []
    for r in results:
        if r[6] not in seen:
            seen.add(r[6])
            unique.append(r)
            if len(unique) >= top_results:
                break
    return unique


def attack_plugboard(ciphertext, language='auto', mode=DEFAULT_MODE,
                     top_results=5, sample_len=None, max_pairs=10,
                     top_n=None, max_candidates=None, n_restarts=None,
                     sa_steps=None, refine_accuracy=None, verbose=True):
    """
    プラグボード未知の完全解読シーケンス。上位 top_results 候補を返す。

    mode で探索の広さ（＝精度と所要時間のトレードオフ）を選ぶ。
    個別パラメータを明示すればモードの既定値を上書きできる。

    Phase A: phase1 で IC ベースにローター・位置を全探索（既存 attack.phase1）
    Phase C: 三段階スコアでプラグボードを復元
    Phase B: リング設定を再探索（既存 attack.refine_rings）
    Phase D: 単語リスト照合込みで最終スコア
    """
    if mode not in MODE_PARAMS:
        raise ValueError(f'unknown mode: {mode} (expected one of {list(MODE_PARAMS)})')

    ct_ints = text_to_ints(ciphertext)
    ct_len = len(ct_ints)
    if ct_len < 30:
        print('警告: 暗号文が30文字未満です。統計的解読は信頼できません。')
    if sample_len is None:
        sample_len = min(200, ct_len)

    params = _scale_params_for_length(MODE_PARAMS[mode], ct_len)
    overrides = dict(top_n=top_n, max_candidates=max_candidates,
                     n_restarts=n_restarts, sa_steps=sa_steps,
                     refine_accuracy=refine_accuracy)
    params.update({k: v for k, v in overrides.items() if v is not None})

    # --- Phase A: ローター順＋初期位置 ---
    candidates = phase1(ciphertext, top_n=params['top_n'], sample_len=sample_len,
                        language=language, verbose=verbose)

    # --- Phase C: プラグボード復元（段階スコア） ---
    if HAS_RUST:
        results = phase2_staged_rust(
            ciphertext, candidates, language=language,
            max_candidates=params['max_candidates'], max_pairs=max_pairs,
            n_restarts=params['n_restarts'], sa_steps=params['sa_steps'],
            verbose=verbose)
    else:
        results = phase2_staged_python(
            ciphertext, candidates, language=language,
            max_candidates=min(params['max_candidates'], 60), max_pairs=max_pairs,
            n_restarts=params['n_restarts'], verbose=verbose)

    results = _dedupe(results, top_results)

    # --- Phase B: リング設定の再探索（既存の refine を流用） ---
    results = refine_rings(ciphertext, results,
                           accuracy=params['refine_accuracy'], verbose=verbose)
    results = _dedupe(results, top_results)
    return results


def selftest(mode=DEFAULT_MODE):
    """既知平文を暗号化し、プラグボードを含む全設定を復元できるか確認。"""
    print('=' * 60)
    print('  セルフテスト: プラグボード未知からの完全解読')
    print(f'  モード: {MODE_LABELS[mode][0]}')
    print(f'  Rust/Rayon: {"有効" if HAS_RUST else "無効（純Python）"}')
    print('=' * 60)

    plaintext = (
        'THEENEMYFLEETHASBEENSPOTTEDNEARTHENORTHERNCOASTWEMUST'
        'PREPAREOURDEFENSESIMMEDIATELYANDSENDWORDTOHEADQUARTERS'
        'BEFOREDAWNTOMORROWALLUNITSSHOULDREMAINONHIGHALERT')
    rotors = ('II', 'V', 'III')
    positions = (7, 20, 11)
    plugboard = 'AB CD EF GH IJ KL'   # 6ペア
    enc = Enigma(rotors, 'B', (0, 0, 0), positions, plugboard)
    ct = enc.encrypt(plaintext)

    print(f'真の設定: rotors={rotors} pos={positions} plugboard="{plugboard}"')
    print(f'平文長: {len(plaintext)}  プラグボード: 6ペア')
    print(f'暗号文: {ct[:60]}...')
    print()

    t0 = time.time()
    results = attack_plugboard(ct, language='english', mode=mode,
                               top_results=3, verbose=True)
    el = time.time() - t0

    print()
    print('=' * 60)
    for i, r in enumerate(results):
        print(f'\n--- 候補 {i+1} ---')
        print(format_result(r))

    best = results[0]
    if best[6] == plaintext:
        print(f'[PASS] 完全一致で解読成功 ({el:.1f}s)')
    else:
        cm = sum(a == b for a, b in zip(best[6], plaintext))
        print(f'[INFO] 第1候補一致率 {cm}/{len(plaintext)} = '
              f'{100*cm/len(plaintext):.1f}%  ({el:.1f}s)')


def prompt_mode():
    """対話モードで探索モードを選ばせる。"""
    modes = list(MODE_PARAMS)
    print()
    print('探索モードを選んでください（精度と所要時間のトレードオフ）:')
    for number, mode in enumerate(modes, start=1):
        label, desc = MODE_LABELS[mode]
        default_mark = '  ← 既定' if mode == DEFAULT_MODE else ''
        print(f'  [{number}] {label}モード  {desc}{default_mark}')
    try:
        choice = input(f'選択 (1-{len(modes)}, 空欄で既定) > ').strip()
    except (EOFError, KeyboardInterrupt):
        return DEFAULT_MODE
    by_number = {str(i): m for i, m in enumerate(modes, start=1)}
    return by_number.get(choice, DEFAULT_MODE)


def run_attack(ciphertext, language='auto', mode=DEFAULT_MODE):
    cleaned = sum(1 for c in ciphertext.upper() if 'A' <= c <= 'Z')
    label, desc = MODE_LABELS[mode]
    print()
    print(f'文字数: {cleaned}  言語: {language}  モード: {label}  '
          f'Rust: {"有効" if HAS_RUST else "無効"}')
    print(f'（{desc} 途中で止めるには Ctrl+C）')
    if not HAS_RUST:
        print('注意: Rust コアが無効なため、目安時間より大幅に遅くなります。')
    print('=' * 60)
    results = attack_plugboard(ciphertext, language=language, mode=mode,
                               top_results=5, verbose=True)
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
            print('[INFO] スコア差が大きく第1候補がほぼ確実に正解です。')
        elif gap > 0.2:
            print('[INFO] 第1候補が有力です。')
        else:
            print('[INFO] スコア差が小さいです。複数候補を目視確認してください。')


def main():
    p = argparse.ArgumentParser(
        description='エニグマ プラグボード未知 暗号文単独攻撃（段階スコア・精度3モード）')
    p.add_argument('ciphertext', nargs='?',
                   help='復号する暗号文（A-Zのみ。空白等は無視）')
    p.add_argument('--lang', choices=['english', 'romaji', 'auto'], default=None)
    p.add_argument('--mode', choices=list(MODE_PARAMS), default=None,
                   help=f'探索モード（既定 {DEFAULT_MODE}）')
    p.add_argument('--normal', action='store_true',
                   help='通常モード（--mode normal と同じ、速いが粗い）')
    p.add_argument('--thorough', action='store_true',
                   help='徹底モード（--mode thorough と同じ、非常に遅い）')
    p.add_argument('--selftest', action='store_true', help='既知平文で動作確認')
    args = p.parse_args()

    if args.thorough:
        mode = 'thorough'
    elif args.normal:
        mode = 'normal'
    else:
        mode = args.mode  # None なら後で対話または既定で決める

    if args.selftest:
        selftest(mode or DEFAULT_MODE)
        return

    ciphertext = args.ciphertext
    interactive = ciphertext is None
    if interactive:
        print('=' * 60)
        print('  エニグマ解読ツール（プラグボード未知）')
        print('=' * 60)
        print('暗号文を入力して Enter を押してください。')
        try:
            ciphertext = input('暗号文 > ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not ciphertext:
            print('暗号文が入力されませんでした。終了します。')
            return

    if mode is None:
        mode = prompt_mode() if interactive else DEFAULT_MODE

    language = args.lang or 'auto'
    run_attack(ciphertext, language=language, mode=mode)


if __name__ == '__main__':
    main()
