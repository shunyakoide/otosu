// AudioContext の時刻と performance.now の対応（D29）。
// getOutputTimestamp / outputLatency は音声スレッドのロックを待つことがあり、毎フレーム呼ぶと
// 1〜2秒固まることがあった。ロックの要らない currentTime だけを見て、なめらかな時計を作る。

/** これより大きくずれたら（中断や復帰）なめらかにせず合わせ直す（秒） */
const SNAP_SEC = 0.1;
/** 1回ごとに、ずれのこの割合だけ寄せる */
const FOLLOW = 0.05;

export class AudioClock {
  private ctxAt = NaN;
  private perfAt = 0;
  /** 出力の遅れ（秒）。currentTime の音がスピーカーから出るまで */
  latency = 0;

  /** 出力の遅れを読み直す（ロックを待つことがあるので、開始時など一度だけ呼ぶ） */
  measureLatency(ctx: BaseAudioContext & { outputLatency?: number; baseLatency?: number }): void {
    this.latency = ctx.outputLatency || ctx.baseLatency || 0;
  }

  /** 毎フレーム呼ぶ。currentTime（音声の処理の区切りごとに飛んで進む）と now（ms）から、今のコンテキスト時刻を返す */
  update(currentTime: number, now: number): number {
    const predicted = this.ctxAt + (now - this.perfAt) / 1000;
    const err = currentTime - predicted;
    if (!(Math.abs(err) < SNAP_SEC)) this.ctxAt = currentTime;
    else this.ctxAt = predicted + err * FOLLOW;
    this.perfAt = now;
    return this.ctxAt;
  }

  /** 今スピーカーから出ている音のコンテキスト時刻 */
  audible(): number {
    return this.ctxAt - this.latency;
  }

  /** コンテキスト時刻 → その音がスピーカーから聞こえる performance.now 時刻（ms） */
  toPerf(audioTime: number): number {
    return this.perfAt + (audioTime - this.ctxAt + this.latency) * 1000;
  }
}
