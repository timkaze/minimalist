# ミニマリスト オンライン

> **overlay ブランチ**：トップページは「オーバーレイ版」の試作（袋から引いたタイルを今いるマスに置き，矢印の向きへ出る．置いたタイルがマスの効果を上書きする）．
> コードは `src/overlay/`（tiles.ts・engine.ts・bot.ts・ui.ts），公開先は https://minimalist-online-overlay.garireonetk.workers.dev （push で自動デプロイ）．
> オンライン対戦：部屋は Durable Object `OverlayRoom`（`worker/overlayRoom.ts`，`/api/overlay/:code/ws`）．通し確認は `npx wrangler dev --port 8799` のあと `npx tsx scripts/overlay-online-smoke.ts`．
> 検証：`npx tsx training/overlay-report.ts 600`（`RULES='{"hes":"second"}'` でルール，`COSTS=REST=3` でコスト，`SET=intro` でセットを変える）．
> 仕様と検証結果は Obsidian の `ミニマリスト_オーバーレイ版_仕様.md`（元のメモは `overlay_version.md`）．
> **強いボット（探索＋評価関数）**：`src/overlay/search.ts`（手番の中を探索）と `src/overlay/value.ts`（持ち物から「あと何手番で終わるか」の分布を出す評価関数 V．重みは `src/overlay/value.json`）．方針と進み具合は Obsidian の `ミニマリスト_オーバーレイ版_改善方針.md`．
> - 画面・部屋では，ボットの種類「つよいAI」がこの探索ボット（`src/overlay/bots.ts` の `botAction`）．ほかの種類は以前の型ごとのAI（v0.4 のルールで学習したもの）
> - 学習：`~/.venvs/dm-sim/bin/python training/overlay_fit.py --iters 6 --games 6000`（自己対戦でデータを作り PyTorch で当てはめる．ルールを変えたら `--rules '{…}' --tag 名前 --out 出力先`）
> - 指標：`npx tsx training/overlay-metrics.ts 3000`（長さ・先手勝率・売り切れ・勝者の買い方の型・タイルの採用率．`POOL='search?obj=win,aiFree'` のようにボットを名前で指定）
> - 対戦：`npx tsx training/overlay-duel.ts 'search?obj=win' aiFree 600`／狙い撃ちとタイルの強さ：`npx tsx training/overlay-probe.ts 400`／V とロールアウトの照合：`npx tsx training/overlay-rollout.ts`
> - ルールやタイルを変えた版を1本調べる：`OV_TILES='{"BIGDAY":{"cost":7}}' RULES='{"chips":false}' SET='all+MOMENTUM' training/overlay-exp.sh 名前`（V の学習し直し → 指標 → まとめて買わない条件．結果は `training/overlay-runs/exp_名前/`）
> - 試作のタイル（勢い・ひきかえす・山積み・収納棚）は `EXPERIMENTAL`（`tiles.ts`）．ルール `favBoard`（大掃除の日・ルンバを盤に置く）は画面からは選べない（検証用）
> - ボットの名前：`aiFree` など（`OPRESETS`）／`search?m=重み&obj=mean|win&b=葉の予算&ban=買わない種類&bonus=種類:上乗せ:枚数`
> 以下はスライド版（slide ブランチ）と，前のルールのオンライン版（main ブランチ）の説明．
>
> **slide ブランチ**：トップページは「スライド版」の試作（手札なし．山札の上をめくってコマを動かす）．
> コードは `src/slide/`，公開先は https://minimalist-online-slide.garireonetk.workers.dev （push で自動デプロイ）．
> オンライン対戦：部屋は Durable Object `SlideRoom`（`worker/slideRoom.ts`，`/api/slide/:code/ws`）．通し確認は `npx wrangler dev --port 8799` のあと `npx tsx scripts/slide-online-smoke.ts`．
> 市場のカードセットは `CARD_SETS`（`src/slide/cards.ts`）．`SET=intro npx tsx training/slide-report.ts` でセットごとに検証できる．
> 仕様と検証結果は Obsidian の `ミニマリスト_スライド版_仕様.md`．検証：`npx tsx training/slide-report.ts 600`（`BOARD=slow` で盤を変える）．
> 以下は前のルールのオンライン版（main ブランチ）の説明．

デッキを作って，最後にデッキを消すボードゲーム「ミニマリスト」を，ブラウザで遊べるようにしたものです．

- **ボットと遊ぶ**：ブラウザだけで動きます（サーバー不要）
- **友だちと遊ぶ**：部屋を作ってリンクを送るだけ．2〜6人，空いた席はボットで埋められます
- **ボットの学習**：自己対戦で方針のパラメータを進化させます（`npm run train`）

