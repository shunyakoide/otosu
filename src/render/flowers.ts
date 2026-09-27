import {
  AdditiveBlending, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial,
} from 'three';
import { HZ } from '../sim/constants';

// 蔦に咲く花（D25）。見た目だけで、sim・音には関わらない。どこに咲かせるかは render.ts の蔦が決める。
// 図形ごとに「種」（花びらの数・形・反り・開き方・色）を決め、1輪ごとに少しずつ違う花を咲かせる。
// 花びらは1枚ずつ曲面の板（インスタンス）。頂点シェーダが蕾から開く3Dの形を作り、花ごとの傾きで回して
// 正射影で描く（上から見える花、横から見える花が混ざる）。明るさは面の向きで変える（加算合成なので奥行きの並べ替えは不要）。
// 動き（開く・しぼむ・消える）は咲いた時刻からの経過で頂点シェーダが決める。CPU は咲いたときにリングバッファの
// 枠を書いて、その範囲だけ GPU に送る（毎フレームの書き換えなし。回る図形に付いた花の位置だけ setPos で直す）。

/** 花びら（と花芯）のインスタンスの上限 */
const MAX_PETALS = 49152;
/** 開く時間（秒）。内側の花びらは INNER_DELAY 秒遅れて開く */
const OPEN_SEC = 0.7;
const INNER_DELAY = 0.25;
/** 咲いたまま残る時間（秒）。そのあと茎を離れて落ち、FADE_TAU の時定数で消えていく */
const HOLD_SEC = 2.4;
const FADE_TAU = 3.2;
/** 落ちる速さ: 空気の抵抗で FALL_V（px/s）に近づく（時定数 FALL_TAU 秒）。横揺れ（px）と、回転の速さ（rad/s） */
const FALL_V = 95;
const FALL_TAU = 0.7;
const FALL_SWAY = 16;
const FALL_TUMBLE = 1.6;
/** 散り方: 花びらが離れる時刻のばらつき（秒）、ひねりの速さ（rad/s）、外へ広がる距離（花の半径に対して） */
const SCATTER_STAGGER = 0.7;
const SCATTER_TWIST = 3.0;
const SCATTER_SPREAD = 0.6;
/** これより暗くなったら描かない（fade の値） */
const FADE_MIN = 0.02;
const LIFE_SEC = INNER_DELAY + HOLD_SEC - FADE_TAU * Math.log(FADE_MIN);

/** 色の見た目の明るさ（輝度）をそろえる値。緑や黄は同じ明度でも明るく見え、ブルームで白飛びするため */
const PETAL_LUMA = 0.3;
const CORE_LUMA = 0.4;
const LEAF_LUMA = 0.3;

function evenLuma(c: Color, luma: number): void {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.multiplyScalar(Math.min(2.5, luma / Math.max(l, 0.02)));
}

/** 咲いてから消えるまでの秒数と、茎を離れて落ち始めるまでの秒数 */
export const FLOWER_LIFE_SEC = LIFE_SEC;
export const FLOWER_HOLD_SEC = HOLD_SEC;

/** 見た目だけに使う決定論的な乱数 [0, 1) */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** 花の形（1輪ごとに FORMS からランダムに選ぶ） */
type Form = {
  petals: number;
  /** 花びらの幅（花の半径に対する半幅） */
  width: number;
  /** 開ききったときの花びらの角度（軸から、ラジアン）。小さいほど杯形（チューリップ）、π/2 で平ら */
  openAngle: number;
  /** 幅方向の反り（杯のように縁が持ち上がる） */
  cup: number;
  /** 長さ方向の反り（先が外へ反る +、内へ巻く −） */
  curl: number;
  /** 先端の切れ込み（桜のような） */
  notch: number;
  /** 先の尖り（0 = 丸い） */
  pointy: number;
  /** 内側の2枚目の花びらの大きさ（0 = なし）と、開く角度（外側に対する倍率） */
  layer2: number;
  layer2Open: number;
  /** 花芯の大きさ */
  core: number;
  size: number;
};

