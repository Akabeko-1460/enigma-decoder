"""
ブラウザ版解読機が読み込む言語データを web/public/data/ に書き出す。

Python が無いブラウザ側でも Python 版と同じ言語モデルを組めるように、
scoring.py が使っているデータをそのままの形で配る。

    python tools/build_web_assets.py

出力（すべて gzip）:
    web/public/data/ngrams_en.txt.gz    事前計算済み n-gram 頻度表（リポジトリ同梱物のコピー）
    web/public/data/romaji_corpus.txt.gz ローマ字コーパス（corpora.py 由来）
    web/public/data/wordlist_en.txt.gz   英単語リスト（wordlist_data.py 由来）

n-gram 表だけは既に gzip 済みのファイルがあるのでバイト単位でコピーする。
中身を作り直すと Python 版とスコアがずれる可能性があるため。
"""
import gzip
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

OUT_DIR = os.path.join(ROOT, 'web', 'public', 'data')
NGRAM_SRC = os.path.join(ROOT, 'ngrams_en.txt.gz')


def clean(text):
    """A-Z だけ抽出して大文字化（scoring.clean と同じ）。"""
    return ''.join(c for c in text.upper() if 'A' <= c <= 'Z')


def write_gzip(name, text):
    path = os.path.join(OUT_DIR, name)
    # mtime=0 で内容が同じなら毎回同じバイト列になる（無駄な差分を出さない）
    with gzip.GzipFile(path, 'wb', mtime=0) as f:
        f.write(text.encode('ascii'))
    return path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    if not os.path.exists(NGRAM_SRC):
        print(f'ERROR: {NGRAM_SRC} が見つかりません。', file=sys.stderr)
        return 1
    ngram_dst = os.path.join(OUT_DIR, 'ngrams_en.txt.gz')
    shutil.copyfile(NGRAM_SRC, ngram_dst)

    from corpora import ROMAJI_CORPUS
    romaji = clean(ROMAJI_CORPUS)
    if len(romaji) < 1000:
        print(f'ERROR: ローマ字コーパスが短すぎます ({len(romaji)} 文字)', file=sys.stderr)
        return 1
    romaji_dst = write_gzip('romaji_corpus.txt.gz', romaji)

    from wordlist_data import ENGLISH_WORDS
    words = sorted(ENGLISH_WORDS)
    words_dst = write_gzip('wordlist_en.txt.gz', '\n'.join(words) + '\n')

    for path, note in ((ngram_dst, 'n-gram 頻度表'),
                       (romaji_dst, f'ローマ字コーパス {len(romaji)} 文字'),
                       (words_dst, f'英単語 {len(words)} 語')):
        size_kb = os.path.getsize(path) / 1024
        print(f'  {os.path.basename(path):24s} {size_kb:7.1f} KB  {note}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
