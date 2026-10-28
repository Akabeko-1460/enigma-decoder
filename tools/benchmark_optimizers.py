"""
Phase C（プラグボード復元）の最適化手法を、同じ条件で比べるベンチマーク。

比べる手法（4 つとも Rust コアの同じ層で動かす）:
    current  現行の既定。段階スコア山登り（空＋ランダム初期値 n_restarts 回）＋SA 磨き上げ
    hc       段階スコア山登りだけを、予算が尽きるまでランダム初期値から再スタート
    sa       SA＋貪欲山登り磨きだけを、予算が尽きるまで空の plugboard から再スタート
    ga       遺伝的アルゴリズム（enigma_decoder/src/core.rs の ga_plugboard）

公平性のための取り決め:
    - テストケースは固定シードで生成する。平文の切り出し範囲は、GA の調整用（tune）と
      評価用（A / B）でコーパスの別の部分に分ける
    - 試行（ケース × シード）ごとに、まず current を実行して候補ごとの適応度評価回数
      （復号＋採点の回数）を記録し、hc / sa / ga にはその回数を候補ごとの上限として与える
    - 言語モデル・適応度（trigram + 0.5×quadgram）・Phase B・最終の順位付けは全手法で共通
    - Phase A（ローター・位置の候補列挙）は乱数を使わないので、ケースごとに 1 回だけ
      実行して全手法で共有する。手法の実行順はケース・シードごとに交互にし、
      実時間の比較が計測時期の偏りを受けにくいようにする

計測は 2 段:
    pipeline  既定の解読と同じ流れ（Phase A → C → B）で第 1 候補を平文と比べる
    oracle    正解のローター・位置だけを Phase C に渡し、最適化手法そのものを比べる

使い方（phase2_optimize を含む Rust コアを入れた Python で実行する）:
    python tools/benchmark_optimizers.py --set A --seeds 5 --out results_a.json
    python tools/benchmark_optimizers.py --set B --seeds 5 --out results_b.json
    python tools/benchmark_optimizers.py --set tune --oracle-only --methods current,ga --ga-pop 64
"""
import argparse
import json
import os
import random
import statistics
import sys
import time
from dataclasses import dataclass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from attack import phase1  # noqa: E402
from corpora import ENGLISH_CORPUS  # noqa: E402
from decrypt_plugboard import (HAS_OPTIMIZE, ROTOR_NAMES, finish_results,  # noqa: E402
                               phase2_optimize_rust, resolve_params)
from enigma import Enigma  # noqa: E402
from scoring import clean, english_model  # noqa: E402

METHODS = ('current', 'hc', 'sa', 'ga')
LANGUAGE = 'english'      # selftest と同じ。Phase C の適応度は英語モデルだけになる
MODE = 'accuracy'         # 既定のモード
MAX_PAIRS = 10            # attack_plugboard の既定
TOP_RESULTS = 5           # run_attack の既定

# 平文はコーパスを前後に分けて切り出す（調整用と評価用で文が重ならないように）
_CORPUS = clean(ENGLISH_CORPUS)
_EVAL_TEXT = _CORPUS[:2000]
_TUNE_TEXT = _CORPUS[2000:]


@dataclass(frozen=True)
class CaseSet:
    seed: int
    n_cases: int
    lengths: tuple
    pairs: tuple
    source: str


CASE_SETS = {
    # README の実測と同じ条件（50〜150字・2〜10ペア・10ケース）
    'A': CaseSet(seed=1001, n_cases=10, lengths=(50, 150), pairs=(2, 10), source=_EVAL_TEXT),
    # 現行でも取りこぼす短文（35〜60字・2〜10ペア）
    'B': CaseSet(seed=2002, n_cases=10, lengths=(35, 60), pairs=(2, 10), source=_EVAL_TEXT),
    # GA の調整用。評価には使わない
    'tune': CaseSet(seed=3003, n_cases=12, lengths=(35, 120), pairs=(2, 10), source=_TUNE_TEXT),
}


