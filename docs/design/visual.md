# otosu — 描画設計（ステップ1 / MVP）

> 当時の提案。採否と現行の仕様は [decisions.md](decisions.md) を参照（食い違うときはそちらが優先）。

担当: ビジュアル。前提は `docs/concept.md`（素の Three.js + UnrealBloomPass / AfterimagePass、React/R3F なし）。
方針: **暗い「待機状態」と、衝突の瞬間の HDR フラッシュを明確に分ける**。ブルームは閾値を超えたフラッシュにだけかける。

## 1. 座標系とカメラ

- **論理ワールドは 1920×1080 固定、原点は左上、y は下向き、単位は px**（物理と同じ座標）。ウィンドウサイズで物理が変わらないので決定論性が保てる。1920x1080 のプロジェクターでは 1 単位 = 1 ピクセルになる。
- `OrthographicCamera(left=0, right=1920, top=0, bottom=-1080, near=-10, far=10)`。描画側では **`y_render = -y_physics`** に変換する（変換は `toRender(x, y)` の1か所だけに置く）。top/bottom を反転させて y 下向きにする方法は面の向きが裏返るので使わない。
- 1920x1080 以外のウィンドウ: `s = min(w/1920, h/1080)`。フラスタムを中央基準で `w/s × h/s` に広げ、余白は黒にする。left = `-(w/s - 1920)/2`（他の辺も同様）。
- マウス座標 → ワールド座標は、上のスケールの逆変換 `(clientX - offsetX)/s` を使う（入力は物理座標で扱う）。
- リサイズ時の処理: カメラの各辺を更新 → `updateProjectionMatrix()` → `renderer.setSize(w, h)` → `composer.setSize(w, h)`（ブルームの解像度もここで追従する）。

## 2. レンダラーとポストプロセス

- `new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false })`
  - antialias は EffectComposer を通すと効かないので、MSAA はコンポーザ側の RT で行う。
  - `setClearColor(0x000000, 1)`、`toneMapping = NeutralToneMapping`、`toneMappingExposure = 1.0`
    （ACES は彩度が落ちるので使わない。比較用に lil-gui で NoToneMapping / AgX に切り替えられるようにする）。
  - `setPixelRatio(Math.min(devicePixelRatio, 1))` を既定にする（投影は DPR 1 で十分。Retina でのプレビュー時だけ GUI で 1.5 まで許可）。
- Composer: `new EffectComposer(renderer, new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 }))`
  - HalfFloat にするのは、1.0 を超える HDR 値をフラッシュ表現に使うため。
- パスの順序（import は `three/addons/postprocessing/{EffectComposer,RenderPass,AfterimagePass,UnrealBloomPass,OutputPass}.js`）:
  1. `RenderPass(scene, camera)`
  2. `AfterimagePass(damp)` — 既定 `damp = 0.88`（60fps 基準）。**フレームレートに依存する**ので、毎フレーム `uniforms.damp.value = 0.88 ** (dt * 60)` で補正する。
     シェーダは古い画素のうち 0.1 未満を切り捨てるので、黒へ戻ることは保証される（投影で黒が締まる）。
  3. `UnrealBloomPass(new Vector2(w, h), strength=0.9, radius=0.35, threshold=0.8)` — 残像にもブルームがかかるよう Afterimage の後に置く。
  4. **`OutputPass()` は必須**。トーンマッピングと sRGB 変換をここで行う。これがないと色が暗く、くすんで見える。
- 色の指定はすべて sRGB の hex（`Color.setHex`）で書き、ColorManagement に任せる。マテリアルは全部 `MeshBasicMaterial({ blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false })`。
  黒背景に加算合成なので、**色の値を下げる = フェードアウト**として扱える（不透明度はいじらない）。
- 描画順は `renderOrder` で 波紋 < 線 < ボール < UI プレビュー。

## 3. ボール（数百個）

- **InstancedMesh を1つ**使う。`CircleGeometry(1, 20)` を半径でスケールする。`maxCount = 1024`、`mesh.count = 生存数`、`frustumCulled = false`、
  `instanceMatrix.setUsage(DynamicDrawUsage)`、色は `instanceColor` で渡す（HDR 値 >1 も可）。
