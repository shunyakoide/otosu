import {
  AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, type Color,
} from 'three';

// 当たった点の星座（D62、constellation）。当たった点を星として残し、続けて当たった点どうしを細い線で結ぶ。
// 区間（8小節）が変わると、それまでの星座はゆっくり消えて描き直すので、曲の区切りが星座の形として見える。
// 近くにまた当たったら、新しい星は作らずその星を明るくする（よく鳴る場所ほど明るい星になる）。
// 時刻は renderStep から取るので、止めると止まる。

/** 1つの区間で残す星と線の数（超えたら古いものから置き換える） */
const MAX_STARS = 48;
const MAX_LINKS = 64;
/** 同じ星とみなす距離（ワールド px）、続けて当たったとみなして結ぶ間（秒） */
const MERGE_R = 14;
const LINK_SEC = 0.9;
/** 前の区間の星座が消えきる秒、星・線が現れる秒 */
const FADE_SEC = 2.2;
const APPEAR_SEC = 0.35;
/** 星の十字の腕の長さ（ワールド px）: 基本と、明るさでのびる分 */
const ARM = 3.5;
const ARM_GROW = 5;

type Star = { x: number; y: number; at: number; lit: number; bright: number };
type Link = { a: Star; b: Star; at: number };
type Sky = { stars: Star[]; links: Link[]; section: number; endedAt: number };

/** 星1つ = 十字の2本、線1本 = 1本 */
const SKY_SEGS = MAX_STARS * 2 + MAX_LINKS;

export class Constellation {
  readonly object: LineSegments;
  /** 今の区間と、消えていく前の区間 */
  private cur: Sky = { stars: [], links: [], section: -1, endedAt: Infinity };
  private prev: Sky | null = null;
  private last: Star | null = null;
  private lastAt = -Infinity;
  private readonly pos: BufferAttribute;
  private readonly col: BufferAttribute;

  constructor() {
    const g = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(2 * SKY_SEGS * 2 * 3), 3);
    this.col = new BufferAttribute(new Float32Array(2 * SKY_SEGS * 2 * 3), 3);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    this.object = new LineSegments(g, new LineBasicMaterial({
      vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  /** 当たった（ワールド座標、時刻は秒、section = 区間の番号） */
  hit(x: number, y: number, at: number, strength: number, section: number): void {
    const sky = this.cur;
    if (section !== sky.section) {
      if (sky.stars.length > 0) {
        sky.endedAt = at;
        this.prev = sky;
      }
      this.cur = { stars: [], links: [], section, endedAt: Infinity };
      this.last = null;
    }
    const { stars } = this.cur;
    const v = Math.min(1, strength);
    let star = stars.find((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < MERGE_R ** 2);
    if (star) {
      star.bright = Math.min(1, star.bright + 0.25 * v);
      star.lit = at;
    } else {
      star = { x, y, at, lit: at, bright: 0.35 + 0.3 * v };
      if (stars.length >= MAX_STARS) {
        const old = stars.shift()!;
        this.cur.links = this.cur.links.filter((l) => l.a !== old && l.b !== old);
      }
      stars.push(star);
    }
    const from = this.last;
    if (from && from !== star && at - this.lastAt < LINK_SEC
      && !this.cur.links.some((l) => (l.a === from && l.b === star) || (l.a === star && l.b === from))) {
      if (this.cur.links.length >= MAX_LINKS) this.cur.links.shift();
      this.cur.links.push({ a: from, b: star, at });
    }
    this.last = star;
    this.lastAt = at;
  }

  /** 止めた・配置を読み込んだあとなどに、すべて消す */
  clear(): void {
    this.cur = { stars: [], links: [], section: -1, endedAt: Infinity };
    this.prev = null;
    this.last = null;
  }

  /** 毎フレーム呼ぶ。time = 表示している時刻（秒） */
  update(on: boolean, time: number, base: Color): void {
    this.object.visible = on;
    if (!on) return;
    const pos = this.pos;
    const col = this.col;
    let k = 0;
    const seg = (ax: number, ay: number, bx: number, by: number, a: number) => {
      pos.setXYZ(k, ax, -ay, 0);
      col.setXYZ(k++, base.r * a, base.g * a, base.b * a);
      pos.setXYZ(k, bx, -by, 0);
      col.setXYZ(k++, base.r * a, base.g * a, base.b * a);
    };
    const drawSky = (sky: Sky | null) => {
      let n = 0;
      if (sky) {
        const fade = time < sky.endedAt ? 1 : Math.max(0, 1 - (time - sky.endedAt) / FADE_SEC);
        if (fade > 0) {
          for (const s of sky.stars) {
            const age = time - s.at;
            if (age < 0) continue;
            const appear = Math.min(1, age / APPEAR_SEC);
            // 当たった直後に強く光り、あとは小さくまたたく
            const flash = Math.max(0, 1 - (time - s.lit) / 0.3);
            const twinkle = 0.85 + 0.15 * Math.sin(time * 2.3 + s.x * 0.05 + s.y * 0.07);
            const a = fade * appear * (s.bright * twinkle * 0.8 + flash * 0.8);
            const arm = ARM + ARM_GROW * (s.bright * 0.5 + flash * 0.6);
            seg(s.x - arm, s.y, s.x + arm, s.y, a);
            seg(s.x, s.y - arm, s.x, s.y + arm, a);
            n += 2;
          }
          for (const l of sky.links) {
            const age = time - l.at;
            if (age < 0) continue;
            // 前の星から新しい星へ線が伸びる
            const g = Math.min(1, age / APPEAR_SEC);
            const e = 1 - (1 - g) ** 3;
            const a = fade * 0.3 * (1 + Math.max(0, 1 - age / 0.4));
            seg(l.a.x, l.a.y, l.a.x + (l.b.x - l.a.x) * e, l.a.y + (l.b.y - l.a.y) * e, a);
            n++;
          }
        }
      }
      for (; n < SKY_SEGS; n++) seg(0, 0, 0, 0, 0);
    };
    if (this.prev && time - this.prev.endedAt >= FADE_SEC) this.prev = null;
    drawSky(this.prev);
    drawSky(this.cur);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as LineBasicMaterial).dispose();
  }
}
