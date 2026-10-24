# 開発の手引き

otosu のコードを読む・直す人向けの説明。設計の判断とその理由は [decisions.md](decisions.md) に D 番号で書いてある。

## コマンド

Node.js 20.19 以上。

```bash
npm install
npm run dev      # 開発用サーバー（Vite）
npm test         # Vitest。物理の決定論・すり抜けない・MIDI の書き出しなど
npm run lint     # Biome
npm run build    # 型チェック（tsc）と本番ビルド（dist/）
npm run preview  # 本番ビルドを手元で開く（Service Worker はここで確かめる）
npm run deploy   # ビルドして Cloudflare Workers へ（wrangler.jsonc の routes は作者のドメイン）
```

CI（`.github/workflows/ci.yml`）は `npm ci`・lint・test・build を流す。

## フォルダの構成

```text
src/
├── main.ts     # 組み立て。各部をつなぐ
├── sim/        # 物理と音楽のルール。決定論的で、DOM・音・描画に触れない
├── scene/      # 配置の保存形式（エンコード・検証）
├── audio/      # Tone.js の声部・和音・時計（clock.ts）
├── render/     # three.js の描画。背景・花・当たった点の表示・後処理
├── input/      # ポインタ入力を論理座標の図形にする
├── midi/       # Web MIDI の出力と Standard MIDI File の書き出し
├── app/        # ループ・保存・小窓・ショートカット・録画などの配線
├── ui/         # ツールバー・小窓・案内（素の DOM と CSS）
└── pwa/        # Service Worker とその登録
test/           # Vitest
public/         # アイコン・manifest など、そのまま配る素材
```

## 動き方

- **時刻**: 主になる時計は AudioContext の `currentTime`（D3・D8）。sim は 120Hz（D1）で、音の時刻より少し先行して進み、衝突ごとに `HitEvent` を出す。発音時刻はステップから決まるので、リズムは描画の重さで揺れない
- **ループ**（`src/app/loop.ts`）: 毎フレーム sim を進め、出たイベントを音・MIDI・描画に渡す。タブが隠れている間は `setInterval` で進める（D76）
- **描画**: 「今の時刻（renderStep）」の世界を、sim の履歴から補間して描く。描画はイベントから自分用のコピーを持ち、sim の状態を直接読まない（D9）
- **音と光は 1:1**（D4）: 鳴らす・光らせるの判定は sim だけが行う。例外は D11 に書いた入力のフィードバックと和音の持続音
- **決定論**: sim への変更はすべてコマンド（`src/sim/types.ts` の `Command`）として入る。同じ配置と同じ入力からは同じ音楽になる。テスト（`test/sim.test.ts`）でこれを確かめる
- **座標**: sim は論理 1920×1080（y 下向き、D2）。置ける範囲は余白まで広げてある（D23）

## 配置の保存

- 形式は `SceneData`（`src/sim/types.ts`、`v: 2`）。検証と変換は `src/scene/scene.ts`
- 保存先は 3 つ
  - 自動保存: localStorage の `otosu.scene.v1`
  - ファイル: `.otosu.json`（保存の小窓の export / import）
  - リンク: `#s=<JSON を UTF-8 にして base64url にしたもの>`。開くと一度だけ読み、端末の保存に移して URL から消す（D55）。http(s) で開いていないとき（アプリに包んだときなど）は、公開しているサイトの URL でコピーする
- 古い形式や壊れた値は、読み込むときに推定・既定値で補う（D18・D32）
- この端末の設定（音量・光・MIDI など）は配置とは別に保存する（D24）

## 確かめるときの URL の引数

| 引数 | 何をするか |
|---|---|
| `?fps` | 右下に fps・画質の段階（q0〜q3）・音の遅れを出す（D27・D58） |
| `?latency=0.05` / `?latency=interactive` | AudioContext の `latencyHint` を変える（D58） |
| `?speaker=1` / `?speaker=0` | スマホのスピーカー向けの低音カットと持ち上げを、掛ける・掛けない（D75） |

## 気をつけること

- sim（`src/sim/`）には時刻・乱数・DOM を持ち込まない。決定論が崩れると、保存した配置やリンクが同じ音楽にならない
- 音の時刻は `currentTime` の 1 本に揃える。`Tone.now()` や Tone の先読みは使わない（D8）
- 毎フレーム `getOutputTimestamp()` を呼ばない。Chrome で画面が止まることがある（D29）
- Service Worker は本番ビルドでだけ登録する。キャッシュの版は、ビルドのたびに `vite.config.ts` が dist の中身から作る（D74）
- iPhone の Safari の画面収録では Web Audio の音が雑音になる。動画は録画ボタン（MediaRecorder）で録る（D70）