- Points は採用しない。gl_PointSize の上限が環境で異なり、DPR の扱いやフラッシュ時のスケールが面倒になるため。
- 半径は **5px**（物理と同じ値を共有）。待機時の色は `#E8ECF2 × 0.55`（閾値未満なのでブルームはかからない）。
- 位置は物理の前ステップと現ステップを **α = accumulator / dt で補間**して描く（固定ステップと表示フレームのずれによるガタつき対策）。
- 画面下端より下（`y > 1080 + r`）に出たボールは物理側で消す。インデックスを詰め替えるときは、色の状態も一緒に移動させる。

## 4. 線分（太さのある線）

- **細長いクアッドの InstancedMesh を1つ**使う（`PlaneGeometry(1, 1)` を 長さ×太さ にスケールし、中点へ移動して `atan2` で回転）。上限は 256 本。
  - Line2 / LineSegments2 を採らない理由: 線ごとの色を毎フレーム変えるには InterleavedBuffer を書き換える必要があり、扱いにくい。InstancedMesh なら `setColorAt` だけで済み、将来の回転（`setMatrixAt`）にもそのまま対応できる。
- 太さは **3px**（投影で視認できる最小限）。端点には丸キャップを兼ねて **半径 3px の点**を、別の InstancedMesh（最大 512 個）で置く。色は線と同期させる。
- 待機時の色は **その線の音程色 × 0.30**（暗いがどの音かはわかる程度。ブルームなし）。

## 5. 衝突時の発光演出（すべて「瞬時に立ち上がり → 指数で減衰」）

`v` = 正規化した衝突速度（0〜1）、`t` = 発音時刻からの経過秒数。線もボールも、再トリガー時は **加算せず `max(現在値, 新規値)`** を取る（連打で白飛びさせない）。

| 対象 | 強度（instanceColor に掛ける係数） | 時定数 | 打ち切り | 補足 |
|---|---|---|---|---|
| 線 | `0.30 + (1.2 + 1.8v) · e^(−t/0.18)` | 180ms | 1.2s | 色は音程色。ピーク時だけ白へ 25% 寄せる（`lerp(pitch, white, 0.25·e^(−t/0.06))`） |
| ボール | `0.55 + (1.0 + 1.5v) · e^(−t/0.09)` | 90ms | 0.6s | 色は当たった線の音程色に染まり、以後その色を 0.55 で保つ（どの線を経由したかが見える）。スケールは `1 + 0.35·e^(−t/0.06)` |
| 波紋 | `1.2v · (1−p)²`、`p = t/0.5` | 0.5s | 0.5s | `v ≥ 0.25` のときだけ出す。半径 `5 + (20 + 40v)·easeOutCubic(p)`、リング幅 1.5px、音程色 |
| 放出口 | `0.4 + 1.0 · e^(−t/0.12)` | 120ms | — | 放出拍ごとに光らせる（BPM の視覚的なガイド） |

- 波紋は `RingGeometry(0.93, 1, 48)` の InstancedMesh（プール 64 個、満杯なら最古を上書き）。
- 減衰は毎フレーム `t` から直接計算する（前フレームの値に掛け算を重ねない。フレームレートに依存しないため）。
- 残像（damp 0.88）と組み合わせると、ボールの軌跡が約 0.3 秒の尾を引く。尾が長すぎれば damp を 0.85 に下げる。

## 6. 配色

- 背景は `#000000` のみ。ビネット・グレイン・グラデーションは一切入れない（投影で黒浮きするため）。
- **音程と色を対応させる（採用）**。ペンタトニックの5つの度数を5色に固定し、オクターブは明度だけで表す（低いほど ×0.8、高いほど ×1.1）。
  色数は「5色 + 白」に限定する。長い線（低音）が寒色側、短い線（高音）が暖色側になるよう並べる。

| 度数 | 色 | hex |
|---|---|---|
| 1（根音） | ディープブルー | `#3D6BFF` |
| 2 | シアン | `#2EC8E6` |
| 3 | ミント | `#3DDC97` |
| 5 | アンバー | `#FFB23F` |
| 6 | コーラル | `#FF5A6E` |
| UI / ボールの待機色 | オフホワイト | `#E8ECF2` |

- 色は mono（全部オフホワイトで、フラッシュだけ明るくなる）だけにした（D37）。以前は `colorMode: 'pitch' | 'mono'` を切り替えられた

