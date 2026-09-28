// sim/ 以下は純 TS（three / tone / DOM を import しない）。決定論性のため Math.random は使わない。

/** 論理ワールドのサイズ（px, y 下向き） */
export const WORLD_W = 1920;
export const WORLD_H = 1080;

/** 範囲（y の下限は常に 0 = 放出口の高さ。上は放出口より上なので置く意味がない） */
export type Bounds = { minX: number; maxX: number; maxY: number };
/** 16:9 のワールドそのもの。ボールを消す範囲の既定値 */
export const WORLD_BOUNDS: Bounds = { minX: 0, maxX: WORLD_W, maxY: WORLD_H };
/**
 * 図形を置ける範囲の上限（D23）。ウィンドウが 16:9 でないとき、表示されているワールドの外にも置ける。
 * 左右は各 1 画面分、下は縦長の画面（9:19.5 程度）まで
 */
export const PLACE_BOUNDS: Bounds = { minX: -WORLD_W, maxX: 2 * WORLD_W, maxY: 4 * WORLD_H };

/** 物理の固定タイムステップ */
export const HZ = 120;
/** テンポの範囲（ツールバーでも、読み込む配置でも） */
export const BPM_MIN = 40;
export const BPM_MAX = 200;
export const DT = 1 / HZ;

/** beats 拍のステップ数（小数のまま。放出・くり返しの格子と区間の長さの共通の式。D10） */
export function beatSteps(beats: number, bpm: number, hz: number = HZ): number {
  return (beats * hz * 60) / bpm;
}

export const G = 1400; // 重力 px/s²
export const BALL_RADIUS = 5;
export const LINE_WIDTH = 3;
/** 当たり判定半径 = ボール半径 + 線の太さの半分 */
export const HIT_RADIUS = BALL_RADIUS + LINE_WIDTH / 2;
export const MIN_LINE_LEN = Math.round(WORLD_W * 0.03); // 58px

export const RESTITUTION = 0.72;
export const TANGENT_KEEP = 0.98;
/** これ未満の法線速度は跳ねずに滑る */
export const REST_VN = 40;
/** これ未満の法線速度はイベントを出さない（鳴らない・光らない） */
export const V_MIN = 80;
export const V_REF = Math.sqrt(2 * G * WORLD_H);

/** 同じボールが同じ線に再発火するまでのステップ数 */
export const BALL_LINE_COOLDOWN = 8;
/** 同じ線が再発火するまでのステップ数（約 60ms） */
export const LINE_COOLDOWN = 7;

export const MAX_BALLS = 200;
/** 全図形の辺の合計の上限（超える図形は追加しない） */
export const MAX_SEGS = 400;
/** 1つの図形の辺の上限（ペンは 48、円は 24） */
export const MAX_SHAPE_EDGES = 64;

/** バンパー（D13）: 反発係数と、反射後の速さの上限 */
export const BUMPER_RESTITUTION = 1.2;
export const BUMPER_MAX_SPEED = Math.round(Math.sqrt(2 * G * WORLD_H));

/** chain: 直前の衝突からこのステップ数以内に別の図形に当たると連鎖 */
export const CHAIN_WINDOW = 120;
/** energy: 直近 2 小節の衝突数をこの数で割って 0..1 */
export const ENERGY_HITS = 24;
export const MAX_AGE_STEPS = HZ * 20;
export const STALL_SPEED = 5;
export const STALL_STEPS = HZ;

/** エフェクト（D32）。echo: 拍の頭で ECHO_COUNT 回、velocity は ECHO_DECAY の累乗 */
export const ECHO_COUNT = 3;
export const ECHO_BEATS = 1;
export const ECHO_DECAY = 0.55;
/** rise: 半拍ごとに RISE_COUNT 回、1回ごとにスロットを1つ（circle は1帯 = 5）上げる。一番上で止まる */
export const RISE_COUNT = 4;
export const RISE_BEATS = 0.5;
export const RISE_DECAY = 0.8;
/** chord: 重ねる音の velocity の倍率 */
export const CHORD_GAIN = 0.7;

/** 描画用の位置履歴（ステップ数） */
export const HISTORY = 96;

/** ハーモニーの1区間の長さ（小節、4/4） */
export const SECTION_BARS = 8;

/** 放出口の揺らぎ（P1）。位置は放出番号 k の関数 */
export const DRIFT_PERIOD = 64; // drift: 三角波の周期（放出回数）
export const PHRASE_LEN = 16; // phrase: 同じ位置に留まる放出回数
export const DRIFT_AMP_MAX = 80;
export const DRIFT_AMP_DEFAULT = 24;

/** 衝突速度 → 0..1（音量と発光強度の共通値） */
export function impactVelocity(vn: number): number {
  const x = Math.min(1, Math.max(0, (vn - V_MIN) / (V_REF - V_MIN)));
  return 0.12 + 0.88 * Math.pow(x, 0.6);
}

/** 回転速度の上限。長い線ほど遅く回す（1ステップの掃引が当たり判定半径を超えないように） */
export function maxOmega(halfLen: number): number {
  return (0.9 * HIT_RADIUS * HZ) / Math.max(halfLen, 1);
}

