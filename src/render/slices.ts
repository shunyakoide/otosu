import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector2 } from 'three';
import type { BackdropLayer, LayerFrame } from './backdrop';
import { CubeView, ISO_PITCH, ISO_YAW } from './cube';
import { NOISE, NOISE3 } from './glsl';
import { disposeMesh } from './layer';

// 背景の時間のスライス（D42、slices）。TouchDesigner の Texture 3D TOP（動く画像を毎フレーム貯めて、板に1枚ずつ並べる）のつくり。
// 動く雲の画像を、手前の板には今、奥の板ほど少し前のものを映す。雲の動きが手前から隣の板へ、奥へと伝わっていく。
// 貯める代わりに、雲を「時刻を入れると形が決まる」ノイズにして、板ごとに遅らせた時刻で計算する（状態を持たない）。
// 雲は真ん中ほど濃い。奥の板（古い雲）ほど少し薄い。板の縁は細い線、板の面はフィルムの粒のようにざらつく。
// 当たった点には反応しない（波はうるさかった）。盛り上がり（energy）で少し濃く、速く流れる。色は白黒だけ（D37）。
// 光を足すだけなので、深さは使わず、全体の画面にそのまま描く。時刻は renderStep から取るので、止めると止まる。

/** 板の数 */
const SHEETS = 12;
/** 大きさ（立方体の辺の半分が、見えている範囲の短いほうの半分に占める割合） */
const FIT = 0.42;
/** 雲の模様の大きさと、変わる速さ（ノイズの単位 / 秒） */
const FREQ = 1.5;
const SPEED = 0.18;
/** 隣の板との時刻のずれ（秒） */
const LAG = 0.35;
/** 色と、1枚の明るさ */
const COLOR = 0xd8dde4;
const ALPHA = 0.085;

const VERT = /* glsl */ `
uniform mat4 mvp;
varying vec3 vP;
void main() {
  vP = position;
  gl_Position = mvp * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float time;
uniform float drift;   // 流れた量（盛り上がりで速く進む）
uniform float energy;
uniform float level;
uniform vec3 base;
varying vec3 vP;
${NOISE}
${NOISE3}

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.6;
  for (int i = 0; i < 4; i++) {
    s += a * noise3(p);
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    a *= 0.55;
  }
  return s;
}

void main() {
  vec3 p = vP;
  // 手前（z = 1）の板が今。奥の板ほど前の時刻
  float back = (1.0 - p.z) * 0.5 * ${(SHEETS - 1).toFixed(1)};
  float t = drift - back * ${(LAG * SPEED).toFixed(4)};
  // 動く雲（2D の画像。時刻で形が変わり、少しずつ漂う）。真ん中ほど濃い
  float n = fbm(vec3(p.xy * ${FREQ.toFixed(2)} + vec2(0.35, -0.2) * t, t));
  float v = smoothstep(-0.2, 0.55, n + 0.15 * energy) * (0.25 + exp(-dot(p.xy, p.xy) * 0.9));
  v *= 1.0 - 0.45 * back / ${(SHEETS - 1).toFixed(1)};
  // 板の縁: 面は縁の手前で薄くし、縁には細い線
  vec2 e = 1.0 - abs(p.xy);
  float m = min(e.x, e.y);
  float frame = (1.0 - smoothstep(0.0, 0.012, m)) * 1.2;
  float grain = 0.55 + 0.9 * rand(floor(gl_FragCoord.xy) + fract(time * 7.3) * 91.0);
  float a = ${ALPHA.toFixed(3)} * (v * smoothstep(0.0, 0.08, m) * grain + frame);
  gl_FragColor = vec4(base * a * level, 1.0);
}`;

/** 背景の雲の断面 */
export class Slices implements BackdropLayer {
  readonly object: Mesh;
  private readonly view = new CubeView();
  private readonly u = {
    mvp: { value: this.view.mvp },
    time: { value: 0 },
    drift: { value: 0 },
    energy: { value: 0 },
    level: { value: 1 },
    base: { value: new Color(COLOR) },
  };
  private readonly size = new Vector2();

  constructor() {
    // 板 = z を等間隔にした -1..1 の四角
    const pos = new Float32Array(SHEETS * 4 * 3);
    const index: number[] = [];
    for (let k = 0; k < SHEETS; k++) {
      const z = (k / (SHEETS - 1)) * 2 - 1;
      pos.set([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z], k * 12);
      const b = k * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.object = new Mesh(geo, new ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide,
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.object.frustumCulled = false;
    this.object.renderOrder = -1;
  }

  hit(): void {}

  update(f: LayerFrame): void {
    const s = f.renderer.getSize(this.size);
    this.view.update(s.x / Math.max(1, s.y), ISO_YAW, ISO_PITCH, FIT, f.camera);
    this.u.time.value = f.time;
    // 時刻 × 速さにすると、盛り上がりが変わった瞬間に雲がとぶので、フレームごとに足していく
    this.u.drift.value += f.step * SPEED * (1 + f.energy);
    this.u.energy.value = f.energy;
    this.u.level.value = f.level;
  }

  dispose(): void {
    disposeMesh(this.object);
  }
}
