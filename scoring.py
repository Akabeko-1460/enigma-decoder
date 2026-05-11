"""
言語モデルとスコアリング。

組み込みコーパスから bigram, trigram, quadgram の対数確率テーブルを
構築する。短文向けには quadgram よりも trigram + bigram の重み付き
スコアの方が信号が強いことが多い。
"""

import math
from collections import Counter

from corpora import ENGLISH_CORPUS, ROMAJI_CORPUS


def clean(text):
    """A-Zだけ抽出して大文字化。"""
    return ''.join(c for c in text.upper() if 'A' <= c <= 'Z')


def build_ngram_logprobs(text, n):
    """テキストからn-gramの対数確率テーブルを作る。"""
    counts = Counter(text[i:i+n] for i in range(len(text) - n + 1))
    total = sum(counts.values())
    # 観測されない n-gram のフロア値（ラプラス的なスムージング）
    floor = math.log10(0.01 / total)
    table = {k: math.log10(v / total) for k, v in counts.items()}
    return table, floor


class LanguageModel:
    """ある言語の n-gram モデル一式。"""

    def __init__(self, name, corpus):
        self.name = name
        cleaned = clean(corpus)
        if len(cleaned) < 1000:
            raise ValueError(f'{name}: corpus too small ({len(cleaned)} chars)')
        self.cleaned_len = len(cleaned)
        self.bi, self.bi_floor = build_ngram_logprobs(cleaned, 2)
        self.tri, self.tri_floor = build_ngram_logprobs(cleaned, 3)
        self.quad, self.quad_floor = build_ngram_logprobs(cleaned, 4)

    @property
    def tri_array(self):
        if hasattr(self, '_tri_array'):
            return self._tri_array
        arr = [0.0] * (26**3)
        for k, v in self.tri.items():
            idx = (ord(k[0])-65)*676 + (ord(k[1])-65)*26 + (ord(k[2])-65)
            arr[idx] = v
        self._tri_array = arr
        return arr

    @property
    def quad_array(self):
        if hasattr(self, '_quad_array'):
            return self._quad_array
        arr = [0.0] * (26**4)
        for k, v in self.quad.items():
            idx = (ord(k[0])-65)*17576 + (ord(k[1])-65)*676 + (ord(k[2])-65)*26 + (ord(k[3])-65)
            arr[idx] = v
        self._quad_array = arr
        return arr

    def _score_n(self, text, table, floor, n):
        if len(text) < n:
            return floor * max(1, len(text))
        s = 0.0
        get = table.get
        for i in range(len(text) - n + 1):
            s += get(text[i:i+n], floor)
        return s

    def score(self, text):
        """
        混合スコア（文字あたり正規化）を返す。
        短文では trigram が安定して効く。bigram と quadgram も補助的に混ぜる。
        """
        if not text:
            return -1e9
        L = len(text)
        bi = self._score_n(text, self.bi, self.bi_floor, 2) / max(1, L - 1)
        tri = self._score_n(text, self.tri, self.tri_floor, 3) / max(1, L - 2)
        quad = self._score_n(text, self.quad, self.quad_floor, 4) / max(1, L - 3)
        # 重み付け: trigramを主体にしつつbi/quadで補強
        return 0.2 * bi + 0.5 * tri + 0.3 * quad

    def score_raw(self, text):
        """trigramの素のスコア（正規化なし）。Phase 2用。"""
        return self._score_n(text, self.tri, self.tri_floor, 3)


def index_of_coincidence(text):
    """一致指数。英語/ローマ字 ≈ 0.06-0.08, ランダム ≈ 0.038。"""
    n = len(text)
    if n < 2:
        return 0.0
    counts = Counter(text)
    return sum(c * (c - 1) for c in counts.values()) / (n * (n - 1))


# シングルトン的にロード
_english = None
_romaji = None


def english_model():
    global _english
    if _english is None:
        _english = LanguageModel('english', ENGLISH_CORPUS)
    return _english


def romaji_model():
    global _romaji
    if _romaji is None:
        _romaji = LanguageModel('romaji', ROMAJI_CORPUS)
    return _romaji


def best_language_score(text):
    """両言語でスコアし、高い方の (言語名, スコア) を返す。"""
    en = english_model().score(text)
    ja = romaji_model().score(text)
    if en >= ja:
        return ('english', en)
    return ('romaji', ja)


if __name__ == '__main__':
    # 動作確認
    en = english_model()
    ja = romaji_model()
    print(f'English corpus: {en.cleaned_len} chars, '
          f'{len(en.tri)} unique trigrams')
    print(f'Romaji corpus:  {ja.cleaned_len} chars, '
          f'{len(ja.tri)} unique trigrams')

    samples = [
        ('HELLOWORLDTHISISATEST', 'english plain'),
        ('WATASHIWANIHONJINDESU', 'romaji plain'),
        ('XQZWVKJYBPMHFCDLNRGTU', 'random'),
    ]
    for s, label in samples:
        en_s = en.score(s)
        ja_s = ja.score(s)
        ic = index_of_coincidence(s)
        print(f'{label:18s}: EN={en_s:+.3f}  JA={ja_s:+.3f}  IC={ic:.4f}')