/** 図形ごとの色（同じ図形の花は色の系統をそろえ、形だけ変える） */
type Palette = {
  /** 色相のずれ（周）と彩度・明るさ */
  hue: number;
  sat: number;
  light: number;
  /** 花芯の色相（花びらからのずれ） */
  coreHue: number;
};

type Rand = (k: number) => number;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const pick = <T>(xs: readonly T[], t: number): T => xs[Math.min(xs.length - 1, Math.floor(t * xs.length))]!;

/** 花の種類。r(k) は 0..1 の乱数（k ごとに別の値） */
const FORMS: readonly ((r: Rand) => Form)[] = [
  // ひなぎく: 細く平たい花びらがたくさん、大きな花芯
  (r) => ({ petals: pick([16, 20, 24], r(0)), width: lerp(0.06, 0.09, r(1)), openAngle: lerp(1.35, 1.55, r(2)), cup: 0.1, curl: lerp(-0.1, 0.2, r(3)),
    notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.22, 0.3, r(4)), size: lerp(0.85, 1.1, r(5)) }),
  // 桜: 丸い5枚に切れ込み
  (r) => ({ petals: 5, width: lerp(0.36, 0.44, r(1)), openAngle: lerp(1.2, 1.45, r(2)), cup: lerp(0.2, 0.4, r(3)), curl: 0.1,
    notch: lerp(0.14, 0.22, r(4)), pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.14, size: lerp(0.75, 0.95, r(5)) }),
  // チューリップ: 3+3 枚の杯形
  (r) => ({ petals: 3, width: lerp(0.5, 0.58, r(1)), openAngle: lerp(0.35, 0.6, r(2)), cup: lerp(0.45, 0.6, r(3)), curl: lerp(-0.2, 0.1, r(4)),
    notch: 0, pointy: 0.3, layer2: 0.92, layer2Open: 0.8, core: 0.1, size: lerp(0.9, 1.15, r(5)) }),
  // ゆり: 6 枚の長く尖った花びらが外へ反る
  (r) => ({ petals: 6, width: lerp(0.2, 0.26, r(1)), openAngle: lerp(0.7, 0.95, r(2)), cup: 0.3, curl: lerp(0.9, 1.3, r(3)),
    notch: 0, pointy: lerp(0.8, 1.2, r(4)), layer2: 0, layer2Open: 0.7, core: 0.1, size: lerp(1.0, 1.25, r(5)) }),
  // 睡蓮: 尖った花びらが2重、ゆるい杯形
  (r) => ({ petals: pick([8, 10, 12], r(0)), width: lerp(0.16, 0.22, r(1)), openAngle: lerp(0.9, 1.2, r(2)), cup: lerp(0.3, 0.5, r(3)), curl: 0.1,
    notch: 0, pointy: lerp(0.6, 1.0, r(4)), layer2: lerp(0.7, 0.85, r(6)), layer2Open: 0.6, core: 0.16, size: lerp(0.95, 1.2, r(5)) }),
  // 菊: 細い花びらが2重で丸く盛り上がる
  (r) => ({ petals: pick([16, 20, 24], r(0)), width: lerp(0.06, 0.08, r(1)), openAngle: lerp(0.8, 1.1, r(2)), cup: 0.5, curl: lerp(-0.4, -0.1, r(3)),
    notch: 0, pointy: 0.2, layer2: lerp(0.7, 0.85, r(6)), layer2Open: 0.55, core: 0.08, size: lerp(0.85, 1.05, r(5)) }),
  // 釣鐘草: 幅広い5枚がつながった鐘形、先だけ外へ
  (r) => ({ petals: 5, width: lerp(0.5, 0.6, r(1)), openAngle: lerp(0.3, 0.45, r(2)), cup: 0.2, curl: lerp(1.0, 1.5, r(3)),
    notch: 0, pointy: lerp(0.5, 0.9, r(4)), layer2: 0, layer2Open: 0.7, core: 0.08, size: lerp(0.8, 1.0, r(5)) }),
  // 星形（クレマチス）: 幅広で尖った 4〜6 枚が平らに
  (r) => ({ petals: pick([4, 5, 6], r(0)), width: lerp(0.28, 0.38, r(1)), openAngle: lerp(1.35, 1.55, r(2)), cup: lerp(0.05, 0.2, r(3)), curl: lerp(0, 0.3, r(4)),
    notch: 0, pointy: lerp(0.7, 1.2, r(6)), layer2: 0, layer2Open: 0.7, core: lerp(0.14, 0.2, r(7)), size: lerp(0.9, 1.15, r(5)) }),
  // 薔薇: 丸い花びらが2重に深く重なる
  (r) => ({ petals: pick([5, 6], r(0)), width: lerp(0.45, 0.55, r(1)), openAngle: lerp(0.75, 1.0, r(2)), cup: lerp(0.5, 0.7, r(3)), curl: lerp(0.2, 0.5, r(4)),
    notch: 0, pointy: 0, layer2: lerp(0.72, 0.82, r(6)), layer2Open: 0.45, core: 0.06, size: lerp(0.85, 1.05, r(5)) }),
  // 梅・野ばら: 丸い5枚が平らに、花芯のしべが目立つ
  (r) => ({ petals: 5, width: lerp(0.42, 0.5, r(1)), openAngle: lerp(1.3, 1.5, r(2)), cup: lerp(0.25, 0.45, r(3)), curl: 0,
    notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.2, 0.26, r(4)), size: lerp(0.75, 0.95, r(5)) }),
  // たんぽぽ: とても細い花びらがぎっしり2重
  (r) => ({ petals: 24, width: lerp(0.045, 0.06, r(1)), openAngle: lerp(1.2, 1.45, r(2)), cup: 0.05, curl: lerp(-0.2, 0.1, r(3)),
    notch: 0.05, pointy: 0, layer2: lerp(0.6, 0.75, r(6)), layer2Open: 0.7, core: 0.1, size: lerp(0.8, 1.0, r(5)) }),
  // 風車（コスモス）: 8 枚の幅広い花びら、先にぎざぎざ
  (r) => ({ petals: 8, width: lerp(0.22, 0.28, r(1)), openAngle: lerp(1.3, 1.5, r(2)), cup: lerp(0.1, 0.25, r(3)), curl: lerp(0, 0.2, r(4)),
    notch: lerp(0.06, 0.1, r(6)), pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.14, 0.2, r(7)), size: lerp(0.95, 1.15, r(5)) }),
];

