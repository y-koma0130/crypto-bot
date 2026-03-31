# crypto-bot

GPT-4o + テクニカル分析を組み合わせた仮想通貨トレードボット。
3つの戦略ボットが協調して KuCoin 上で自動売買を行う。

## ボット構成

| ボット | 戦略 | 対象ペア | 間隔 |
|---|---|---|---|
| **Momentum** | EMA(20/50) クロス + 出来高 + ATR + MACD + 4h MTF確認 + GPT レジーム判定 | BTC/USDT, ETH/USDT | 毎時 |
| **Range** | RSI(30/70) 反転確認 + BB + ADX(≤25) + BB幅フィルター + GPT ニュースフィルター | XRP/USDT, SOL/USDT | 15分毎 |
| **Sentiment** | RSS ニュース → GPT バッチ分析 + EMA(20) 確認（司令塔） | 全4ペア | 30分毎 |

Sentiment Bot が `HALT` を出すと、他2ボットの新規エントリーをブロックする。日次損失が資本の -10% に達した場合も全ボットの新規エントリーを停止する。

### Momentum Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | BTC/USDT, ETH/USDT |
| 時間軸 | 1時間足（+ 4時間足で MTF 確認） |
| 資金比率 | 40% |
| エントリー条件 | EMA(20) が EMA(50) を上抜け + 出来高 ≥ 20期間平均の1.2倍 + ATR ボラティリティ拡大（≥ 1.1倍） + MACD ヒストグラム > 0 + 4h EMA(50) 上で推移 |
| エグジット条件 | EMA(20) が EMA(50) を下抜け or トレーリングストップ発動 |
| GPT 役割 | エントリー前にトレンド/レンジ判定（レンジならスキップ、1時間キャッシュ、障害時はテクニカルのみで続行） |

### Range Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | XRP/USDT, SOL/USDT |
| 時間軸 | 15分足 |
| 資金比率 | 35% |
| エントリー条件 | RSI < 30（買い）/ RSI > 70（売り）+ 反転確認（RSI が戻り始め） + BB の外側 + BB 幅 < 6%（スクイーズ確認） + ADX ≤ 25（レンジ相場確認） |
| エグジット条件 | RSI が 45〜55 に戻る or トレーリングストップ発動 |
| GPT 役割 | 重大ニュース直後の誤シグナルをフィルター（15分キャッシュ、障害時はテクニカルのみで続行） |

### Sentiment Bot 詳細

| 項目 | 値 |
|---|---|
| 対象ペア | 全4ペアを監視（独自トレードも可） |
| 時間軸 | 30分毎チェック |
| 資金比率 | 25% |
| GPT 出力 | `BULLISH` / `NEUTRAL` / `BEARISH` / `HALT` の4段階 |
| エントリー条件 | GPT が BULLISH + 価格が EMA(20) の上で推移 |
| HALT の場合 | Bot1/Bot2 の新規エントリーをブロック、既存ポジションは損切りラインで管理 |
| ニュースソース | CoinDesk + CoinTelegraph（RSS フィード、10分キャッシュ、6時間以内の記事のみ） |

## アーキテクチャ

```
main.ts (エントリーポイント)
 ├── node-cron スケジューラ（排他制御付き）
 ├── Bot1 Momentum ── EMA + MACD + ATR + 出来高 + 4h MTF + GPT レジーム判定
 ├── Bot2 Range    ── RSI(25/75) 反転確認 + BB + ADX + GPT ニュースフィルター
 ├── Bot3 Sentiment ── RSS → GPT バッチ分析 + EMA(20) 確認
 │
 ├── core/exchange.ts  ── ccxt (KuCoin) / リトライ / スリッページ保護
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
| 損切り | 初期 -5%（ATR 提供時は highWaterMark ± 2×ATR に動的変更） |
| トレーリング: ブレークイーブン | 含み益 +3% で損切りを建値（+ 手数料分）に移動 |
| トレーリング: 利益ロック | 含み益 +5% で損切りを建値 +2% に移動 |
| 同時ポジション上限 | 各ボット 1、全体 3、同方向最大 2 |
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

- OHLCV データは要約統計に圧縮して送信（~95% トークン削減）
- Sentiment 分析は全ペアを1回のバッチ API 呼び出しで処理
- レジーム分類は1時間、ニュースフィルターは15分キャッシュ
- `max_tokens: 500` で出力を制限

## ディレクトリ構成

```
crypto-bot/
├── main.ts                  エントリーポイント
├── config/
│   └── settings.ts          ボット設定・リスク定数・テクニカル指標パラメータ
├── bots/
│   ├── momentum.ts          Bot1: EMA クロス + ATR フィルター
│   ├── range.ts             Bot2: RSI 反転確認 + BB
│   └── sentiment.ts         Bot3: GPT ニュース分析（司令塔）
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
| `--bot` | `momentum` | `momentum` or `range` |
| `--pair` | `BTC/USDT` | 対象ペア |
| `--days` | `90` | テスト期間（日数） |

出力指標: 勝率、総損益、最大ドローダウン、シャープレシオ、プロフィットファクター

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