## 構成

| 場所 | 中身 |
|---|---|
| `src/engine/` | ルールエンジン（ブラウザ・サーバー・学習で共有） |
| `src/bot/` | ボット．方針はすべてパラメータ（`BotGenome`）で決まる．`learned.json` が学習済み |
| `src/client/` | ゲーム画面（素の TypeScript，ライブラリなし） |
| `src/net/protocol.ts` | ブラウザとサーバーのメッセージ |
| `worker/` | Cloudflare Worker と，部屋ごとの Durable Object（ゲームの正しい状態を持つ） |
| `training/` | 学習（進化戦略）と評価 |
| `test/` | ルールエンジンのテスト |

オンライン対戦では，ゲームの状態はサーバー（Durable Object）だけが持ち，各プレイヤーには自分の手札など見てよい情報だけを送ります．山札の順番はだれにも送りません．

## 手元で動かす

```bash
npm install
npm run dev          # 画面だけ（ボット対戦のみ）：http://localhost:5173
npm run dev:worker   # サーバー込み（オンライン対戦も可）：http://localhost:8787
npm test             # ルールのテスト
npm run smoke        # オンライン対戦の自動確認（dev:worker を起動した状態で）
```

## 無料で公開する（GitHub ＋ Cloudflare）

Cloudflare Workers の無料プランで動きます（1日10万リクエストまで．Durable Objects も無料プランで使えます）．

### 1. Cloudflare の準備
1. https://dash.cloudflare.com/sign-up で無料アカウントを作る
2. ダッシュボード右側の **Account ID** を控える
3. 「My Profile → API Tokens → Create Token」で **Edit Cloudflare Workers** テンプレートからトークンを作り，控える
4. 初回だけ，Workers のサブドメイン（`xxx.workers.dev` の `xxx`）を決めるよう求められたら決める

### 2. GitHub の準備
1. GitHub で空のリポジトリを作る（例：`minimalist-online`．公開・非公開どちらでも可）
2. このフォルダで：
   ```bash
   git init -b main
   git add .
   git commit -m "first commit"
   git remote add origin https://github.com/<あなたのユーザー名>/minimalist-online.git
   git push -u origin main
   ```
3. リポジトリの「Settings → Secrets and variables → Actions → New repository secret」で2つ登録：
   - `CLOUDFLARE_API_TOKEN`：1-3 のトークン
   - `CLOUDFLARE_ACCOUNT_ID`：1-2 の Account ID

### 3. デプロイ
- `main` に push するたびに，GitHub Actions がテスト → ビルド → デプロイします（`.github/workflows/deploy.yml`）
- 最初の push の後，Actions タブで再実行するか，もう一度 push してください（シークレット登録前の実行は失敗します）
- 公開 URL：`https://minimalist-online.<サブドメイン>.workers.dev`

#### 試験用の公開（test ブランチ）
本番に出す前に試したい変更は `test` ブランチに push すると，別の Worker `minimalist-online-test` にデプロイされます（`https://minimalist-online-test.<サブドメイン>.workers.dev`）．部屋のデータは本番と別なので，本番の対戦には影響しません．
```bash
git switch -c test        # 初回（2回目からは git switch test）
git merge 作業ブランチ     # 試したい変更を取り込む
git push -u origin test
```
よければ main にマージして push すると本番に出ます．Actions の「Run workflow」も main・test 以外のブランチではデプロイしません．

GitHub を使わずに手元から直接公開することもできます：
```bash
npx wrangler login
npm run deploy
```

## ボットの学習と検証

```bash
npm run evaluate                 # 各戦略の強さ（勝率倍率，1.0 = 公平）
npm run train                    # ワンルーム用のボットを学習（20世代×20個体×60試合で数分）
FLOOR=storage npm run train      # 間取りを指定して学習
npm run train -- 30 24 80        # 世代数・個体数・試合数を指定
```

- 学習は**進化戦略**です．ボットの方針（何を何枚買うか，何から消すか，配置の評価の重み）を数値で表し，対戦で勝ち残った個体を少しずつ変えながら世代を重ねます
- 最後に新しい乱数で多めに対戦させ，今の学習済みより強いときだけ `src/bot/learned.json`（間取りごと）を更新します

ルールを検討するためのスクリプト：

| コマンド | 内容 |
|---|---|
| `npx tsx training/report.ts` | おすすめの間取りごとに，ゲームの長さ・購入枚数・戦略の勝率倍率などを表にする |
| `npx tsx training/study.ts 'R×3 D×3 RD×1 J×2 X×1'` | 初期デッキ案の検証（買わない型の強さ，学習ボットの買い方など） |
| `npx tsx training/archetypes.ts` | 使えるカードを変えて別々に学習し，系統どうしを戦わせる（支配的な戦略があるか） |
| `npx tsx training/floor-lab.ts` | 間取りの試作を比べる（ファイル内に間取りを書く） |
| `MARKET_ADD=ST npx tsx training/card-lab.ts` | 新しいカードの候補を市場に加え，「候補あり」「候補なし」「台車・ハブなし」の系統を学習して比べる |

