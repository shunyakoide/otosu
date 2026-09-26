# otosu 音響設計（ステップ1 / MVP）

前提は `docs/concept.md`。決定論的物理・量子化なし・長さ→音程・速度→音量・ペンタトニック固定をそのまま守る。
対象は Tone.js v15 系（`"tone": "^15.1"`）。v15 で非推奨になった `Tone.Transport` などのグローバル参照は使わない。

## 1. 基本方針

- **時間の主導権は物理が持つ。** MVP では Tone の Transport を使わない。BPM は「放出間隔を物理ステップ数に換算するための値」として扱う（§4）。
- **発音は衝突を検出したその場で即時に行う。** Transport のスケジューリングも先読み（lookAhead）も使わない（§5）。
- 音色は「ガラス／マレット系の減衰音＋深めのリバーブ」にする。持続音は使わない。ペンタトニックなので、音が重なっても濁らない。

## 2. Tone.js 構成

### 2.1 Context（他のノードより先に作る）
- `Tone.setContext(new Tone.Context({ latencyHint: "interactive", lookAhead: 0 }))`
- 必ず**シンセやエフェクトを1つも生成する前に**実行する。後から実行すると、既存ノードが古い Context に取り残される。

### 2.2 シンセ：PolySynth を1台だけ使う（音ごとには生成しない）
- `new Tone.PolySynth(Tone.FMSynth, { maxPolyphony: 24, volume: -14 })`
  - 音ごとに生成すると GC と接続コストでノイズやドロップの原因になるため採用しない。上限を超えたときは PolySynth が自動で音を捨てるので、これを安全弁として利用する（§6）。
- FMSynth のパラメータ（`synth.set({...})`）：

| パラメータ | 値 | 狙い |
|---|---|---|
| harmonicity | 3 | ベル寄りの倍音 |
| modulationIndex | 3.5 | 立ち上がりの輝き。上げると金属的になる |
| oscillator.type | "sine" | |
| modulation.type | "sine" | |
| envelope | attack 0.004 / decay 1.4 / sustain 0 / release 0.4 | 打撃後に自然に減衰する音 |
| modulationEnvelope | attack 0.002 / decay 0.25 / sustain 0 / release 0.2 | 最初だけ明るく、すぐ丸くなる |

- 発音は `synth.triggerAttackRelease(freq, 1.2, Tone.immediate(), velocity)` で行う。
  - 音価は decay に近い 1.2s にする。sustain が 0 なので、実際の長さは envelope が決める。音価を短くしすぎると release に早く入り、尾が切れる。

### 2.3 エフェクトチェーン（すべて直列）
```
PolySynth → Filter(highpass) → FeedbackDelay → Reverb → Compressor → Limiter → Destination
```
| ノード | 設定 |
|---|---|
| `Tone.Filter` | type "highpass", frequency 120, rolloff -12（投影会場の PA で低域がこもるのを防ぐ） |
| `Tone.FeedbackDelay` | delayTime = 60/BPM × 0.75 秒（付点8分。BPM 90 なら 0.5s）, feedback 0.28, wet 0.18 |
| `Tone.Reverb` | decay 6, preDelay 0.03, wet 0.35。IR は非同期に生成されるので、開始時に `await reverb.ready` する |
| `Tone.Compressor` | threshold -20, ratio 3, attack 0.01, release 0.25（重なったときの音量を揃える） |
| `Tone.Limiter` | threshold -1（マスターの保護） |
| `Tone.getDestination().volume` | -3 dB |

- BPM を変更したら `delay.delayTime.rampTo(新しい値, 0.1)` で追従させる。
- ステレオ定位（線の x 座標で pan）はステップ2の候補とする。MVP ではモノ音源をリバーブで広げるだけにする。

## 3. 線の長さ → 音程

- 音程は**線を作成したときに1回だけ計算**して線に保持する。リサイズしても再計算しない。同じ線がずっと同じ音で鳴ることを優先する。
- 入力は `r = lengthPx / window.innerWidth`（CSS px 基準。devicePixelRatio は掛けない）。
- スケールは **C メジャーペンタトニック**、音域は **C3〜C6（3オクターブ、16音）**。ルートは定数 `ROOT_MIDI = 48` にして、後から変えられるようにする。
- マッピングは対数で行う。短い線が高音域に偏らないよう、長さの比で均等に割り当てる。
```
R_MIN = 0.03, R_MAX = 0.6, N = 16
rc  = clamp(r, R_MIN, R_MAX)
t   = log(rc / R_MIN) / log(R_MAX / R_MIN)     // 0 = 短い, 1 = 長い
i   = round((1 - t) * (N - 1))                  // 長い → i が小さい → 低い
PENTA = [0, 2, 4, 7, 9]
midi = ROOT_MIDI + 12 * floor(i / 5) + PENTA[i % 5]
freq = Tone.Frequency(midi, "midi").toFrequency()
```
- 例（画面幅 1920px）：60px 未満は C6、約 1150px 以上は C3。
- 線の最小長さは 0.03 × 画面幅とする。これより短いドラッグは線として確定させない（描画担当と共有）。