@dataclass(frozen=True)
class Case:
    index: int
    plaintext: str
    ciphertext: str
    rotors: tuple
    positions: tuple
    plugboard: str
    n_pairs: int


def make_cases(case_set):
    """固定シードでテストケースを作る。リング設定は selftest と同じ (0,0,0)。"""
    rng = random.Random(case_set.seed)
    cases = []
    for index in range(case_set.n_cases):
        length = rng.randint(*case_set.lengths)
        start = rng.randrange(len(case_set.source) - length + 1)
        plaintext = case_set.source[start:start + length]
        rotors = tuple(rng.sample(ROTOR_NAMES, 3))
        positions = tuple(rng.randrange(26) for _ in range(3))
        n_pairs = rng.randint(*case_set.pairs)
        letters = rng.sample('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 2 * n_pairs)
        plugboard = ' '.join(letters[2 * k] + letters[2 * k + 1] for k in range(n_pairs))
        ciphertext = Enigma(rotors, 'B', (0, 0, 0), positions, plugboard).encrypt(plaintext)
        cases.append(Case(index, plaintext, ciphertext, rotors, positions, plugboard, n_pairs))
    return cases


def fitness_per_char(text):
    """Phase C の適応度（Rust の Scorer::score と同じ trigram + 0.5×quadgram）を文字数で割る。"""
    en = english_model()
    tri = sum(en.tri.get(text[i:i + 3], en.tri_floor) for i in range(len(text) - 2))
    quad = sum(en.quad.get(text[i:i + 4], en.quad_floor) for i in range(len(text) - 3))
    return (tri + 0.5 * quad) / len(text)


def char_match(text, plaintext):
    return sum(a == b for a, b in zip(text, plaintext)) / len(plaintext)


def true_plugboard_array(case):
    return Enigma(case.rotors, 'B', (0, 0, 0), case.positions, case.plugboard).plugboard


def true_rank(case, candidates):
    """Phase A の候補列で正解のローター・位置が何位か（1 始まり。無ければ None）。"""
    for rank, cand in enumerate(candidates, start=1):
        if cand[1] == case.rotors and cand[2] == case.positions:
            return rank
    return None


def run_methods(case, candidates, params, seed, methods, ga_params, apply_phase_b):
    """
    1 試行ぶん、全手法で Phase C（と必要なら Phase B）を回して記録を返す。
    current を最初に回し、その候補ごとの評価回数を他手法の上限にする。
    """
    records = []
    budgets = None
    for method in methods:
        t0 = time.perf_counter()
        results, evals = phase2_optimize_rust(
            case.ciphertext, candidates, method, language=LANGUAGE,
            max_candidates=params['max_candidates'], max_pairs=MAX_PAIRS,
            n_restarts=params['n_restarts'], sa_steps=params['sa_steps'],
            budgets=budgets, run_seed=seed, ga_params=ga_params, verbose=False)
        t1 = time.perf_counter()
        if method == 'current':
            budgets = evals
        if apply_phase_b:
            results = finish_results(case.ciphertext, results, params['refine_accuracy'],
                                     top_results=TOP_RESULTS, verbose=False)
        t2 = time.perf_counter()

        best = results[0]
        text = best[6]
        records.append(dict(
            method=method, seed=seed, case=case.index,
            length=len(case.plaintext), pairs=case.n_pairs,
            solved=text == case.plaintext,
            char_match=char_match(text, case.plaintext),
            fitness=fitness_per_char(text),
            pb_exact=list(best[4]) == true_plugboard_array(case) and best[3] == (0, 0, 0),
            evals=sum(evals), evals_per_candidate=sum(evals) / len(evals),
            time_phase_c=t1 - t0, time_total=t2 - t0,
        ))
    return records


def rotate(methods, k):
    """current を先頭に固定したまま、残りの実行順を k だけずらす。"""
    rest = list(methods[1:])
    if not rest:
        return list(methods)
    k %= len(rest)
    return [methods[0]] + rest[k:] + rest[:k]


def run_case(case, seeds, methods, ga_params, oracle_only, log):
    """1 ケースを全シード・全手法で回す。Phase A はここで 1 回だけ実行して共有する。"""
    params = resolve_params(MODE, len(case.ciphertext))
    ref_fitness = fitness_per_char(case.plaintext)
    log(f'case {case.index}: {len(case.plaintext)}字 {case.n_pairs}ペア '
        f'rotors={case.rotors} pos={case.positions} 平文の適応度={ref_fitness:.3f}')

    # (計測の段, Phase C に渡す候補, Phase B を掛けるか)
    levels = [('oracle', [(None, case.rotors, case.positions)], False)]
    rank = None
    if not oracle_only:
        t0 = time.perf_counter()
        candidates = phase1(case.ciphertext, top_n=params['top_n'],
                            sample_len=min(200, len(case.ciphertext)),
                            language=LANGUAGE, verbose=False)
        rank = true_rank(case, candidates)
        log(f'  Phase A {time.perf_counter() - t0:.1f}s  正解の順位={rank} '
            f'(Phase C に渡すのは上位 {params["max_candidates"]})')
        levels.append(('pipeline', candidates, True))

    records = []
    for seed in seeds:
        order = rotate(methods, case.index + seed)
        for level, cands, apply_phase_b in levels:
            for rec in run_methods(case, cands, params, seed, order, ga_params, apply_phase_b):
                rec.update(level=level, true_rank=rank, ref_fitness=ref_fitness)
                records.append(rec)
                log(format_record(rec))
    return records


def format_record(rec):
    return (f'  seed={rec["seed"]} {rec["level"]:8s} {rec["method"]:7s} '
            f'solved={int(rec["solved"])} match={rec["char_match"]:.3f} '
            f'fit={rec["fitness"]:.3f} evals/cand={rec["evals_per_candidate"]:.0f} '
            f'C={rec["time_phase_c"]:.2f}s total={rec["time_total"]:.2f}s')


def summarize(records, methods):
    """手法ごとの集計表（Markdown）を返す。"""
    lines = []
    for level in ('pipeline', 'oracle'):
        rows = [r for r in records if r['level'] == level]
        if not rows:
            continue
        current = {(r['case'], r['seed']): r for r in rows if r['method'] == 'current'}
        lines.append(f'\n### {level}\n')
        lines.append('| 手法 | 完全解読 | 文字一致率 | 適応度/字 | 対現行 適応度 勝-分-負 '
                     '| 評価回数/候補 | Phase C 時間 | 合計時間 |')
        lines.append('|---|---|---|---|---|---|---|---|')
        for method in methods:
            mine = [r for r in rows if r['method'] == method]
            if not mine:
                continue
            solved = sum(r['solved'] for r in mine)
            wins = ties = losses = 0
            for r in mine:
                diff = r['fitness'] - current[(r['case'], r['seed'])]['fitness']
                if abs(diff) < 1e-9:
                    ties += 1
                elif diff > 0:
                    wins += 1
                else:
                    losses += 1
            lines.append(
                f'| {method} | {solved}/{len(mine)} ({100 * solved / len(mine):.0f}%) '
                f'| {100 * statistics.mean(r["char_match"] for r in mine):.1f}% '
                f'| {statistics.mean(r["fitness"] for r in mine):.4f} '
                f'| {wins}-{ties}-{losses} '
                f'| {statistics.mean(r["evals_per_candidate"] for r in mine):,.0f} '
                f'| {statistics.mean(r["time_phase_c"] for r in mine):.2f}s '
                f'| {statistics.mean(r["time_total"] for r in mine):.2f}s |')
    return '\n'.join(lines)


def print_merged(paths):
    """分割実行した結果ファイルを合算し、集計表と実行時間の合計を出す。"""
    runs = []
    for path in paths:
        with open(path, encoding='utf-8') as f:
            runs.append(json.load(f))
    records = [rec for run in runs for rec in run['records']]
    methods = runs[0]['methods']
    print(f'files={len(paths)} records={len(records)} '
          f'cases={sorted({(r["set"], r["case"]) for r in records})}')
    print(summarize(records, methods))
    print(f'\n実行時間の合計 {sum(run["elapsed_sec"] for run in runs) / 60:.1f} 分')
    return 0


def ga_params_from_args(args):
    pairs = dict(ga_pop=args.ga_pop, ga_elite=args.ga_elite, ga_tournament=args.ga_tournament,
                 ga_crossover=args.ga_crossover, ga_mutation=args.ga_mutation,
                 ga_staged=None if args.ga_staged is None else bool(args.ga_staged),
                 ga_polish=args.ga_polish)
    return {k: v for k, v in pairs.items() if v is not None}


def main():
    p = argparse.ArgumentParser(description='Phase C の最適化手法（HC・SA・GA）を同条件で比べる')
    p.add_argument('--set', choices=list(CASE_SETS))
    p.add_argument('--merge', nargs='+', metavar='JSON',
                   help='分割して実行した --out の JSON を合算して集計表だけを出す')
    p.add_argument('--seeds', type=int, default=5, help='シード数（1..N を使う）')
    p.add_argument('--first-case', type=int, default=0, help='何番目のケースから使うか')
    p.add_argument('--cases', type=int, default=None, help='何ケース使うか（既定は残り全部）')
    p.add_argument('--methods', default=','.join(METHODS),
                   help='カンマ区切り。current は予算の基準なので必ず含める')
    p.add_argument('--oracle-only', action='store_true',
                   help='正解のローター・位置だけで最適化手法を比べる（速い）')
    p.add_argument('--out', default=None, help='全試行の記録を書き出す JSON のパス')
    p.add_argument('--ga-pop', type=int)
    p.add_argument('--ga-elite', type=int)
    p.add_argument('--ga-tournament', type=int)
    p.add_argument('--ga-crossover', type=float)
    p.add_argument('--ga-mutation', type=float)
    p.add_argument('--ga-staged', type=int, choices=[0, 1])
    p.add_argument('--ga-polish', type=float)
    args = p.parse_args()

    if args.merge:
        return print_merged(args.merge)
    if args.set is None:
        p.error('--set か --merge のどちらかを指定してください')
    if not HAS_OPTIMIZE:
        print('ERROR: enigma_decoder に phase2_optimize がありません。'
              'README の手順で Rust コアをビルドしてください。', file=sys.stderr)
        return 1
    methods = [m.strip() for m in args.methods.split(',') if m.strip()]
    if not methods or methods[0] != 'current' or not set(methods) <= set(METHODS):
        print(f'ERROR: --methods は current で始め、{METHODS} から選んでください。',
              file=sys.stderr)
        return 1

    last_case = None if args.cases is None else args.first_case + args.cases
    cases = make_cases(CASE_SETS[args.set])[args.first_case:last_case]
    seeds = list(range(1, args.seeds + 1))
    ga_params = ga_params_from_args(args)

    def log(msg):
        print(msg, flush=True)

    t0 = time.perf_counter()
    log(f'set={args.set} seeds={seeds} methods={methods} ga_params={ga_params or "既定"}')
    records = []
    for case in cases:
        records += run_case(case, seeds, methods, ga_params, args.oracle_only, log)
    for rec in records:
        rec['set'] = args.set
    elapsed = time.perf_counter() - t0

    log(summarize(records, methods))
    log(f'\n合計 {elapsed / 60:.1f} 分')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(dict(set=args.set, seeds=seeds, methods=methods, ga_params=ga_params,
                           elapsed_sec=elapsed, records=records), f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
