import { createFilter, createGain, createNoiseBurst, pluckEnvelope } from "./nodes";

/**
 * UI 効果音。どれも 0.3 秒未満で、操作の邪魔にならない範囲で
 * 「押した手応え」だけを返す。
 */
export type SfxName =
  /** 汎用のボタン */
  | "click"
  /** ページ遷移リンク */
  | "nav"
  /** セグメント切替・チェック系 */
  | "toggle"
  /** 解読開始などの実行ボタン */
  | "launch"
  | "powerOn"
  | "powerOff";

export function playSfx(ctx: AudioContext, destination: AudioNode, name: SfxName): void {
  const now = ctx.currentTime;

  switch (name) {
    case "click":
      blip(ctx, destination, now, { from: 1480, to: 940, peak: 0.16, decaySec: 0.05 });
      tick(ctx, destination, now, 0.05);
      break;

    case "nav":
      blip(ctx, destination, now, { from: 620, to: 1240, peak: 0.13, decaySec: 0.09 });
      break;

    case "toggle":
      blip(ctx, destination, now, { from: 520, to: 760, peak: 0.14, decaySec: 0.07 });
      tick(ctx, destination, now, 0.03);
      break;

    case "launch":
      sweep(ctx, destination, now);
      break;

    case "powerOn":
      chime(ctx, destination, now, [523.25, 783.99, 1046.5]);
      break;

    case "powerOff":
      chime(ctx, destination, now, [1046.5, 783.99, 523.25]);
      break;
  }
}

type BlipOptions = {
  from: number;
  to: number;
  peak: number;
  decaySec: number;
};

/** 音程が滑る短い矩形波。デジタル機器のビープの芯になる。 */
function blip(
  ctx: AudioContext,
  destination: AudioNode,
  startAt: number,
  { from, to, peak, decaySec }: BlipOptions
): void {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(from, startAt);
  osc.frequency.exponentialRampToValueAtTime(to, startAt + decaySec);

  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, startAt, peak, decaySec);

  // 矩形波そのままだと耳に刺さるので、高域を落として角を丸める
  osc.connect(createFilter(ctx, "lowpass", 5200)).connect(gain).connect(destination);
  osc.start(startAt);
  osc.stop(startAt + decaySec + 0.03);
}

/** 押した瞬間の「カチッ」。ノイズの立ち上がりだけを使う。 */
function tick(
  ctx: AudioContext,
  destination: AudioNode,
  startAt: number,
  peak: number
): void {
  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, startAt, peak, 0.018, 0.001);
  createNoiseBurst(ctx, startAt, 0.04)
    .connect(createFilter(ctx, "highpass", 3800))
    .connect(gain)
    .connect(destination);
}

/** 実行ボタン。低音から駆け上がって、最後にノイズで抜ける。 */
function sweep(ctx: AudioContext, destination: AudioNode, startAt: number): void {
  const durationSec = 0.3;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(150, startAt);
  osc.frequency.exponentialRampToValueAtTime(880, startAt + durationSec);

  const filter = createFilter(ctx, "lowpass", 600, 7);
  filter.frequency.setValueAtTime(600, startAt);
  filter.frequency.exponentialRampToValueAtTime(4200, startAt + durationSec);

  const gain = createGain(ctx, 0);
  pluckEnvelope(gain, startAt, 0.2, durationSec, 0.03);

  osc.connect(filter).connect(gain).connect(destination);
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.05);

  const airGain = createGain(ctx, 0);
  pluckEnvelope(airGain, startAt + durationSec - 0.04, 0.1, 0.16, 0.02);
  createNoiseBurst(ctx, startAt + durationSec - 0.06, 0.24)
    .connect(createFilter(ctx, "highpass", 2400))
    .connect(airGain)
    .connect(destination);
}

/** 音を ON/OFF したときの合図。3 音を駆け上がる／駆け下りる。 */
function chime(
  ctx: AudioContext,
  destination: AudioNode,
  startAt: number,
  frequencies: number[]
): void {
  const stepSec = 0.075;

  frequencies.forEach((frequency, index) => {
    const at = startAt + index * stepSec;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = frequency;

    const gain = createGain(ctx, 0);
    pluckEnvelope(gain, at, 0.16, 0.14, 0.006);

    osc.connect(gain).connect(destination);
    osc.start(at);
    osc.stop(at + 0.2);
  });
}