## 4. BPM と放出口の周期

- **BPM の初期値は 90。** lil-gui で 60〜140 の範囲を調整できるようにする。
- 放出口は2つで、**比 2:3** を推奨する。
  - 放出口 A：2拍ごと（BPM 90 で 1.333s）
  - 放出口 B：3拍ごと（2.0s）。位相は A と同じ
  - 6拍（4s）で一巡する。重なりは少なく、パターンとして聴き取りやすい。
- 代替案として **3:4**（A 3拍 / B 4拍、12拍周期）も lil-gui で選べるようにする。こちらはゆったりしていて、5分間の放置向き。
- 放出時刻は物理ステップの整数倍に丸める。物理を 240Hz で固定するなら、BPM 90 の2拍は 320 ステップ、3拍は 480 ステップになる。`periodSteps = round(beats * 60 / BPM * STEP_HZ)` とする。これで同じ配置なら常に同じ結果になる。

## 5. レイテンシと即時発音

- Context は `latencyHint: "interactive"`、`lookAhead: 0` にする（§2.1）。
- 衝突コールバックの中で、その場で `triggerAttackRelease(..., Tone.immediate(), vel)` を呼ぶ。
  - `Tone.now()` は lookAhead を加算するので使わない。lookAhead が 0 なら値は同じだが、意図を明示するために `immediate()` を使う。
  - Transport やコールバックの予約は使わない。
- 1フレーム内の複数ステップで起きた衝突は、同じフレームでまとめて鳴らす。そのため最大 1 フレーム（約 16ms）の揺れが出るが、発光も同じフレームで出るので、音と光は一致する（量子化しないという方針に合致）。
- 実装後に `Tone.getContext().rawContext.baseLatency` と `outputLatency` をコンソールに出し、実測値を記録する。

## 6. 発音過多への初期安全策（最小限）

1. **最小速度のしきい値。** 法線方向の速度が `V_MIN` 未満の衝突は鳴らさない（§7。転がりや微小な再接触のバズを防ぐ）。
2. **線ごとのクールダウン 60ms。** 同じ線が 60ms 以内に再び鳴った場合は無視する。発光はさせてよい。
3. **PolySynth の maxPolyphony 24。** 超過分は Tone が自動で捨てる。
4. ボールは画面下端から出たら即削除する（物理担当）。

これ以上の制限（同時発音の窓制限・ボールの寿命など）は、5分間放置のテストをしてから判断する。

## 7. 衝突速度 → velocity

```
vn    = |ボール速度 · 線の法線|                 // px/s, 反射前の法線成分
V_REF = sqrt(2 * g * window.innerHeight)       // 画面の高さぶん自由落下したときの速度
V_MIN = 0.04 * V_REF
if vn < V_MIN → 発音しない
x   = clamp((vn - V_MIN) / (V_REF - V_MIN), 0, 1)
vel = 0.12 + 0.88 * x^0.6                      // 弱い当たりも聴こえるよう下駄と曲線を付ける
```
- `g` は物理担当の重力定数（px/s²）と同じ値を使う。
- 発光の強さにも同じ `vel` を使ってもらう。これで音と光の強さが揃う。

## 8. AudioContext の開始（ユーザー操作）

- 起動時は全面オーバーレイに「click to start」を表示し、物理は停止させておく。
- 最初の `pointerdown` で、次の順に実行する。
  1. `await Tone.start()`
  2. `await reverb.ready`
  3. 必要ならフルスクリーンを要求する（同じユーザー操作の中で行う）
  4. オーバーレイを消し、物理と放出を開始する
- `visibilitychange` で復帰したときに `Tone.getContext().state !== "running"` なら、再度クリックを促す表示を出す。

## 9. 物理・描画担当への要求

**衝突イベント**（物理ステップの中から同期的に `onCollision(e)` を呼ぶ。1回の衝突につき1回）

| フィールド | 型 | 用途 |
|---|---|---|
| `lineId` | number | クールダウンの判定、線の音程の参照 |
| `ballId` | number | デバッグ用 |
| `normalSpeed` | number (px/s) | velocity の計算。**反射前**の法線速度の絶対値 |
| `x`, `y` | number (CSS px) | 発光位置、将来の pan |
| `step` | number | 発生した物理ステップの番号（決定論性の検証、将来の時刻補正に使う） |

**線オブジェクト**
- 作成時に `lengthPx` を確定させ、音響側が計算した `midi` と `freq` を持たせる。線の色やサイズを音程に連動させたい場合は `midi` を参照する。
- 最小長さ `0.03 × innerWidth` 未満は確定させない。
- 削除時に音響側で行う処理はない。

**物理の仕様**
- 固定タイムステップは 240Hz を推奨する（速いボールのすり抜けと多重衝突を防ぐため）。
- 放出時刻は §4 のステップ数の式で決める。
- 重力定数 `g` は共有定数として export する。
- 同じ線への連続接触（めり込みによる再衝突）は、物理側でも位置補正で防いでほしい。
