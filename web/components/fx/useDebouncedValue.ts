"use client";

import { useEffect, useState } from "react";

/**
 * 値が落ち着くまで更新を遅らせる。
 *
 * 入力のたびにリビール演出を掛け直すと文字が延々と踊って読めないので、
 * 打鍵が止まったタイミングで初めて演出を走らせるために使う。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return settled;
}