function makePalette(group: number): Palette {
  const r = (k: number) => hash01(group, 0x51ec1e5, k);
  return {
    hue: (r(11) - 0.5) * 0.35,
    sat: 0.55 + 0.4 * r(12),
    light: 0.5 + 0.2 * r(13),
    coreHue: r(14) < 0.5 ? 0.12 + 0.1 * r(15) : 0.5 + (r(16) - 0.5) * 0.3,
  };
}

const VERT = /* glsl */ `
uniform float uTime;
attribute vec4 aPos;    // 花の中心 x, y（ワールド, y 下向き）, 半径, 咲いた時刻（秒）
attribute vec4 aPetal;  // 軸まわりの角度, 種類（0 外側 / 1 内側 / 2 花芯）, 長さ, 半幅
attribute vec4 aForm;   // 開ききった角度, 幅の反り, 長さの反り, 切れ込み
attribute vec4 aOrient; // 花が向く方向（画面内の角度）, 傾き, 軸まわりの回転, 乱数
attribute vec2 aMisc;   // 明るさ, 開き始めの遅れ（秒）
attribute vec2 aTurn;   // 付いている図形が咲いてから回った角度（画面の向き）, 茎の長さ（px）
attribute vec3 aColor;
attribute vec3 aCore;
varying vec3 vColor;
varying vec3 vBase;
varying vec2 vUW;
varying float vShade;
varying float vKind;
const float PI = 3.14159265359;

vec3 rotAxis(vec3 v, vec3 k, float a) {
  return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a));
}

void main() {
  float t = uTime - aPos.w - aMisc.y;
  if (t < 0.0 || t > ${LIFE_SEC.toFixed(3)}) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 画面外に潰す
    return;
  }
  float tf = max(0.0, uTime - aPos.w - ${HOLD_SEC.toFixed(3)}); // 落ち始めてからの秒数（花ごとにそろえる）
  float fade = exp(-tf / ${FADE_TAU.toFixed(3)});
  float p = min(1.0, t / ${OPEN_SEC.toFixed(3)});
  // 蕾から開き、しぼむときは少し閉じる
  // 少し行き過ぎてから落ち着く（勢いよく開く。明るさは上げない）
  float q = p - 1.0;
  float open = 1.0 + 2.4 * q * q * q + 1.4 * q * q;
  float bloom = open * (0.85 + 0.15 * fade);
  // 根本から: 小さな蕾が茎の先で大きく育ちながら開く
  float grow = 0.08 + 0.92 * open;
  float tf0 = uTime - aPos.w; // 花ごとにそろえた経過（内側の花びらの遅れを含まない）
  float stem = aTurn.y * smoothstep(0.0, ${(OPEN_SEC * 0.8).toFixed(3)}, tf0);

  float u = position.y + 0.5; // 付け根 0 → 先 1
  float w = position.x * 2.0; // 幅 -1..1
  float R = aPos.z;
  float kind = aPetal.y;
  bool isCore = abs(kind - 2.0) < 0.5;
  bool isLeaf = kind > 2.5;
  vec3 P;
  vec3 N;
  if (isCore) {
    // 花芯: 軸に垂直な円盤（少し持ち上げる）
    float rr = u * R * aPetal.z * (0.4 + 0.6 * bloom);
    float th = w * PI;
    P = vec3(rr * cos(th), rr * sin(th), 0.08 * R);
    N = vec3(0.0, 0.0, 1.0);
  } else {
    float phi = aPetal.x;
    vec3 radial = vec3(cos(phi), sin(phi), 0.0);
    vec3 tang = vec3(-sin(phi), cos(phi), 0.0);
    float len = R * aPetal.z * (0.55 + 0.45 * bloom);
    // 軸からの角度: 蕾（ほぼ閉じる）→ 開ききった角度。長さ方向に反る
    float pitch = mix(0.12, aForm.x, bloom) + aForm.z * u * bloom;
    vec3 along = sin(pitch) * radial + cos(pitch) * vec3(0.0, 0.0, 1.0);
    vec3 up = cos(pitch) * radial - sin(pitch) * vec3(0.0, 0.0, 1.0); // 花びらの面の法線（外側）
    // 幅: 付け根は細く、中ほどで最大、先で丸く閉じる。切れ込みは先端の中央を短くする
    float notch = max(aForm.w, 0.0);
    float pointy = max(-aForm.w, 0.0);
    float prof = pow(sin(PI * min(u * 1.05, 1.0)), 0.6 + 1.2 * pointy) * (1.0 - 0.25 * u * u);
    // 葉: 付け根から膨らみ、先は尖る
    if (isLeaf) prof = pow(sin(PI * u), 0.85) * (1.0 - 0.3 * u);
    float hw = R * aPetal.w * prof * (0.6 + 0.4 * bloom);
    float s = u * len * (1.0 - notch * exp(-w * w * 6.0) * smoothstep(0.7, 1.0, u));
    // 縁が内側（軸の側）へ持ち上がる。葉は中央の筋で V 字に折れる
    float lift = isLeaf ? aForm.y * abs(w) * hw : aForm.y * w * w * hw;
    P = s * along + w * hw * tang - lift * up;
    N = normalize(up + tang * (2.0 * aForm.y * w));
  }
  P *= grow;

  // 散る: 花びらは1枚ずつ少しずれて離れ、外へ広がりながら自分の軸でひねれる（花芯は花と一緒）
  float h1 = fract(sin(aPetal.x * 12.9898 + aOrient.w * 78.233 + kind * 4.1) * 43758.5453);
  float h2 = fract(sin(aPetal.x * 39.3468 + aOrient.w * 11.135 + kind * 7.7) * 24634.6345);
  float h3 = fract(sin(aPetal.x * 73.156 + aOrient.w * 52.235 + kind * 2.3) * 12345.6789);
  float tp = isCore ? tf : max(0.0, tf - ${SCATTER_STAGGER.toFixed(2)} * h1);
  if (!isCore && tp > 0.0) {
    vec3 radial = vec3(cos(aPetal.x), sin(aPetal.x), 0.0);
    P = rotAxis(P, radial, tp * ${SCATTER_TWIST.toFixed(2)} * (h2 - 0.5));
    N = rotAxis(N, radial, tp * ${SCATTER_TWIST.toFixed(2)} * (h2 - 0.5));
    P += radial * R * ${SCATTER_SPREAD.toFixed(2)} * (0.5 + h3) * (1.0 - exp(-tp / 0.9));
  }

  // 花の向き: 軸まわりに回し、画面内の方向へ傾ける
  vec3 z = vec3(0.0, 0.0, 1.0);
  P = rotAxis(P, z, aOrient.z);
  N = rotAxis(N, z, aOrient.z);
  // 落ちながら、傾きの向きと傾きがゆっくり回る（いろいろな角度から見える）
  float seed = aOrient.w;
  float dir = aOrient.x + tf * ${FALL_TUMBLE.toFixed(2)} * (seed - 0.5);
  float tilt = aOrient.y + tf * ${FALL_TUMBLE.toFixed(2)} * (0.4 + 0.6 * seed);
  vec3 k = vec3(-sin(dir), cos(dir), 0.0);
  P = rotAxis(P, k, tilt);
  N = rotAxis(N, k, tilt);

  // 面の向きで明るさを変える: 光の当たる面は明るく、斜めの面は縁が光る（両面）
  vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
  float ndv = abs(N.z);
  float diff = abs(dot(N, L));
  vShade = aMisc.x * fade * smoothstep(0.0, 1.0, p) * (0.3 + 0.5 * diff + 0.45 * pow(1.0 - ndv, 2.0));
  vColor = isCore ? aCore : aColor;
  vBase = aCore;
  vUW = vec2(u, w);
  vKind = kind;
  // 付いている図形と一緒に回る。花の中心は茎の先（線の外側）
  mat2 turn = mat2(cos(aTurn.x), sin(aTurn.x), -sin(aTurn.x), cos(aTurn.x));
  P.xy = turn * P.xy;
  vec2 stemTip = turn * vec2(cos(aOrient.x), sin(aOrient.x)) * stem;
  // 落ちる速さと揺れは花びらごとに少しずつ違う
  // 葉はひらひらと遅く落ちる
  float vf = isCore ? 1.0 : isLeaf ? 0.7 + 0.2 * h3 : 0.9 + 0.2 * h3;
  float fall = ${FALL_V.toFixed(1)} * vf * (tp - ${FALL_TAU.toFixed(2)} * (1.0 - exp(-tp / ${FALL_TAU.toFixed(2)})));
  float sway = ${FALL_SWAY.toFixed(1)} * sin(tp * 1.6 + seed * 6.28 + h1 * 2.0) * min(1.0, tp);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vec2(aPos.x + sway, -aPos.y - fall) + stemTip + P.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying vec3 vBase;
varying vec2 vUW;
varying float vShade;
varying float vKind;
void main() {
  float u = vUW.x;
  float w = abs(vUW.y);
  vec3 col;
  if (vKind > 2.5) {
    // 葉: 付け根は濃く、中央の筋と斜めの葉脈を少し光らせる
    float mid = exp(-w * w * 80.0) * smoothstep(0.02, 0.2, u) * (1.0 - smoothstep(0.85, 1.0, u));
    float side = pow(abs(sin((u * 5.0 - w * 1.6) * 3.14159)), 14.0) * smoothstep(0.1, 0.4, w) * (1.0 - w);
    float edge = smoothstep(0.8, 1.0, w);
    col = mix(vBase, vColor, smoothstep(0.0, 0.6, u)) * (0.45 + 0.35 * u + 0.6 * mid + 0.3 * side + 0.35 * edge);
  } else if (vKind > 1.5) {
    // 花芯: 縁にしべの点
    float dots = pow(abs(cos(vUW.y * 3.14159 * 9.0)), 6.0) * smoothstep(0.55, 0.9, u);
    col = vColor * (0.7 + 0.8 * dots);
  } else {
    // 花びら: 付け根は花芯の色、先へ花びらの色で明るく。縁と中央の筋を少し光らせる
    float edge = smoothstep(0.7, 1.0, w) + 0.6 * smoothstep(0.85, 1.0, u);
    float vein = 0.25 * exp(-w * w * 40.0) * smoothstep(0.1, 0.8, u);
    col = mix(vBase * 0.6, vColor, smoothstep(0.0, 0.45, u)) * (0.35 + 0.65 * smoothstep(0.0, 0.8, u) + 0.5 * edge + vein);
  }
  gl_FragColor = vec4(col * vShade, 1.0);
}`;

