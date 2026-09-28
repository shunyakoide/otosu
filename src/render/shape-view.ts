import { Color } from 'three';
import { HZ, LINE_WIDTH, MIN_LINE_LEN, WORLD_W } from '../sim/constants';
import { lengthToNote } from '../sim/music';
import type { ShapeAddedEvent } from '../sim/types';
import type { Glints } from './glints';
import { FX_WAVE_SEC, Outline } from './outline';
import { GRAY, noteColor, OFF_WHITE, type ColorMode } from './palette';
import type { Ripples } from './ripples';
import { hitTest, makeShape, MAX_VERTS, pose, shapeAngle, vertexAngle, type Shape } from './shape';

// 図形の線を描く: 形ごとの光（D16）、共鳴・連鎖の光らせ直し、ホバーと選択（D54）、エフェクトの輪郭（D32）、
// 消えていく図形、描いている途中の図形（プレビュー）。

/** 描画中の図形とホバー（座標は論理ワールド）。input.ts が書き、render が読む */
export type Preview = {
  active: boolean;
  /** 頂点列 [x0, y0, x1, y1, ...] */
  points: number[];
  closed: boolean;
  bumper: boolean;
  /** 周長（音程の決定に使う） */
  perimeter: number;
  hover: { active: boolean; x: number; y: number };
};

/** 消えていく図形。delay 秒待ってから dur 秒で消える */
export type Dying = { shape: Shape; phi: number; step: number; delay: number; dur: number };
type FxWave = { group: number; step: number; v: number };

// 削除（step2 案3）
const DIE_SEC = 0.2;
const WIPE_SEC = 0.3;
const WIPE_DELAY_SEC = 0.15;
const HOVER_TAU = 0.05;
/** メニューを開いている図形をゆっくり明滅させる周期（秒、D54） */
const SELECT_PERIOD = 1.6;
/** そのとき、いちばん薄いところで消す割合 */
const SELECT_FADE = 0.85;
/** 当たるたびに広がる輪郭（D32）を覚えておく数 */
const MAX_FX_WAVES = 64;

// 形ごとの光（D16）。音と光は 1:1: 光るのは HitEvent の step だけ
// circle（キック）: 図形全体が脈打つ（速い立ち上がり → 減衰）＋重心から輪が広がる。大きい円ほどゆっくり大きく
const KICK_ATTACK = 0.015;
/** 脈の減衰の時定数: 小さい円 KICK_DECAY_MIN → 半径 KICK_BIG_R 以上で +KICK_DECAY_BIG */
const KICK_DECAY_MIN = 0.3;
const KICK_DECAY_BIG = 0.25;
const KICK_BIG_R = 200;
/** 脈のときの明るさの上乗せ（0.35 + 0.55v）· 包絡（最大 ~0.85） */
const KICK_GAIN = 0.35;
const KICK_GAIN_V = 0.55;
/** 重心まわりの拡大（(0.5 + v) · KICK_SCALE · 包絡） */
const KICK_SCALE = 0.03;
/** 輪: 図形の半径から grow = KICK_RING_GROW + KICK_RING_GROW_K·半径 だけ広がる。長さ dur = KICK_RING_SEC + KICK_RING_SEC_BIG·(大きさ) */
const KICK_RING_GROW = 20;
const KICK_RING_GROW_K = 0.6;
const KICK_RING_SEC = 0.7;
const KICK_RING_SEC_BIG = 0.8;
const KICK_RING_GAIN = 0.45;
// triangle（金属）: 辺に沿って細かいきらめきが散り（glints.ts）、長く残る
const METAL_TAU = 2.5;
/** 図形全体の長い余韻（控えめ） */
const METAL_GLOW = 0.12;
// square（木）: 短く鋭い閃光、余韻ほぼなし。一瞬だけ外側に細い輪郭が弾ける
const WOOD_FLASH = 0.045;
const WOOD_TAU = 0.15;
const WOOD_ECHO_SEC = 0.12;
const WOOD_ECHO_GROW = 0.06;
// 図形の形の輪（円の KICK_RING と同じく、重心から図形と同じ形の輪郭が広がる）
// square: 短く速く弾け出る。triangle: ゆっくり広がりながら少し回り、長く残る
const WOOD_RING_GROW = 14;
const WOOD_RING_GROW_K = 0.35;
const WOOD_RING_SEC = 0.35;
const WOOD_RING_GAIN = 0.6;
const METAL_RING_GROW = 24;
const METAL_RING_GROW_K = 0.7;
const METAL_RING_SEC = 1.6;
const METAL_RING_GAIN = 0.35;
/** 広がるあいだに回る角度（rad） */
const METAL_RING_SPIN = 0.35;

