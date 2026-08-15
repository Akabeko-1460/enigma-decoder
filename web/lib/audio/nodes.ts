/**
 * Web Audio の細かい手続きをまとめた部品置き場。
 *
 * 音源ファイルは一切使わず、効果音も BGM もここにある部品で合成する
 * （素材のライセンス確認が不要、追加ダウンロードが 0 バイトで済むため）。
 */

/** 指数ランプはゼロを扱えないので、無音の代わりに使う下限値。 */
const SILENT = 0.0001;

/** MIDI ノート番号を周波数に直す（69 = A4 = 440Hz）。 */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

/**
 * ホワイトノイズ。ハイハットやクリック音の芯に使う。
 * 生成コストが小さくないので AudioContext ごとに 1 本だけ作って使い回す。
 */
export function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;

  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.random() * 2 - 1;
  }

  noiseBuffers.set(ctx, buffer);
  return buffer;
}

/**
 * 立ち上がりが一瞬で、あとは指数的に減衰するエンベロープ。
 * 打楽器・クリック音・プラック系の音はすべてこの形。
 */
export function pluckEnvelope(
  gain: GainNode,
  startAt: number,
  peak: number,
  decaySec: number,
  attackSec = 0.004
): void {
  const param = gain.gain;
  param.setValueAtTime(SILENT, startAt);
  param.exponentialRampToValueAtTime(peak, startAt + attackSec);
  param.exponentialRampToValueAtTime(SILENT, startAt + attackSec + decaySec);
}

/**
 * 一発ぶんのノイズ源。接続は呼び出し側で行う。
 * 毎回ランダムな位置から読み出すので、連打しても同じ音には聞こえない。
 */
export function createNoiseBurst(
  ctx: AudioContext,
  startAt: number,
  durationSec: number
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.start(startAt, Math.random() * 1.5);
  source.stop(startAt + durationSec);
  return source;
}

/** バンドを絞ったフィルタ。ノイズから打楽器の音色を作るのに使う。 */
export function createFilter(
  ctx: AudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 1
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

export function createGain(ctx: AudioContext, value: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = value;
  return gain;
}
