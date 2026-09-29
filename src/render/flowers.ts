import {
  AdditiveBlending, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial,
} from 'three';
import { HZ } from '../sim/constants';
import { hash01 } from './hash';

// 蔦に咲く花（D25）。見た目だけで、sim・音には関わらない。どこに咲かせるかは render.ts の蔦が決める。
// 図形ごとに「種」（花びらの数・形・反り・開き方・色）を決め、1輪ごとに少しずつ違う花を咲かせる。
// 花びらは1枚ずつ曲面の板（インスタンス）。頂点シェーダが蕾から開く3Dの形を作り、花ごとの傾きで回して
// 正射影で描く（上から見える花、横から見える花が混ざる）。明るさは面の向きで変える（加算合成なので奥行きの並べ替えは不要）。
// 動き（開く・しぼむ・消える）は咲いた時刻からの経過で頂点シェーダが決める。CPU は咲いたときにリングバッファの
// 枠を書いて、その範囲だけ GPU に送る（毎フレームの書き換えなし。回る図形に付いた花の位置だけ setPos で直す）。

/**
 * 花びら（と花芯）のインスタンスの上限。GPU は使ったことのある枠を毎フレーム全部処理するので、大きいほど重い。
 * 足りなければ古い順に上書きする（一番古いのは落ちて暗くなった花なので、少し早く消えるだけ）
 */
const MAX_PETALS = 65536;
/** 開く時間（秒）。内側の花びらは INNER_DELAY 秒遅れて開く */
const OPEN_SEC = 0.7;
const INNER_DELAY = 0.25;
/** 咲いたまま残る時間（秒）。そのあと茎を離れて落ち、FADE_TAU の時定数で消えていく */
const HOLD_SEC = 2.4;
const FADE_TAU = 2.0;
/** 茎を離れるとすぐ、この割合まで暗くなる（時定数 DROP_TAU 秒）。咲いている花が落ちたものに埋もれないように */
const DROP_DIM = 0.55;
const DROP_TAU = 0.6;
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
/** 彼岸花のしべが付け根から先までに上へ曲がる角度（ラジアン） */
const STAMEN_TURN = 1.3;
const LIFE_SEC = INNER_DELAY + HOLD_SEC - FADE_TAU * Math.log(FADE_MIN);

/** 色の見た目の明るさ（輝度）をそろえる値。緑や黄は同じ明度でも明るく見え、ブルームで白飛びするため */
const PETAL_LUMA = 0.3;
const CORE_LUMA = 0.4;
const LEAF_LUMA = 0.3;
/** white モードの花びらと芯の彩度と輝度（色は淡く、そのぶん明るくして、はっきり見えるように） */
const MONO_SAT = 0.2;
const MONO_CORE_SAT = 0.1;
const MONO_PETAL_LUMA = 0.42;
const MONO_CORE_LUMA = 0.5;

function evenLuma(c: Color, luma: number): void {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.multiplyScalar(Math.min(2.5, luma / Math.max(l, 0.02)));
}

/** 咲いてから茎を離れて落ち始めるまでの秒数 */
export const FLOWER_HOLD_SEC = HOLD_SEC;

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

/** 花の種類のモード。mixed は FORMS から1輪ごとに選び、ほかは1種類だけを咲かせる */
export const FLOWER_KINDS = ['mixed', 'sunflower', 'spiderlily', 'daisy', 'meadow'] as const;
/** 小窓に出す名前（キーと違うものだけ） */
export const FLOWER_LABELS: Partial<Record<FlowerKind, string>> = { spiderlily: 'spider lily' };
export type FlowerKind = (typeof FLOWER_KINDS)[number];

/** 色相（周）・彩度・明るさと、そろえる輝度 */
type Tone = { h: number; s: number; l: number; luma: number };

/** しべ（花びらと同じ板を細く長くしたもの。先に葯が光る） */
type Stamens = { count: number; len: number; width: number; pitch: number; curl: number };

/** 花畑（meadow）の中の1種類: 形と色の組と、出る割合 */
type Variant = { weight: number; form: (r: Rand) => Form; petal: Tone; core: Tone };

/** 種類ごとの見た目。花の形・色と、蔦のどこにどう咲かせるか（vines.ts が読む） */
export type Species = {
  forms: readonly ((r: Rand) => Form)[];
  /** 花畑: 形と色の組を画面の場所で選ぶ（近くには同じ組が咲き、色がまとまって帯になる）。forms・petal・core より優先 */
  variants?: readonly Variant[];
  /** 花びらと花芯の色（なければ図形の色から作る）。hueJitter は花ごとの色相の揺れ */
  petal?: Tone;
  core?: Tone;
  hueJitter: number;
  /** 花芯の模様: 0 = 縁にしべの点 / n > 0 = n 粒の種がらせん（黄金角）に並ぶ */
  disc: number;
  /** 花びらの縁の波打ち（0 = なし） */
  wave: number;
  stamens?: Stamens;
  /** 散り方: 1 = 花びらが1枚ずつ離れて舞う / 0 = 首ごと落ちる */
  scatter: number;
  /** 1本の茎の先に放射状に付く花の数（[最小, 最大]。なければ1輪） */
  umbel?: readonly [number, number];
  /** 傾き（0 = 正面）の範囲。なければ蔦が決める */
  tilt?: readonly [number, number];
  /** 蔦側: 葉を出すか・葉の色（なければ蔦の色）と大きさ、花の大きさと間隔の倍率、房の添え花 */
  leaves: boolean;
  leafColor?: Color;
  leafScale: number;
  size: number;
  gap: number;
  /** 房の添え花の数の上限（0 = なし）と、蔦から離れて咲く幅（px） */
  extras: number;
  spread: number;
  /** 添え花で埋める（花畑）: 毎回たくさん（2〜extras 輪）、蔦の両側へ、周に沿っても広く、大きめに。なければ 0〜2 輪を片側へ */
  fill?: boolean;
  /** 花の向きのばらつき（ラジアン）と、上へ寄せる強さ。0 でなければ、花は蔦から生えて茎でばらばらに伸びる（花畑） */
  faceJitter: number;
  rise: number;
  /** すだれ: 花の場所ごとに垂れる房を出す確率（0 = なし）と、垂れる長さの倍率 */
  cascade?: number;
  cascadeDrop?: number;
  /** 当たった所から放射状に咲く花の数（花火のように。0 = なし）と、蔦の伸びる長さの倍率 */
  burst?: number;
  reach?: number;
  /** 上へ伸びる（茎を空の方へ寄せ、房は縦の軸のまわりに横を向き、しべは上へ反る） */
  upright?: boolean;
  /** 茎（蔦からの長さの倍率と、線で描くときの色・太さ px。色がなければ茎は描かず葉でつなぐ） */
  stem: number;
  stemColor?: Color;
  stemWidth?: number;
  /** 茎の明るさ（花に対して。重なると明るくなるので、たくさん咲く種類は控えめに） */
  stemGain?: number;
};