const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
/** 弦の余韻の時定数: 低音（note 0）ほど長い 1.5s → 高音（note 15）0.4s */
const stringTau = (note: number) => 1.5 - (1.1 * Math.min(15, Math.max(0, note))) / 15;
/** 円の大きさ 0..1 */
const kickSize = (r: number) => Math.min(1, Math.max(0, r / KICK_BIG_R));

/** 同じステップで複数の図形が消えた（clear / loadScene）ときは左から右へ拭うように消す */
export function stagger(group: Dying[]): void {
  if (group.length < 2) return;
  for (const d of group) {
    d.delay = WIPE_DELAY_SEC * Math.min(1, Math.max(0, d.shape.gx / WORLD_W));
    d.dur = WIPE_SEC;
  }
}

export class ShapeView {
  /** 描いている図形（group → 図形） */
  readonly shapes = new Map<number, Shape>();
  readonly outline = new Outline();
  /** メニューを開いている図形（-1 でなし）。ゆっくり明滅させ、どれを選んだかわかるようにする（D54） */
  selected = -1;
  private selectedWas = -1;
  private selectT = 0;
  private readonly dying = new Map<number, Dying>();
  private readonly hoverAmt = new Map<number, number>();
  private readonly fxWaves: FxWave[] = [];
  private readonly previewVerts = new Float32Array(MAX_VERTS * 2);
  private previewNote = -1;
  private previewFlashAt = -Infinity;
  private readonly tint = new Color();
  private readonly hitOut = { dist: 0, inside: false };
  private readonly ripples: Ripples;
  private readonly glints: Glints;

  constructor(ripples: Ripples, glints: Glints) {
    this.ripples = ripples;
    this.glints = glints;
  }

  add(e: ShapeAddedEvent): Shape {
    const shape = makeShape(e);
    this.shapes.set(e.group, shape);
    // 置いた瞬間（確定音）: 形の光で鳴らす。line / pen は始点から光が走る
    this.trigger(shape, e.step, 0.5, 0);
    return shape;
  }

  /** 図形を描く対象から外す（消える動きは die で決める） */
  drop(group: number): Shape | undefined {
    const s = this.shapes.get(group);
    if (!s) return undefined;
    this.shapes.delete(group);
    this.hoverAmt.delete(group);
    return s;
  }

  /** 外した図形を、消えていく図形として残す（同じステップで消えた図形はあとで stagger に渡す） */
  die(s: Shape, step: number): Dying {
    const d: Dying = { shape: s, phi: shapeAngle(s, step), step, delay: 0, dur: DIE_SEC };
    this.dying.set(s.group, d);
    return d;
  }

  /** エフェクトの付いた図形に当たった: 輪郭が外へ広がる（D32） */
  fxHit(s: Shape, step: number, v: number): void {
    if (s.effect === 'none') return;
    if (this.fxWaves.length >= MAX_FX_WAVES) this.fxWaves.shift();
    this.fxWaves.push({ group: s.group, step, v });
  }