## 7. 線を引く操作中のプレビュー

- ドラッグ開始点に端点ドットを置き、カーソルまで仮の線を描く。色は **確定したらなる音程色**（`lengthToNote(len)` を音担当と共有して使う）で、強度は `0.35 + 0.15·sin(2π·2t)`（2Hz の呼吸）。
- 長さが度数の境界をまたいだ瞬間、色が切り替わると同時に線を 80ms だけ 0.8 まで光らせる（音程が変わったことが指に伝わる）。
- 長さが最小長（24px）未満のときはグレー `#555` にし、この状態で離しても線を作らない。
- 確定時は線全体を1回だけ `v = 0.5` 相当でフラッシュさせる（衝突時と同じカーブ）。
- 右クリックで削除: カーソルから 12px 以内の最寄りの線を対象にする。ホバー中は強度を 0.6 にして予告し、削除時は 200ms で強度を 0 にしつつ長さを 0.9 倍まで縮めてから消す。
- カーソル: 描画中は `crosshair`、2秒操作がなければ `cursor: none`（投影時に矢印を映さない）。

## 8. プロジェクター投影

- フルスクリーン: `F` キーで `document.documentElement.requestFullscreen()`、`H` キーで lil-gui の表示を切り替える。body と canvas の背景は `#000`、`overflow: hidden`。
- 黒を締める: ブルームの閾値 0.8 と Afterimage の 0.1 カットで、待機時は背景に一切の光が漏れない構成にしている。画面全体が光る演出（全面フラッシュなど）は作らない。
- 性能目標: 1920×1080・DPR 1 で 60fps を維持（M1 相当の内蔵 GPU を想定）。draw call はおよそ 6（ボール・線・端点・波紋・放出口・プレビュー）＋ポストの各パス。
  毎フレームの `new` を禁止し、Matrix4 / Color は使い回す。`instanceMatrix` / `instanceColor` の `needsUpdate` は変化があったときだけ立てる。
- 実機確認の項目: 待機時の強度 0.30 がプロジェクター上で見えるかどうか。環境光で見えない場合は GUI で 0.45 まで上げる（パラメータとして外に出しておく）。
- 表示遅延の補正: lil-gui に `visualOffsetMs`（−100〜+100、既定 0）を用意し、音とのずれを会場で合わせられるようにする。

## 9. 物理担当への要求

1. 座標は **論理 1920×1080、y 下向き、単位 px**。ボール半径（5px）、線の太さ（3px。当たり判定は中心線からの距離 `r + 1.5` を推奨）、最小線長（24px）は共有定数にする。
2. ボールの状態は `Float32Array` で **前ステップと現ステップの位置**を公開する（補間用）。あわせて `accumulator / dt` の α も渡してほしい。
3. 衝突イベントは `{ simTime, ballIndex, lineId, x, y, nx, ny, speed, v(0〜1 に正規化) }` の形で配列に積み、描画側が毎フレーム drain する。`v` の正規化は音側の音量と**同じ式**を使う。
4. 線は `{ id, ax, ay, bx, by }` を安定した id で管理する（削除アニメーションと回転の将来対応のため）。
5. ボールを消すときにインデックスが詰め替わる場合は、その対応を通知してほしい（ボールの色状態を移すため）。

## 10. 音担当への要求

1. `lengthToNote(lengthPx) → { degree: 0..4, octave, midi }` を**純関数として共有**してほしい（プレビュー色と衝突色に使う）。
2. 同期: Tone.js は lookAhead 分だけ先に予約するので、衝突イベントに発音予定時刻 `audioTime` を付けてほしい。描画側は `Tone.getDraw().schedule(cb, audioTime)` 相当のタイミング（または `audioTime - Tone.now()` の分だけ遅延）でフラッシュを開始する。音と光の完全一致を優先する（concept の決定事項）。
3. `lookAhead` は 0.05s 程度を希望する（遅延を詰めて、描画側の操作プレビュー音にも使えるようにするため）。
4. 放出タイミング（拍）のイベントも同じ形で欲しい（放出口のパルス用）。
5. 同時発音上限などで**鳴らさなかった衝突**には `muted: true` を付けてほしい。その衝突は光を弱めて（×0.4）描く（光って鳴らない、という不一致を目立たせないため）。
