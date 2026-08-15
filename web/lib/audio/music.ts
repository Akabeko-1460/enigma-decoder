import { createFilter, createGain, createNoiseBurst, midiToFreq, pluckEnvelope } from "./nodes";

/**
 * BGM。4 つ打ちのテクノを 4 小節ループで組み立てる。
 *
 * 音源ファイルを持たないので、キック・ハイハット・クラップ・ベース・
 * アルペジオ・パッドをすべてその場で合成し、16 分音符のグリッドに並べる。
 */

const BPM = 124;
const STEPS_PER_BAR = 16;
const STEP_SEC = 60 / BPM / 4;

/**
 * 先読みスケジューリング。setInterval の精度は当てにできないので、
 * タイマーでは「これから SCHEDULE_AHEAD_SEC 以内に鳴る音」を予約するだけにし、
 * 発音時刻そのものは AudioContext の時計で決める。
 */
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.12;

/** 小節ごとの和音。暗い響きにしたいので A マイナー中心に置く。 */
const PROGRESSION = [
  { root: 33, chord: [0, 3, 7, 10] }, // Am7
  { root: 33, chord: [0, 3, 7, 10] },
  { root: 29, chord: [0, 4, 7, 11] }, // Fmaj7
  { root: 31, chord: [0, 4, 7, 10] }, // G7
];

/** ループ 1 周ぶんのステップ数。1 小節 = 1 和音 */
const TOTAL_STEPS = STEPS_PER_BAR * PROGRESSION.length;

const KICK_STEPS = [0, 4, 8, 12];
const CLAP_STEPS = [4, 12];
/** ベースはキックの裏。テクノらしい跳ねを作る */
const BASS_STEPS = [2, 6, 10, 14];
const ARP_STEPS = [0, 2, 3, 6, 8, 10, 11, 14];
const ACCENT_HAT_STEPS = [2, 6, 10, 14];

export type MusicLoop = {
  start: () => void;
  stop: () => void;
};

export function createTechnoLoop(ctx: AudioContext, destination: AudioNode): MusicLoop {
  // アルペジオだけ付点 8 分のディレイに通す。テクノの奥行きはほぼこれで決まる
  const arpBus = createGain(ctx, 1);
  const delay = ctx.createDelay(1);
  delay.delayTime.value = STEP_SEC * 3;
  const feedback = createGain(ctx, 0.34);
  const damping = createFilter(ctx, "lowpass", 2600);
  delay.connect(damping).connect(feedback).connect(delay);
  arpBus.connect(delay);
  delay.connect(destination);
  arpBus.connect(destination);

  let timer: number | null = null;
  let step = 0;
  let nextStepTime = 0;

  function scheduleStep(index: number, at: number): void {
    const bar = PROGRESSION[Math.floor(index / STEPS_PER_BAR)];
    const inBar = index % STEPS_PER_BAR;

    if (KICK_STEPS.includes(inBar)) kick(ctx, destination, at);
    if (CLAP_STEPS.includes(inBar)) clap(ctx, destination, at);
    if (inBar % 2 === 1) hat(ctx, destination, at, 0.055, 0.03);
    if (ACCENT_HAT_STEPS.includes(inBar)) hat(ctx, destination, at, 0.09, 0.1);

    if (BASS_STEPS.includes(inBar)) {
      bass(ctx, destination, at, midiToFreq(bar.root + 12));
    }

    const arpIndex = ARP_STEPS.indexOf(inBar);
    if (arpIndex >= 0) {
      // 和音の構成音を下から辿り、後半でオクターブ上へ抜ける
      const semitone =
        bar.chord[arpIndex % bar.chord.length] + (arpIndex >= bar.chord.length ? 12 : 0);
      arp(ctx, arpBus, at, midiToFreq(bar.root + 36 + semitone));
    }

    if (inBar === 0) {
      pad(
        ctx,
        destination,
        at,
        STEP_SEC * STEPS_PER_BAR,
        bar.chord.map((semitone) => midiToFreq(bar.root + 24 + semitone))
      );
    }
  }

  function pump(): void {
    // タイマーが大きく遅れた（タブが間引かれたなど）ときに、溜まった音を
    // 一気に鳴らしてしまわないよう、遅れていたら今に合わせ直す
    if (nextStepTime < ctx.currentTime) {
      nextStepTime = ctx.currentTime + 0.02;
    }

    while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      scheduleStep(step, nextStepTime);
      nextStepTime += STEP_SEC;
      step = (step + 1) % TOTAL_STEPS;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      step = 0;
      nextStepTime = ctx.currentTime + 0.08;
      timer = window.setInterval(pump, LOOKAHEAD_MS);
      pump();
    },

    stop() {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
      // 予約済みの音（最大 SCHEDULE_AHEAD_SEC ぶん）は鳴り切る。
      // 呼び出し側がマスターをフェードするので、途切れ方は目立たない。
    },
  };
}

function kick(ctx: AudioContext, destination: AudioNode, at: number): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(44, at + 0.09);

  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, at, 0.85, 0.24);

  osc.connect(gain).connect(destination);
  osc.start(at);
  osc.stop(at + 0.28);
}

function hat(
  ctx: AudioContext,
  destination: AudioNode,
  at: number,
  peak: number,
  decaySec: number
): void {
  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, at, peak, decaySec, 0.002);

  createNoiseBurst(ctx, at, decaySec + 0.03)
    .connect(createFilter(ctx, "highpass", 7800))
    .connect(gain)
    .connect(destination);
}

function clap(ctx: AudioContext, destination: AudioNode, at: number): void {
  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, at, 0.22, 0.13, 0.005);

  createNoiseBurst(ctx, at, 0.18)
    .connect(createFilter(ctx, "bandpass", 1700, 1.4))
    .connect(gain)
    .connect(destination);
}

function bass(ctx: AudioContext, destination: AudioNode, at: number, frequency: number): void {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = frequency;

  // フィルタを閉じながら鳴らすと、アシッド寄りの「ビョン」という減衰になる。
  // ランプの起点を固定するため、先に setValueAtTime で発音時刻を打つ
  const filter = createFilter(ctx, "lowpass", 1500, 8);
  filter.frequency.setValueAtTime(1500, at);
  filter.frequency.exponentialRampToValueAtTime(260, at + 0.18);

  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, at, 0.26, 0.19);

  osc.connect(filter).connect(gain).connect(destination);
  osc.start(at);
  osc.stop(at + 0.24);
}

function arp(ctx: AudioContext, destination: AudioNode, at: number, frequency: number): void {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = frequency;

  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, at, 0.1, 0.1, 0.003);

  osc.connect(createFilter(ctx, "highpass", 420)).connect(gain).connect(destination);
  osc.start(at);
  osc.stop(at + 0.14);
}

function pad(
  ctx: AudioContext,
  destination: AudioNode,
  at: number,
  durationSec: number,
  frequencies: number[]
): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.05, at + durationSec * 0.35);
  gain.gain.linearRampToValueAtTime(0.0001, at + durationSec);

  const filter = createFilter(ctx, "lowpass", 700, 0.8);
  filter.frequency.setValueAtTime(700, at);
  filter.frequency.linearRampToValueAtTime(1600, at + durationSec * 0.6);
  filter.frequency.linearRampToValueAtTime(700, at + durationSec);
  filter.connect(gain).connect(destination);

  for (const frequency of frequencies) {
    // 2 本をわずかにずらして厚みを出す
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(at);
      osc.stop(at + durationSec + 0.05);
    }
  }
}
