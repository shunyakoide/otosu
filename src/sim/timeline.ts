import { beatSteps, HZ, SECTION_BARS } from './constants';
import { sectionAt, sectionSteps } from './music';

/**
 * 拍の格子とハーモニー区間の基準（D9, D10）。テンポを変えたとき・配置を読み込んだときに、
 * そのステップを起点（anchor）に取り直す。放出・くり返しの格子と区間は、どれもこの起点から数える
 */
export class Timeline {
  bpm: number;
  /** 起点のステップと、そこでの区間番号 */
  anchor = 0;
  base = 0;
  /** 1区間のステップ数 */
  sectionLen: number;

  constructor(bpm: number) {
    this.bpm = bpm;
    this.sectionLen = sectionSteps(bpm, SECTION_BARS, HZ);
  }

  /** s を起点に、区間 base から新しいテンポで数え直す */
  retime(s: number, bpm: number, base: number): void {
    this.base = base;
    this.anchor = s;
    this.bpm = bpm;
    this.sectionLen = sectionSteps(bpm, SECTION_BARS, HZ);
  }

  /** ステップのハーモニー区間（0..3） */
  sectionAt(step: number): number {
    return sectionAt(step, this.anchor, this.base, this.sectionLen);
  }

  /** energy の窓（2 小節 = 区間の 1/4） */
  get energyWindow(): number {
    return Math.max(1, Math.round(this.sectionLen / 4));
  }

  /** 格子 anchor + round(k·beats 拍) のうち、c 以上で最初のステップ（放出の格子と同じ式） */
  gridAtOrAfter(c: number, beats: number): number {
    const a = this.anchor;
    const p = beatSteps(beats, this.bpm);
    let k = Math.max(0, Math.ceil((c - a) / p) - 1);
    while (a + Math.round(k * p) < c) k++;
    return a + Math.round(k * p);
  }
}
