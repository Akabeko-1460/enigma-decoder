"use client";

import { useEffect, useLayoutEffect } from "react";

/**
 * クライアントでは useLayoutEffect、サーバーでは useEffect。
 *
 * 復号リビールは「最終文字列が 1 フレームでも見えてしまうと台無し」なので、
 * ペイント前に初期状態を書き換える必要がある。SSR で useLayoutEffect を
 * 呼ぶと警告が出るため差し替える。
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
