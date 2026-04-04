# crypto-bot

GPT-4o + Polymarket予測市場 + テクニカル分析を組み合わせた仮想通貨トレードボット。
5つの戦略ボットが協調して KuCoin 上で自動売買を行う。GPTはマーケットレジーム分類に活用（月額 ~$1未満）。

## ボット構成

| ボット | 戦略 | 対象ペア | 間隔 | 資金比率 |
|---|---|---|---|---|
| **Momentum** | コア: EMA(20/50) クロス + MACD / 参考(2/4): 出来高加重スコア + ATR + MTF一致度 + GPTレジーム | BTC/USDT, ETH/USDT | 毎時 | 30% |
| **Momentum Fast** | コア: EMA(9/21) クロス + MACD / 参考(1/2): 出来高加重スコア + ATR | BTC/USDT, ETH/USDT | 15分毎 | 10% |
| **Range** | コア: RSI(30/70) 反転 + BB外側 / 参考(2/3): BB幅 + GPTレジーム + Polymarket確率 | XRP/USDT, SOL/USDT | 15分毎 | 35% |
| **Polymarket** | Polymarket 確率の急変（10分で±15%）をトリガーにエントリー | 全4ペア | 10分毎 | 5% |
| **Sentiment** | Polymarket確率(≥65%) + RSS HALTキーワード検出（司令塔） | 全4ペア | 30分毎 | 20% |

- Sentiment Bot が `HALT` を出すと、他の全ボットの新規エントリーをブロック
- 日次損失が資本の -10% に達した場合も全ボット停止
- GPT はマーケットレジーム分類（TRENDING/RANGING）に活用、1hキャッシュで月額 ~$1未満

### ショートポジション（先物）

`FUTURES_ENABLED=true` の場合、各ボットが先物経由でショート可能。

| ボット | ロング（スポット） | ショート（先物） |
|---|---|---|
| **Momentum** | EMAクロスオーバー | EMAクロスアンダー + MACD < 0 |
| **Momentum Fast** | EMA(9/21)クロスオーバー | EMA(9/21)クロスアンダー + MACD < 0 |
| **Range** | RSI < 30 + BB下限 | RSI > 70 + BB上限 |
| **Polymarket** | 確率急上昇（bullish方向） | 確率急上昇（bearish方向） |
| **Sentiment** | BULLISH + EMA(20)上 | BEARISH + EMA(20)下 |

- ccxt `kucoinfutures`（USDT-M ペア）、レバレッジは `FUTURES_LEVERAGE` で設定（デフォルト2倍）

### ボット詳細

#### Momentum Bot

| 項目 | 値 |
|---|---|
| 時間軸 | 1時間足（+ 15m/4h/日足で MTF 一致度スコアリング） |
| エントリー（コア） | EMA(20) が EMA(50) をクロス + MACD ヒストグラム方向一致（全て必須） |
| エントリー（参考） | 出来高加重スコア ≥ 0.5 / ATR 拡大 ≥ 1.1倍 / MTF一致度 ≥ 75% / GPTレジーム=TRENDING(confidence≥0.6)（4つ中2つ以上）。MTFスコア全一致で100%、3/4一致で70%のポジションサイズ |
| エグジット | EMAクロス反転 / 段階的トレーリング / 部分利確（+4%で半分決済） / 最高値-3%追跡 |

#### Momentum Fast Bot

| 項目 | 値 |
|---|---|
| 時間軸 | 15分足 |
| エントリー（コア） | EMA(9) が EMA(21) をクロス + MACD 方向一致（全て必須） |
| エントリー（参考） | 出来高加重スコア ≥ 0.5 / ATR 拡大（2つ中1つ以上） |
| エグジット | EMAクロス反転 / 段階的トレーリング / 部分利確（+2%で半分決済） / 最高値-1.5%追跡 / 時間ベース損切り（4h経過+1%未達で決済） |

#### Range Bot

| 項目 | 値 |
|---|---|
| 時間軸 | 15分足 |
| エントリー（コア） | RSI < 30（買い）/ RSI > 70（売り）+ 反転確認 + BB 外側（全て必須） |
| エントリー（参考） | BB幅 < 6% / GPTレジーム=RANGING(confidence≥0.6) / Polymarket確率フィルター（3つ中2つ以上） |
| エグジット | RSI 45〜55 に回帰 / 段階的トレーリング / 部分利確（+1.5%で半分決済） / 最高値-1%追跡 |

#### Polymarket Bot

| 項目 | 値 |
|---|---|
| 時間軸 | 10分毎 |
| エントリー | Polymarket確率の急変（10分で±15%以上）をトリガーに、変化方向にエントリー |
| エグジット | 確率が反転（逆方向に±15%変化）/ 段階的トレーリング / 部分利確（+3%で半分決済） / 最高値-2%追跡 |

#### Sentiment Bot（司令塔）

| 項目 | 値 |
|---|---|
| 判定方式 | Polymarket確率（≥55%でBULLISH/BEARISH）+ RSSニュースHALTキーワード検出。**GPT不要** |
| ロングエントリー | BULLISH + 価格が EMA(20) の上 |
| ショートエントリー | BEARISH + 価格が EMA(20) の下（先物経由） |
| エグジット | センチメント反転（BULLISH↔BEARISH）/ 段階的トレーリング / 部分利確（+4%で半分決済） / 最高値-3%追跡 |
| HALT | RSSニュースにHALTキーワード（hack, exploit, stolen等の緊急事態のみ）検出で全ボット停止 |
| データソース | Polymarket Gamma API + CoinDesk/CoinTelegraph RSS |