const MIXED: Species = { forms: FORMS, hueJitter: 0.1, disc: 0, wave: 0, scatter: 1, leaves: true, leafScale: 1, size: 1, gap: 1, extras: 2, spread: 8, faceJitter: 0, rise: 0, stem: 1 };

export const SPECIES: Record<FlowerKind, Species> = {
  mixed: MIXED,
  // ひまわり: 黄色い舌状花が2列、大きな茶色の円盤に種がらせんに並ぶ。正面を向き、首ごと落ちる
  sunflower: {
    forms: [
      (r) => ({ petals: pick([21, 24, 26], r(0)), width: lerp(0.13, 0.16, r(1)), openAngle: lerp(1.4, 1.55, r(2)), cup: lerp(0.1, 0.25, r(3)),
        curl: lerp(-0.15, 0.2, r(4)), notch: 0, pointy: lerp(0.3, 0.6, r(6)), layer2: lerp(0.85, 0.95, r(7)), layer2Open: 0.95,
        core: lerp(0.42, 0.5, r(8)), size: lerp(1.05, 1.25, r(5)) }),
    ],
    petal: { h: 0.13, s: 1, l: 0.52, luma: 0.62 },
    core: { h: 0.075, s: 0.8, l: 0.3, luma: 0.14 },
    hueJitter: 0.04,
    disc: 220,
    wave: 0.15,
    scatter: 0,
    tilt: [0.05, 0.75],
    leaves: true,
    leafColor: new Color(0x4f9a3a),
    leafScale: 1.35,
    size: 1.15,
    gap: 1.6,
    extras: 0,
    spread: 8,
    faceJitter: 0,
    rise: 0,
    stem: 1,
  },
  // 彼岸花: 細い6枚が強く反り返って縁が縮れ、長いしべが上へ弧を描く。茎の先に数輪が輪になって付き、葉は出さない
  spiderlily: {
    forms: [
      (r) => ({ petals: 6, width: lerp(0.07, 0.085, r(1)), openAngle: lerp(0.6, 0.8, r(2)), cup: lerp(0.15, 0.25, r(3)),
        curl: lerp(2.0, 2.5, r(4)), notch: 0, pointy: lerp(0.3, 0.5, r(6)), layer2: 0, layer2Open: 0.7, core: 0.05, size: 1 }),
    ],
    petal: { h: 0.995, s: 0.95, l: 0.5, luma: 0.28 },
    core: { h: 0.06, s: 0.7, l: 0.6, luma: 0.45 },
    hueJitter: 0.012,
    disc: 0,
    wave: 0.9,
    stamens: { count: 7, len: 1.5, width: 0.014, pitch: 0.38, curl: -0.1 },
    scatter: 0.5,
    umbel: [4, 6],
    upright: true,
    leaves: false,
    leafScale: 1,
    size: 0.55,
    gap: 1.3,
    extras: 0,
    spread: 8,
    faceJitter: 0,
    rise: 0,
    // すっと伸びるまっすぐな茎の先に咲く
    stem: 4,
    stemColor: new Color(0x5f9e4a),
    stemWidth: 2,
  },
  // 花畑: 小さな花がびっしり咲き、いろいろな花が混ざる。同じ色はまとまって帯になる（場所で選ぶ）。
  // 紫の小菊とすみれが多く、赤い八重・ポピー・桃・キンポウゲ・わすれな草・白のカモミール・青の矢車菊などが混ざる。ところどころ房が垂れる（すだれ）
  meadow: {
    forms: [],
    variants: [
      // ポピー: 4枚の大きな杯形
      { weight: 0.09, form: (r) => ({ petals: 4, width: lerp(0.58, 0.66, r(1)), openAngle: lerp(0.75, 1.0, r(2)), cup: lerp(0.45, 0.6, r(3)), curl: 0.1,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.14, size: lerp(1.0, 1.2, r(5)) }),
        petal: { h: 0.065, s: 1, l: 0.52, luma: 0.42 }, core: { h: 0.13, s: 0.9, l: 0.5, luma: 0.55 } },
      // 赤い八重（ゼラニウム・ラナンキュラス）: 丸い花びらが2重に杯形
      { weight: 0.1, form: (r) => ({ petals: 5, width: lerp(0.5, 0.6, r(1)), openAngle: lerp(0.9, 1.15, r(2)), cup: lerp(0.45, 0.6, r(3)), curl: 0.25,
          notch: 0, pointy: 0, layer2: lerp(0.7, 0.8, r(6)), layer2Open: 0.5, core: 0.07, size: lerp(0.8, 1.0, r(5)) }),
        petal: { h: 0.995, s: 0.85, l: 0.55, luma: 0.32 }, core: { h: 0.98, s: 0.8, l: 0.35, luma: 0.2 } },
      // 紫の小菊（アスター）: 細い花びらが 10〜14 枚、黄色い花芯（小さいので、枚数を減らしても見た目は変わらない。花畑は数が多く、重さに効く）
      { weight: 0.22, form: (r) => ({ petals: pick([10, 12, 14], r(0)), width: lerp(0.09, 0.12, r(1)), openAngle: lerp(1.35, 1.55, r(2)), cup: 0.08, curl: lerp(-0.1, 0.15, r(3)),
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.2, 0.26, r(4)), size: lerp(0.85, 1.05, r(5)) }),
        petal: { h: 0.76, s: 0.75, l: 0.6, luma: 0.4 }, core: { h: 0.13, s: 0.95, l: 0.5, luma: 0.5 } },
      // すみれ: 丸い5枚が平らに
      { weight: 0.13, form: (r) => ({ petals: 5, width: lerp(0.38, 0.46, r(1)), openAngle: lerp(1.3, 1.5, r(2)), cup: lerp(0.2, 0.35, r(3)), curl: 0.05,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.12, size: lerp(0.75, 0.95, r(5)) }),
        petal: { h: 0.7, s: 0.7, l: 0.6, luma: 0.38 }, core: { h: 0.14, s: 0.9, l: 0.55, luma: 0.5 } },
      // 桃の小菊
      { weight: 0.07, form: (r) => ({ petals: pick([10, 12], r(0)), width: lerp(0.1, 0.13, r(1)), openAngle: lerp(1.3, 1.5, r(2)), cup: 0.1, curl: 0.05,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.18, 0.22, r(4)), size: lerp(0.85, 1.0, r(5)) }),
        petal: { h: 0.88, s: 0.6, l: 0.7, luma: 0.5 }, core: { h: 0.13, s: 0.9, l: 0.5, luma: 0.5 } },
      // 黄色のキンポウゲ: 丸い5枚の浅い杯
      { weight: 0.08, form: (r) => ({ petals: 5, width: lerp(0.42, 0.5, r(1)), openAngle: lerp(1.0, 1.25, r(2)), cup: lerp(0.35, 0.5, r(3)), curl: 0.05,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.14, size: lerp(0.7, 0.85, r(5)) }),
        petal: { h: 0.14, s: 1, l: 0.5, luma: 0.6 }, core: { h: 0.12, s: 0.9, l: 0.45, luma: 0.45 } },
      // 空色のわすれな草: 小さな丸い5枚、黄色い目
      { weight: 0.07, form: (r) => ({ petals: 5, width: lerp(0.4, 0.48, r(1)), openAngle: lerp(1.4, 1.55, r(2)), cup: 0.15, curl: 0,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.16, size: lerp(0.55, 0.7, r(5)) }),
        petal: { h: 0.57, s: 0.75, l: 0.65, luma: 0.5 }, core: { h: 0.14, s: 0.95, l: 0.55, luma: 0.55 } },
      // 赤紫の小菊
      { weight: 0.07, form: (r) => ({ petals: pick([10, 12], r(0)), width: lerp(0.1, 0.13, r(1)), openAngle: lerp(1.3, 1.5, r(2)), cup: 0.1, curl: 0.05,
          notch: 0, pointy: 0.2, layer2: 0, layer2Open: 0.7, core: lerp(0.18, 0.22, r(4)), size: lerp(0.85, 1.0, r(5)) }),
        petal: { h: 0.85, s: 0.85, l: 0.55, luma: 0.38 }, core: { h: 0.13, s: 0.9, l: 0.5, luma: 0.5 } },
      // 珊瑚色のポピー
      { weight: 0.05, form: (r) => ({ petals: 4, width: lerp(0.58, 0.66, r(1)), openAngle: lerp(0.8, 1.05, r(2)), cup: lerp(0.4, 0.55, r(3)), curl: 0.1,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.12, size: lerp(0.95, 1.1, r(5)) }),
        petal: { h: 0.02, s: 0.85, l: 0.65, luma: 0.45 }, core: { h: 0.1, s: 0.8, l: 0.4, luma: 0.35 } },
      // 薄紫の小菊
      { weight: 0.06, form: (r) => ({ petals: pick([10, 12], r(0)), width: lerp(0.09, 0.12, r(1)), openAngle: lerp(1.35, 1.55, r(2)), cup: 0.08, curl: 0,
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.2, 0.24, r(4)), size: lerp(0.8, 0.95, r(5)) }),
        petal: { h: 0.72, s: 0.45, l: 0.75, luma: 0.6 }, core: { h: 0.13, s: 0.9, l: 0.5, luma: 0.5 } },
      // 白のカモミール: 白い花びら、大きな黄色い花芯（白は暗いと濁るので明るく）
      { weight: 0.16, form: (r) => ({ petals: 12, width: lerp(0.09, 0.12, r(1)), openAngle: lerp(1.4, 1.56, r(2)), cup: 0.05, curl: lerp(0, 0.2, r(3)),
          notch: 0, pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.26, 0.32, r(4)), size: lerp(0.75, 0.9, r(5)) }),
        petal: { h: 0.6, s: 0.04, l: 0.9, luma: 1.4 }, core: { h: 0.13, s: 1, l: 0.5, luma: 0.6 } },
      // 青の矢車菊: 8枚の先がぎざぎざ、濃い青の目
      { weight: 0.08, form: (r) => ({ petals: 8, width: lerp(0.2, 0.25, r(1)), openAngle: lerp(1.2, 1.4, r(2)), cup: 0.15, curl: 0.1,
          notch: lerp(0.1, 0.15, r(6)), pointy: 0, layer2: 0, layer2Open: 0.7, core: 0.15, size: lerp(0.8, 0.95, r(5)) }),
        petal: { h: 0.63, s: 0.85, l: 0.55, luma: 0.4 }, core: { h: 0.68, s: 0.6, l: 0.35, luma: 0.25 } },
      // 青の桔梗: 先の尖った5枚の星形
      { weight: 0.07, form: (r) => ({ petals: 5, width: lerp(0.32, 0.38, r(1)), openAngle: lerp(1.1, 1.3, r(2)), cup: lerp(0.3, 0.4, r(3)), curl: 0.1,
          notch: 0, pointy: lerp(0.7, 0.9, r(6)), layer2: 0, layer2Open: 0.7, core: 0.1, size: lerp(0.85, 1.0, r(5)) }),
        petal: { h: 0.66, s: 0.7, l: 0.6, luma: 0.42 }, core: { h: 0.6, s: 0.2, l: 0.85, luma: 0.7 } },
    ],
    hueJitter: 0.04,
    disc: 0,
    wave: 0,
    scatter: 1,
    leaves: true,
    leafColor: new Color(0x5fae55),
    leafScale: 0.55,
    size: 0.55,
    gap: 0.4,
    fill: true,
    extras: 12,
    spread: 100,
    faceJitter: 1.0,
    rise: 0.7,
    cascade: 0.45,
    cascadeDrop: 1.4,
    burst: 16,
    reach: 1.4,
    // 長さのばらばらな茎で伸びる（茎は描かない。花だけが広がる）
    stem: 1.6,
  },
  // デイジー（マーガレット・ひなぎく）: 白く細い花びらに黄色い花芯。先がうっすら桃色のものも混ざる
  daisy: {
    forms: [
      (r) => ({ petals: pick([18, 21, 24], r(0)), width: lerp(0.07, 0.1, r(1)), openAngle: lerp(1.4, 1.56, r(2)), cup: 0.08, curl: lerp(-0.1, 0.15, r(3)),
        notch: lerp(0, 0.06, r(6)), pointy: 0, layer2: 0, layer2Open: 0.7, core: lerp(0.24, 0.3, r(4)), size: lerp(0.85, 1.05, r(5)) }),
      (r) => ({ petals: pick([28, 34], r(0)), width: lerp(0.045, 0.06, r(1)), openAngle: lerp(1.25, 1.45, r(2)), cup: 0.1, curl: lerp(-0.2, 0.05, r(3)),
        notch: 0, pointy: 0, layer2: lerp(0.75, 0.85, r(6)), layer2Open: 0.8, core: lerp(0.2, 0.26, r(4)), size: lerp(0.7, 0.9, r(5)) }),
    ],
    // 白は暗いと灰色に濁るので、ほかの花より明るく
    petal: { h: 0.6, s: 0.05, l: 0.9, luma: 1.6 },
    core: { h: 0.135, s: 1, l: 0.5, luma: 0.65 },
    hueJitter: 0.06,
    disc: 70,
    wave: 0,
    scatter: 1,
    leaves: true,
    leafColor: new Color(0x5fae55),
    leafScale: 0.8,
    size: 0.85,
    gap: 0.85,
    extras: 2,
    spread: 8,
    faceJitter: 0,
    rise: 0,
    stem: 1,
  },
};

