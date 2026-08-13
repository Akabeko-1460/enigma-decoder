"""
WASM 移植の一致検証に使う「Python 側の正解値」を書き出す。

言語モデル（n-gram 表・単語照合・言語判定）は移植で最もずれやすい箇所なので、
固定テキストに対する best_language_score_short の値を基準として保存し、
Node 上の WASM が同じ値を返すかを web/scripts/verify-wasm.mjs で突き合わせる。

    python tools/emit_score_reference.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

OUT_PATH = os.path.join(ROOT, 'web', 'scripts', 'score-reference.json')

# 平文・部分的に崩れた文・ランダム文字列を混ぜ、スコアの大小関係まで見る
SAMPLE_TEXTS = [
    'THEENEMYFLEETHASBEENSPOTTEDNEARTHENORTHERNCOAST',
    'MEETMEATTHEOLDBRIDGEATDAWNBRINGTHEDOCUMENTS',
    'HELLOWORLDTHISISATEST',
    'WATASHIWANIHONJINDESUKYOUWAIITENKIDESUNE',
    'XQZWVKJYBPMHFCDLNRGTUSAOIEXQZWVKJYBPMHFCDLNRGTU',
    'THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG',
]


def main():
    from scoring import best_language_score_short, english_model, romaji_model

    en = english_model()
    ja = romaji_model()
    entries = []
    for text in SAMPLE_TEXTS:
        lang, score = best_language_score_short(text)
        entries.append({'text': text, 'lang': lang, 'score': score})

    payload = {
        'note': 'python tools/emit_score_reference.py で再生成',
        'englishFloors': {
            'bi': en.bi_floor, 'tri': en.tri_floor, 'quad': en.quad_floor,
        },
        'romajiFloors': {
            'bi': ja.bi_floor, 'tri': ja.tri_floor, 'quad': ja.quad_floor,
        },
        'scores': entries,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'wrote {OUT_PATH}')
    for e in entries:
        print(f"  {e['lang']:8s} {e['score']:+.6f}  {e['text'][:40]}")


if __name__ == '__main__':
    main()
