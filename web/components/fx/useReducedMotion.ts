"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * OS の「アニメーションを減らす」設定を見る。
 *
 * CSS 側は globals.css のメディアクエリで止まるが、JS で駆動する演出
 * （スクランブル・タイプアウト・ランプ）は自前で判定して最終状態へ飛ばす必要がある。
 * サーバーでは false 固定。useSyncExternalStore なのでハイドレーション後の
 * 反映は React が面倒を見てくれる。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}
