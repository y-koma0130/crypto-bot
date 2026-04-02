# crypto-bot

GPT-4o + テクニカル分析を組み合わせた仮想通貨トレードボット。
5つの戦略ボットが協調して KuCoin 上で自動売買を行う。

## ボット構成

| ボット | 戦略 | 対象ペア | 間隔 |
|---|---|---|---|
| **Momentum** | コア: EMA(20/50) クロス + MACD / 参考(2/4): 出来高 + ATR + 4h MTF + ADX トレンド判定 | BTC/USDT, ETH/USDT | 毎時 |
| **Momentum Fast** | コア: EMA(9/21) クロス + MACD / 参考(1/2): 出来高 + ATR（GPT省略、速度優先） | BTC/USDT, ETH/USDT | 15分毎 |
| **Range** | コア: RSI(30/70) 反転 + BB外側 / 参考(2/3): BB幅 + ADX(≤25) + Polymarket確率 | XRP/USDT, SOL/USDT | 15分毎 |
| **Polymarket** | Polymarket 確率の急変（10分で±15%）をトリガーにエントリー。GPT不要 | 全4ペア | 10分毎 |
| **Sentiment** | Polymarket確率 + RSSキーワードでセンチメント判定（GPT不要、司令塔） | 全4ペア | 30分毎 |

Sentiment Bot が `HALT` を出すと、他のボットの新規エントリーをブロックする。日次損失が資本の -10% に達した場合も全ボットの新規エントリーを停止する。

### 損切りチェッカー

全ボットのオープンポジションを **1分毎** に横断チェックする高頻度損切りタイマーを搭載。各ボットのtick間隔（15分〜1時間）に依存せず、急落時にも迅速に損切りを実行する。

### ショートポジション（先物）

`FUTURES_ENABLED=true` の場合、各ボットがショート（空売り）ポジションを先物経由で取れるようになる。

| ボット | ロング（スポット） | ショート（先物） |
|---|---|---|
| **Momentum** | EMAクロスオーバー | EMAクロスアンダー + MACD < 0 |
| **Momentum Fast** | EMA(9/21)クロスオーバー | EMA(9/21)クロスアンダー + MACD < 0 |
| **Range** | RSI < 30 + BB下限 | RSI > 70 + BB上限 |
| **Polymarket** | 確率急上昇（bullish方向） | 確率急上昇（bearish方向） |
| **Sentiment** | BULLISH + EMA(20)上 | BEARISH + EMA(20)下 |

- 先物クライアントは ccxt の `kucoinfutures` を使用（USDT-M ペア）
- レバレッジは `FUTURES_LEVERAGE` で設定（デフォルト2倍、最大20倍）
- `FUTURES_ENABLED=false`（デフォルト）ではショートエントリーはスキップされる

### Momentum Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | BTC/USDT, ETH/USDT |
| 時間軸 | 1時間足（+ 4時間足で MTF 確認） |
| 資金比率 | 30% |
| エントリー条件（コア） | EMA(20) が EMA(50) を上抜け + MACD ヒストグラム > 0（全て必須） |
| エントリー条件（参考） | 出来高 ≥ 20期間平均の1.2倍 / ATR 拡大（≥ 1.1倍） / 4h EMA(50) 上で推移 / ADX > 25（トレンド判定）（4つ中2つ以上で実行） |
| エグジット条件 | EMA(20) が EMA(50) を下抜け or トレーリングストップ発動 |

### Momentum Fast Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | BTC/USDT, ETH/USDT |
| 時間軸 | 15分足 |
| 資金比率 | 10% |
| エントリー条件（コア） | EMA(9) が EMA(21) をクロス + MACD ヒストグラム方向一致（全て必須） |
| エントリー条件（参考） | 出来高 ≥ 20期間平均の1.2倍 / ATR 拡大（2つ中1つ以上で実行。GPT判定なし、速度優先） |
| エグジット条件 | EMA(9) が EMA(21) を逆クロス or トレーリングストップ発動 |

### Range Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | XRP/USDT, SOL/USDT |
| 時間軸 | 15分足 |
| 資金比率 | 35% |
| エントリー条件（コア） | RSI < 30（買い）/ RSI > 70（売り）+ 反転確認（RSI が戻り始め） + BB の外側（全て必須） |
| エントリー条件（参考） | BB 幅 < 6%（スクイーズ確認） / ADX ≤ 25（レンジ相場確認） / Polymarket確率フィルター（3つ中2つ以上で実行） |
| エグジット条件 | RSI が 45〜55 に戻る or トレーリングストップ発動 |

### Sentiment Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | 全4ペアを監視（独自トレードも可） |
| 時間軸 | 30分毎チェック |
| 資金比率 | 20% |
| 判定方式 | Polymarket確率（≥65%でBULLISH/BEARISH）+ RSSニュースHALTキーワード検出。**GPT不要** |
| ロングエントリー | Polymarket BULLISH + 価格が EMA(20) の上で推移 |
| ショートエントリー | Polymarket BEARISH + 価格が EMA(20) の下で推移（先物経由） |
| HALT の場合 | RSSニュースにHALTキーワード（hack, exploit, ban等）検出で全ボット停止 |
| データソース | Polymarket Gamma API（確率判定）+ CoinDesk/CoinTelegraph RSS（HALT検出のみ） |

