# 物理エンジン＆アーキテクチャ設計（ステップ1 / MVP）

前提: `docs/concept.md` の決定事項（方式A: 決定論的物理、自前物理、音程＝長さ、音量＝衝突速度、Three.js + Tone.js + lil-gui）に従う。

## 1. 座標系

- **ワールド座標 = CSS ピクセル、原点は画面左上、y 下向き**。入力（`clientX/Y`）をそのまま使え、変換が不要。
- 重力は **+y**。Three.js は `OrthographicCamera(left=0, right=W, top=0, bottom=H, near=-1, far=1)` とすれば y 下向きのまま一致する（メッシュ座標 = 物理座標）。
- `renderer.setPixelRatio(devicePixelRatio)` で解像度だけ上げ、座標は CSS px のまま。リサイズ時はカメラの right/bottom と物理の境界（W,H）だけ更新し、既存の線は動かさない。
- 角度・角速度は y 下向き座標でそのまま計算する（正の ω = 画面上で時計回り）。

## 2. 固定タイムステップ

- `STEP_HZ = 120`、`DT = 1/120`。物理は **ステップ番号 `step: number`（整数）** を唯一の時計とする。
- accumulator パターン（rAF ごと）:
  ```
  acc += min(frameDelta, 0.1)          // タブ復帰時の暴走防止
  n = 0
  while (acc >= DT && n < MAX_STEPS_PER_FRAME /*8*/) { sim.step(); acc -= DT; n++ }
  if (n == MAX_STEPS_PER_FRAME) acc = 0 // 追いつけない分は捨てる（スローモーション化）
  render(alpha = acc / DT)             // 補間は任意。MVP は補間なしで可
  ```
- 物理コードは `frameDelta`・`performance.now()`・`Date` を一切参照しない。

## 3. 決定論性のルール

1. `Math.random` 禁止（lint で `no-restricted-properties`）。乱数が要る場合は `sim` が持つシード付き PRNG（mulberry32）のみ。MVP では使わない。
2. 時刻依存の値はすべて **step から毎回算出**（累積加算しない）。放出時刻・回転角とも `f(step)` で求める → 浮動小数点誤差がドリフトしない。
3. 反復順序を固定: 線分は `id` 昇順の配列、ボールは生成順の配列。`Map/Set` の反復に物理結果を依存させない。
4. 入力（線の追加・削除・回転切替）は **コマンドキューに積み、次の `step()` の先頭で適用**。ステップ途中で世界が変わらない。
5. 物理モジュール（`src/sim/`）は three / tone / DOM を import しない純 TS。Node 上で回せるので、「同じ配置で N ステップ回した状態ハッシュが一致する」テストを vitest で書く。
6. 同一ブラウザ・同一マシンで同一結果を保証範囲とする（`Math.sin/cos` のブラウザ間差は許容）。

## 4. ボール vs 線分の衝突（連続衝突判定）

パラメータ初期値（lil-gui で調整）: 半径 `r=6`、重力 `g=1400 px/s²`、反発係数 `e=0.72`、接線保持率 `f=0.98`。
落下 1000px で約 1670 px/s → 1ステップ約 14px 移動し半径を超えるため、**CCD 必須**。

**方式: 掃引円 vs 線分 = 点の光線 vs カプセル（線分を r だけ膨らませた形）の最初の交差時刻（TOI）**

```
step 内のボール更新:
  v += g*DT                               // 半陰的オイラー（先に速度）
  remaining = 1.0                         // このステップの残り割合
  for iter in 0..3:                       // 1ステップ最大4回の反射
    d = v * DT * remaining
    hit = 全線分について TOI を求め最小の t∈[0,1] を選ぶ（同値は id 小を優先）
    if !hit: p += d; break
    p += d * hit.t;  p += hit.n * 0.01    // 法線方向に微小押し出し（再衝突防止）
    反射（§5）; 衝突イベント判定（§7）
    remaining *= (1 - hit.t)
  重なり救済: 全線分で dist(p, seg) < r なら法線方向に押し出すだけ（音は鳴らさない）
             ※ ボールの上に線を引いた時・回転線分の掃引で入り込んだ時の保険
```

TOI の求め方（線分 A→B、単位法線 n、光線 p + t·d）:
- 側面: n と −n の2本のオフセット直線（距離 r）と光線の交点で、射影パラメータが [0, |AB|] に収まるもの。`d·n_side < 0`（接近中）のみ採用。
- 端点: A, B を中心とする半径 r の円と光線の交点（2次方程式の小さい方の解）。端点での法線は `normalize(hitPos − 端点)`。
- 側面と端点のうち最小 t を採用。すでに離れる方向（`d·n >= 0`）の交差は無視。

