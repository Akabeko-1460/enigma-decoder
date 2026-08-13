/**
 * WASM 解読エンジンの検証（Node 上で実行、ブラウザ不要）。
 *
 *   node scripts/verify-wasm.mjs
 *
 * 3 つを確認する:
 *   1. エニグマの既知ベクトル（AAAAA → BDZGO）
 *   2. 言語モデルのスコアが Python と一致するか
 *      （基準値は python tools/emit_score_reference.py で生成）
 *   3. 解読が実際に正解設定を復元できるか（PB既知 / PB未知）
 *
 * パイプラインは web/lib/solver/pipeline.ts と同じ手順を、ワーカーを使わず
 * 逐次で再現している。並列化の有無で結果は変わらない設計なので、これが
 * 通ればブラウザ側の計算部分は同じ答えを出す。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import init, { Solver } from "../lib/wasm/enigma_decoder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "public", "data");
const WASM_PATH = path.join(WEB, "public", "wasm", "enigma_decoder_bg.wasm");

/** スコア一致とみなす許容差。f64 のまま計算しているので本来は完全一致する。 */
const SCORE_TOLERANCE = 1e-9;

const REFLECTOR_B = 0;
const ROTOR_LABELS = ["I", "II", "III", "IV", "V"];

let failures = 0;

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function gunzip(file) {
  return zlib.gunzipSync(fs.readFileSync(path.join(DATA, file))).toString("utf8");
}

function textToInts(text) {
  const out = [];
  for (const ch of text.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out.push(c - 65);
  }
  return Uint8Array.from(out);
}

function lettersOf(values) {
  return Array.from(values, (v) => String.fromCharCode(v + 65)).join("");
}

function rotorPermutations() {
  const out = [];
  for (let a = 0; a < 5; a++)
    for (let b = 0; b < 5; b++) {
      if (b === a) continue;
      for (let c = 0; c < 5; c++) {
        if (c === a || c === b) continue;
        out.push(a, b, c);
      }
    }
  return Uint32Array.from(out);
}

function parsePlugboard(text) {
  const pb = new Uint8Array(26);
  for (let i = 0; i < 26; i++) pb[i] = i;
  for (const pair of text.toUpperCase().split(/\s+/)) {
    if (pair.length !== 2) continue;
    const a = pair.charCodeAt(0) - 65;
    const b = pair.charCodeAt(1) - 65;
    if (a >= 0 && a < 26 && b >= 0 && b < 26 && a !== b) {
      pb[a] = b;
      pb[b] = a;
    }
  }
  return pb;
}

function decodeRanked(flat) {
  const rows = [];
  for (let i = 0; i + 7 <= flat.length; i += 7) {
    rows.push({
      score: flat[i],
      rotors: [flat[i + 1], flat[i + 2], flat[i + 3]],
      pos: [flat[i + 4], flat[i + 5], flat[i + 6]],
    });
  }
  return rows;
}

function flattenCandidates(rows) {
  const flat = new Uint32Array(rows.length * 6);
  rows.forEach((row, i) => {
    flat.set(row.rotors, i * 6);
    flat.set(row.pos, i * 6 + 3);
  });
  return flat;
}

function dedupe(rows, limit) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    unique.push(row);
    if (unique.length >= limit) break;
  }
  return unique;
}

const byScoreDesc = (a, b) => b.score - a.score;

/**
 * 精度プリセット。web/lib/breakLevels.ts の写し。
 * 検証スクリプトから TS を直接読めないので複製している。
 * breakLevels.ts を変えたらここも直すこと。
 */
const BASE_PARAMS = {
  normal: { breadth: 300, nRestarts: 2, saSteps: 15000, refineAccuracy: false },
  accuracy: { breadth: 1000, nRestarts: 4, saSteps: 40000, refineAccuracy: true },
  thorough: { breadth: 3000, nRestarts: 8, saSteps: 120000, refineAccuracy: true },
};
const WIDTH_SCALE = { normal: 0.3, accuracy: 1.0, thorough: 3.0 };

function searchParamsFor(level, ctLength) {
  const base = BASE_PARAMS[level];
  const scale = WIDTH_SCALE[level];
  let floors;
  if (ctLength < 80) floors = [3000, 6];
  else if (ctLength < 150) floors = [1000, 4];
  else return { ...base };
  return {
    ...base,
    breadth: Math.max(base.breadth, Math.trunc(floors[0] * scale)),
    nRestarts: Math.max(base.nRestarts, floors[1]),
  };
}

function describe(row) {
  return `rotors=${row.rotors.map((n) => ROTOR_LABELS[n]).join(" ")} pos=${lettersOf(row.pos)} rings=${lettersOf(row.rings)}`;
}