## アーキテクチャ

```
main.ts (エントリーポイント)
 ├── node-cron スケジューラ（排他制御付き）
 ├── Bot1 Momentum      ── EMA(20/50) クロス + MACD（1h足、ロング/ショート）
 ├── Bot1-fast Momentum  ── EMA(9/21) クロス + MACD（15m足、GPT省略、速度優先）
 ├── Bot2 Range          ── RSI(30/70) 反転 + BB（15m足、ロング: スポット / ショート: 先物）
 ├── Polymarket Bot      ── Polymarket 確率急変をトリガー（10分毎、GPT不要）
 ├── Bot3 Sentiment      ── Polymarket確率 + RSSキーワード（GPT不要、司令塔）
 ├── Stop-loss checker   ── 1分毎に全ボットのポジションを横断チェック
 │
 ├── core/exchange.ts  ── ccxt (KuCoin スポット + 先物) / リトライ / スリッページ保護
 ├── core/gpt.ts       ── OpenAI API / バッチ分析 / キャッシュ
 ├── core/risk.ts      ── トレーリングストップ / ATR / PnL 計算
 ├── core/news.ts      ── RSS フィード (CoinDesk + CoinTelegraph)
 ├── core/db.ts        ── Drizzle ORM (Supabase PostgreSQL)
 └── core/logger.ts    ── JSONL ファイル + コンソール (JST)
```

## セットアップ

### 前提条件

- Node.js >= 20
- pnpm
- KuCoin アカウント + API キー
- OpenAI API キー
- Supabase プロジェクト

### インストール

```bash
pnpm install
```

### 環境変数

`.env.example` をコピーして `.env.test` / `.env.prod` を作成する。

```bash
cp .env.example .env.test
```

```env
# KuCoin
KUCOIN_API_KEY=
KUCOIN_API_SECRET=
KUCOIN_PASSPHRASE=          # API作成時に自分で設定したパスワード

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini    # prod では gpt-4o

# Database (Supabase PostgreSQL)
DATABASE_URL=postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres

# 動作モード
DRY_RUN=true                # true = 発注せずログのみ
ENV=test                    # test | prod

# 資金設定（USDT）
TOTAL_CAPITAL=1000

# 先物設定（ショートポジション用）
FUTURES_ENABLED=false       # true = ショートポジション有効
FUTURES_LEVERAGE=2          # レバレッジ倍率（1〜20）
```

### DB マイグレーション

```bash
pnpm db:generate   # マイグレーション SQL 生成
pnpm db:migrate    # DB に適用
```

### 起動

```bash
# テスト環境（DRY_RUN=true）
pnpm dev

# 本番環境
pnpm start:prod
```

## リスク管理

| パラメータ | 値 |
|---|---|
| 損切り（Momentum/Sentiment） | -5%（ATR 提供時は highWaterMark ± 2×ATR に動的変更） |
| 損切り（Momentum Fast/Range） | -2%（短期ボット向けタイト設定） |
| トレーリング: ブレークイーブン | 含み益 +1.5% で損切りを建値に移動 |
| トレーリング: 利益ロック | 含み益 +3% で損切りを建値 +1% に移動 |
| 日足トレンドフィルター | 日足 EMA(20) の上→ロングのみ、下→ショートのみ（全ボット共通） |
| 部分利確 | 含み益 +2% で半分決済、残りはトレーリングで伸ばす |
| 時間ベース損切り | Momentum Fast: 4時間経過で+1%未達なら決済 |
| 連敗制御 | 同一ボット3連敗で次のtickをスキップ |
| 相関フィルター | BTC直近1h -2%超でアルト（XRP/SOL）のロングをブロック |
| 同時ポジション上限 | 各ボット 1、全体 5、同方向最大 2 |
| 損切りチェック間隔 | 1分毎（全ボット横断、tick間隔に依存しない高頻度チェック） |
| 日次損失上限 | 資本の -10%（超過で全ボット停止） |
| 1トレードあたりのリスク | 資本の 1% |
| 取引手数料 | 0.1%（PnL に反映） |
| スリッページ許容 | 0.5%（成行→許容幅付き指値に自動変換） |

## 信頼性

| 機能 | 説明 |
|---|---|
| Graceful Shutdown | SIGTERM/SIGINT で cron 停止→bot_status 更新→安全終了 |
| ポジション復元 | 起動時に DB のオープントレードからインメモリ状態を復元 |
| Cron 排他制御 | ボット毎の mutex で tick の重複実行を防止 |
| API リトライ | 指数バックオフ（1s→2s→4s、最大3回） |
| 注文追跡 | 指値注文後に約定をポーリング（最大30秒、指数バックオフ） |
| DB SSL | PostgreSQL 接続は SSL 必須 |
| 起動時ヘルスチェック | DB・Exchange API の疎通を確認してから稼働開始 |

