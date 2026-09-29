import { Color, PlaneGeometry } from 'three';
import { HZ } from '../sim/constants';
import { FLOWER_HOLD_SEC, Flowers, SPECIES, type FlowerKind } from './flowers';
import { hash01 } from './hash';
import { commit, instanced, putQuad } from './instancing';
import { noteColor, OFF_WHITE, type ColorMode } from './palette';
import { arcPos, pointAt, shapeAngle, wrapArc, type Point, type Shape } from './shape';

// 蔦と花（D25）: 衝突した点から図形に沿って蔦が伸び、通ったところに花が順に咲く。
// 花・葉の形と動きは flowers.ts。ここでは、どこにいつ咲かせるかと、蔦の線を決める。
const MAX_VINES = 96;
const MAX_VINE_QUADS = 12288;
/** 伸びる速さ（px/s）と、片側に伸びる長さ = VINE_REACH + VINE_REACH_V · 衝突の強さ */
const VINE_SPEED = 220;
const VINE_REACH = 90;
const VINE_REACH_V = 320;
/** 同じ図形で次の蔦を伸ばすまでの最短間隔（秒） */
const VINE_GAP_SEC = 0.4;
/** まだ茎に付いている花や葉からこの距離（px、周に沿って）以内には、新しく咲かせない（重なって濁らないように） */
const VINE_CROWD_FLOWER = 32;
const VINE_CROWD_LEAF = 14;
/** 図形の線をまたいで巻きつく揺れ（px）と波長（px） */
const VINE_AMP = 5;
const VINE_WAVE = 70;
/** 蔦を描く刻み（px）と太さ（px） */
const VINE_STEP = 5;
const VINE_WIDTH = 1.4;
const VINE_GAIN = 0.32;
/** 花の間隔（px）: VINE_FLOWER_GAP × (0.8..1.3) */
const VINE_FLOWER_GAP = 70;
/** 花の半径（px）と明るさ: 基準 + 衝突の強さに比例 */
const VINE_FLOWER_R = 46;
const VINE_FLOWER_R_V = 30;
const VINE_FLOWER_GAIN = 0.2;
const VINE_FLOWER_GAIN_V = 0.12;
/** 当たった所に咲く花の大きさ（倍） */
const VINE_FLOWER_HIT_SCALE = 1.6;
/** 茎の長さ（花の大きさに対して）。花は蔦からこの分だけ外へ離れて咲き、付け根の2枚の葉がその間をつなぐ（茎の線は描かない） */
const VINE_STEM = 0.7;
/** 葉: 間隔（px）、長さ（花の大きさに対して）、明るさ、伸びる向きの蔦からの傾き（ラジアン） */
const LEAF_GAP = 34;
const LEAF_LEN = 0.95;
const LEAF_GAIN = 0.32;
const LEAF_ANGLE = 0.75;
const VINE_COLOR = new Color(0x6fcf7a);
/** すだれ（花畑）: 外へ出る幅と垂れる長さ（花の大きさに対して）、弓なりの強さ、房の花の数、上から先まで咲き進む秒数 */
const CASCADE_OUT = 1.0;
const CASCADE_DROP = 3.2;
const CASCADE_BEND = 0.22;
const CASCADE_MIN = 5;
const CASCADE_MAX = 9;
const CASCADE_SEC = 0.6;
/** 花火（花畑）: 茎が届く長さ（花の大きさに対して）、上へ寄せる強さ、伸びる速さ（px/s） */
const BURST_REACH = 4.5;
const BURST_RISE = 0.5;
const BURST_SPEED = 260;
/** 花火とすだれの混み具合を、普通の花と別に見るための列（free の dn に入れる。花のずれより十分大きい値） */
const LANE_BURST = 1e5;
const LANE_CASCADE = 2e5;

/** at = 咲き始めるステップ（落ち始めたら図形に付いて動かすのをやめる） */
type VineFlower = { handle: number; arc: number; off: number; at: number };
/** 図形の周上で、花や葉が咲いている場所と期間（ステップ） */
/** dn は蔦からの法線方向のずれ（px） */
type Bloomed = { arc: number; from: number; until: number; leaf: boolean; dn: number };

type Vine = {
  group: number; step: number; phi0: number; arc0: number; reach: number; seed: number; note: number;
  /** 蔦が消え始めるまでの秒数 */
  life: number;
  flowers: VineFlower[];
};