  /** 図形を形の性格で光らせる（衝突・確定音の共通） */
  trigger(s: Shape, step: number, v: number, arc: number): void {
    switch (s.form) {
      case 'circle': {
        const k = kickSize(s.radius);
        s.hit = { step, v, s: 0, tau: KICK_DECAY_MIN + KICK_DECAY_BIG * k };
        // 重心から広がる淡い輪（大きい円ほどゆっくり大きく）
        this.ripples.push({
          x: s.gx, y: s.gy, step, note: s.note, r0: s.radius,
          grow: KICK_RING_GROW + KICK_RING_GROW_K * s.radius,
          dur: KICK_RING_SEC + KICK_RING_SEC_BIG * k,
          gain: KICK_RING_GAIN * (0.4 + v),
        });
        break;
      }
      case 'triangle':
        s.hit = { step, v, s: arc, tau: METAL_TAU };
        this.glints.spawn(s, step, v, arc);
        // 重心から三角の輪郭がゆっくり回りながら広がる（回る向きは図形の回る向き、止まっていれば交互）
        this.ripples.push({
          x: s.gx, y: s.gy, step, note: s.note, r0: s.radius,
          grow: METAL_RING_GROW + METAL_RING_GROW_K * s.radius,
          dur: METAL_RING_SEC, gain: METAL_RING_GAIN * (0.4 + v),
          sides: 3, angle: vertexAngle(s, step),
          spin: METAL_RING_SPIN * (s.omega !== 0 ? Math.sign(s.omega) : step % 2 ? 1 : -1),
        });
        break;
      case 'square':
        s.hit = { step, v, s: arc, tau: WOOD_TAU };
        // 重心から四角の輪郭が短く弾け出る
        this.ripples.push({
          x: s.gx, y: s.gy, step, note: s.note, r0: s.radius,
          grow: WOOD_RING_GROW + WOOD_RING_GROW_K * s.radius,
          dur: WOOD_RING_SEC, gain: WOOD_RING_GAIN * (0.4 + v),
          sides: 4, angle: vertexAngle(s, step),
        });
        break;
      default:
        s.hit = { step, v, s: arc, tau: stringTau(s.note) };
    }
  }

  /**
   * 表示中の図形のうち (x, y) に最も近いものの group（なければ -1）。
   * 辺から radius 以内、または閉じた図形の内側。姿勢はステップ rs のもの（B3）。
   */
  pick(x: number, y: number, radius: number, rs: number): number {
    const o = this.hitOut;
    let bestId = -1;
    let best = radius;
    for (const s of this.shapes.values()) {
      hitTest(s, shapeAngle(s, rs), x, y, o);
      if (o.dist < best) {
        best = o.dist;
        bestId = s.group;
      }
      // 内側は、他の図形の辺の近くより優先度を下げる
      if (o.inside && bestId < 0) {
        best = radius * 0.99;
        bestId = s.group;
      }
    }
    return bestId;
  }

  private updateHover(dt: number, preview: Preview, pickR: number, rs: number): void {
    const h = preview.hover;
    const target = !preview.active && h.active ? this.pick(h.x, h.y, pickR, rs) : -1;
    const k = 1 - Math.exp(-dt / HOVER_TAU);
    if (target >= 0 && !this.hoverAmt.has(target)) this.hoverAmt.set(target, 0);
    for (const [id, v] of this.hoverAmt) {
      const nv = v + ((id === target ? 1 : 0) - v) * k;
      if (id !== target && nv < 0.01) this.hoverAmt.delete(id);
      else this.hoverAmt.set(id, nv);
    }
  }

