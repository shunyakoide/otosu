import { beatSteps, ECHO_BEATS, ECHO_COUNT, ECHO_DECAY, RISE_BEATS, RISE_COUNT, RISE_DECAY } from './constants';
import { formMidi, riseSlot, type SongId } from './music';
import type { Shape } from './shape';
import type { Timeline } from './timeline';
import type { HitEvent, ShapeEffect, SimEvent } from './types';

type Repeat = { ev: HitEvent; k: number; step: number };

/** くり返しの間隔（拍）。rise は半拍、それ以外（echo）は1拍 */
const beatsOf = (effect: ShapeEffect | undefined): number => (effect === 'rise' ? RISE_BEATS : ECHO_BEATS);

/**
 * echo / rise のくり返し（D32）。group → 当たった音の写しと、次に出す回数・ステップ。
 * 1つの図形のくり返しは常に1列（また当たったら、その音から数え直す）。Map の挿入順で出すので決定論的
 */
export class Repeats {
  private readonly items = new Map<number, Repeat>();
  private readonly time: Timeline;
  private readonly shapes: ReadonlyMap<number, Shape>;

  constructor(time: Timeline, shapes: ReadonlyMap<number, Shape>) {
    this.time = time;
    this.shapes = shapes;
  }

  delete(group: number): void {
    this.items.delete(group);
  }

  clear(): void {
    this.items.clear();
  }

  /**
   * 当たった音 ev のくり返しを予約する。最初は格子の半分以上あけた次の格子（当たった音とくっつかないように）。
   * 同じ図形の残りは捨てて数え直す
   */
  start(s: number, effect: 'echo' | 'rise', ev: HitEvent): void {
    const beats = beatsOf(effect);
    const gap = Math.ceil(beatSteps(beats, this.time.bpm) / 2);
    this.items.delete(ev.group);
    this.items.set(ev.group, { ev: { ...ev }, k: 1, step: this.time.gridAtOrAfter(s + gap, beats) });
  }

  /** 残りのくり返しを新しい格子（s から始まる）に取り直す（テンポ変更のあと） */
  regrid(s: number): void {
    for (const r of this.items.values()) r.step = this.time.gridAtOrAfter(s, beatsOf(this.shapes.get(r.ev.group)?.effect));
  }

  /**
   * 時刻の来たくり返しを out に出す。区間と音高は鳴らすステップで決め直す。
   * 出すイベントの step はすべて s（drainEvents の順序は崩れない）。chain・energy には数えない
   */
  flush(s: number, song: SongId, out: SimEvent[]): void {
    if (this.items.size === 0) return;
    for (const [group, r] of this.items) {
      if (r.step > s) continue;
      const sh = this.shapes.get(group);
      const rise = sh?.effect === 'rise';
      const note = rise ? riseSlot(r.ev.form, r.ev.note, r.k) : r.ev.note;
      if (!sh || note < 0) {
        this.items.delete(group);
        continue;
      }
      const section = this.time.sectionAt(s);
      out.push({
        ...r.ev, step: s, echo: r.k, note, section, midi: formMidi(r.ev.form, note, section, song),
        velocity: r.ev.velocity * Math.pow(rise ? RISE_DECAY : ECHO_DECAY, r.k),
      });
      r.k++;
      if (r.k > (rise ? RISE_COUNT : ECHO_COUNT)) this.items.delete(group);
      else r.step = this.time.gridAtOrAfter(s + 1, beatsOf(sh.effect));
    }
  }
}