## リスク管理

### ボット別エグジットプロファイル

各ボットの特性に合わせた損切り・利確・トレーリング設定。利益が伸びるほど損切りラインも段階的に引き上げ、大きなトレンドを逃さない。

| ボット | 損切り | 部分利確 | トレーリング幅 | 時間損切り |
|---|---|---|---|---|
| **Momentum** | -5% | +4%で半分 | +2%→建値、+3%→+1%、+5%→+3%、+8%→+5.5%、以降は最高値-3%追跡 | — |
| **Momentum Fast** | -2% | +2%で半分 | +1.5%→建値、+2%→+0.5%、+3%→+1.5%、以降は最高値-1.5%追跡 | 4h経過+1%未達で決済 |
| **Range** | -2% | +1.5%で半分 | +1%→建値、+1.5%→+0.5%、+2%→+1%、以降は最高値-1%追跡 | — |
| **Polymarket** | -2% | +3%で半分 | +2%→建値、+3%→+1.5%、+5%→+3%、以降は最高値-2%追跡 | — |
| **Sentiment** | -5% | +4%で半分 | Momentumと同じ段階的トレーリング | — |

ATR が提供されている場合（Momentum系）、ATRベースの損切りライン（highWaterMark ± 2×ATR）も計算し、段階的トレーリングと比較して有利な方を採用する。

### 全体リスク管理

| パラメータ | 値 |
|---|---|
| 日足トレンドフィルター | 日足 EMA(20) の上→ロングのみ、下→ショートのみ（全ボット共通、1hキャッシュ） |
| 相関フィルター | BTC直近1h -2%超でアルト（XRP/SOL）のロングをブロック |
| 連敗制御 | 同一ボット3連敗で次のtickをスキップ（5分キャッシュ） |
| 損切りチェック | 1分毎に全ボットのポジションを横断チェック（各ボットのmutex内で実行） |
| 同時ポジション上限 | 各ボット 1、全体 5、同方向最大 3 |
| 日次損失上限 | 資本の -10%（超過で全ボット停止） |
| 取引手数料 | 0.1%（PnL に反映） |
| スリッページ許容 | 0.5%（成行→許容幅付き指値に自動変換） |

## アーキテクチャ

```
main.ts (エントリーポイント)
 ├── node-cron スケジューラ（排他制御付き）
 ├── Momentum         ── EMA(20/50) + MACD + ADX（1h足）
 ├── Momentum Fast    ── EMA(9/21) + MACD（15m足）
 ├── Range            ── RSI(30/70) + BB + Polymarket（15m足）
 ├── Polymarket       ── 確率急変トリガー（10分毎）
 ├── Sentiment        ── Polymarket確率 + RSS HALT検出（司令塔）
 ├── Stop-loss checker ── 1分毎に全ボット横断チェック
 │
 ├── core/exchange.ts    ── ccxt (KuCoin スポット + 先物) / リトライ / スリッページ保護
 ├── core/indicators.ts  ── EMA / MTFスコアリング / ボリューム加重分析（共通モジュール）
 ├── core/risk.ts        ── トレーリングストップ / 部分利確 / ATR / PnL / 日足トレンド判定
 ├── core/news.ts        ── Polymarket Gamma API + RSS フィード + センチメント判定
 ├── core/gpt.ts         ── OpenAI API ラッパー（マーケットレジーム分類に使用）
 ├── core/db.ts          ── Drizzle ORM (Supabase PostgreSQL)
 └── core/logger.ts      ── JSONL ファイル + コンソール (JST)
```

## セットアップ

### 前提条件

- Node.js >= 20
- pnpm
- KuCoin アカウント + API キー
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

# OpenAI（マーケットレジーム分類に使用）
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

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

## ディレクトリ構成

```
crypto-bot/
├── main.ts                  エントリーポイント
├── config/
│   └── settings.ts          ボット設定・リスク定数・テクニカル指標パラメータ
├── bots/
│   ├── momentum.ts          Momentum: EMA(20/50) + MACD（1h足）
│   ├── momentum-fast.ts     Momentum Fast: EMA(9/21) + MACD（15m足）
│   ├── range.ts             Range: RSI(30/70) + BB（15m足）
│   ├── polymarket.ts        Polymarket: 確率急変トリガー（10分毎）
│   └── sentiment.ts         Sentiment: Polymarket + RSS（司令塔）
├── core/
│   ├── exchange.ts          ccxt ラッパー（KuCoin スポット + 先物）
│   ├── indicators.ts        EMA / MTFスコアリング / ボリューム加重分析
│   ├── risk.ts              トレーリングストップ・部分利確・ATR・PnL 計算
│   ├── gpt.ts               OpenAI API ラッパー（マーケットレジーム分類）
│   ├── news.ts              Polymarket Gamma API + RSS フィード + センチメント判定
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

過去データを使ってボット戦略のパフォーマンスを検証できる。取得所・DB はモックに差し替えて実行。

```bash
# デフォルト（Momentum / BTC/USDT / 90日）
pnpm backtest

# オプション指定
pnpm backtest -- --bot momentum-fast --pair ETH/USDT --days 30
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `--bot` | `momentum` | `momentum`, `momentum-fast`, or `range` |
| `--pair` | `BTC/USDT` | 対象ペア |
| `--days` | `90` | テスト期間（日数） |

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
