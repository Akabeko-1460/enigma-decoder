import { createTechnoLoop, type MusicLoop } from "./music";
import { createGain } from "./nodes";
import { setSoundEnabled } from "./preference";
import { playSfx, type SfxName } from "./sfx";

/**
 * 音全体の統括。効果音と BGM のバスを持ち、
 * 「鳴らしてよい状態か」を 3 つの条件で判断する。
 *
 *   enabled   ユーザーが音を ON にしている
 *   unlocked  ページ上で 1 度でも操作があった（自動再生方針の解除条件）
 *   paused    タブが裏に回っている
 *
 * setInterval はタブが裏に回ると間引かれ、BGM の先読みが間に合わなくなる。
 * 裏では鳴らす意味もないので、素直に AudioContext ごと止める。
 */

const MASTER_LEVEL = 0.9;
const FADE_IN_SEC = 0.12;
/** OFF にした直後の合図音を鳴らし切りたいので、絞るほうは少し長く取る */
const FADE_OUT_SEC = 0.4;

type Rig = {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  loop: MusicLoop;
};

let rig: Rig | null = null;
let enabled = false;
let unlocked = false;
let paused = false;

/** 停止予約が古い状態のまま発火しないようにするための世代番号。 */
let generation = 0;

function ensureRig(): Rig | null {
  if (rig) return rig;
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;

  const ctx = new AudioContext();

  // 最初の一音を頭切れさせないよう、無音から立ち上げる
  const master = createGain(ctx, 0);

  // 効果音と BGM が重なったときに歪まないよう、軽く頭を押さえる
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 12;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.18;
  master.connect(limiter).connect(ctx.destination);

  const sfxBus = createGain(ctx, 1);
  sfxBus.connect(master);

  // BGM は操作音より一段下げて、効果音が埋もれないようにする
  const musicBus = createGain(ctx, 0.5);
  musicBus.connect(master);

  rig = { ctx, master, sfxBus, musicBus, loop: createTechnoLoop(ctx, musicBus) };
  return rig;
}

function shouldPlay(): boolean {
  return enabled && unlocked && !paused;
}

function fadeMaster(target: Rig, level: number, durationSec: number): void {
  const now = target.ctx.currentTime;
  const gain = target.master.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(level, now + durationSec);
}

function applyState(): void {
  const token = (generation += 1);

  if (shouldPlay()) {
    const target = ensureRig();
    if (!target) return;
    void target.ctx.resume();
    fadeMaster(target, MASTER_LEVEL, FADE_IN_SEC);
    target.loop.start();
    return;
  }

  // 一度も鳴らしていないなら AudioContext を作らないまま帰る
  if (!rig) return;
  const target = rig;
  target.loop.stop();

  if (paused) {
    target.master.gain.cancelScheduledValues(target.ctx.currentTime);
    target.master.gain.value = 0;
    void target.ctx.suspend();
    return;
  }

  fadeMaster(target, 0, FADE_OUT_SEC);
  // 無音のまま回し続けても電池を食うだけなので、絞り切ってから止める
  window.setTimeout(
    () => {
      if (token === generation && !shouldPlay()) void target.ctx.suspend();
    },
    (FADE_OUT_SEC + 0.15) * 1000
  );
}

/** ページ上で最初の操作があったときに呼ぶ。ここまでブラウザは音を出させてくれない。 */
export function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  applyState();
}

/** 保存済みの設定を起動時に反映する用。画面からの切り替えは changeSoundEnabled を使う。 */
export function setAudioEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  applyState();
}

/**
 * 音の ON/OFF を切り替える。
 * 保存と再生状態の反映、合図音の順序をここだけで決めたいので、
 * 画面側はこの関数を呼ぶ。
 */
export function changeSoundEnabled(next: boolean): void {
  // OFF の合図は、鳴らせなくなる前に出しておく必要がある
  if (!next) playUiSound("powerOff");
  setSoundEnabled(next);
  setAudioEnabled(next);
  if (next) playUiSound("powerOn");
}

/** タブが裏に回ったかどうか。 */
export function setAudioPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  applyState();
}

export function playUiSound(name: SfxName): void {
  if (!shouldPlay()) return;
  const target = ensureRig();
  if (!target) return;
  if (target.ctx.state === "suspended") void target.ctx.resume();
  playSfx(target.ctx, target.sfxBus, name);
}