/** 蔦の、起点から周に沿って d（符号付き）だけ進んだ点での線からのずれ */
function vineOff(v: Vine, d: number): number {
  const k = (2 * Math.PI) / VINE_WAVE;
  return VINE_AMP * (Math.sin(d * k + v.seed * 6.28) + 0.35 * Math.sin(d * k * 2.3 + v.seed * 11));
}

export class Vines {
  readonly flowers = new Flowers(1);
  readonly quads = instanced(new PlaneGeometry(1, 1), MAX_VINE_QUADS, 1);
  private readonly vines: Vine[] = [];
  /** 図形ごとに、最後に蔦を伸ばしたステップ */
  private readonly vineAt = new Map<number, number>();
  private readonly bloomed = new Map<number, Bloomed[]>();
  private readonly pt: Point = { x: 0, y: 0, nx: 0, ny: 0 };
  private readonly color = new Color();
  private readonly tint = new Color();

  /** 図形が消えた */
  forget(group: number): void {
    this.flowers.forget(group);
    this.vineAt.delete(group);
    this.bloomed.delete(group);
  }

  /** 全部消す（花を出さない設定のとき） */
  clear(): void {
    this.vines.length = 0;
    this.vineAt.clear();
    this.bloomed.clear();
    commit(this.quads, 0);
    this.flowers.clear();
  }

