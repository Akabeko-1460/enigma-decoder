"""
コマンドラインエントリポイント。

使い方:
    python decrypt.py                          # 対話モード（ターミナルで暗号文を入力）
    python decrypt.py <ciphertext>             # 暗号文を引数で渡す
    python decrypt.py --lang english <ct>      # 英語と仮定
    python decrypt.py --lang romaji  <ct>      # ローマ字と仮定
    python decrypt.py --selftest               # 既知平文での動作確認
    python decrypt.py --quick <ct>             # 高速モード（精度低）

VSCodeで実行ボタン (▷) を押すと対話モードで起動します。

短文の現実的な限界:
    - 200文字以上 : 安定して解読可能
    - 100-200文字 : 解読可能だが上位候補を確認すべき
    - 50-100文字  : 運次第。複数のもっともらしい復号が出る
    - 50文字未満  : 統計的に信頼できない
"""

import argparse
import sys

from enigma import Enigma
from attack import attack, format_result


def selftest():
    """既知の平文を暗号化して攻撃で復号できるか確認。"""
    print('=' * 60)
    print('セルフテスト: 既知平文を暗号化 → 攻撃で復号')
    print('=' * 60)

    # 200文字程度の英語平文（友人からのメッセージを想定）
    plaintext = (
        'HELLOMYFRIENDIHOPEYOUAREDOINGWELLTODAYIWASTHINKINGABOUT'
        'OURCONVERSATIONFROMLASTWEEKABOUTTHENEWPROJECTANDIWANTED'
        'TOSHAREAFEWMORETHOUGHTSWITHYOUWHENYOUHAVETIMETOREADTHIS'
        'PLEASELETMEKNOWWHATYOUTHINK'
    )

    # カジュアル使用想定の設定（プラグボード2ペア）
    rotors = ('II', 'IV', 'V')
    rings = (0, 0, 0)
    positions = (3, 14, 9)
    plugboard = 'AB CD'
    enc = Enigma(rotors, 'B', rings, positions, plugboard)
    ciphertext = enc.encrypt(plaintext)

    print(f'真の設定: rotors={rotors} positions={positions} '
          f'plugboard="{plugboard}"')
    print(f'平文長: {len(plaintext)}')
    print(f'暗号文: {ciphertext[:60]}...')
    print()

    results = attack(ciphertext, language='english',
                     top_n=200, max_candidates=50,
                     top_results=3, verbose=True)
    print()
    print('=' * 60)
    print(f'上位 {len(results)} 候補:')
    print('=' * 60)
    for i, r in enumerate(results):
        print(f'\n--- 候補 {i+1} ---')
        print(format_result(r))

    score, rotors_g, positions_g, rings_g, pb_g, lang, text = results[0]
    if text == plaintext:
        print('[PASS] 完全一致で復号成功')
    else:
        matches = sum(1 for a, b in zip(text, plaintext) if a == b)
        print(f'[INFO] 第1候補一致率 {matches}/{len(plaintext)} = '
              f'{100*matches/len(plaintext):.1f}%')


def prompt_ciphertext():
    """ターミナルから暗号文を入力させる。"""
    print('=' * 60)
    print('  エニグマ暗号文単独復号ツール')
    print('=' * 60)
    print('復号したい暗号文を入力して Enter を押してください。')
    print('（A-Z以外の文字は自動的に無視されるので、空白や改行があっても OK）')
    print('（中止する場合は何も入力せずに Enter）')
    print()
    try:
        text = input('暗号文 > ').strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None
    return text if text else None