export type LeafOpts = {
  len: number;
  gain: number;
  dirX: number;
  dirY: number;
  /** 葉の向きを軸にした傾き（0 = 正面） */
  roll: number;
};

export type BloomOpts = {
  /** 花の半径（px） */
  radius: number;
  /** 明るさ */
  gain: number;
  /** 花が向く画面内の方向（ワールドの向き: x 右・y 下） */
  faceX: number;
  faceY: number;
  /** 傾き（0 = 正面、π/2 = 真横） */
  tilt: number;
  /** 茎の長さ（px）。花は (x, y) から face の方へ茎の分だけ離れて咲く */
  stem: number;
};

export class Flowers {
  readonly mesh: Mesh;
  private readonly geo = new InstancedBufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly aPos = this.attr('aPos', 4);
  private readonly aPetal = this.attr('aPetal', 4);
  private readonly aForm = this.attr('aForm', 4);
  private readonly aOrient = this.attr('aOrient', 4);
  private readonly aMisc = this.attr('aMisc', 2);
  private readonly aColor = this.attr('aColor', 3);
  private readonly aCore = this.attr('aCore', 3);
  private readonly aTurn = this.attr('aTurn', 2);
  private readonly all = [this.aPos, this.aPetal, this.aForm, this.aOrient, this.aMisc, this.aColor, this.aCore, this.aTurn];
  /** 花の先頭の枠ごとの、その花のインスタンス数（setPos 用） */
  private readonly count = new Uint8Array(MAX_PETALS);
  /** 次に書く枠と、使ったことのある枠の数 */
  private head = 0;
  private used = 0;
  /** このフレームで書いた範囲（枠番号）。送るのは次の draw で */
  private dirtyFrom = -1;
  private dirtyCount = 0;
  /** setPos で書き換えた枠の範囲 [movedFrom, movedTo)。なければ movedTo = 0 */
  private movedFrom = MAX_PETALS;
  private movedTo = 0;

