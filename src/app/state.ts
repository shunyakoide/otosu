// いくつかのモジュールが読み書きする、動いている状態。宣言の順番に左右されないように1つにまとめて渡す。

export type EngineState = {
  /** 音を始めたか（最初のクリックで） */
  started: boolean;
  /** 一時停止中か（D30 → D50） */
  paused: boolean;
  /** step 0 を鳴らす音の時刻（AudioContext の秒）。開始時と、遅れすぎたときに取り直す（D8-1） */
  t0: number;
};

export const createState = (): EngineState => ({ started: false, paused: false, t0: 0 });