def prompt_language():
    """平文言語の選択を尋ねる。"""
    print()
    print('平文の言語を選んでください:')
    print('  [1] auto     自動判定（英語かローマ字を内部でスコアして高い方を採用）')
    print('  [2] english  英文')
    print('  [3] romaji   ローマ字日本語')
    while True:
        try:
            choice = input('言語 [1-3, デフォルト 1] > ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 'auto'
        if choice == '' or choice == '1':
            return 'auto'
        if choice == '2' or choice.lower() in ('english', 'en'):
            return 'english'
        if choice == '3' or choice.lower() in ('romaji', 'ja', 'jp'):
            return 'romaji'
        print('  → 1, 2, 3 のいずれかを入力してください。')


def prompt_mode(text_len):
    """探索モードの選択を尋ねる。"""
    print()
    print('探索モードを選んでください:')
    print('  [1] 通常モード  約1〜3分。0〜2ペアのプラグボードなら十分。')
    print('  [2] 精度モード  約10〜30分。短文・多めプラグボードでも追跡。')
    print('  [3] 徹底モード  数時間。極端な条件でも諦めない（時間無制限）。')
    while True:
        try:
            choice = input('モード [1-3, デフォルト 1] > ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 'normal'
        if choice == '' or choice == '1':
            return 'normal'
        if choice == '2':
            return 'accuracy'
        if choice == '3':
            return 'thorough'
        print('  → 1, 2, 3 のいずれかを入力してください。')


# モード別のパラメータ（ベースライン。短文では run_attack() が動的に上書きする）
MODE_PARAMS = {
    'normal':    dict(top_n=200,   max_candidates=300,   tier2_n=0,    accuracy=False, n_restarts=2, sample_len=100),
    'accuracy':  dict(top_n=3000,  max_candidates=3000,  tier2_n=300,  accuracy=True,  n_restarts=3, sample_len=200),
    'thorough':  dict(top_n=20000, max_candidates=20000, tier2_n=800,  accuracy=True,  n_restarts=5, sample_len=300),
}


def _scale_params_for_length(params, cleaned_count, mode):
    """
    短文では IC 分散が大きく正解候補が top_n の外に落ちやすいため、
    文字数に応じて探索幅を動的に拡大する。
    n=60 のとき正解のランクは平均 ~500 (IC のみ) → top_n ≥ 2000 が必要。
    """
    p = dict(params)
    n = cleaned_count

    if mode == 'normal':
        if n < 80:
            p['top_n']          = max(p['top_n'], 4000)
            p['max_candidates'] = max(p['max_candidates'], 800)
            p['n_restarts']     = max(p['n_restarts'], 4)
            p['accuracy']       = True
            p['tier2_n']        = max(p.get('tier2_n', 0), 200)
        elif n < 130:
            p['top_n']          = max(p['top_n'], 2000)
            p['max_candidates'] = max(p['max_candidates'], 500)
            p['n_restarts']     = max(p['n_restarts'], 3)
            p['accuracy']       = True
            p['tier2_n']        = max(p.get('tier2_n', 0), 150)
        elif n < 200:
            p['top_n']          = max(p['top_n'], 800)
            p['max_candidates'] = max(p['max_candidates'], 400)
            p['n_restarts']     = max(p['n_restarts'], 2)
    elif mode == 'accuracy':
        if n < 80:
            p['top_n']          = max(p['top_n'], 8000)
            p['max_candidates'] = max(p['max_candidates'], 8000)
            p['n_restarts']     = max(p['n_restarts'], 5)
        elif n < 130:
            p['top_n']          = max(p['top_n'], 5000)
            p['max_candidates'] = max(p['max_candidates'], 5000)
            p['n_restarts']     = max(p['n_restarts'], 4)

    return p


def run_attack(ciphertext, language='auto', mode='normal'):
    """攻撃を実行して上位候補を表示する。"""
    cleaned_count = sum(1 for c in ciphertext.upper() if 'A' <= c <= 'Z')
    params = _scale_params_for_length(MODE_PARAMS[mode], cleaned_count, mode)
    # sample_len は暗号文長で頭打ち
    params['sample_len'] = min(params['sample_len'], cleaned_count)

    print()
    print(f'文字数: {cleaned_count}')
    print(f'言語: {language}')
    print(f'モード: {mode}')
    if cleaned_count < 30:
        print('警告: 30文字未満では復号は信頼できません。')
    elif cleaned_count < 80 and mode == 'normal':
        print('注意: 80文字未満のため探索幅を自動拡大しました（通常より遅くなります）。')

    estimated = {
        'normal':    '1〜3分',
        'accuracy':  '10〜30分',
        'thorough':  '数時間（暗号文長と PC の性能による）',
    }
    print(f'（推定時間: {estimated[mode]}。途中で止めるには Ctrl+C）')
    print('=' * 60)

    results = attack(ciphertext, language=language,
                     top_n=params['top_n'],
                     max_candidates=params['max_candidates'],
                     sample_len=params['sample_len'],
                     accuracy=params['accuracy'],
                     n_restarts=params['n_restarts'],
                     tier2_n=params['tier2_n'],
                     top_results=5, verbose=True)

    print()
    print('=' * 60)
    print(f'  上位 {len(results)} 候補')
    print('=' * 60)
    for i, r in enumerate(results):
        print(f'\n--- 候補 {i+1} ---')
        print(format_result(r))

    # スコア差で信頼度を簡易評価
    if len(results) >= 2:
        gap = results[0][0] - results[1][0]
        if gap > 0.5:
            print('[INFO] スコア差が大きいので第1候補がほぼ確実に正解です。')
        elif gap > 0.2:
            print('[INFO] 第1候補が有力ですが、第2候補も念のため確認してください。')
        else:
            print('[INFO] スコア差が小さいです。複数候補を目視で確認してください。')
            if mode == 'normal':
                print('       精度モードでもう一度試すと改善される可能性があります。')


def main():
    p = argparse.ArgumentParser(
        description='エニグマ暗号文単独攻撃（Gillogly法 二段階）')
    p.add_argument('ciphertext', nargs='?',
                   help='復号する暗号文（A-Zのみ。空白等は無視）')
    p.add_argument('--lang', choices=['english', 'romaji', 'auto'],
                   default=None, help='平文言語の指定')
    p.add_argument('--mode', choices=['normal', 'accuracy', 'thorough'],
                   default=None, help='探索モード')
    p.add_argument('--accuracy', action='store_true',
                   help='精度モード（--mode accuracy と同じ）')
    p.add_argument('--thorough', action='store_true',
                   help='徹底モード（--mode thorough と同じ、時間無制限）')
    p.add_argument('--quick', action='store_true',
                   help='高速モード（通常モードよりさらに粗い）')
    p.add_argument('--selftest', action='store_true',
                   help='既知平文で動作確認')
    args = p.parse_args()

    if args.selftest:
        selftest()
        return

    # モードの解決
    if args.thorough:
        mode = 'thorough'
    elif args.accuracy:
        mode = 'accuracy'
    elif args.mode:
        mode = args.mode
    else:
        mode = None  # 後で対話で決める

    # 暗号文の取得
    ciphertext = args.ciphertext
    interactive = ciphertext is None
    if interactive:
        ciphertext = prompt_ciphertext()
        if not ciphertext:
            print('暗号文が入力されませんでした。終了します。')
            return

    # 言語の決定
    language = args.lang
    if language is None:
        if interactive:
            language = prompt_language()
        else:
            language = 'auto'

    # モードの決定
    if mode is None:
        if interactive:
            cleaned_count = sum(1 for c in ciphertext.upper() if 'A' <= c <= 'Z')
            mode = prompt_mode(cleaned_count)
        else:
            mode = 'normal'

    # --quick は通常モードのさらに高速版（後方互換）
    if args.quick:
        mode = 'normal'

    run_attack(ciphertext, language=language, mode=mode)


if __name__ == '__main__':
    main()