  /**
   * 衝突した点から蔦を伸ばし、通るところに咲く花を先に予約する（開く時刻は蔦が届く時刻）。
   * kind は咲かせる花の種類（花の大きさ・間隔・葉の有無も種類で変わる）
   */
  grow(s: Shape, step: number, x: number, y: number, v: number, mono: boolean, kind: FlowerKind = 'mixed'): void {
    const spc = SPECIES[kind];
    if (s.perimeter <= 0) return;
    const last = this.vineAt.get(s.group);
    if (last !== undefined && step >= last && (step - last) / HZ < VINE_GAP_SEC) return;
    this.vineAt.set(s.group, step);
    const arc0 = arcPos(s, step, x, y);
    let reach = (VINE_REACH + VINE_REACH_V * v) * (spc.reach ?? 1);
    if (s.closed) reach = Math.min(reach, s.perimeter / 2);
    const r = (k: number, j: number) => hash01(s.group, step, 300 + k * 8 + j);
    // r は花ごとに 8 個まで。ほかの乱数は用途ごとに別の系列にする（花畑では k が数百になり、範囲が重なるため）
    const stream = (salt: number) => {
      const seed = (hash01(s.group, step, -1 - salt) * 0x7fffffff) | 0;
      return (k: number, j: number) => hash01(seed, k, j);
    };
    const rFace = stream(0), rCascade = stream(1), rExtra = stream(2), rBurst = stream(3);
    // 同じ所に続けて当たっても、まだ咲いている所には重ねない（散ったあとにまた咲く）
    const hold = Math.round(FLOWER_HOLD_SEC * HZ);
    const busy = (this.bloomed.get(s.group) ?? []).filter((b) => b.from <= step && step < b.until);
    const taken: Bloomed[] = [];
    // 周に沿っても蔦から離れる向きにも近いときだけ、混んでいるとみなす
    const free = (arc: number, at: number, leaf: boolean, dn = 0): boolean => {
      // 小さな花の種類は、そのぶん詰めて咲かせる
      const gap = leaf ? VINE_CROWD_LEAF : VINE_CROWD_FLOWER * Math.min(1, spc.size);
      for (const b of busy) {
        if (b.leaf !== leaf || at < b.from || at >= b.until) continue;
        let d = Math.abs(arc - b.arc);
        if (s.closed) d = Math.min(d, s.perimeter - d);
        if (d < gap && Math.abs(dn - b.dn) < gap) return false;
      }
      taken.push({ arc, from: at, until: at + hold, leaf, dn });
      return true;
    };
    const vine: Vine = {
      group: s.group, step, phi0: shapeAngle(s, step), arc0, reach, seed: r(0, 0), note: s.note, life: reach / VINE_SPEED + FLOWER_HOLD_SEC, flowers: [],
    };
    const phi = shapeAngle(s, step);
    const base = noteColor(s.note, 'pitch');
    const size = (VINE_FLOWER_R + VINE_FLOWER_R_V * v) * spc.size;
    const gain = VINE_FLOWER_GAIN + VINE_FLOWER_GAIN_V * v;
    const pt = this.pt;
    let k = 0;
    const leafC = new Color().copy(VINE_COLOR).lerp(base, 0.25);
    if (mono) leafC.copy(OFF_WHITE);
    if (spc.leafColor) leafC.copy(spc.leafColor);
    /** 周上 d（符号付き）の位置に1輪。scale は大きさ、dn・da は蔦からの法線・周方向のずれ（px） */
    const put = (d: number, scale: number, dn: number, da: number) => {
      const arc = wrapArc(s, arc0 + d + da);
      if (Number.isNaN(arc)) return;
      pointAt(s, phi, arc, pt);
      const side = dn >= 0 ? 1 : -1;
      const at = step + Math.round((Math.abs(d) / VINE_SPEED) * HZ);
      if (!free(arc, at, false, dn)) return;
      // 花が向く方向: 蔦の外側。ばらばらに伸びる種類（花畑）は、向きをずらして少し上へ寄せる
      let fx = pt.nx * side, fy = pt.ny * side;
      if (spc.faceJitter > 0) {
        const a = (rFace(k, 0) - 0.5) * 2 * spc.faceJitter;
        const ca = Math.cos(a), sa = Math.sin(a);
        [fx, fy] = [fx * ca - fy * sa, fx * sa + fy * ca - spc.rise];
        const l = Math.hypot(fx, fy) || 1;
        fx /= l;
        fy /= l;
      }
      // ばらばらに伸びる種類は、蔦から生えて茎で外へ伸びる（ずれの分だけ茎を長く）。ほかは蔦から離れた所に咲く
      const rooted = spc.faceJitter > 0;
      const off = vineOff(vine, d) + (rooted ? 0 : dn);
      const stem = VINE_STEM * size * scale * spc.stem * (rooted ? 0.3 + 1.4 * r(k, 0) : 0.6 + 0.8 * r(k, 0)) + (rooted ? Math.abs(dn) : 0);
      const handle = this.flowers.bloom(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
        radius: size * scale, gain,
        faceX: fx, faceY: fy,
        tilt: 0.2 + 1.2 * r(k, 1),
        stem,
      }, base, mono, kind);
      vine.flowers.push({ handle, arc, off, at });
      k++;
      // 茎を線で描く種類と、ばらばらに伸びる種類（花畑。葉が重なって緑が光りすぎる）は、付け根の葉を出さない
      if (!spc.leaves || spc.stemColor || spc.faceJitter > 0) return;
      // 茎の代わりに、花の付け根から左右へ葉を2枚（花はその間から伸びる）
      for (const sgn of [1, -1]) {
        const a = sgn * (0.55 + 0.4 * r(k, 6));
        const ca = Math.cos(a), sa = Math.sin(a);
        const lh = this.flowers.leaf(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
          len: (stem * 1.2 + size * scale * 0.3) * spc.leafScale * (0.8 + 0.4 * r(k, 7)),
          gain: LEAF_GAIN,
          dirX: fx * ca - fy * sa,
          dirY: fx * sa + fy * ca,
          roll: 0.2 + 0.9 * r(k, 5),
        }, leafC);
        vine.flowers.push({ handle: lh, arc, off, at });
        k++;
      }
    };
    // 葉: 蔦に沿って左右交互に。伸びる向きへ少し倒して出る（葉のない種類は出さない）
    for (const dir of spc.leaves ? [1, -1] : []) {
      let side = r(k, 3) < 0.5 ? 1 : -1;
      for (let d = LEAF_GAP * (0.3 + 0.7 * r(k, 2)); d <= reach; d += LEAF_GAP * (0.7 + 0.6 * r(k, 2))) {
        const arc = wrapArc(s, arc0 + dir * d);
        if (Number.isNaN(arc)) break;
        pointAt(s, phi, arc, pt);
        const off = vineOff(vine, dir * d);
        // 周の進む向き（法線を -90° 回したもの）
        const tx = pt.ny, ty = -pt.nx;
        const ca = Math.cos(LEAF_ANGLE), sa = Math.sin(LEAF_ANGLE);
        const at = step + Math.round((d / VINE_SPEED) * HZ);
        if (!free(arc, at, true)) {
          side = -side;
          k++;
          continue;
        }
        const handle = this.flowers.leaf(s.group, at, k, pt.x + pt.nx * off, pt.y + pt.ny * off, {
          len: size * LEAF_LEN * spc.leafScale * (0.7 + 0.6 * r(k, 4)),
          gain: LEAF_GAIN,
          dirX: pt.nx * side * ca + tx * dir * sa,
          dirY: pt.ny * side * ca + ty * dir * sa,
          roll: 0.2 + 0.9 * r(k, 5),
        }, leafC);
        vine.flowers.push({ handle, arc, off, at });
        side = -side;
        k++;
      }
    }

    /**
     * すだれ: 周上 d から花の房が弓なりに垂れる（少し外・上へ出てから下へ）。先ほど花が小さく、上から順に咲く。
     * 花は弓（弦からのふくらみが sin）に沿って並べる（画面は y 上向き）
     */
    const cascade = (d: number) => {
      const arc = wrapArc(s, arc0 + d);
      if (Number.isNaN(arc)) return;
      const at0 = step + Math.round((Math.abs(d) / VINE_SPEED) * HZ);
      // まだ垂れている所には重ねない（すだれ専用の列で混み具合を見る）
      if (!free(arc, at0, false, LANE_CASCADE)) return;
      pointAt(s, phi, arc, pt);
      const off = vineOff(vine, d);
      const bx = pt.x + pt.nx * off, by = pt.y + pt.ny * off;
      const rc = (j: number) => rCascade(k, j);
      // 出る向き: 蔦の外側を横へ寄せ、少し上へ
      const sgn = pt.nx !== 0 ? Math.sign(pt.nx) : rc(0) < 0.5 ? 1 : -1;
      let ox = pt.nx + sgn * 0.8, oy = 0.35;
      const ol = Math.hypot(ox, oy);
      ox /= ol;
      oy /= ol;
      const w = size * CASCADE_OUT * (0.6 + 0.8 * rc(1));
      const len = size * CASCADE_DROP * (spc.cascadeDrop ?? 1) * (0.6 + 0.8 * rc(2));
      const vx = ox * w, vy = oy * w - len;
      const vl = Math.hypot(vx, vy);
      // 上へふくらむ向きに弓なり
      const bend = CASCADE_BEND * (vx >= 0 ? 1 : -1);
      const px = -vy / vl, py = vx / vl;
      const n = CASCADE_MIN + Math.floor(rc(3) * (CASCADE_MAX - CASCADE_MIN + 1));
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        const bow = Math.sin(Math.PI * t) * vl * bend;
        const cx = vx * t + px * bow, cy = vy * t + py * bow;
        const at = at0 + Math.round(t * CASCADE_SEC * HZ);
        const handle = this.flowers.bloom(s.group, at, k, bx, by, {
          radius: size * (0.42 - 0.2 * t) * (0.85 + 0.3 * rCascade(k, 4)),
          gain,
          faceX: cx, faceY: -cy,
          tilt: 0.5 + 0.7 * rCascade(k, 5),
          stem: Math.hypot(cx, cy),
        }, base, mono, kind);
        vine.flowers.push({ handle, arc, off, at });
        k++;
      }
    };

    // 当たった所に大きな1輪
    put(0, VINE_FLOWER_HIT_SCALE, r(0, 3) < 0.5 ? 1 : -1, 0);
    // 花火: 当たった所から、長さのばらばらな茎が放射状に伸びて一気に咲く（近いものから順に）。上寄りに
    // 同じ所に続けて当たったときは、前の花火が咲いている間は重ねない（花火専用の列で混み具合を見る）
    const burstArc = wrapArc(s, arc0);
    if (spc.burst && !Number.isNaN(burstArc) && free(burstArc, step, false, LANE_BURST)) {
      const arc = burstArc;
      pointAt(s, phi, arc, pt);
      const off = vineOff(vine, 0);
      const bx = pt.x + pt.nx * off, by = pt.y + pt.ny * off;
      for (let j = 0; j < spc.burst; j++) {
        const rb = (i: number) => rBurst(j, i);
        // 画面（y 上）での向き: 全方向に、上へ寄せる
        const a = (j + rb(0)) / spc.burst * Math.PI * 2;
        let ux = Math.cos(a), uy = Math.sin(a) + BURST_RISE;
        const ul = Math.hypot(ux, uy);
        ux /= ul;
        uy /= ul;
        const reachB = size * BURST_REACH * (0.25 + 0.75 * Math.sqrt(rb(1)));
        const at = step + Math.round((reachB / BURST_SPEED) * HZ);
        const handle = this.flowers.bloom(s.group, at, k, bx, by, {
          radius: size * (0.5 + 0.6 * rb(2)),
          gain,
          faceX: ux, faceY: -uy,
          tilt: 0.2 + 1.0 * rb(3),
          stem: reachB,
        }, base, mono, kind);
        vine.flowers.push({ handle, arc, off, at });
        k++;
      }
    }
    for (const dir of [1, -1]) {
      const gap = VINE_FLOWER_GAP * spc.gap;
      let d = gap * (0.5 + 0.5 * r(k, 2));
      while (d <= reach) {
        // 房: 主の1輪に、小さな花を 0〜2 輪添える
        const side = r(k, 3) < 0.5 ? 1 : -1;
        put(dir * d, 0.6 + 0.8 * r(k, 4), side * 2, 0);
        if (spc.cascade && rCascade(k, 9) < spc.cascade) cascade(dir * d);
        if (spc.fill) {
          // 花畑: 毎回たくさん、蔦の両側へ、周に沿っても広く
          const extra = 2 + Math.floor(rExtra(k, 0) * (spc.extras - 1));
          const kb = k;
          for (let j = 0; j < extra; j++) {
            const rj = (i: number) => rExtra(kb, 1 + j * 4 + i);
            put(dir * d, 0.35 + 0.3 * r(k, 4) + 0.3 * rj(1), (rj(0) < 0.5 ? 1 : -1) * (2 + spc.spread * rj(2)), (rj(3) - 0.5) * gap * 1.6);
          }
        } else {
          // 小さな花を 0〜2 輪、主の反対側へ添える
          const extra = r(k, 5) < 0.6 ? Math.min(spc.extras, r(k, 6) < 0.35 ? 2 : 1) : 0;
          for (let j = 0; j < extra; j++) {
            put(dir * d, 0.35 + 0.3 * r(k, 4), -side * (2 + spc.spread * r(k, 6)), (r(k, 7) - 0.5) * gap * 0.8);
          }
        }
        d += gap * (0.7 + 0.6 * r(k, 2));
      }
    }
    this.bloomed.set(s.group, busy.concat(taken));
    if (this.vines.length >= MAX_VINES) this.vines.shift();
    this.vines.push(vine);
  }

  /** 蔦の線を描き、花を進める。thick = 線を太く描く倍率（D26） */
  draw(rs: number, shapes: ReadonlyMap<number, Shape>, mode: ColorMode, thick: number): void {
    const c = this.color;
    const pt = this.pt;
    let n = 0;
    let w = 0;
    for (const vine of this.vines) {
      const t = (rs - vine.step) / HZ;
      const s = shapes.get(vine.group);
      if (!s || t > vine.life + 3 * 0.9) continue;
      this.vines[w++] = vine;
      if (t < 0) continue;
      const phi = shapeAngle(s, rs);
      // 回っている図形に付いた花・葉は、落ちるまで位置と向きを直す
      if (s.omega !== 0) {
        for (const f of vine.flowers) {
          if ((rs - f.at) / HZ > FLOWER_HOLD_SEC) continue;
          pointAt(s, phi, f.arc, pt);
          this.flowers.setPos(f.handle, pt.x + pt.nx * f.off, pt.y + pt.ny * f.off, phi - vine.phi0);
        }
      }
      const front = Math.min(vine.reach, t * VINE_SPEED);
      const fade = Math.exp(-Math.max(0, t - vine.life) / 0.9);
      c.copy(VINE_COLOR).lerp(noteColor(vine.note, mode), 0.35);
      if (mode === 'mono') c.copy(OFF_WHITE);
      for (const dir of [1, -1]) {
        let px = NaN, py = NaN;
        for (let d = 0; d <= front && n < MAX_VINE_QUADS; d += VINE_STEP) {
          const arc = wrapArc(s, vine.arc0 + dir * d);
          if (Number.isNaN(arc)) break;
          pointAt(s, phi, arc, pt);
          const off = vineOff(vine, dir * d);
          const x = pt.x + pt.nx * off, y = pt.y + pt.ny * off;
          if (!Number.isNaN(px)) {
            // 先端ほど細く明るい（伸びている間だけ）
            const tip = front < vine.reach ? Math.exp(-(front - d) / 12) : 0;
            const width = VINE_WIDTH * thick * (0.5 + 0.5 * Math.min(1, (front - d) / 40 + 0.3));
            putQuad(this.quads, n++, px, py, x, y, width, this.tint.copy(c).multiplyScalar(VINE_GAIN * fade * (1 + 1.5 * tip)));
          }
          px = x;
          py = y;
        }
      }
    }
    this.vines.length = w;
    commit(this.quads, n);
    this.flowers.draw(rs);
  }
}
