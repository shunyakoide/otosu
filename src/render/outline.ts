import { CircleGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, PlaneGeometry, type MeshBasicMaterial } from 'three';
import { HZ, LINE_WIDTH } from '../sim/constants';
import { riseSlot } from '../sim/music';
import { easeOutCubic } from './ease';
import { additive, commit, instanced, putDisc, putQuad } from './instancing';
import { noteColor, type ColorMode } from './palette';
import { contour, type Shape } from './shape';

// 図形の線（辺と、開いた図形の端の丸キャップ）をまとめて描く。毎フレーム begin → 描く → commit。

const MAX_EDGE_INST = 2048;
const MAX_CAPS = 2048;

// バンパー: 二重線
const BUMPER_OFFSET = 2.5;
const BUMPER_WIDTH = 2;

/**
 * エフェクトの輪郭（D32）。エフェクトの付いた図形は、まわりに淡い輪郭を何重かまとい、種類ごとに見分けられるよう動きと色を変える。
 * echo: 同心の輪が外へ広がりながら消えていく（波紋）。rise: 同じ形が上へ昇りながら消えていく（色は上がっていく音の色）。
 * chord: 動かない点線の輪郭を重ねる（色は重ねる音の色。mono でも点線で分かる）。
 * 開いた図形（線・ペン）では echo と chord は両側に、rise は上側だけに出す（上へずれるだけの rise と見分けられるように）
 */
const FX_ECHO_RINGS = 3;
const FX_ECHO_GAP = 11;
const FX_ECHO_SEC = 2.4;
const FX_RISE_COPIES = 3;
const FX_RISE_GAP = 9;
const FX_RISE_SEC = 1.8;
const FX_CHORD_GAP = 6;
/** chord の点線: 点の長さ・間隔（px）。mono でも echo・rise と見分けられるように */
const FX_DOT = 2.5;
const FX_DOT_GAP = 5;
/** 輪郭の明るさ（待機の線に対する割合）と太さ（px） */
const FX_GAIN = 1.6;
const FX_WIDTH = 1.5;
/** 当たるたびに輪郭が外へ広がる: 距離・秒・明るさ */
const FX_WAVE_REACH = 44;
export const FX_WAVE_SEC = 0.9;
const FX_WAVE_GAIN = 0.9;

/**
 * 辺のマテリアル（弦が鳴る）。インスタンスごとに
 *   aA = (辺の周上の開始位置 s0, 辺の長さ, 打点の周上の位置, 揺れの変位 px)
 *   aB = (全体の明るさ, 打点の光の強さ, 打点の光の広がり σ, 閉じた図形なら周長・開いていれば 0)
 * instanceColor は色味だけ（明るさ 1）。打点からの周上の距離 d で exp(−d/σ) の光を足す。
 */
