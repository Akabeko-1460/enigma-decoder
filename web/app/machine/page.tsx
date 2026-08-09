"use client";

import { useMemo, useState } from "react";
import { Enigma, ROTOR_NAMES, group5, type EnigmaConfig } from "@/lib/enigma";
import { FIXED_CONFIG, describeConfig } from "@/lib/fixedConfig";

type Mode = "fixed" | "custom";

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function useConfig(mode: Mode, custom: EnigmaConfig): EnigmaConfig {
  return mode === "fixed" ? FIXED_CONFIG : custom;
}

export default function MachinePage() {
  const [mode, setMode] = useState<Mode>("fixed");
  const [custom, setCustom] = useState<EnigmaConfig>({
    rotors: ["I", "II", "III"],
    reflector: "B",
    rings: [0, 0, 0],
    positions: [0, 0, 0],
    plugboard: "",
  });

  const [plainIn, setPlainIn] = useState("HELLO MY FRIEND MEET ME AT DAWN");
  const [cipherIn, setCipherIn] = useState("");

  const cfg = useConfig(mode, custom);
  const desc = useMemo(() => describeConfig(cfg), [cfg]);

  // エニグマは対合的なので暗号化・復号は同じ関数
  const cipherOut = useMemo(() => {
    try {
      return new Enigma(cfg).encrypt(plainIn);
    } catch {
      return "";
    }
  }, [cfg, plainIn]);

  const plainOut = useMemo(() => {
    try {
      return new Enigma(cfg).encrypt(cipherIn);
    } catch {
      return "";
    }
  }, [cfg, cipherIn]);

  function setRotor(i: number, v: string) {
    const r = [...custom.rotors] as [string, string, string];
    r[i] = v;
    setCustom({ ...custom, rotors: r });
  }
  function setPos(i: number, v: number) {
    const p = [...custom.positions] as [number, number, number];
    p[i] = v;
    setCustom({ ...custom, positions: p });
  }
  function setRing(i: number, v: number) {
    const r = [...custom.rings] as [number, number, number];
    r[i] = v;
    setCustom({ ...custom, rings: r });
  }

  return (
    <div>
      <h1>生成機・復号機</h1>
      <p className="sub">
        エニグマは対合的な暗号なので、<b>同じ内部状態</b>で暗号文をもう一度通すと平文に戻ります。
        左で作った暗号文を右に貼れば復号されます。
      </p>

      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <div style={{ flex: "0 0 auto" }}>
            <button
              className={mode === "fixed" ? "" : "ghost"}
              onClick={() => setMode("fixed")}
            >
              固定内部状態
            </button>{" "}
            <button
              className={mode === "custom" ? "" : "ghost"}
              onClick={() => setMode("custom")}
            >
              自分で設定
            </button>
          </div>
          <div style={{ flex: 1 }} />
        </div>

        {mode === "fixed" ? (
          <table className="kv" style={{ marginTop: 12 }}>
            <tbody>
              <tr><td className="k">ローター</td><td className="mono">{desc.rotors}</td></tr>
              <tr><td className="k">リフレクター</td><td className="mono">{desc.reflector}</td></tr>
              <tr><td className="k">リング設定</td><td className="mono">{desc.rings}</td></tr>
              <tr><td className="k">初期位置</td><td className="mono">{desc.positions}</td></tr>
              <tr><td className="k">プラグボード</td><td className="mono">{desc.plugboard}</td></tr>
            </tbody>
          </table>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div className="grid2">
              <div>
                <label>ローター（左・中・右）</label>
                <div className="row">
                  {[0, 1, 2].map((i) => (
                    <select
                      key={i}
                      value={custom.rotors[i]}
                      onChange={(e) => setRotor(i, e.target.value)}
                    >
                      {ROTOR_NAMES.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>
              <div>
                <label>リフレクター</label>
                <select
                  value={custom.reflector}
                  onChange={(e) =>
                    setCustom({ ...custom, reflector: e.target.value as "B" | "C" })
                  }
                >
                  <option value="B">B</option>
                  <option value="C">C</option>
                </select>
              </div>
            </div>
            <div className="grid2">
              <div>
                <label>初期位置（左・中・右）</label>
                <div className="row">
                  {[0, 1, 2].map((i) => (
                    <select key={i} value={custom.positions[i]} onChange={(e) => setPos(i, Number(e.target.value))}>
                      {letters.map((c, j) => (<option key={c} value={j}>{c}</option>))}
                    </select>
                  ))}
                </div>
              </div>
              <div>
                <label>リング設定（左・中・右）</label>
                <div className="row">
                  {[0, 1, 2].map((i) => (
                    <select key={i} value={custom.rings[i]} onChange={(e) => setRing(i, Number(e.target.value))}>
                      {letters.map((c, j) => (<option key={c} value={j}>{c}</option>))}
                    </select>
                  ))}
                </div>
              </div>
            </div>
            <label>プラグボード（例: AR GK OX）</label>
            <input
              type="text"
              value={custom.plugboard}
              onChange={(e) => setCustom({ ...custom, plugboard: e.target.value })}
              placeholder="スペース区切りの2文字ペア"
            />
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>生成機（平文 → 暗号文）</h2>
          <label>平文</label>
          <textarea value={plainIn} onChange={(e) => setPlainIn(e.target.value)} />
          <label>暗号文（5文字区切り）</label>
          <div className="out">{group5(cipherOut) || <span className="muted">—</span>}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => setCipherIn(cipherOut)}>
              → 右の復号機へ送る
            </button>
            <button
              className="ghost"
              onClick={() => navigator.clipboard?.writeText(cipherOut)}
            >
              コピー
            </button>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>復号機（暗号文 → 平文）</h2>
          <label>暗号文（空白や改行は無視されます）</label>
          <textarea value={cipherIn} onChange={(e) => setCipherIn(e.target.value)} />
          <label>復号結果</label>
          <div className="out">{plainOut || <span className="muted">—</span>}</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            固定内部状態を知っていれば、このように一瞬で復号できます。
          </div>
        </div>
      </div>
    </div>
  );
}