## 5. 反射と回転する線分

- 接触点での線分表面速度 `vs`（静止線分なら 0）を使い、**相対速度で反射**:
  ```
  vr = v − vs;  vn = dot(vr, n)           // vn < 0 で接近
  vr' = vr − (1+e)·vn·n  を法線成分、接線成分は ×f
  v = vr' + vs
  impactSpeed = −vn                        // 音量・発光に使う
  ```
- **回転**: 線分は中点 c・半長 h・角度 θ で保持。`θ(step) = θ0 + ω·(step − rotStartStep)/STEP_HZ`（毎ステップ算出）。端点 = `c ± h·(cosθ, sinθ)`。
- 接触点 q での表面速度: `vs = ω × (q − c) = (−ω·(q.y−c.y), ω·(q.x−c.x))`。
- ステップ内では線分を **そのステップ終了時の姿勢で静止**とみなして CCD する（近似だが決定論的）。線分の掃引によるすり抜けを防ぐため、`|ω|·h·DT < r` となるよう ω を制限（例 r=6, h=200 → |ω| < 3.6 rad/s。UI 上限は 2 rad/s）。取りこぼしは §4 の重なり救済で押し出す。
- オン/オフ切替: オフ時は現在角を θ0 に焼き込み ω=0 にする。オン時は `rotStartStep = 現在step`、θ0 = 現在角。切替はコマンドキュー経由（§3-4）なので決定論的。
- 回転中の線分は長さ不変 → 音程は変わらない（音程＝長さ）。

## 6. 放出口（BPM 同期）

- 1拍のステップ数 `stepsPerBeat = STEP_HZ*60/BPM`（120BPM → 60）。
- 各放出口は `division`（拍単位の間隔、例 1, 0.5, 0.75）と `offsetBeats` を持つ。
- k 回目の放出ステップは **累積せず** `emitStep(k) = round((offsetBeats + k·division) · stepsPerBeat)` で算出し、`step == emitStep(nextK)` で放出して `nextK++`。非整数でもドリフトしない（揺れは最大 ±1/240 s）。
- 推奨 BPM は 7200 の約数（60, 72, 80, 90, 96, 100, 120, 144, 150）で、拍が整数ステップになり完全周期になる。
- 複数放出口: 例 A=division 1、B=division 0.75 → 4:3 のポリリズム。全体周期は `lcm` 拍（この例で 3拍）。
- 放出位置・初速は固定値（x ジッタなし）。同配置なら軌道が完全に周期化する。
- BPM 変更時: `anchorStep = 現在step` から k を 0 に振り直す（位相は次の拍頭に合わせる）。

## 7. 連打（転がり・ビビり）対策

物理側で「鳴らすべき衝突」だけをイベント化する:
1. **静止接触化**: `impactSpeed < REST_VN (40 px/s)` なら法線速度を 0 にしてイベントを出さない（跳ねずに滑る／転がる）。
2. **最低衝突速度**: `impactSpeed < MIN_AUDIBLE_VN (80 px/s)` はイベントなし。
3. **ボール×線分クールダウン**: ボールごとに `lastHitStep[segmentId]`（小さな配列/オブジェクト）を持ち、同じ線分への再発火は `COOLDOWN_STEPS = 8`（≈67ms）以上空ける。反射処理自体は常に行う。
4. 線分単位の同時発音制限・ボイス上限は audio 側の責務（ここでは `impactSpeed` を渡すのみ）。

## 8. ボールの寿命

削除条件（いずれか、step 末尾で判定）:
- 画面外: `y > H + 50`、`x < −50`、`x > W + 50`（上方向は削除しない）。
- 年齢: `step − bornStep > MAX_AGE_STEPS (120*20 = 2400)`。
- 停滞: 速度 < 5 px/s が 120 ステップ連続（線の谷にはまった場合）。
- 上限: `MAX_BALLS = 200`。超過時は最古を削除。
削除は `despawn` イベントで render に通知（フェードアウトは render 側）。

## 9. モジュール構成と型