環境変数で一時的にルールを変えて試せます．
- `CARD_COST="R+=3,BAG=2"`：カードのコスト
- `MARKET_DROP=BAG`／`MARKET_ADD=TRK,ST`：市場のカード（試作・不採用のカードは `cards.ts` の後ろの方にある．ゴミ収集車・階段・はしご・ローラー・カッター・ポイントカード・フリマ）
- `LINES="自由:;台車なし:R+"`：`archetypes.ts` で比べる系統

### ボットの種類
6つのプリセットは，`training/archetypes.ts` で「使ってよいカード」を変えて学習し，ワンルームで互いに互角に近かった系統です（`src/bot/presets.json`）．

| 名前 | 主に買うカード |
|---|---|
| バランス型 | 台車・仕分け箱・ハブ・通路・紙袋 |
| エンジン型 | ハブ・台車・通路（紙袋は買わない） |
| 通路型 | 台車・通路・紙袋（ハブは買わない） |
| ハブ型 | 台車・ハブ・紙袋（通路は買わない） |
| 紙袋型 | ハブ・通路・仕分け箱・紙袋（台車は買わない） |
| 身軽型 | 通路・紙袋だけ（買う枚数が少ない） |
| 学習済み | 間取りごとに学習した方針（`learned.json`） |
| ランダム | 上の6つのどれか |

## 画面の操作
- **戻す（↶）**：置いたカードを手札に戻せます．＋のカード（台車・紙袋など）を置くと山札から引く＝見えない情報に触れるので，それより前には戻せません（`applyAction` の `undo`．手番を終えるとリセット）
- **持っているカード**：自分のカードをカードナンバー順に一覧できます．ナンバーは初期デッキを混ぜる前と，買ったときに振るので，山札の順番はわかりません．それぞれ手札・場・山札・捨札のどこにあるかも表示します

## 市場のカードを選ぶ（テストプレイ用）
開始画面の「市場のカード」で，候補（`cards.ts` の `MARKET_CANDIDATES`：標準6種＋試作7種）から `MARKET_PICK`（6）種類を選べます．基本カード（→・↓）はいつも並びます．オンラインではホストが選び，サーバーが `marketFromPick` で確かめます．ボットは試作カードを学習していないので，ほとんど買いません．

## 間取り（個人ボード）
`src/engine/floors.ts` に文字で書きます．ゲーム開始時に選べます（おすすめは `RECOMMENDED_FLOORS`）．

```
S . . 4 6      S：スタート  .：置けるマス  #：柱（ずっと置けない）
. . . 4 6      数字 n：段ボール（排除した枚数の合計が n になると置ける）
. # . 4 6      G：ゴミ捨て場（置くと捨欲無制限）
4 4 4 # 6
6 6 6 6 G
```

間取りの性格は**左上3×3の柱の位置**と段ボールの枚数でほぼ決まります．柱を増やしすぎると＋で伸ばす連鎖がふさがれ，「何も買わない」が強くなります．

### カスタムの間取り（テストプレイ用）
開始画面の「間取り」で「カスタム（自分で作る）」を選ぶと，その場で間取りを作れます（ボット対戦・オンラインとも）．
- 行・列の数（2〜8）
- マスを押して，置ける／柱／段ボール（n 枚排除すると開く）／ゴミ捨て場（1つまで．置かなくてもよい）に変える
- 目盛り：上の欄が列ごとの物欲，左の欄が行ごとの捨欲（0〜9）．物欲・捨欲の増え方を変えられる
- 「〇〇をもとにする」で既存の間取りから始められる．作った間取りはブラウザに保存される

サーバーは `floorFromSpec`（`floors.ts`）で確かめます（スタートの右のマスは置けるマスにする，など）．ボットは間取りに合わせた学習をしていないので，ワンルーム用の方針で動きます．

## ルールを変えたいとき
- カードの効果・コスト・市場・初期デッキ：`src/engine/cards.ts`
- 検証用に切り替えられるルール：`cards.ts` の `RULE`（粗大ごみの扱い `bulky`，手札からも排除できるか `handRemove`）
- 手番の流れ・勝敗：`src/engine/game.ts`

変えたら `npm test` と `npx tsx training/report.ts` で確認し，必要なら間取りごとに `npm run train` でボットを学習し直してください．
