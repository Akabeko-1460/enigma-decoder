//! 言語モデルと最終スコアリング（`scoring.py` の Rust 移植）。
//!
//! ブラウザには Python が無いので、Python 側でやっていた
//! 「n-gram 頻度表の読み込み → 密配列化 → 対数確率スコア」と
//! 「単語リスト照合」をここで行う。数式は `scoring.py` と一対一で対応させてある。

use std::collections::HashSet;

pub const BI_SIZE: usize = 26 * 26;
pub const TRI_SIZE: usize = 26 * 26 * 26;
pub const QUAD_SIZE: usize = 26 * 26 * 26 * 26;

/// `word_fitness` が拾う単語長の範囲。3文字語はランダム文字列への
/// 偽陽性が多いため 4 文字以上に限定する（scoring.py と同じ）。
const WORD_MIN_LEN: usize = 4;
const WORD_MAX_LEN: usize = 12;

/// 短文スコアで単語照合に与える重み。根拠は scoring.py の score_short を参照。
const WORD_WEIGHT: f64 = 0.5;

/// ある言語の n-gram 対数確率テーブル一式。
pub struct LanguageModel {
    pub bi: Vec<f64>,
    pub bi_floor: f64,
    pub tri: Vec<f64>,
    pub tri_floor: f64,
    pub quad: Vec<f64>,
    pub quad_floor: f64,
}

/// A-Z だけを 0..25 の数値へ。それ以外は捨てる。
pub fn text_to_ints(text: &str) -> Vec<u8> {
    text.bytes()
        .filter_map(|b| {
            let up = b.to_ascii_uppercase();
            if (b'A'..=b'Z').contains(&up) { Some(up - b'A') } else { None }
        })
        .collect()
}

pub fn ints_to_text(ints: &[u8]) -> String {
    ints.iter().map(|&c| (c + b'A') as char).collect()
}

/// n-gram のキー（"THE" など）を密配列の添字へ。範囲外文字があれば None。
fn ngram_index(key: &[u8]) -> Option<usize> {
    let mut idx = 0usize;
    for &b in key {
        if !(b'A'..=b'Z').contains(&b) { return None; }
        idx = idx * 26 + (b - b'A') as usize;
    }
    Some(idx)
}

impl LanguageModel {
    fn empty() -> Self {
        Self {
            bi: vec![0.0; BI_SIZE],
            bi_floor: 0.0,
            tri: vec![0.0; TRI_SIZE],
            tri_floor: 0.0,
            quad: vec![0.0; QUAD_SIZE],
            quad_floor: 0.0,
        }
    }

    /// 事前計算済み n-gram 頻度表（`ngrams_en.txt.gz` を展開したテキスト）から構築。
    ///
    /// 形式は `scoring.py::load_ngram_counts` と同じ:
    ///   `# <section> <total>` でセクションが始まり、以降 `KEY COUNT` が並ぶ。
    ///   section は bigram / trigram / quadgram。
    pub fn from_ngram_counts(text: &str) -> Result<Self, String> {
        let mut model = Self::empty();
        // (対象配列を選ぶための) 現在のセクション番号。0=bi, 1=tri, 2=quad
        let mut section: Option<usize> = None;
        let mut totals = [0f64; 3];

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }

            if let Some(header) = line.strip_prefix('#') {
                let mut parts = header.split_whitespace();
                let name = parts.next().unwrap_or("");
                let total: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                section = match name {
                    "bigram" => Some(0),
                    "trigram" => Some(1),
                    "quadgram" => Some(2),
                    _ => None,
                };
                if let Some(s) = section {
                    if total <= 0.0 {
                        return Err(format!("section {name} has invalid total {total}"));
                    }
                    totals[s] = total;
                }
                continue;
            }

            let Some(s) = section else { continue };
            let mut parts = line.split_whitespace();
            let (Some(key), Some(count)) = (parts.next(), parts.next()) else { continue };
            let Some(idx) = ngram_index(key.as_bytes()) else { continue };
            let Ok(count) = count.parse::<f64>() else { continue };

