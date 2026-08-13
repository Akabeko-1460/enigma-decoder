/**
 * 言語モデル用データの取得。
 *
 * `public/data/` に置いた gzip 済みテキストを読んで展開する。
 * 生成は `python tools/build_web_assets.py`。
 */

import type { SolverAssets } from "./types";

const DATA_BASE = "/data";

/** gzip のマジックナンバー。 */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * gzip ファイルを取得して文字列にする。
 *
 * ホスティングによっては `.gz` に `Content-Encoding: gzip` を付けて配信し、
 * ブラウザが先に展開してしまうことがある。先頭バイトを見て、まだ圧縮されて
 * いるときだけ自前で展開する。
 */
async function fetchMaybeGzipped(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 2));
  const isGzipped = head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  if (!isGzipped) {
    return new TextDecoder().decode(buffer);
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

let cached: Promise<SolverAssets> | null = null;
let cachedWithRomaji = false;

/**
 * 言語データを読み込む（プロセス内でキャッシュする）。
 *
 * `needRomaji` が false のときはローマ字コーパスを取りに行かない。
 * ローマ字モデルは quadgram の密配列だけで 3.6MB あり、ワーカー数だけ
 * 複製されるので、使わないなら作らない方がよい。
 */
export function loadAssets(needRomaji: boolean): Promise<SolverAssets> {
  // ローマ字が必要になったのに romaji 無しでキャッシュ済みなら読み直す
  if (cached && (cachedWithRomaji || !needRomaji)) return cached;

  cachedWithRomaji = needRomaji;
  cached = (async () => {
    const [ngramText, wordlistText, romajiCorpus] = await Promise.all([
      fetchMaybeGzipped(`${DATA_BASE}/ngrams_en.txt.gz`),
      fetchMaybeGzipped(`${DATA_BASE}/wordlist_en.txt.gz`),
      needRomaji ? fetchMaybeGzipped(`${DATA_BASE}/romaji_corpus.txt.gz`) : Promise.resolve(""),
    ]);
    return { ngramText, wordlistText, romajiCorpus };
  })();
  return cached;
}
