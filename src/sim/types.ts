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

export type Command =
  | { kind: 'addSegment'; ax: number; ay: number; bx: number; by: number }
  | { kind: 'removeSegment'; id: number }
  | { kind: 'clearSegments' }
  | { kind: 'setRotation'; on: boolean; speed: number }
  | { kind: 'setTempo'; bpm: number; pattern: readonly number[] };

export type HitEvent = {
  kind: 'hit';
  step: number;
  ballId: number;
  lineId: number;
  x: number;
  y: number;
  normalSpeed: number;
  velocity: number;
  note: number;
};

export type SimEvent =
  | HitEvent
  | { kind: 'emit'; step: number; emitterId: number; ballId: number }
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
