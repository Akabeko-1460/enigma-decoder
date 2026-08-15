/**
 * 音を鳴らすかどうかの設定。
 *
 * React の外に置いてあるのは、値を読みたいのが「トグルボタン」と
 * 「文書全体のクリックを拾うリスナ」の 2 か所に分かれているため。
 * useSyncExternalStore からそのまま購読できる形にしてある。
 */

const STORAGE_KEY = "enigma:sound";

/** 初回訪問は音ありで迎える。ブラウザの自動再生方針上、実際に鳴り出すのは最初の操作から */
const DEFAULT_ENABLED = true;

const listeners = new Set<() => void>();

/**
 * getSnapshot は再描画のたびに呼ばれるので localStorage を毎回は触らない。
 * null は「まだ読んでいない」。
 */
let cached: boolean | null = null;

export function subscribeSoundEnabled(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function getSoundEnabled(): boolean {
  if (cached !== null) return cached;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cached = stored === null ? DEFAULT_ENABLED : stored === "on";
  } catch {
    // プライベートウィンドウでは localStorage が例外を投げることがある
    cached = DEFAULT_ENABLED;
  }
  return cached;
}

/** サーバー描画時は保存値を読めないので、既定値で描いてハイドレーション後に合わせる。 */
export function getSoundEnabledOnServer(): boolean {
  return DEFAULT_ENABLED;
}

export function setSoundEnabled(next: boolean): void {
  if (cached === next) return;
  cached = next;

  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // 保存できなくても今の再生状態は変えられるので、この場は握りつぶす
  }

  for (const listener of listeners) listener();
}