            let logprob = (count / totals[s]).log10();
            match s {
                0 => model.bi[idx] = logprob,
                1 => model.tri[idx] = logprob,
                _ => model.quad[idx] = logprob,
            }
        }

        if totals.iter().any(|&t| t <= 0.0) {
            return Err("ngram file is missing one of bigram/trigram/quadgram".into());
        }
        // 観測されない n-gram のフロア値（ラプラス的なスムージング）
        model.bi_floor = (0.01 / totals[0]).log10();
        model.tri_floor = (0.01 / totals[1]).log10();
        model.quad_floor = (0.01 / totals[2]).log10();
        Ok(model)
    }

    /// 生コーパスから直接構築（`scoring.py::build_ngram_logprobs` 相当）。
    /// ローマ字モデルのように事前計算表が無い言語で使う。
    pub fn from_corpus(corpus: &str) -> Result<Self, String> {
        let cleaned = text_to_ints(corpus);
        if cleaned.len() < 1000 {
            return Err(format!("corpus too small ({} chars)", cleaned.len()));
        }
        let mut model = Self::empty();
        build_counts(&cleaned, 2, &mut model.bi, &mut model.bi_floor);
        build_counts(&cleaned, 3, &mut model.tri, &mut model.tri_floor);
        build_counts(&cleaned, 4, &mut model.quad, &mut model.quad_floor);
        Ok(model)
    }

    /// n-gram 対数確率の総和。`scoring.py::_score_n` と同じ扱い。
    fn score_n(&self, text: &[u8], n: usize) -> f64 {
        let (table, floor) = match n {
            2 => (&self.bi, self.bi_floor),
            3 => (&self.tri, self.tri_floor),
            _ => (&self.quad, self.quad_floor),
        };
        if text.len() < n {
            return floor * (text.len().max(1) as f64);
        }
        let mut s = 0.0;
        for window in text.windows(n) {
            let idx = window.iter().fold(0usize, |acc, &c| acc * 26 + c as usize);
            let v = table[idx];
            s += if v != 0.0 { v } else { floor };
        }
        s
    }

    /// 文字あたりに正規化した混合スコア（trigram 主体、bi/quad で補強）。
    pub fn score(&self, text: &[u8]) -> f64 {
        if text.is_empty() { return -1e9; }
        let len = text.len();
        let bi = self.score_n(text, 2) / (len.saturating_sub(1).max(1) as f64);
        let tri = self.score_n(text, 3) / (len.saturating_sub(2).max(1) as f64);
        let quad = self.score_n(text, 4) / (len.saturating_sub(3).max(1) as f64);
        0.2 * bi + 0.5 * tri + 0.3 * quad
    }
}

/// 長さ n の n-gram を数えて対数確率の密配列へ書き込む。
fn build_counts(cleaned: &[u8], n: usize, table: &mut [f64], floor: &mut f64) {
    let mut counts = vec![0u32; 26usize.pow(n as u32)];
    for window in cleaned.windows(n) {
        let idx = window.iter().fold(0usize, |acc, &c| acc * 26 + c as usize);
        counts[idx] += 1;
    }
    let total: f64 = counts.iter().map(|&c| c as f64).sum();
    if total <= 0.0 { return; }
    for (idx, &c) in counts.iter().enumerate() {
        if c > 0 {
            table[idx] = (c as f64 / total).log10();
        }
    }
    *floor = (0.01 / total).log10();
}

/// 実在英単語の集合。短文スコアの補助指標に使う。
pub struct WordList {
    words: HashSet<Box<[u8]>>,
}

impl WordList {
    /// 1 行 1 単語のテキストから構築。長さ範囲外の語は捨てる。
    pub fn from_text(text: &str) -> Self {
        let mut words = HashSet::new();
        for line in text.lines() {
            let word = text_to_ints(line.trim());
            if (WORD_MIN_LEN..=WORD_MAX_LEN).contains(&word.len()) {
                words.insert(word.into_boxed_slice());
            }
        }
        Self { words }
    }

