"use client";

import { useEffect, useState } from "react";

/**
 * 画面下端に固定するステータスバー。
 *
 * 表示は雰囲気作りが主目的だが、値は実測を出す（コア数・経過時間・時刻）。
 * サーバー側では確定しないので、ハイドレーション不一致を避けるため
 * 初期値はプレースホルダにして useEffect で埋める。
 */
export default function StatusBar() {
  const [clock, setClock] = useState("--:--:--");
  const [cores, setCores] = useState<number | null>(null);
  const [uptime, setUptime] = useState(0);
  const [zone, setZone] = useState("");

  useEffect(() => {
    setCores(navigator.hardwareConcurrency || 1);
    setZone(offsetLabel());

    const startedAt = Date.now();
    const tick = () => {
      const now = new Date();
      setClock(
        [now.getHours(), now.getMinutes(), now.getSeconds()]
          .map((n) => String(n).padStart(2, "0"))
          .join(":")
      );
      setUptime(Math.floor((Date.now() - startedAt) / 1000));
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="statusbar" role="status" aria-label="システムステータス">
      <span className="row" style={{ gap: 7 }}>
        <span className="led" data-status="ok" />
        <b>SYS</b> ONLINE
      </span>
      {/* data-optional は畳む優先度。1 が先に消え、2 が最後まで残る側で消える。
          畳む条件は globals.css のメディアクエリが持つ */}
      <span data-optional="1">
        <b>ENGINE</b> RUST&rarr;WASM
      </span>
      <span data-optional="2">
        <b>CORES</b> ×{cores ?? "--"}
      </span>
      <span>
        <b>NET</b> LOCAL-ONLY
      </span>
      <span className="statusbar__spacer" />
      <span data-optional="1">
        <b>UPTIME</b> {formatUptime(uptime)}
      </span>
      <span>
        <b>UTC{zone}</b> {clock}
      </span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** "+09" のようなローカルタイムゾーン表記。サーバーでも同じ式でよいよう単純化。 */
function offsetLabel(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  return sign + String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
}
