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


def run_attack(ciphertext, language='auto', top_n=200, max_candidates=80,
               sample_len=100):
    """攻撃を実行して上位候補を表示する。"""
    cleaned_count = sum(1 for c in ciphertext.upper() if 'A' <= c <= 'Z')
    print()
    print(f'文字数: {cleaned_count}')
    print(f'言語: {language}')
    if cleaned_count < 30:
        print('警告: 30文字未満では復号は信頼できません。')
    elif cleaned_count < 100:
        print('注意: 100文字未満では複数の候補から目視で選ぶ必要があります。')
    print('（復号には1〜3分ほどかかります。お待ちください...）')
    print('=' * 60)

    results = attack(ciphertext, language=language,
                     top_n=top_n, max_candidates=max_candidates,
                     sample_len=sample_len, top_results=5, verbose=True)

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


def main():
    p = argparse.ArgumentParser(
        description='エニグマ暗号文単独攻撃（Gillogly法）')
    p.add_argument('ciphertext', nargs='?',
                   help='復号する暗号文（A-Zのみ。空白等は無視）')
    p.add_argument('--lang', choices=['english', 'romaji', 'auto'],
                   default='auto', help='平文言語の指定')
    p.add_argument('--top', type=int, default=200,
                   help='Phase 1 で残す候補数 (default: 200)')
    p.add_argument('--max-cand', type=int, default=80,
                   help='Phase 2 で精査する候補数 (default: 80)')
    p.add_argument('--sample', type=int, default=100,
                   help='Phase 1 で使う暗号文先頭の文字数 (default: 100)')
    p.add_argument('--quick', action='store_true',
                   help='高速モード（top=80, max-cand=20）')
    p.add_argument('--selftest', action='store_true',
                   help='既知平文で動作確認')
    args = p.parse_args()

    if args.selftest:
        selftest()
        return

    # 引数で暗号文が渡されていなければ対話モード
    ciphertext = args.ciphertext
    if not ciphertext:
        ciphertext = prompt_ciphertext()
        if not ciphertext:
            print('暗号文が入力されませんでした。終了します。')
            return

    if args.quick:
        args.top = 80
        args.max_cand = 20

    run_attack(ciphertext,
               language=args.lang,
               top_n=args.top,
               max_candidates=args.max_cand,
               sample_len=args.sample)


if __name__ == '__main__':
    main()
