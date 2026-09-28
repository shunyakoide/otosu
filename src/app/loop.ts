import type { Audio } from '../audio/audio';
import type { AudioClock } from '../audio/clock';
import type { Input } from '../input/input';
import type { Midi } from '../midi/midi';
import type { Renderer } from '../render/render';
import { HISTORY, HZ } from '../sim/constants';
import type { Sim } from '../sim/sim';
import type { SimEvent } from '../sim/types';
import type { Params } from './params';
import type { EngineState } from './state';

// 時計は AudioContext の1本（decisions.md D3, D8）。
// sim は LOOKAHEAD ぶん先行し、音は t0 + step/HZ に予約、描画は「今聴こえている時刻」の世界を表示する。

const LOOKAHEAD = 0.05;
const MAX_STEPS_PER_FRAME = 8;
const MAX_LAG = 0.1;
const LATE_DROP = 0.02;

export type LoopDeps = {
  params: Params;
  state: EngineState;
  sim: Sim;
  audio: Audio;
  midi: Midi;
  renderer: Renderer;
  input: Input;
  clock: AudioClock;
};

/** ?fps: 実機で重さを確かめるための表示（fps と画質の段階。D27） */
function fpsMeter(renderer: Renderer): ((now: number) => void) | null {
  if (!new URLSearchParams(location.search).has('fps')) return null;
  const el = document.body.appendChild(document.createElement('div'));
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;font:11px monospace;color:#8f8;pointer-events:none;z-index:9';
  let frames = 0;
  let t = performance.now();
  return (now) => {
    if (++frames && now - t >= 1000) {
      el.textContent = `${Math.round((frames * 1000) / (now - t))} fps · q${renderer.qualityLevel}`;
      frames = 0;
      t = now;
    }
  };
}

export function startLoop({ params, state, sim, audio, midi, renderer, input, clock }: LoopDeps): void {
  // 音の時計（D29）: getOutputTimestamp は音声スレッドを待って固まることがあるので使わない
  const toPerf = (audioTime: number): number => clock.toPerf(audioTime);
  const fps = fpsMeter(renderer);
  let lastFrame = performance.now();

  function frame(now: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    fps?.(now);

    if (!state.started) {
      renderer.render(sim, -1, dt, input.preview);
      return;
    }

    const ctx = audio.raw;
    const ct = ctx.currentTime;
    clock.update(ct, now);

    // 遅れすぎたら基準を取り直し、飛ばした時間は捨てる（D8-1）
    let target = Math.floor((ct - state.t0 + LOOKAHEAD) * HZ);
    if (target - sim.step > MAX_LAG * HZ) {
      state.t0 = ct + LOOKAHEAD - (sim.step + 1) / HZ;
      target = sim.step + 1;
    }
    for (let n = 0; sim.step < target && n < MAX_STEPS_PER_FRAME; n++) sim.advance();

    const t0 = state.t0;
    const kept: SimEvent[] = [];
    for (const e of sim.drainEvents()) {
      const time = t0 + e.step / HZ;
      if (e.kind === 'hit') {
        midi.record(e); // 録音は step 基準なので、遅れて捨てる衝突も入れる
        if (time < ct - LATE_DROP) continue; // 音も光も捨てる
        if (params.internalSound) audio.play(e, Math.max(time, ct));
        if (!params.muted && !state.paused) midi.play(e, Math.max(time, ct), toPerf);
      } else if (e.kind === 'section') {
        audio.setSection(e.root, Math.max(time, ct));
      } else if (e.kind === 'shapeAdded') {
        // 確定音（D11: 入力へのフィードバック。MIDI には送らない）
        if (params.internalSound && time >= ct - LATE_DROP) audio.confirm(e.midi, Math.max(time, ct), e.form);
      }
      kept.push(e);
    }
    renderer.push(kept);
    midi.update();

    let rs = (clock.audible() - t0) * HZ + (params.visualOffsetMs / 1000) * HZ;
    rs = Math.min(sim.step - 1, Math.max(sim.step - HISTORY + 2, rs));
    renderer.render(sim, rs, dt, input.preview);
  }
  requestAnimationFrame(frame);
}
