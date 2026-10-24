# otosu

落ちる玉が、描いた線や図形に当たって鳴る生成音楽の作品。Vite + TypeScript + three.js + Tone.js の静的サイト（PWA）。

@docs/development.md

## コマンド
- `npm test`・`npm run lint`・`npm run build` が CI と同じ確かめ。変更のあとは 3 つとも通す
- 画面や音の変更は `npm run dev` で開いて確かめる。Service Worker は `npm run build && npm run preview` で確かめる

## コードの決まり
- コメントと設計の記録は日本語。コミットのメッセージは英語の命令形で、関わる判断があれば末尾に `(D76)` のように番号を付ける
- 設計の判断を新しくしたら、[docs/decisions.md](docs/decisions.md) に D 番号を足し、決めたことと理由を書く。コードのコメントからはその番号で指す
- TypeScript は strict と `noUncheckedIndexedAccess`。Biome の推奨ルール（`noNonNullAssertion` は切ってある）。整形には使わず、今の書き方に合わせる
- 依存は増やさない。UI は素の DOM と CSS で、描画と音は three.js と Tone.js が受け持つ（D56）
- `src/sim/` は決定論的に保つ。three・tone・DOM を import せず、`Math.random` や時刻を使わない

## やってはいけないこと
- 保存形式（`SceneData`）を、古い保存データやリンクが読めなくなる形で変えない。足すときは任意の項目にして、無いときの既定を決める
- `wrangler.jsonc` の `routes`（作者のドメイン）を変えない
- 音の時刻に `Tone.now()` や Tone の先読みを使わない（D8）

計画・調査メモはこのリポジトリに置かない(作者の手元の別リポジトリで管理している)。