  /** 毎フレーム呼ぶ。idle = 待機の線の明るさ、thick = 線を太く描く倍率（D26）、pickR = ホバーで図形を選ぶ半径 */
  draw(rs: number, dt: number, preview: Preview, mode: ColorMode, idle: number, thick: number, pickR: number): void {
    this.updateHover(dt, preview, pickR, rs);
    if (this.selected !== this.selectedWas) {
      this.selectedWas = this.selected;
      this.selectT = 0;
    }
    this.selectT += dt;
    // 0 → 1 → 0 をなめらかに（開いた瞬間はいつもの濃さから薄くなっていく）
    const pulse = 0.5 - 0.5 * Math.cos((2 * Math.PI * this.selectT) / SELECT_PERIOD);
    const out = this.outline;
    out.begin(thick);
    const tint = this.tint;

    for (const s of this.shapes.values()) {
      let base = idle;
      let spot = 0;
      let sigma = 1;
      let sHit = 0;
      let vib = 0;
      let white = 0;
      let k = 1;
      let echo = 0;
      let echoK = 1;
      const h = s.hit;
      if (h) {
        const t = Math.max(0, (rs - h.step) / HZ);
        if (t > 3 * h.tau && t > 1.2) {
          s.hit = null;
        } else if (s.form === 'circle') {
          // キック: 図形全体が脈打つ（速い立ち上がり → h.tau で減衰）。打点の光・揺れはなし
          const env = (1 - Math.exp(-t / KICK_ATTACK)) * Math.exp(-t / h.tau);
          base += (KICK_GAIN + KICK_GAIN_V * h.v) * env;
          k = 1 + KICK_SCALE * (0.5 + h.v) * env;
          white = 0.15 * env;
        } else if (s.form === 'triangle') {
          // 金属: 短い閃き + 打点の細い光がゆっくり滲む + 長く淡い余韻（きらめきの粒は glints.ts）
          base += (0.3 + 0.4 * h.v) * Math.exp(-t / 0.08) + METAL_GLOW * h.v * Math.exp(-t / h.tau);
          spot = (0.5 + 0.9 * h.v) * Math.exp(-t / 0.3);
          sigma = Math.min(4 + 60 * t, s.perimeter);
          sHit = h.s;
          white = 0.3 * Math.exp(-t / 0.05);
        } else if (s.form === 'square') {
          // 木: 短く鋭い閃光、余韻ほぼなし。外側に細い輪郭が一瞬弾ける
          base += (0.6 + 0.8 * h.v) * Math.exp(-t / WOOD_FLASH);
          spot = (0.8 + 1.2 * h.v) * Math.exp(-t / 0.05);
          sigma = 14;
          sHit = h.s;
          white = 0.4 * Math.exp(-t / 0.035);
          if (t < WOOD_ECHO_SEC) {
            const q = t / WOOD_ECHO_SEC;
            echo = 0.6 * h.v * (1 - q) ** 2;
            echoK = 1 + WOOD_ECHO_GROW * easeOutCubic(q);
          }
        } else {
          // 線全体の短いフラッシュ + 低音ほど長く残る余韻
          base += (0.4 + 0.6 * h.v) * Math.exp(-t / 0.18) + 0.2 * h.v * Math.exp(-t / h.tau);
          // 打点の光: 周に沿って σ = 6 + 500t で広がる
          spot = (1.0 + 1.6 * h.v) * Math.exp(-t / (0.35 * h.tau));
          sigma = Math.min(6 + 500 * t, s.perimeter);
          sHit = h.s;
          // 弦の揺れ: 低音ほどゆっくり（12Hz → 6Hz）、余韻とともに減衰
          const f = 12 - 0.4 * s.note;
          const amp = (s.kind === 'bumper' ? 3.2 : 2.5) * h.v;
          vib = amp * Math.exp(-t / (0.5 * h.tau)) * Math.sin(2 * Math.PI * f * t);
          white = 0.25 * Math.exp(-t / 0.06);
        }
      }
      // 共鳴: 衝突の光よりはっきり弱く（最大 +0.22）
      if (rs >= s.resStep) base += 0.15 * (0.5 + s.resV) * Math.exp(-(rs - s.resStep) / HZ / 0.3);
      // 連鎖の光らせ直し
      if (rs >= s.replayAt) {
        const t = (rs - s.replayAt) / HZ;
        base += 0.9 * Math.exp(-t / 0.15);
        white = Math.max(white, 0.3 * Math.exp(-t / 0.08));
      }
      const hv = this.hoverAmt.get(s.group) ?? 0;
      base = Math.max(base, 0.3 + 0.3 * hv);
      // メニューを開いている図形: 光らせるのではなく、線もエフェクトも薄くして戻すのをくり返す（D54）
      const alpha = s.group === this.selected ? 1 - SELECT_FADE * pulse : 1;
      base *= alpha;
      spot *= alpha;
      tint.copy(noteColor(s.note, mode)).lerp(OFF_WHITE, white);
      const phi = shapeAngle(s, rs);
      const v = pose(s, phi, k);
      out.draw(v, s.n, s.closed, s.kind === 'bumper', tint, LINE_WIDTH + 1.5 * hv,
        base, spot, sigma, sHit, vib);
      if (echo > 0.01) {
        const ve = pose(s, phi, echoK);
        out.draw(ve, s.n, s.closed, false, tint, 1, echo * alpha, 0, 1, 0, 0);
      }
      if (s.effect !== 'none') out.drawFxRings(s, phi, rs, idle, alpha, mode, tint);
    }

    // 当たるたびに外へ広がる輪郭（D32）
    let w = 0;
    for (const f of this.fxWaves) {
      const q = (rs - f.step) / HZ / FX_WAVE_SEC;
      const s = this.shapes.get(f.group);
      if (q >= 1 || !s) continue;
      this.fxWaves[w++] = f;
      if (q < 0 || s.effect === 'none') continue;
      const alpha = f.group === this.selected ? 1 - SELECT_FADE * pulse : 1;
      out.drawFxWave(s, shapeAngle(s, rs), q, f.v, alpha, mode, tint);
    }
    this.fxWaves.length = w;

    // 消えかけの図形: 遅延のあいだは待機の明るさ、その後 0.8·(1−p)² で消しながら重心へ 10% 縮める
    for (const [id, d] of this.dying) {
      const p = ((rs - d.step) / HZ - d.delay) / d.dur;
      if (p >= 1) {
        this.dying.delete(id);
        continue;
      }
      const q = Math.max(0, p);
      const base = p < 0 ? idle : 0.8 * (1 - q) ** 2;
      const s = d.shape;
      const v = pose(s, d.phi, 1 - 0.1 * easeOutCubic(q));
      tint.copy(noteColor(s.note, mode));
      out.draw(v, s.n, s.closed, s.kind === 'bumper', tint, LINE_WIDTH, base, 0, 1, 0, 0);
    }

    this.drawPreview(preview, mode);
    out.commit();
  }

  private drawPreview(preview: Preview, mode: ColorMode): void {
    const pts = preview.points;
    const n = Math.min(pts.length / 2, MAX_VERTS) | 0;
    if (!preview.active || n < 2) {
      this.previewNote = -1;
      return;
    }
    const tint = this.tint;
    const now = performance.now() / 1000;
    let base = 1;
    if (preview.perimeter < MIN_LINE_LEN) {
      tint.copy(GRAY);
      this.previewNote = -1;
    } else {
      const note = lengthToNote(preview.perimeter).index;
      if (note !== this.previewNote) {
        if (this.previewNote >= 0) this.previewFlashAt = now;
        this.previewNote = note;
      }
      base = 0.35 + 0.15 * Math.sin(2 * Math.PI * 2 * now) + 0.8 * Math.exp(-(now - this.previewFlashAt) / 0.08);
      tint.copy(noteColor(note, mode));
    }
    const v = this.previewVerts;
    for (let i = 0; i < n * 2; i++) v[i] = pts[i]!;
    this.outline.draw(v, n, preview.closed, preview.bumper, tint, LINE_WIDTH, base, 0, 1, 0, 0);
  }
}