/** 滑らかなノイズ [0, 1)（格子点の乱数を補間）。花畑の色の帯に使う */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash01(ix + i, iy + j, seed);
  return lerp(lerp(h(0, 0), h(1, 0), sx), lerp(h(0, 1), h(1, 1), sx), sy);
}

/** 花畑の組を場所で選ぶ。t は 0..1（近い場所ほど近い値）。割合で区切る */
function pickVariant(vs: readonly Variant[], t: number): Variant {
  const total = vs.reduce((a, v) => a + v.weight, 0);
  let acc = 0;
  for (const v of vs) {
    acc += v.weight / total;
    if (t < acc) return v;
  }
  return vs[vs.length - 1]!;
}

/** 花畑の帯の大きさ（px）: 大きな帯と、その中の小さなまだら */
const DRIFT_PX = 260;
const DRIFT_FINE_PX = 90;

/**
 * 花ごとの乱数の種（step と、同じ step で咲かせる花の番号 k から）。k は 64 を超えることがある（花畑）ので、
 * step * 64 + k のように足すと、次の step の花と種がぶつかる
 */
const flowerKey = (step: number, k: number): number => (hash01(step, k, 0x51ed270b) * 0x7fffffff) | 0;

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
attribute vec4 aPetal;  // 軸まわりの角度, 種類（0 外側 / 1 内側 / 2 花芯 / 3 葉 / 4 しべ / 5 茎）, 長さ（茎は弓なりの強さ）, 半幅（花芯は模様: 種の数、茎は px）
attribute vec4 aForm;   // 開ききった角度, 幅の反り, 長さの反り, 切れ込み
attribute vec4 aOrient; // 花が向く方向（画面内の角度）, 傾き, 軸まわりの回転, 乱数
attribute vec4 aMisc;   // 明るさ, 開き始めの遅れ（秒）, 縁の波打ち, 散り方（1 = 1枚ずつ舞う / 0 = 首ごと）
attribute vec4 aTurn;   // 付いている図形が咲いてから回った角度（画面の向き）, 茎の長さ（px）, 茎の向き（画面内の角度）, 花びらの付け根の半径（花の半径に対して）
attribute vec3 aColor;
attribute vec3 aCore;
varying vec3 vColor;
varying vec3 vBase;
varying vec2 vUW;
varying float vShade;
varying float vKind;
varying float vDisc;
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
  float fade = exp(-tf / ${FADE_TAU.toFixed(3)}) * mix(${DROP_DIM.toFixed(2)}, 1.0, exp(-tf / ${DROP_TAU.toFixed(2)}));
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
  bool isLeaf = abs(kind - 3.0) < 0.5;
  bool isStamen = abs(kind - 4.0) < 0.5;
  bool isStem = kind > 4.5;
  vec2 uw = vec2(u, w);
  vec3 P;
  vec3 N;
  if (isStem) {
    // 茎: 花の外で、画面に平らな線として描く（下の gl_Position で）
    P = vec3(0.0);
    N = vec3(0.0, 0.0, 1.0);
  } else if (isCore) {
    // 花芯: 軸に垂直な円盤（少し持ち上げる）。板をそのまま広げ、丸く切り抜くのはフラグメント側
    float rr = R * aPetal.z * (0.4 + 0.6 * bloom);
    uw = position.xy * 2.0;
    P = vec3(uw * rr, 0.08 * R);
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
    // しべ: 細い糸のまま（先の葯はフラグメント側）
    if (isStamen) prof = 1.0 - 0.4 * u;
    float wave = aMisc.z;
    // 縁が縮れる花びらは、幅も少し細くなったり太くなったりする
    prof *= 1.0 + 0.18 * wave * sin(u * 23.0 + aPetal.x * 5.0);
    float hw = R * aPetal.w * prof * (0.6 + 0.4 * bloom);
    float s = u * len * (1.0 - notch * exp(-w * w * 6.0) * smoothstep(0.7, 1.0, u));
    // 縁が内側（軸の側）へ持ち上がる。葉は中央の筋で V 字に折れる
    float lift = isLeaf ? aForm.y * abs(w) * hw : aForm.y * w * w * hw;
    // 付け根は花芯の縁から（ひまわりのように円盤の外から花びらが出る）
    // 中心線: 反りの強い花びら・しべは、曲がり具合（一定の曲率）を積分して、本当に巻く形にする。
    // ほかは付け根からの向きで近似する（今までの形のまま）
    vec3 spine = s * along;
    if (isStamen || wave > 0.0) {
      float p0 = mix(0.12, aForm.x, bloom);
      float k = aForm.z * bloom / max(len, 1e-3);
      vec2 rz = abs(k) < 1e-4
        ? s * vec2(sin(p0), cos(p0))
        : vec2(cos(p0) - cos(p0 + k * s), sin(p0 + k * s) - sin(p0)) / k;
      spine = rz.x * radial + rz.y * vec3(0.0, 0.0, 1.0);
    }
    P = spine + w * hw * tang - lift * up + radial * aTurn.w * R * (0.4 + 0.6 * bloom);
    // 縁の波打ち: 縁ほど面の外へ交互にうねる
    float ruffle = wave * sin(u * 26.0 + aPetal.x * 3.0) * w * w * smoothstep(0.15, 0.5, u);
    P += up * ruffle * R * 0.07;
    N = normalize(up + tang * (2.0 * aForm.y * w) + along * ruffle * 0.8);
  }
  P *= grow;

  // 散る: 花びらは1枚ずつ少しずれて離れ、外へ広がりながら自分の軸でひねれる（花芯は花と一緒）
  float h1 = fract(sin(aPetal.x * 12.9898 + aOrient.w * 78.233 + kind * 4.1) * 43758.5453);
  float h2 = fract(sin(aPetal.x * 39.3468 + aOrient.w * 11.135 + kind * 7.7) * 24634.6345);
  float h3 = fract(sin(aPetal.x * 73.156 + aOrient.w * 52.235 + kind * 2.3) * 12345.6789);
  // 散り方が 0 の花は、花びらも花芯と一緒に首ごと落ちる
  float sc = isCore || isStem ? 0.0 : aMisc.w;
  float tp = max(0.0, tf - ${SCATTER_STAGGER.toFixed(2)} * h1 * sc);
  if (sc > 0.0 && tp > 0.0) {
    vec3 radial = vec3(cos(aPetal.x), sin(aPetal.x), 0.0);
    float twist = tp * ${SCATTER_TWIST.toFixed(2)} * (h2 - 0.5) * sc;
    P = rotAxis(P, radial, twist);
    N = rotAxis(N, radial, twist);
    P += radial * R * ${SCATTER_SPREAD.toFixed(2)} * sc * (0.5 + h3) * (1.0 - exp(-tp / 0.9));
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
  // しべ（彼岸花）: 花から出る向き（3D を画面に写したもの）から、画面の上へ向かって少しずつ曲がる弧にする。
  // 付け根から先まで同じ曲がり方なので、なめらかな弓なりになる（先だけ曲げると、まっすぐな棒に見えた）
  if (isStamen) {
    float p0 = mix(0.12, aForm.x, bloom);
    vec3 v0 = sin(p0) * vec3(cos(aPetal.x), sin(aPetal.x), 0.0) + cos(p0) * z;
    v0 = rotAxis(rotAxis(v0, z, aOrient.z), k, tilt);
    float L = R * aPetal.z * (0.55 + 0.45 * bloom) * grow * max(length(v0.xy), 0.35);
    float a0 = atan(v0.y, v0.x);
    // 右へ出るしべは左回り、左へ出るしべは右回りで上へ
    float kk = (cos(a0) >= 0.0 ? 1.0 : -1.0) * ${STAMEN_TURN.toFixed(2)} * bloom / max(L, 1e-3);
    float sl = u * L;
    float a1 = a0 + kk * sl;
    vec2 arc = abs(kk) < 1e-5 ? sl * vec2(cos(a0), sin(a0)) : vec2(sin(a1) - sin(a0), cos(a0) - cos(a1)) / kk;
    P = vec3(arc + vec2(-sin(a1), cos(a1)) * w * R * aPetal.w * (1.0 - 0.4 * u), 0.0);
  }

  // 面の向きで明るさを変える: 光の当たる面は明るく、斜めの面は縁が光る（両面）
  vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
  float ndv = abs(N.z);
  float diff = abs(dot(N, L));
  vShade = aMisc.x * fade * smoothstep(0.0, 1.0, p) * (0.3 + 0.5 * diff + 0.45 * pow(1.0 - ndv, 2.0));
  vColor = isCore ? aCore : aColor;
  vBase = aCore;
  vUW = uw;
  vKind = kind;
  vDisc = isCore ? aPetal.w : 0.0;
  // 付いている図形と一緒に回る。花の中心は茎の先（線の外側）
  mat2 turn = mat2(cos(aTurn.x), sin(aTurn.x), -sin(aTurn.x), cos(aTurn.x));
  P.xy = turn * P.xy;
  vec2 stemTip = turn * vec2(cos(aTurn.z), sin(aTurn.z)) * stem;
  // 落ちる速さと揺れは花びらごとに少しずつ違う
  // 葉はひらひらと遅く落ちる
  float vf = isCore || isStem ? 1.0 : isLeaf ? 0.7 + 0.2 * h3 : mix(1.0, 0.9 + 0.2 * h3, sc);
  float fall = ${FALL_V.toFixed(1)} * vf * (tp - ${FALL_TAU.toFixed(2)} * (1.0 - exp(-tp / ${FALL_TAU.toFixed(2)})));
  float sway = ${FALL_SWAY.toFixed(1)} * sin(tp * 1.6 + seed * 6.28 + h1 * 2.0 * sc) * min(1.0, tp);
  vec2 at = stemTip + P.xy;
  // 茎は付け根から茎の先まで、太さは px
  if (isStem) {
    // 弓なりに（強さと向きは aPetal.z: 茎の長さに対するふくらみ。正で左へ）
    vec2 side = vec2(-stemTip.y, stemTip.x) / max(length(stemTip), 1e-3);
    at = stemTip * u + side * (w * aPetal.w + sin(PI * u) * length(stemTip) * aPetal.z);
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vec2(aPos.x + sway, -aPos.y - fall) + at, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying vec3 vBase;
varying vec2 vUW;
varying float vShade;
varying float vKind;
varying float vDisc;
const float GOLDEN = 2.39996323;
void main() {
  float u = vUW.x;
  float w = abs(vUW.y);
  vec3 col;
  if (vKind > 4.5) {
    // 茎: 中央が明るい
    col = vColor * (1.0 - 0.6 * w * w);
  } else if (vKind > 3.5) {
    // しべ: 糸は花びらの色、先に葯（花芯の色）が光る
    float anther = smoothstep(0.93, 0.98, u);
    col = mix(vColor * (0.5 + 0.5 * u), vBase * 1.6, anther);
  } else if (vKind > 2.5) {
    // 葉: 付け根は濃く、中央の筋と斜めの葉脈を少し光らせる
    float mid = exp(-w * w * 80.0) * smoothstep(0.02, 0.2, u) * (1.0 - smoothstep(0.85, 1.0, u));
    float side = pow(abs(sin((u * 5.0 - w * 1.6) * 3.14159)), 14.0) * smoothstep(0.1, 0.4, w) * (1.0 - w);
    float edge = smoothstep(0.8, 1.0, w);
    col = mix(vBase, vColor, smoothstep(0.0, 0.6, u)) * (0.45 + 0.35 * u + 0.6 * mid + 0.3 * side + 0.35 * edge);
  } else if (vKind > 1.5) {
    // 花芯: 板の中の円盤（外は描かない）
    float r = length(vUW);
    float disc = 1.0 - smoothstep(0.93, 1.0, r);
    if (vDisc < 0.5) {
      // 縁にしべの点
      float dots = pow(abs(cos(atan(vUW.y, vUW.x) * 9.0)), 6.0) * smoothstep(0.55, 0.9, r);
      col = vColor * (0.7 + 0.8 * dots) * disc;
    } else {
      // 種がらせんに並ぶ（n 粒目は半径 √(n/N)・角度 n × 黄金角）。近くの番号だけ調べて、いちばん近い種との距離を見る
      float ns = vDisc;
      float n0 = floor(r * r * ns);
      float best = 1e3;
      for (int i = 0; i < 72; i++) {
        float n = n0 + float(i) - 36.0;
        if (n < 0.5 || n > ns) continue;
        float a = n * GOLDEN;
        best = min(best, distance(vUW, sqrt(n / ns) * vec2(cos(a), sin(a))));
      }
      float seed = 1.0 - smoothstep(0.25, 0.55, best / sqrt(3.14159 / ns));
      // 中心は暗く、外ほど明るい。縁に小さな花の輪
      float rim = smoothstep(0.78, 0.92, r);
      col = vColor * ((0.35 + 0.5 * r) * (0.6 + 1.6 * seed) + 1.6 * rim) * disc;
    }
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
  private readonly aMisc = this.attr('aMisc', 4);
  private readonly aColor = this.attr('aColor', 3);
  private readonly aCore = this.attr('aCore', 3);
  private readonly aTurn = this.attr('aTurn', 4);
  private readonly all = [this.aPos, this.aPetal, this.aForm, this.aOrient, this.aMisc, this.aColor, this.aCore, this.aTurn];
  /** 花の先頭の枠ごとの、その花のインスタンス数（setPos 用） */
  private readonly count = new Uint16Array(MAX_PETALS);
  /** 次に書く枠と、使ったことのある枠の数 */
  private head = 0;
  private used = 0;
  /** リングを何周したか。枠ごとに、書いたときの周を覚える（上書きされた花の古い番号で動かさないように） */
  private lap = 0;
  private readonly laps = new Uint32Array(MAX_PETALS);
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
   * base は図形の色（音程の色）。kind が mixed 以外なら、その種類の形と色で咲く（彼岸花は茎の先に数輪）。
   * 返り値は花の番号（setPos で動かす用）
   */
  bloom(group: number, step: number, k: number, x: number, y: number, o: BloomOpts, base: Color, mono: boolean, kind: FlowerKind = 'mixed'): number {
    const spc = SPECIES[kind];
    let pal = this.palettes.get(group);
    if (!pal) {
      pal = makePalette(group);
      this.palettes.set(group, pal);
    }
    const key = flowerKey(step, k);
    const r = (j: number) => hash01(group, key, j);
    // 形は1輪ごとに選ぶ（同じ図形の中でも違う花が咲く）
    // 花畑は場所で組を選ぶ（ノイズは真ん中に寄るので広げてから。境目は少し混ざる）
    let variant: Variant | undefined;
    if (spc.variants) {
      const n = 0.65 * valueNoise(x / DRIFT_PX, y / DRIFT_PX, 11) + 0.35 * valueNoise(x / DRIFT_FINE_PX, y / DRIFT_FINE_PX, 12);
      const t = Math.min(0.999, Math.max(0, (n - 0.5) * 2.2 + 0.5 + (r(22) - 0.5) * 0.2));
      variant = pickVariant(spc.variants, t);
    }
    const sp = (variant ? variant.form : pick(spc.forms, r(20)))((j) => hash01(group, key, 40 + j));
    const petalTone = variant?.petal ?? spc.petal;
    const coreTone = variant?.core ?? spc.core;
    const st = spc.stamens;
    const florets = spc.umbel ? spc.umbel[0] + Math.floor(r(21) * (spc.umbel[1] - spc.umbel[0] + 1)) : 1;
    const per = sp.petals * (sp.layer2 > 0 ? 2 : 1) + (st?.count ?? 0) + 1;
    const stemLine = spc.stemColor ? 1 : 0;
    const start = this.take(per * florets + stemLine);

    // 色: 種類に色があればそれを、なければ図形の色から種ごとに色相をずらす。花ごとに少し揺らす。
    // white モードでは図形の色からの花は淡く、そのぶん明るく（種類の色はそのまま）
    const c = this.c;
    const jit = (r(4) - 0.5) * spc.hueJitter;
    if (petalTone) {
      c.setHSL(petalTone.h + jit, petalTone.s, petalTone.l);
      evenLuma(c, petalTone.luma);
    } else {
      base.getHSL(this.hsl);
      c.setHSL(this.hsl.h + pal.hue + jit, mono ? MONO_SAT : pal.sat, pal.light);
      evenLuma(c, mono ? MONO_PETAL_LUMA : PETAL_LUMA);
    }
    const pr = c.r, pg = c.g, pb = c.b;
    if (coreTone) {
      c.setHSL(coreTone.h + jit * 0.5, coreTone.s, coreTone.l);
      evenLuma(c, coreTone.luma);
    } else {
      base.getHSL(this.hsl);
      c.setHSL(this.hsl.h + pal.hue + jit + pal.coreHue, mono ? MONO_CORE_SAT : 0.85, 0.6);
      evenLuma(c, mono ? MONO_CORE_LUMA : CORE_LUMA);
    }

    const size = sp.size * o.radius * (0.85 + 0.3 * r(0));
    const face = Math.atan2(-o.faceY, o.faceX); // 画面（y 上向き）での方向
    const tilt0 = spc.tilt ? lerp(spc.tilt[0], spc.tilt[1], r(2)) : o.tilt;
    let i = start;
    // 1輪ぶん（彼岸花なら房の中の1輪）の中で共通の値
    let radius = size, dir = face, tilt = tilt0, spin = 0, seed = 0, stemLen = o.stem, stemDir = face;
    const put = (phi: number, kind: number, len: number, hw: number, pitch: number, cup: number, curl: number, tip: number, delay: number, gain: number) => {
      const jit = hash01(group, key, 200 + i - start) - 0.5;
      this.aPos.setXYZW(i, x, y, radius, step / HZ);
      this.aPetal.setXYZW(i, phi + jit * 0.15, kind, len * (1 + 0.12 * jit), hw);
      this.aForm.setXYZW(i, pitch, cup, curl, tip);
      this.aOrient.setXYZW(i, dir, tilt, spin, seed);
      this.aMisc.setXYZW(i, gain, delay, spc.wave, spc.scatter);
      this.aTurn.setXYZW(i, 0, stemLen, stemDir, kind === 2 ? 0 : root);
      this.aColor.setXYZ(i, pr, pg, pb);
      this.aCore.setXYZ(i, c.r, c.g, c.b);
      i++;
    };
    // 切れ込みと尖りは1つにまとめて送る（切れ込み ≥ 0、尖りは負の値）
    const tip = sp.pointy > 0 ? -sp.pointy : sp.notch;
    // 種の円盤がある花は、花びらを円盤の縁から出す（花の大きさは変えない）
    const root = spc.disc > 0 ? sp.core * 0.85 : 0;
    const da = (Math.PI * 2) / sp.petals;
    // 房: 茎の先から、花の向きを中心に扇形に広がって付く（それぞれ外を向いて横から見える）
    // 上へ伸びる花（彼岸花）: 茎は蔦の外側から空の方へ寄せる（下向きの辺からでも上へ伸びる）
    const up = spc.upright ? 1.5 : 0;
    const head = Math.atan2(Math.sin(face) + up, Math.cos(face));
    const mx = Math.cos(head) * o.stem, my = Math.sin(head) * o.stem;
    for (let f = 0; f < florets; f++) {
      const rf = (j: number) => hash01(group, key, 60 + f * 8 + j);
      spin = rf(0) * Math.PI * 2;
      seed = rf(1);
      if (florets > 1) {
        radius = size * (spc.upright ? 0.85 : 0.6) * (0.85 + 0.3 * rf(2));
        if (spc.upright) {
          // 1つの丸い頭に集まり、縦の軸のまわりに輪になって横を向く（少し上向き）。横から見るので、手前・奥を向くものもある
          const th = (f / florets) * Math.PI * 2 + (rf(3) - 0.5) * 0.6;
          const ax = Math.cos(th), ay = 0.05 + 0.2 * rf(4), az = Math.sin(th);
          tilt = Math.acos(az / Math.hypot(ax, ay, az));
          dir = Math.atan2(ay, ax);
        } else {
          dir = face + (f / (florets - 1) - 0.5) * 2.6 + (rf(3) - 0.5) * 0.3;
          tilt = 0.7 + 0.7 * rf(4);
        }
        const reach = size * (0.08 + 0.1 * rf(5));
        const vx = mx + Math.cos(dir) * reach, vy = my + Math.sin(dir) * reach;
        stemLen = Math.hypot(vx, vy);
        stemDir = Math.atan2(vy, vx);
      }
      const delay = florets > 1 ? 0.12 * f * rf(6) : 0;
      for (let j = 0; j < sp.petals; j++) put(j * da, 0, 1 - root, sp.width, sp.openAngle, sp.cup, sp.curl, tip, delay, o.gain);
      if (sp.layer2 > 0) {
        for (let j = 0; j < sp.petals; j++) {
          put((j + 0.5) * da, 1, sp.layer2 * (1 - root), sp.width * 0.85, sp.openAngle * sp.layer2Open, sp.cup, sp.curl, tip, delay + INNER_DELAY, o.gain * 0.9);
        }
      }
      // しべ: 花びらの間から前へ伸び、上へ弧を描く（最後の1本はめしべで、まっすぐ長め）
      if (st) {
        for (let j = 0; j < st.count; j++) {
          const pistil = j === st.count - 1;
          const phi = pistil ? rf(7) * Math.PI * 2 : (j + 0.5) * ((Math.PI * 2) / (st.count - 1));
          put(phi, 4, st.len * (pistil ? 1.1 : 0.9 + 0.2 * rf(j % 8)), st.width, pistil ? st.pitch * 0.5 : st.pitch, 0, st.curl, 0, delay + 0.15, o.gain * 0.9);
        }
      }
      put(0, 2, sp.core, spc.disc, 0, 0, 0, 0, delay + 0.1, o.gain * 0.8);
    }
    if (stemLine) {
      // 茎: 蔦から花（房の中心）まで
      stemLen = o.stem;
      stemDir = head;
      put(0, 5, 0.24 * (seed - 0.5), spc.stemWidth ?? 1, 0, 0, 0, 0, 0, o.gain * (spc.stemGain ?? 1));
      c.copy(spc.stemColor!);
      evenLuma(c, LEAF_LUMA * 1.4);
      this.aColor.setXYZ(i - 1, c.r, c.g, c.b);
    }
    return this.handle(start);
  }

  /**
   * 蔦に葉を1枚付ける（step は出始める時刻）。o.dir は葉の伸びる向き（ワールド）、o.len は長さ（px）。
   * color は葉の色。返り値は setPos 用の番号
   */
  leaf(group: number, step: number, k: number, x: number, y: number, o: LeafOpts, color: Color): number {
    const i = this.take(1);
    const r = (j: number) => hash01(group, flowerKey(step, k), 500 + j);
    const dir = Math.atan2(-o.dirY, o.dirX); // 画面（y 上向き）での向き
    // 花の枠組みを流用: 軸を葉の向きへ倒し、葉は軸に垂直（平ら）に伸ばす
    this.aPos.setXYZW(i, x, y, o.len, step / HZ);
    this.aPetal.setXYZW(i, dir, 3, 1, 0.32 + 0.1 * r(0));
    this.aForm.setXYZW(i, Math.PI / 2, 0.25 + 0.25 * r(1), 0.25 + 0.35 * r(2), 0);
    this.aOrient.setXYZW(i, dir, o.roll, 0, r(3));
    this.aMisc.setXYZW(i, o.gain, 0, 0, 1);
    this.aTurn.setXYZW(i, 0, 0, 0, 0);
    const c = this.c.copy(color);
    evenLuma(c, LEAF_LUMA);
    this.aColor.setXYZ(i, c.r, c.g, c.b);
    c.multiplyScalar(0.45);
    this.aCore.setXYZ(i, c.r, c.g, c.b);
    return this.handle(i);
  }

  /** n 枠を取る（足りなければ先頭に戻って古い花に上書きする）。返り値は先頭の枠 */
  private take(n: number): number {
    if (this.head + n > MAX_PETALS) {
      this.head = 0;
      this.lap++;
    }
    const start = this.head;
    this.head += n;
    this.used = Math.max(this.used, this.head);
    this.count[start] = n;
    this.laps.fill(this.lap, start, start + n);
    this.markDirty(start, n);
    return start;
  }

  /** 外に渡す番号: 枠と周をまとめたもの */
  private handle(start: number): number {
    return this.lap * MAX_PETALS + start;
  }

  /**
   * 咲いている花を動かす（回っている図形に付いた花用）。turn は咲いてから図形が回った角度（ワールドの向き: y 下）。
   * まとめて次の draw で送る
   */
  setPos(handle: number, x: number, y: number, turn: number): void {
    const flower = handle % MAX_PETALS;
    // もう別の花に上書きされていれば何もしない（書くのは先頭から順になので、先頭の枠を見れば分かる）
    if (this.laps[flower] !== Math.floor(handle / MAX_PETALS)) return;
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

  /** 全部消す（花を出さない設定にしたとき。戻したときに古い花が残っていないように） */
  clear(): void {
    this.mesh.visible = false;
    if (!this.used) return;
    this.head = 0;
    this.used = 0;
    this.lap++;
  }

  draw(rs: number): void {
    this.mesh.visible = true;
    this.material.uniforms.uTime!.value = rs / HZ;
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