```
src/
  main.ts            // 起動、rAF ループ（accumulator）、イベント配線
  config.ts          // 定数と lil-gui で調整するパラメータ（Params 型）
  sim/               // ★純 TS。three/tone/DOM 禁止
    types.ts         // 下記の型
    vec.ts           // 2D ベクトル演算（オブジェクト生成を避ける関数群）
    collide.ts       // TOI（光線 vs カプセル）、最近点、押し出し
    physics.ts       // ボール積分・反射・寿命
    shapes.ts        // 線分ストア（追加/削除/回転、姿勢 f(step)）
    emitter.ts       // 放出スケジュール
    sim.ts           // step(): コマンド適用 → 形状姿勢更新 → 放出 → 物理 → 寿命
  audio/             // Tone.js。CollisionEvent → 音程/音量/発音（audio 担当）
  render/            // Three.js、Bloom/Afterimage（visual 担当）
  input/             // pointer → Command 生成（ドラッグで線、右クリックで削除）
test/determinism.test.ts
```

```ts
type SegmentId = number; type BallId = number;
interface Segment { id: SegmentId; cx: number; cy: number; halfLen: number;
  theta0: number; omega: number; rotating: boolean; rotStartStep: number;
  ax: number; ay: number; bx: number; by: number;   // 現ステップの姿勢（キャッシュ）
  length: number }                                  // = 2*halfLen、音程の元
interface Ball { id: BallId; x: number; y: number; vx: number; vy: number; r: number;
  emitterId: number; bornStep: number; slowSteps: number; lastHitStep: Record<SegmentId, number> }
interface Emitter { id: number; x: number; y: number; vx0: number; vy0: number;
  division: number; offsetBeats: number; anchorStep: number; nextK: number }
type Command =
  | { kind: 'addSegment'; ax: number; ay: number; bx: number; by: number }
  | { kind: 'removeSegment'; id: SegmentId }
  | { kind: 'setRotation'; id: SegmentId | 'all'; on: boolean; omega?: number }
  | { kind: 'setBpm'; bpm: number }
type SimEvent =
  | { type: 'collision'; step: number; ballId: BallId; segmentId: SegmentId;
      x: number; y: number; nx: number; ny: number;   // 接触点と法線
      vx: number; vy: number;                          // 反射後速度
      impactSpeed: number; segmentLength: number; emitterId: number }
  | { type: 'spawn'; step: number; ballId: BallId; emitterId: number; x: number; y: number }
  | { type: 'despawn'; step: number; ballId: BallId; reason: 'offscreen'|'age'|'stall'|'cap' }
  | { type: 'segmentAdded'; step: number; segment: Readonly<Segment> }
  | { type: 'segmentRemoved'; step: number; segmentId: SegmentId }
```

- **イベント配線**: `sim.step()` はイベントを内部配列に push するだけ。`main` が1フレーム分のステップを回した後に `sim.drainEvents()` し、`audio.handle(events)` と `render.handle(events)` に同じ配列を渡す（同期・単方向。pub/sub ライブラリ不要）。
- **音のタイミング**: 1フレームで複数ステップ進むため、audio は `step` から時刻を復元する: `audioTime = anchorAudio + (step − anchorStep)/STEP_HZ + LOOKAHEAD(0.05s)`。ズレが 50ms を超えたらアンカーを再設定。render はイベントを即時反映（`LOOKAHEAD` 分の遅れは許容、必要なら render 側で同量遅延）。
- 描画用の状態は `sim.balls` / `sim.segments` を render が読み取り専用で参照する。
- 入力: ドラッグ長 < 12px は無視。右クリック（`contextmenu` を preventDefault）で、カーソルから距離 < 10px の最近傍線分を削除。いずれも Command として `sim.enqueue()`。

## 10. プロジェクト構成（Vite + TypeScript）

- 作成: `npm create vite@latest otosu -- --template vanilla-ts` 相当。
- dependencies: `three`, `tone`, `lil-gui`
- devDependencies: `typescript`, `vite`, `@types/three`, `vitest`, `eslint` + `typescript-eslint`（`Math.random` 禁止ルール用）
- tsconfig: `strict: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`。
- scripts: `dev`, `build`, `preview`, `test`（vitest）。
- `index.html` は `<canvas>` 1枚、黒背景、`body{margin:0;overflow:hidden}`。Tone.js はユーザー操作後に `Tone.start()`（最初のクリックで開始するオーバーレイ）。フルスクリーンは `F` キーで `requestFullscreen()`。

## 11. 実装順序

1. `sim/` + determinism テスト（描画なしで軌道が一致すること）
2. render の最小表示（線と点）→ input → audio 接続
3. lil-gui でパラメータ調整 → 合格基準（線5本・5分放置）で連打対策値を詰める
