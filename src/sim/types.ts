/** 辺の種類（図形単位で同じ値。D13） */
export type SegKind = 'line' | 'bumper';

/**
 * 図形の形（描いたツール）。音色がこれで決まる（D16）。
 * line = ベル、pen = はじく音、circle = キック（拍にそろえる）、triangle = 金属、square = 木・クリック
 */
export type ShapeForm = 'line' | 'pen' | 'circle' | 'triangle' | 'square';
export const SHAPE_FORMS: readonly ShapeForm[] = ['line', 'pen', 'circle', 'triangle', 'square'];

/**
 * 図形の1辺。図形 = 同じ group を持つ Segment の集まり（D12）。1本の線は辺が1つの図形。
 * 回転は図形の重心 (gx, gy) のまわり。辺の姿勢 = 重心 + R(φ)·(rax..rby)、φ は図形の回転角（描いたとき 0）。
 */
export type Segment = {
  id: number;
  /** 図形 id */
  group: number;
  kind: SegKind;
  /** 辺の中点（現ステップ。1本の線なら重心と同じで動かない） */
  cx: number;
  cy: number;
  halfLen: number;
  /** 図形の重心（固定） */
  gx: number;
  gy: number;
  /** 描いたときの端点の、重心からの相対座標（φ = 0） */
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  /**
   * この辺の向きの基準角と基準ステップ・角速度（図形内で omega と rotStartStep は共通）。
   * segmentAngle(seg, step) はこの辺の向き。図形の回転角 φ = segmentAngle − atan2(rby−ray, rbx−rax)
   */
  theta0: number;
  rotStartStep: number;
  omega: number;
  /** 現ステップの姿勢（キャッシュ） */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  length: number;
  /** 音程スロット（図形の周長で決まる。図形内で共通・作成時に固定） */
  note: number;
  addedStep: number;
  /** 未使用（クールダウンは図形単位で sim 内に持つ）。互換のため残す */
  lastEventStep: number;
  /** 回転の向き（図形の属性。id から導かない — B6） */
  dir: 1 | -1;
};

export type Ball = {
  id: number;
  emitterId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornStep: number;
  slowSteps: number;
  /** group → 最後に接触したステップ */
  lastHit: Map<number, number>;
  /** chain の計算用: 直前にイベントになった衝突のステップと図形、今の chain */
  lastEventStep: number;
  lastEventGroup: number;
  chain: number;
};

export type Emitter = {
  id: number;
  x: number;
  y: number;
  /** 放出間隔（拍） */
  beats: number;
  /** 放出間隔（ステップ、整数で固定） */
  periodSteps: number;
  anchorStep: number;
  nextK: number;
};

export type DriftMode = 'off' | 'drift' | 'phrase';

/** 保存形式 v2 の図形: [種類, 回転の向き, 閉じているか, x0, y0, x1, y1, ...]（整数 px、描いたときの座標） */
export type SceneShape = [kind: SegKind, dir: 1 | -1, closed: boolean, ...points: number[]];

/** 保存・読み込みできる配置 v2（D12）。v1 は decode 時に v2 へ変換する */
export type SceneData = {
  v: 2;
  bpm: number;
  pattern: number[];
  rotate: boolean;
  rotationSpeed: number;
  drift: { mode: DriftMode; amp: number };
  shapes: SceneShape[];
  /** shapes と同じ順の形（D16）。無い・長さが合わない・不正な値の要素は点列から推定する（inferForm） */
  forms?: ShapeForm[];
};

/** 旧形式（ステップ2・3）。読み込みのみ */
export type SceneDataV1 = {
  v: 1;
  bpm: number;
  pattern: number[];
  rotate: boolean;
  rotationSpeed: number;
  drift: { mode: DriftMode; amp: number };
  segs: [ax: number, ay: number, bx: number, by: number, dir: 1 | -1][];
};

export type Command =
  | { kind: 'addSegment'; ax: number; ay: number; bx: number; by: number; dir?: 1 | -1 }
  /** form を省略したら点列から推定する（inferForm） */
  | { kind: 'addShape'; points: [number, number][]; closed: boolean; segKind: SegKind; dir?: 1 | -1; form?: ShapeForm }
  /** 辺 id を含む図形をまるごと消す */
  | { kind: 'removeSegment'; id: number }
  | { kind: 'removeShape'; group: number }
  | { kind: 'clearSegments' }
  | { kind: 'setRotation'; on: boolean; speed: number }
  | { kind: 'setTempo'; bpm: number; pattern: readonly number[] }
  | { kind: 'setDrift'; mode: DriftMode; amp: number }
  | { kind: 'loadScene'; scene: SceneData };

export type HitEvent = {
  kind: 'hit';
  /** 鳴らすステップ（音・光・MIDI・録音はすべてこの時刻）。circle のこだまは拍の頭（D21） */
  step: number;
  /** ボールが実際に当たったステップ（こだま以外は step と同じ） */
  contactStep: number;
  /** 0 = 当たった音そのもの。1.. = circle のこだま（接触後の拍の頭で、だんだん弱く。MIDI・録音には入れない。D21） */
  echo: number;
  ballId: number;
  lineId: number;
  x: number;
  y: number;
  normalSpeed: number;
  velocity: number;
  /** 線に固定された音程スロット 0..15（色もこれで決まる） */
  note: number;
  /** 実際に鳴らす音高。ハーモニーの区間で動く。circle は区間の根音（kickMidi）。こだまは鳴らすステップの区間で決め直す */
  midi: number;
  /** ハーモニー進行の区間番号 */
  section: number;
  /** 図形 id と種類 */
  group: number;
  segKind: SegKind;
  form: ShapeForm;
  /** そのボールが直前の衝突から 120 ステップ以内に別の図形に当たったら +1、そうでなければ 1 */
  chain: number;
  /** 直近 2 小節の衝突数 / 24（0..1） */
  energy: number;
};

export type ShapeAddedEvent = {
  kind: 'shapeAdded';
  step: number;
  group: number;
  segKind: SegKind;
  form: ShapeForm;
  note: number;
  /** 追加したステップの区間での音高（確定音用。circle は kickMidi） */
  midi: number;
  closed: boolean;
  dir: 1 | -1;
  /** 重心と、重心からの相対頂点（φ = 0。閉じた図形は最初の点を繰り返さない） */
  gx: number;
  gy: number;
  points: [number, number][];
  /** 追加時点の各辺（コピー） */
  segments: Segment[];
};

export type SimEvent =
  | HitEvent
  | { kind: 'emit'; step: number; emitterId: number; ballId: number; x: number; y: number }
  | { kind: 'emitters'; step: number; emitters: { id: number; x: number; y: number }[] }
  /** 図形の回転角 φ(step) = theta0 + omega·(step − rotStartStep)/HZ（shapeAngle）。頂点 = 重心 + R(φ)·相対頂点 */
  | { kind: 'shapePose'; step: number; group: number; theta0: number; rotStartStep: number; omega: number }
  | ShapeAddedEvent
  | { kind: 'shapeRemoved'; step: number; group: number }
  /** ハーモニー区間の切り替わり（開始時にも1回） */
  | { kind: 'section'; step: number; section: number };

/** あるステップ時点のボール位置（id 昇順） */
export type Snapshot = {
  step: number;
  count: number;
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
};
