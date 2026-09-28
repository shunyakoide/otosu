import type { Audio } from '../audio/audio';
import type { AudioClock } from '../audio/clock';
import type { Midi } from '../midi/midi';
import type { Params } from './params';
import type { EngineState } from './state';

// 音を始める（最初のクリック）と、ページを離れたときに止める（D41）。

export type StartDeps = {
  params: Params;
  state: EngineState;
  audio: Audio;
  clock: AudioClock;
  /** 端末ごとの設定（音量・光など）を音に反映する */
  applyPrefs: () => void;
  /** 始めの画面を消した後（操作の案内を出す） */
  onStarted: () => void;
};

/** 画面いっぱいの「click to start」を押すと音を始める。Enter / Space でも始める */
export function setupStart(overlay: HTMLElement, { params, state, audio, clock, applyPrefs, onStarted }: StartDeps): void {
  let starting = false;
  const start = async () => {
    if (state.started || starting) return;
    starting = true;
    // iOS: マナーモードでも鳴らす（対応していないブラウザでは何もしない）
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    const content = overlay.innerHTML;
    overlay.textContent = '…';
    try {
      await audio.start(params.bpm);
    } catch (err) {
      console.warn('[otosu] audio', err);
      overlay.innerHTML = content;
      starting = false;
      return;
    }
    state.started = true;
    applyPrefs();
    audio.setSong(params.song);
    audio.setMuted(params.muted);
    const ctx = audio.raw;
    clock.measureLatency(ctx);
    // 出力の遅れは鳴り始めてから決まる端末があるので、少し後にもう一度だけ読む
    setTimeout(() => clock.measureLatency(ctx), 1500);
    console.info(`[otosu] baseLatency=${ctx.baseLatency} outputLatency=${ctx.outputLatency}`);
    state.t0 = ctx.currentTime + 0.1;
    overlay.remove();
    onStarted();
  };
  // iOS Safari は pointerdown では音を出させてくれないので click で始める
  overlay.addEventListener('click', () => void start());
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    void start();
  });
}

/**
 * タブを隠すと rAF が止まり note off が送られないので、先に全部止める。
 * パッドは rAF と関係なく鳴り続けるので、AudioContext ごと止める（一時停止と同じく時刻も止まる）。
 * 戻ったら再開する。iOS は戻ったときに interrupted のままのことがあるので resume し直す（D41）
 */
export function suspendWhenHidden({ state, audio, midi }: { state: EngineState; audio: Audio; midi: Midi }): void {
  const hide = () => {
    midi.allNotesOff();
    if (state.started) void audio.raw.suspend();
  };
  addEventListener('visibilitychange', () => {
    if (document.hidden) hide();
    else if (state.started) void audio.raw.resume();
  });
  addEventListener('pagehide', hide);
  addEventListener('pageshow', () => {
    if (state.started && !document.hidden) void audio.raw.resume();
  });
}