async function main() {
  console.log("WASM 解読エンジン検証");

  await init({ module_or_path: fs.readFileSync(WASM_PATH) });
  const ngramText = gunzip("ngrams_en.txt.gz");
  const wordlistText = gunzip("wordlist_en.txt.gz");

  // --- 2. 言語モデルのスコア一致 ---
  // Python の best_language_score_short は常に英語・ローマ字を比較するので、
  // 突き合わせには両言語を積んだモデルを使う。
  console.log("\n[2] 言語モデル（Python との一致）");
  {
    const both = new Solver(ngramText, gunzip("romaji_corpus.txt.gz"), wordlistText);
    const reference = JSON.parse(fs.readFileSync(path.join(HERE, "score-reference.json"), "utf8"));
    for (const entry of reference.scores) {
      const got = both.score_text(entry.text);
      const delta = Math.abs(got.score - entry.score);
      check(
        `${entry.text.slice(0, 28)}…`,
        got.lang === entry.lang && delta < SCORE_TOLERANCE,
        `python=${entry.score.toFixed(6)}(${entry.lang}) wasm=${got.score.toFixed(6)}(${got.lang}) Δ=${delta.toExponential(2)}`
      );
    }
    both.free();
  }

  // 以降は「平文の言語＝英語」を指定したときのブラウザ側と同じ構成にする。
  // 英語指定ならローマ字モデルを積まない（積むと最終スコアでローマ字候補と
  // competing になり、英語だと分かっているのに取り違えることがある）。
  const solver = new Solver(ngramText, "", wordlistText);
  console.log(`  言語モデル読込: 単語 ${solver.word_count} 語 / ローマ字 ${solver.has_romaji ? "あり" : "なし"}`);

  // --- 1. エニグマ既知ベクトル ---
  console.log("\n[1] エニグマ実装");
  const bdzgo = solver.decrypt(
    textToInts("AAAAA"), Uint32Array.from([0, 1, 2]), REFLECTOR_B,
    Uint8Array.from([0, 0, 0]), Uint8Array.from([0, 0, 0]), parsePlugboard("")
  );
  check("AAAAA → BDZGO", bdzgo === "BDZGO", bdzgo);

  const perms = rotorPermutations();

  // --- 3a. PB既知の解読 ---
  console.log("\n[3a] 解読（プラグボード既知）");
  {
    const plaintext = "MEETMEATTHEOLDBRIDGEATDAWNBRINGTHEDOCUMENTSANDDONOTBELATE";
    const rotors = Uint32Array.from([1, 3, 4]); // II IV V
    const rings = Uint8Array.from([0, 0, 0]);
    const pos = Uint8Array.from([7, 4, 22]); // HEW
    const pb = parsePlugboard("AB CD EF");
    const ct = textToInts(solver.decrypt(textToInts(plaintext), rotors, REFLECTOR_B, rings, pos, pb));

    const t0 = Date.now();
    const ranked = decodeRanked(
      solver.phase1_known_shard(ct.slice(0, 200), perms, REFLECTOR_B, pb, true, false, 20)
    );
    const seeded = ranked.slice(0, 5).map((row) => ({
      score: row.score, rotors: row.rotors, pos: row.pos,
      rings: [0, 0, 0], pb: Array.from(pb), lang: "english", text: "",
    }));
    const refined = solver
      .refine_rings_fixed_pb_shard(ct, seeded, pb, false, REFLECTOR_B)
      .sort(byScoreDesc);
    const best = refined[0];
    check(
      "平文を完全復元",
      best.text === plaintext,
      `${describe(best)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
    if (best.text !== plaintext) console.log(`        got: ${best.text}`);
  }

  // --- 3b. PB未知の解読 ---
  const level = process.argv.includes("--level")
    ? process.argv[process.argv.indexOf("--level") + 1]
    : "accuracy";
  console.log(`\n[3b] 解読（プラグボード未知・${level}）`);
  {
    const plaintext =
      "THEALLIEDFORCESAREPREPARINGFORAMAJOROFFENSIVEALONGTHEWESTERNFRONT" +
      "ALLUNITSMUSTBEREADYTOADVANCEATFIRSTLIGHTTOMORROWMORNINGWITHOUTFAIL";
    const rotors = Uint32Array.from([1, 4, 2]); // II V III
    const rings = Uint8Array.from([0, 0, 0]);
    const pos = Uint8Array.from([7, 20, 11]);
    const truePb = parsePlugboard("AB CD EF");
    const ct = textToInts(solver.decrypt(textToInts(plaintext), rotors, REFLECTOR_B, rings, pos, truePb));

    const params = searchParamsFor(level, ct.length);
    console.log(`      ${ct.length} 文字 / params=${JSON.stringify(params)}`);

    const t0 = Date.now();
    const ranked = decodeRanked(solver.phase1_shard(ct.slice(0, 200), perms, REFLECTOR_B, params.breadth));
    console.log(`      Phase A 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s（候補 ${ranked.length} 件）`);

    const t1 = Date.now();
    const rows = solver
      .phase2_staged_shard(ct, flattenCandidates(ranked), 0, REFLECTOR_B, true, false, {
        max_pairs: 10,
        n_restarts: params.nRestarts,
        sa_steps: params.saSteps,
        t_start: 12.0,
        t_end: 0.3,
      })
      .sort(byScoreDesc);
    console.log(`      Phase C 完了 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    const refined = solver
      .refine_rings_shard(ct, dedupe(rows, 5), params.refineAccuracy, REFLECTOR_B)
      .sort(byScoreDesc);
    const best = dedupe(refined, 5)[0];
    const matched = [...best.text].filter((c, i) => c === plaintext[i]).length;
    check(
      "平文を完全復元",
      best.text === plaintext,
      `${describe(best)} 一致 ${matched}/${plaintext.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
    if (best.text !== plaintext) console.log(`        got: ${best.text}`);
  }

  console.log(failures === 0 ? "\n全項目 PASS" : `\n${failures} 件 FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