## GPT トークン最適化

- **GPTコスト実質0**: Momentum→ADX、Range→Polymarket確率、Sentiment→Polymarket閾値に置換済み
- Polymarket Gamma API（無料・認証不要）で予測市場データを10分毎に取得
- RSSニュースはHALTキーワード検出のみに限定（hack, exploit, ban等）
- GPTクライアントは残存（将来拡張用）だが、現在の全ボットで不使用

## ディレクトリ構成

```
crypto-bot/
├── main.ts                  エントリーポイント
├── config/
│   └── settings.ts          ボット設定・リスク定数・テクニカル指標パラメータ
├── bots/
│   ├── momentum.ts          Bot1: EMA(20/50) クロス + MACD（1h足）
│   ├── momentum-fast.ts     Bot1-fast: EMA(9/21) クロス + MACD（15m足）
│   ├── range.ts             Bot2: RSI(30/70) 反転確認 + BB（15m足）
│   ├── polymarket.ts        Polymarket: 確率急変トリガー（10分毎）
│   └── sentiment.ts         Bot3: Polymarket + RSS（司令塔、GPT不要）
├── core/
│   ├── exchange.ts          ccxt ラッパー（KuCoin）
│   ├── gpt.ts               OpenAI API ラッパー
│   ├── risk.ts              トレーリングストップ・ATR・PnL 計算
│   ├── news.ts              RSS フィードフェッチャー
│   ├── db.ts                Drizzle ORM Repository
│   └── logger.ts            JSONL + コンソールログ（JST）
├── backtest/
│   ├── run.ts               バックテスト CLI エントリーポイント
│   ├── runner.ts            バックテスト シミュレーションエンジン
│   ├── data-fetcher.ts      ヒストリカルデータ取得
│   ├── types.ts             バックテスト用型定義
│   ├── mock-exchange.ts     モック取引所クライアント
│   ├── mock-gpt.ts          モック GPT クライアント
│   ├── mock-news.ts         モック ニュースフェッチャー
│   ├── mock-repository.ts   モック リポジトリ
│   └── data/                ヒストリカル OHLCV データ（JSON）
├── db/
│   ├── schema.ts            Drizzle スキーマ定義
│   └── migrations/          マイグレーション SQL
├── types/
│   └── index.ts             共通型定義
└── drizzle.config.ts        Drizzle Kit 設定
```

## npm scripts

| コマンド | 説明 |
|---|---|
| `pnpm dev` | テスト環境で起動（.env.test） |
| `pnpm start:prod` | 本番環境で起動（.env.prod） |
| `pnpm build` | TypeScript ビルド |
| `pnpm typecheck` | 型チェックのみ |
| `pnpm db:generate` | マイグレーション SQL 生成 |
| `pnpm db:migrate` | マイグレーション実行 |
| `pnpm db:push` | スキーマを DB に直接反映（開発用） |
| `pnpm db:studio` | Drizzle Studio 起動（DB ブラウザ） |
| `pnpm backtest` | バックテスト実行 |

## バックテスト

過去データを使ってボット戦略のパフォーマンスを検証できる。GPT・取引所・DB はすべてモックに差し替えて実行される。

```bash
# デフォルト（Momentum / BTC/USDT / 90日）
pnpm backtest

# オプション指定
pnpm backtest -- --bot range --pair XRP/USDT --days 30
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `--bot` | `momentum` | `momentum`, `momentum-fast`, or `range` |
| `--pair` | `BTC/USDT` | 対象ペア |
| `--days` | `90` | テスト期間（日数） |

出力指標: 勝率、総損益、最大ドローダウン、シャープレシオ、プロフィットファクター

- ショートポジション対応（モック先物で売りエントリーも検証可能）
- GPT 判定はモック（常に TRENDING / safe を返す）のため、実運用より多くのエントリーが発生する点に注意

## デプロイ（Railway）

```bash
railway login
railway init
railway up
```

環境変数は Railway ダッシュボードで設定する（`.env.prod` の内容）。
`package.json` の `start:prod` スクリプトが自動検出される。

## KuCoin 固有の注意

- KuCoin API は Key / Secret に加えて **Passphrase（第3認証）** が必要。ccxt では `password` キーにマッピングする
- **Sandbox は 2025年6月に廃止済み** — テストは `DRY_RUN=true` で実行（発注せずログのみ）
- ペア表記は USDT ペアが基本: `BTC/USDT`, `ETH/USDT`, `XRP/USDT`, `SOL/USDT`

## 注意事項

- KuCoin は 2024年11月に金融庁から警告を受けており、サービス停止の可能性がある。実弾運用は最小限の資金で行うこと
- `DRY_RUN=true` では実際の発注は行われないが、KuCoin API から市場データは取得する
- `.env.prod` は絶対にコミットしないこと（`.gitignore` で除外済み）
