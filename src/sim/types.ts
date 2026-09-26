export type Segment = {
  id: number;
  cx: number;
  cy: number;
  halfLen: number;
  /** 回転の基準角と、その基準ステップ。角度は毎ステップ step から算出する */
  theta0: number;
  rotStartStep: number;
  omega: number;
  /** 現ステップの姿勢（キャッシュ） */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  length: number;
  /** 音程インデックス（作成時に固定） */
  note: number;
  addedStep: number;
  lastEventStep: number;
  /** 回転の向き（線の属性。id から導かない — B6） */
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
  /** segmentId → 最後に接触したステップ */
  lastHit: Map<number, number>;
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

/** 保存・読み込みできる配置（座標は整数 px） */
export type SceneData = {
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
  | { kind: 'removeSegment'; id: number }
  | { kind: 'clearSegments' }
  | { kind: 'setRotation'; on: boolean; speed: number }
  | { kind: 'setTempo'; bpm: number; pattern: readonly number[] }
  | { kind: 'setDrift'; mode: DriftMode; amp: number }
  | { kind: 'loadScene'; scene: SceneData };

export type HitEvent = {
  kind: 'hit';
  step: number;
  ballId: number;
  lineId: number;
  x: number;
  y: number;
  normalSpeed: number;
  velocity: number;
  /** 線に固定された音程スロット 0..15（色もこれで決まる） */
  note: number;
  /** 実際に鳴らす音高。ハーモニーの区間で動く */
  midi: number;
  /** ハーモニー進行の区間番号 */
  section: number;
};

export type SimEvent =
  | HitEvent
  | { kind: 'emit'; step: number; emitterId: number; ballId: number; x: number; y: number }
  | { kind: 'emitters'; step: number; emitters: { id: number; x: number; y: number }[] }
  | { kind: 'segmentPose'; step: number; segmentId: number; theta0: number; rotStartStep: number; omega: number }
  | { kind: 'segmentAdded'; step: number; segment: Readonly<Segment> }
  | { kind: 'segmentRemoved'; step: number; segmentId: number };

/** あるステップ時点のボール位置（id 昇順） */
export type Snapshot = {
  step: number;
  count: number;
  ids: Int32Array;
  xs: Float32Array;
  ys: Float32Array;
};