    pub fn len(&self) -> usize { self.words.len() }
    pub fn is_empty(&self) -> bool { self.words.is_empty() }

    /// テキスト中に現れる実在英単語の長さの総和。
    ///
    /// 正しい復号文には実在語が多数含まれ、誤ったリング設定では偶然一致しか
    /// 起きないため、n-gram だけでは割れない候補を切り分けられる。
    pub fn word_fitness(&self, text: &[u8]) -> f64 {
        if self.words.is_empty() { return 0.0; }
        let len = text.len();
        let mut score = 0usize;
        for start in 0..len {
            let max_len = WORD_MAX_LEN.min(len - start);
            for length in WORD_MIN_LEN..=max_len {
                if self.words.contains(&text[start..start + length]) {
                    score += length;
                }
            }
        }
        score as f64
    }
}

/// 英語・ローマ字の両モデルと単語リストをまとめたもの。
/// Python 側の `scoring` モジュールのシングルトンに相当する。
pub struct Models {
    pub english: LanguageModel,
    /// ローマ字モデル。language が english 固定のときは構築しない。
    pub romaji: Option<LanguageModel>,
    pub words: WordList,
}

/// 判定された言語とそのスコア。
pub struct LangScore {
    pub lang: &'static str,
    pub score: f64,
}

impl Models {
    /// 両言語でスコアし、高い方を返す（`best_language_score`）。
    pub fn best_language_score(&self, text: &[u8]) -> LangScore {
        let en = self.english.score(text);
        match &self.romaji {
            Some(ja_model) => {
                let ja = ja_model.score(text);
                if en >= ja {
                    LangScore { lang: "english", score: en }
                } else {
                    LangScore { lang: "romaji", score: ja }
                }
            }
            None => LangScore { lang: "english", score: en },
        }
    }

    /// 短文特化版（`best_language_score_short`）。
    /// 英語側だけ単語リスト照合を加算する（ローマ字には単語リストが無い）。
    pub fn best_language_score_short(&self, text: &[u8]) -> LangScore {
        let en = if text.is_empty() {
            -1e9
        } else {
            self.english.score(text)
                + WORD_WEIGHT * self.words.word_fitness(text) / (text.len().max(1) as f64)
        };
        match &self.romaji {
            Some(ja_model) => {
                let ja = ja_model.score(text);
                if en >= ja {
                    LangScore { lang: "english", score: en }
                } else {
                    LangScore { lang: "romaji", score: ja }
                }
            }
            None => LangScore { lang: "english", score: en },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngram_index_is_base26() {
        assert_eq!(ngram_index(b"AAA"), Some(0));
        assert_eq!(ngram_index(b"AAB"), Some(1));
        assert_eq!(ngram_index(b"BAA"), Some(676));
        assert_eq!(ngram_index(b"A1A"), None);
    }

    #[test]
    fn word_fitness_sums_word_lengths() {
        let list = WordList::from_text("DAWN\nEASTERN\nABC\n");
        // ABC は 3 文字なので登録されない
        assert_eq!(list.len(), 2);
        assert_eq!(list.word_fitness(&text_to_ints("DAWN")), 4.0);
        assert_eq!(list.word_fitness(&text_to_ints("XXDAWNXX")), 4.0);
        assert_eq!(list.word_fitness(&text_to_ints("ABC")), 0.0);
    }

    #[test]
    fn ngram_counts_roundtrip() {
        let src = "# bigram 100\nAB 50\nBA 50\n# trigram 100\nABC 100\n# quadgram 100\nABCD 100\n";
        let m = LanguageModel::from_ngram_counts(src).unwrap();
        assert!((m.bi[ngram_index(b"AB").unwrap()] - (0.5f64).log10()).abs() < 1e-12);
        assert!((m.tri_floor - (0.0001f64).log10()).abs() < 1e-12);
    }
}
