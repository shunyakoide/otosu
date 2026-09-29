import {
  AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, type Color,
} from 'three';
import { midiToFreq } from '../sim/music';

// 当たった点のオシロスコープ（D62、scope）。当たった点を中心に、そのとき鳴っている音の波形が横に伸びる。
// 波形は出力（リミッターのあと）の analyser から取る。出てすぐのあいだは毎フレーム取り直し（音が立ち上がるのを見せる）、
// そのあとは止めてゆっくり消える。オシロと同じく、上向きに 0 を横切るところにそろえて揺れを抑える。
// 音を出していない（ミュート・MIDI だけ・始める前）ときは、鳴らした音高の減衰する正弦波を描く。
// 時刻は renderStep から取るので、止めると止まる。

/** 同時に出す数、出ている秒、波形を取り直し続ける秒、次を出すまでの最短の間（秒） */
const MAX_SCOPE = 3;
const SCOPE_SEC = 1.3;
const LIVE_SEC = 0.28;
const SCOPE_GAP = 0.15;
/** 線の点の数、横幅・振れ幅（CSS px）、中心から両端へ広がる秒 */
const POINTS = 192;
const SCOPE_W = 280;
const SCOPE_AMP = 28;
const OPEN_SEC = 0.12;
/** 波形として描く長さ（秒）。analyser の窓（2048 点）の半分ほど */
const WINDOW_SEC = 0.02;
/** これより小さい振れ幅は「鳴っていない」とみなす */
const SILENT = 0.004;

/** 出力の波形を out に書く（書けなければ false）。書いた点の間隔（秒）も返す */
export type WaveSource = (out: Float32Array<ArrayBuffer>) => number;

type Item = { at: number; x: number; y: number; v: number; midi: number; wave: Float32Array; filled: boolean };

export class Scope {
  readonly object: LineSegments;
  /** 出力の波形（Audio が始まったら main が渡す） */
  source: WaveSource | null = null;
  private readonly items: Item[] = [];
  private head = 0;
  private last = -Infinity;
  private lastTime = -Infinity;
  private readonly raw = new Float32Array(2048);
  private readonly pos: BufferAttribute;
  private readonly col: BufferAttribute;

  constructor() {
    for (let i = 0; i < MAX_SCOPE; i++) {
      this.items.push({ at: -Infinity, x: 0, y: 0, v: 0, midi: 60, wave: new Float32Array(POINTS), filled: false });
    }
    const g = new BufferGeometry();
    const n = MAX_SCOPE * (POINTS - 1) * 2 * 3;
    this.pos = new BufferAttribute(new Float32Array(n), 3);
    this.col = new BufferAttribute(new Float32Array(n), 3);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    this.object = new LineSegments(g, new LineBasicMaterial({
      vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  /** 当たった（ワールド座標、時刻は秒、midi = 鳴らした音高） */
  hit(x: number, y: number, at: number, strength: number, midi: number): void {
    if (at - this.last < SCOPE_GAP) return;
    this.last = at;
    Object.assign(this.items[this.head]!, { at, x, y, v: Math.min(1, strength), midi, filled: false });
    this.head = (this.head + 1) % MAX_SCOPE;
  }

  /** 出力から波形を取る。鳴っていなければ false */
  private capture(wave: Float32Array): boolean {
    const dt = this.source?.(this.raw) ?? 0;
    if (dt <= 0) return false;
    const raw = this.raw;
    let peak = 0;
    for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]!));
    if (peak < SILENT) return false;
    const span = Math.min(raw.length - 1, Math.round(WINDOW_SEC / dt));
    // 前半で、上向きに 0 を横切るところから描く（見つからなければ先頭から）
    let start = 0;
    for (let i = 1; i < raw.length - span; i++) {
      if (raw[i - 1]! < 0 && raw[i]! >= 0) {
        start = i;
        break;
      }
    }
    const gain = 1 / Math.max(peak, 0.05);
    for (let j = 0; j < POINTS; j++) wave[j] = raw[start + Math.round((j / (POINTS - 1)) * span)]! * gain;
    return true;
  }

  /** 音が出ていないとき: 鳴らした音高の減衰する正弦波 */
  private synth(wave: Float32Array, midi: number): void {
    const f = midiToFreq(midi);
    for (let j = 0; j < POINTS; j++) {
      const t = (j / (POINTS - 1)) * WINDOW_SEC;
      wave[j] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / (WINDOW_SEC * 0.6));
    }
  }

  /** 毎フレーム呼ぶ。time = 表示している時刻（秒）、scale = CSS px / ワールド px */
  update(on: boolean, time: number, scale: number, base: Color): void {
    this.object.visible = on;
    const moving = time !== this.lastTime;
    this.lastTime = time;
    if (!on) return;
    const pos = this.pos;
    const col = this.col;
    const w = SCOPE_W / scale;
    let k = 0;
    for (const it of this.items) {
      const age = time - it.at;
      const live = age >= 0 && age < SCOPE_SEC;
      if (live && ((moving && age < LIVE_SEC) || !it.filled)) {
        if (this.capture(it.wave)) it.filled = true;
        else if (!it.filled) {
          this.synth(it.wave, it.midi);
          it.filled = true;
        }
      }
      const q = live ? age / SCOPE_SEC : 1;
      const a = live ? (0.35 + 0.35 * it.v) * (1 - q) ** 1.4 * (1 + Math.max(0, 1 - age / 0.1)) : 0;
      const amp = (SCOPE_AMP * (0.5 + 0.5 * it.v)) / scale;
      // 中心から両端へ開く
      const open = 1 - (1 - Math.min(1, Math.max(0, age) / OPEN_SEC)) ** 3;
      for (let j = 0; j < POINTS - 1; j++) {
        for (const i of [j, j + 1]) {
          const u = i / (POINTS - 1) - 0.5;
          // 両端は細く絞る（当たった点のまわりが一番大きく振れる）
          const taper = Math.cos(Math.PI * u) ** 2;
          const shown = Math.abs(u) * 2 <= open ? 1 : 0;
          pos.setXYZ(k, it.x + u * w, -it.y + (it.wave[i] ?? 0) * amp * taper, 0);
          const c = a * shown * (0.35 + 0.65 * taper);
          col.setXYZ(k++, base.r * c, base.g * c, base.b * c);
        }
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as LineBasicMaterial).dispose();
  }
}