function stringMaterial(): MeshBasicMaterial {
  const mat = additive();
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aA;
attribute vec4 aB;
varying vec4 vA;
varying vec4 vB;
varying float vU;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vA = aA;
vB = aB;
vU = position.x + 0.5;
#ifdef USE_INSTANCING
float wScale = max(length(instanceMatrix[1].xyz), 1e-3);
#else
float wScale = 1.0;
#endif
transformed.y += aA.w * sin(PI * vU) / wScale;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vA;
varying vec4 vB;
varying float vU;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float sPos = vA.x + vU * vA.y;
float dHit = abs(sPos - vA.z);
if (vB.w > 0.0) dHit = min(dHit, vB.w - dHit);
float gHit = exp(-dHit / max(vB.z, 1.0));
diffuseColor.rgb = diffuseColor.rgb * (vB.x + vB.y * gHit) + vec3(0.08 * vB.y * exp(-dHit / 6.0));`);
  };
  return mat;
}

export class Outline {
  readonly edges = instanced(new PlaneGeometry(1, 1, 16, 1), MAX_EDGE_INST, 2, stringMaterial());
  private readonly aA = new InstancedBufferAttribute(new Float32Array(MAX_EDGE_INST * 4), 4);
  private readonly aB = new InstancedBufferAttribute(new Float32Array(MAX_EDGE_INST * 4), 4);
  readonly caps = instanced(new CircleGeometry(1, 16), MAX_CAPS, 2);
  private nEdge = 0;
  private nCap = 0;
  /** 線を太く描く倍率（D26）。begin で決める */
  private thick = 1;
  private readonly color = new Color();

  constructor() {
    this.aA.setUsage(DynamicDrawUsage);
    this.aB.setUsage(DynamicDrawUsage);
    this.edges.geometry.setAttribute('aA', this.aA);
    this.edges.geometry.setAttribute('aB', this.aB);
  }

  /** フレームの始めに呼ぶ */
  begin(thick: number): void {
    this.nEdge = 0;
    this.nCap = 0;
    this.thick = thick;
  }

  /** 書いた分を送る */
  commit(): void {
    commit(this.edges, this.nEdge, [this.aA, this.aB]);
    commit(this.caps, this.nCap);
  }

  /** 辺を1本置く（弦のパラメータ付き） */
  private putEdge(
    ax: number, ay: number, bx: number, by: number, width: number, tint: Color,
    s0: number, len: number, sHit: number, vib: number, base: number, spot: number, sigma: number, closedP: number,
  ): void {
    const i = this.nEdge;
    if (i >= MAX_EDGE_INST) return;
    this.nEdge++;
    putQuad(this.edges, i, ax, ay, bx, by, width, tint);
    this.aA.setXYZW(i, s0, len, sHit, vib);
    this.aB.setXYZW(i, base, spot, sigma, closedP);
  }

  private putCap(x: number, y: number, r: number, c: Color): void {
    const i = this.nCap;
    if (i >= MAX_CAPS) return;
    this.nCap++;
    putDisc(this.caps, i, x, y, r, c);
  }

  /**
   * 頂点列 v（n 点）を辺として描く。バンパーは二重線。開いた図形は両端に丸キャップ。
   * 打点の光（spot, sigma, sHit）は周に沿って測る（閉じた図形は周回する）。
   */
  draw(
    v: Float32Array, n: number, closed: boolean, bumper: boolean,
    tint: Color, width: number, base: number, spot: number, sigma: number, sHit: number, vib: number,
  ): void {
    const k = this.thick;
    const ne = closed ? n : n - 1;
    let perim = 0;
    if (closed) {
      for (let i = 0; i < ne; i++) {
        const j = (i + 1) % n;
        perim += Math.hypot(v[j * 2]! - v[i * 2]!, v[j * 2 + 1]! - v[i * 2 + 1]!);
      }
    }
    let acc = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 2]!, ay = v[i * 2 + 1]!, bx = v[j * 2]!, by = v[j * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      const start = acc;
      acc += len;
      if (bumper) {
        const nx = len > 0 ? -(by - ay) / len : 0;
        const ny = len > 0 ? (bx - ax) / len : 0;
        const w = (BUMPER_WIDTH + (width - LINE_WIDTH) / 2) * k;
        const o = BUMPER_OFFSET * k;
        this.putEdge(ax - nx * o, ay - ny * o, bx - nx * o, by - ny * o, w, tint, start, len, sHit, vib, base, spot, sigma, perim);
        this.putEdge(ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, w, tint, start, len, sHit, vib, base, spot, sigma, perim);
      } else {
        this.putEdge(ax, ay, bx, by, width * k, tint, start, len, sHit, vib, base, spot, sigma, perim);
      }
    }
    if (!closed && n >= 2) {
      const r = (bumper ? BUMPER_OFFSET + BUMPER_WIDTH / 2 : width / 2) * k;
      const sg = Math.max(sigma, 1);
      const c = this.color;
      c.copy(tint).multiplyScalar(base + spot * Math.exp(-Math.abs(sHit) / sg));
      this.putCap(v[0]!, v[1]!, r, c);
      c.copy(tint).multiplyScalar(base + spot * Math.exp(-Math.abs(acc - sHit) / sg));
      this.putCap(v[(n - 1) * 2]!, v[(n - 1) * 2 + 1]!, r, c);
    }
  }

  /** 点線の輪郭。周に沿って FX_DOT の点を FX_DOT_GAP おきに置く */
  private drawDotted(v: Float32Array, n: number, closed: boolean, tint: Color, a: number): void {
    const k = this.thick;
    const ne = closed ? n : n - 1;
    const period = FX_DOT + FX_DOT_GAP;
    let acc = 0;
    for (let i = 0; i < ne; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 2]!, ay = v[i * 2 + 1]!;
      const dx = v[j * 2]! - ax, dy = v[j * 2 + 1]! - ay;
      const len = Math.hypot(dx, dy);
      if (len <= 0) continue;
      // この辺の中で、次の点が始まる位置から置いていく（辺をまたいでも間隔がそろうように）
      for (let t = (period - (acc % period)) % period; t < len; t += period) {
        const t1 = Math.min(len, t + FX_DOT);
        this.putEdge(ax + dx * t / len, ay + dy * t / len, ax + dx * t1 / len, ay + dy * t1 / len, 2 * k, tint,
          0, 1, 0, 0, a, 0, 1, 0);
      }
      acc += len;
    }
  }

  /** 図形の輪郭の外へ d px（dotted なら点線）。開いた図形は両側に */
  private drawFxSides(s: Shape, phi: number, d: number, tint: Color, a: number, dotted = false): void {
    for (let side = 0; side < (s.closed ? 1 : 2); side++) {
      const v = contour(s, phi, side === 0 ? d : -d, 0);
      if (dotted) this.drawDotted(v, s.n, s.closed, tint, a);
      else this.draw(v, s.n, s.closed, false, tint, FX_WIDTH, a, 0, 1, 0, 0);
    }
  }

  /**
   * エフェクトの付いた図形がいつもまとう輪郭（D32）。明るさは待機の線 idle に対する割合で、
   * alpha を掛ける（メニューを開いている図形の明滅、D54）
   */
  drawFxRings(s: Shape, phi: number, rs: number, idle: number, alpha: number, mode: ColorMode, tint: Color): void {
    const a = idle * FX_GAIN * alpha;
    const t = rs / HZ;
    if (s.effect === 'echo') {
      // 等間隔の輪が外へ流れ、外ほど暗く、端で消える
      tint.copy(noteColor(s.note, mode));
      const p = (t / FX_ECHO_SEC) % 1;
      for (let i = 0; i < FX_ECHO_RINGS; i++) {
        const u = (i + p) / FX_ECHO_RINGS;
        const fade = Math.min(1, u * 4) * (1 - u) ** 1.5;
        this.drawFxSides(s, phi, 4 + u * FX_ECHO_RINGS * FX_ECHO_GAP, tint, a * fade);
      }
    } else if (s.effect === 'rise') {
      // 同じ形が上へ昇り、上ほど暗く、上がっていく音の色になる
      const p = (t / FX_RISE_SEC) % 1;
      for (let i = 0; i < FX_RISE_COPIES; i++) {
        const u = (i + p) / FX_RISE_COPIES;
        const n = riseSlot(s.form, s.note, i + 1);
        tint.copy(noteColor(n < 0 ? s.note : n, mode));
        const fade = Math.min(1, u * 4) * (1 - u) ** 1.5;
        this.draw(contour(s, phi, 0, 4 + u * FX_RISE_COPIES * FX_RISE_GAP), s.n, s.closed, false, tint, FX_WIDTH, a * fade, 0, 1, 0, 0);
      }
    } else if (s.effect === 'chord') {
      // 重ねる音の色の細い輪郭が、ぴったり寄り添って動かない
      for (let i = 0; i < s.chord.length; i++) {
        tint.copy(noteColor(s.chord[i]!, mode));
        this.drawFxSides(s, phi, FX_CHORD_GAP * (i + 1), tint, a * (i === 0 ? 1.3 : 1), true);
      }
    }
  }

  /**
   * 当たるたびに外へ広がる輪郭（D32）。q = 広がりの進み 0..1、v = 当たりの強さ、alpha は drawFxRings と同じ。
   * rise は上へ昇り、chord は重ねる音の色で広がる
   */
  drawFxWave(s: Shape, phi: number, q: number, v: number, alpha: number, mode: ColorMode, tint: Color): void {
    const e = easeOutCubic(q);
    const a = FX_WAVE_GAIN * (0.3 + v) * (1 - q) ** 2 * alpha;
    if (s.effect === 'rise') {
      tint.copy(noteColor(Math.max(riseSlot(s.form, s.note, 1), s.note), mode));
      this.draw(contour(s, phi, 0, FX_WAVE_REACH * e), s.n, s.closed, false, tint, FX_WIDTH, a, 0, 1, 0, 0);
    } else if (s.effect === 'chord') {
      for (let i = 0; i < s.chord.length; i++) {
        tint.copy(noteColor(s.chord[i]!, mode));
        this.drawFxSides(s, phi, 3 + (0.5 + 0.5 * i) * FX_WAVE_REACH * e, tint, a, true);
      }
    } else {
      tint.copy(noteColor(s.note, mode));
      this.drawFxSides(s, phi, 3 + FX_WAVE_REACH * e, tint, a);
    }
  }
}