  private readonly palettes = new Map<number, Palette>();
  private readonly c = new Color();
  private readonly hsl = { h: 0, s: 0, l: 0 };

  constructor(order: number) {
    const petal = new PlaneGeometry(1, 1, 3, 6);
    this.geo.index = petal.index;
    this.geo.setAttribute('position', petal.getAttribute('position'));
    for (const a of this.all) this.geo.setAttribute(a.name, a);
    this.geo.instanceCount = 0;
    this.material = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uTime: { value: 0 } },
      blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
    });
    this.mesh = new Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
  }

  private attr(name: string, size: number): InstancedBufferAttribute {
    const a = new InstancedBufferAttribute(new Float32Array(MAX_PETALS * size), size);
    a.name = name;
    a.setUsage(DynamicDrawUsage);
    return a;
  }

  /**
   * 1輪咲かせる（step は咲き始める時刻。先の時刻でもよい）。種は group から決まり、k は同じ step で咲かせる花の番号。
   * base は図形の色（音程の色）。返り値は花の番号（setPos で動かす用）
   */
  bloom(group: number, step: number, k: number, x: number, y: number, o: BloomOpts, base: Color, mono: boolean): number {
    let pal = this.palettes.get(group);
    if (!pal) {
      pal = makePalette(group);
      this.palettes.set(group, pal);
    }
    const key = step * 64 + k;
    const r = (j: number) => hash01(group, key, j);
    // 形は1輪ごとに選ぶ（同じ図形の中でも違う花が咲く）
    const sp = pick(FORMS, r(20))((j) => hash01(group, key, 40 + j));
    const n = sp.petals * (sp.layer2 > 0 ? 2 : 1) + 1;
    if (this.head + n > MAX_PETALS) this.head = 0;
    const start = this.head;
    this.head += n;
    this.used = Math.max(this.used, this.head);
    this.count[start] = n;
    this.markDirty(start, n);

    // 色: 図形の色から種ごとに色相をずらし、花ごとに少し揺らす。white モードでは淡い色だけ
    const c = this.c;
    base.getHSL(this.hsl);
    const hue = this.hsl.h + pal.hue + (r(4) - 0.5) * 0.1;
    c.setHSL(hue, mono ? 0.12 : pal.sat, pal.light);
    evenLuma(c, PETAL_LUMA);
    const pr = c.r, pg = c.g, pb = c.b;
    c.setHSL(hue + pal.coreHue, mono ? 0.05 : 0.85, 0.6);
    evenLuma(c, CORE_LUMA);

    const radius = sp.size * o.radius * (0.85 + 0.3 * r(0));
    const face = Math.atan2(-o.faceY, o.faceX); // 画面（y 上向き）での方向
    const spin = r(3) * Math.PI * 2;
    const seed = r(1);
    let i = start;
    const put = (phi: number, kind: number, len: number, hw: number, pitch: number, delay: number, gain: number) => {
      const jit = hash01(group, key, 100 + i - start) - 0.5;
      this.aPos.setXYZW(i, x, y, radius, step / HZ);
      this.aPetal.setXYZW(i, phi + jit * 0.15, kind, len * (1 + 0.12 * jit), hw);
      // 切れ込みと尖りは1つにまとめて送る（切れ込み ≥ 0、尖りは負の値）
      this.aForm.setXYZW(i, pitch, sp.cup, sp.curl, sp.pointy > 0 ? -sp.pointy : sp.notch);
      this.aOrient.setXYZW(i, face, o.tilt, spin, seed);
      this.aMisc.setXY(i, gain, delay);
      this.aTurn.setXY(i, 0, o.stem);
      this.aColor.setXYZ(i, pr, pg, pb);
      this.aCore.setXYZ(i, c.r, c.g, c.b);
      i++;
    };
    const da = (Math.PI * 2) / sp.petals;
    for (let j = 0; j < sp.petals; j++) put(j * da, 0, 1, sp.width, sp.openAngle, 0, o.gain);
    if (sp.layer2 > 0) {
      for (let j = 0; j < sp.petals; j++) {
        put((j + 0.5) * da, 1, sp.layer2, sp.width * 0.85, sp.openAngle * sp.layer2Open, INNER_DELAY, o.gain * 0.9);
      }
    }
    put(0, 2, sp.core, 0, 0, 0.1, o.gain * 0.8);
    return start;
  }

  /**
   * 蔦に葉を1枚付ける（step は出始める時刻）。o.dir は葉の伸びる向き（ワールド）、o.len は長さ（px）。
   * color は葉の色。返り値は setPos 用の番号
   */
  leaf(group: number, step: number, k: number, x: number, y: number, o: LeafOpts, color: Color): number {
    if (this.head + 1 > MAX_PETALS) this.head = 0;
    const i = this.head;
    this.head += 1;
    this.used = Math.max(this.used, this.head);
    this.count[i] = 1;
    this.markDirty(i, 1);
    const r = (j: number) => hash01(group, step * 64 + k, 500 + j);
    const dir = Math.atan2(-o.dirY, o.dirX); // 画面（y 上向き）での向き
    // 花の枠組みを流用: 軸を葉の向きへ倒し、葉は軸に垂直（平ら）に伸ばす
    this.aPos.setXYZW(i, x, y, o.len, step / HZ);
    this.aPetal.setXYZW(i, dir, 3, 1, 0.32 + 0.1 * r(0));
    this.aForm.setXYZW(i, Math.PI / 2, 0.25 + 0.25 * r(1), 0.25 + 0.35 * r(2), 0);
    this.aOrient.setXYZW(i, dir, o.roll, 0, r(3));
    this.aMisc.setXY(i, o.gain, 0);
    this.aTurn.setXY(i, 0, 0);
    const c = this.c.copy(color);
    evenLuma(c, LEAF_LUMA);
    this.aColor.setXYZ(i, c.r, c.g, c.b);
    c.multiplyScalar(0.45);
    this.aCore.setXYZ(i, c.r, c.g, c.b);
    return i;
  }

  /**
   * 咲いている花を動かす（回っている図形に付いた花用）。turn は咲いてから図形が回った角度（ワールドの向き: y 下）。
   * まとめて次の draw で送る
   */
  setPos(flower: number, x: number, y: number, turn: number): void {
    const n = this.count[flower]!;
    for (let i = flower; i < flower + n; i++) {
      this.aPos.setXY(i, x, y);
      this.aTurn.setX(i, -turn);
    }
    this.movedFrom = Math.min(this.movedFrom, flower);
    this.movedTo = Math.max(this.movedTo, flower + n);
  }

  /** 書いた範囲を送る範囲に含める（離れていれば両方を覆う範囲。リングが一周したときだけ広くなる） */
  private markDirty(start: number, n: number): void {
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = start;
      this.dirtyCount = n;
    } else {
      const from = Math.min(this.dirtyFrom, start);
      this.dirtyCount = Math.max(this.dirtyFrom + this.dirtyCount, start + n) - from;
      this.dirtyFrom = from;
    }
  }

  /** 図形が消えたら種を忘れる（同じ group は再利用されない） */
  forget(group: number): void {
    this.palettes.delete(group);
  }

  clear(): void {
    this.mesh.visible = false;
  }

  draw(rs: number): void {
    this.mesh.visible = true;
    this.material.uniforms['uTime']!.value = rs / HZ;
    if (this.dirtyFrom >= 0) {
      for (const a of this.all) {
        a.clearUpdateRanges();
        a.addUpdateRange(this.dirtyFrom * a.itemSize, this.dirtyCount * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirtyFrom = -1;
      this.dirtyCount = 0;
    }
    if (this.movedTo > 0) {
      // 同じフレームで新しく書いた範囲があれば、それに足す（送ったあと three が範囲を空にする）
      for (const a of [this.aPos, this.aTurn]) {
        a.addUpdateRange(this.movedFrom * a.itemSize, (this.movedTo - this.movedFrom) * a.itemSize);
        a.needsUpdate = true;
      }
      this.movedFrom = MAX_PETALS;
      this.movedTo = 0;
    }
    this.geo.instanceCount = this.used;
  }
}
