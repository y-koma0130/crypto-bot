# CLAUDE.md — crypto-bot

このファイルはClaude Codeがプロジェクトを理解するためのコンテキストです。

---

## プロジェクト概要

GPT-4oを活用したクリプトトレードボット。3つのボットが役割分担して動作する。

- **Bot1 モメンタムBot** — EMAクロスでトレンドを取る
- **Bot2 レンジBot** — RSI/BBで逆張り
- **Bot3 センチメントBot（司令塔）** — GPTでニュース分析、Bot1/2を制御

## 技術スタック

| 項目 | 選定 |
|---|---|
| ランタイム | Node.js 24 + TypeScript |
| パッケージマネージャ | pnpm |
| 取引所API | ccxt（KuCoin） |
| LLM | OpenAI API（gpt-4o / gpt-4o-mini） |
| スケジューリング | node-cron |
| ログ | Supabase（将来）/ JSONファイル（初期） |
| デプロイ | Railway |
| テスト | DRY_RUN=true（Sandbox廃止のため） |

## ディレクトリ構成

```
crypto-bot/
├── CLAUDE.md               ← このファイル
├── README.md
├── package.json
├── tsconfig.json
├── .env.test               ← testnet設定（gitignore対象外・ダミー値で管理）
├── .env.prod               ← mainnet設定（gitignore必須）
├── .gitignore
│
├── config/
│   └── settings.ts         ← 3ボットの設定オブジェクト（ペア・資金比率・閾値）
│
├── bots/
│   ├── momentum.ts         ← Bot1: EMA(20/50)クロス + 出来高確認
│   ├── range.ts            ← Bot2: RSI + Bollinger Band逆張り
│   └── sentiment.ts        ← Bot3: GPTニュース分析 + 司令塔ロジック
│
├── core/
│   ├── exchange.ts         ← ccxtラッパー（テスト/本番切替はここだけ）
│   ├── gpt.ts              ← OpenAI APIラッパー（プロンプト管理）
│   ├── risk.ts             ← 損切り・ポジションサイズ計算
│   └── logger.ts           ← ログ出力（ファイル or Supabase）
│
├── types/
│   └── index.ts            ← 共通型定義
│
└── main.ts                 ← エントリーポイント（3ボット起動）
```

## 環境変数

`.env.test` と `.env.prod` を切り替えて使用。起動コマンドで自動選択。

```env
# 共通フォーマット（.env.test / .env.prod）

# KuCoin
# https://www.kucoin.com でキー発行
KUCOIN_API_KEY=
KUCOIN_API_SECRET=
KUCOIN_PASSPHRASE=          # KuCoin固有の第3認証キー

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini    # prodではgpt-4o

# 動作モード
DRY_RUN=true                # prodではfalse（trueなら発注せずログのみ）
ENV=test                    # test | prod

# 資金設定（USDT）
TOTAL_CAPITAL=1000
```

## 起動コマンド

```bash
# テスト環境（デフォルト）
pnpm dev

# 本番環境
pnpm start:prod

# スクリプト定義（package.json）
# "dev":        "ENV_FILE=.env.test ts-node main.ts"
# "start:prod": "ENV_FILE=.env.prod ts-node main.ts"
```

## ボット設計

### Bot1: モメンタムBot

| 項目 | 値 |
|---|---|
| 対象ペア | BTC/USDT, ETH/USDT |
| 時間軸 | 1時間足 |
| 資金比率 | 40% |
| エントリー条件 | EMA20がEMA50を上抜け + 出来高が20期間平均の1.5倍以上 |
| エグジット条件 | EMA20がEMA50を下抜け or 損切り-5% |
| GPT役割 | エントリー前にトレンド/レンジ判定（レンジ判定ならスキップ） |

### Bot2: レンジBot

| 項目 | 値 |
|---|---|
| 対象ペア | XRP/USDT, SOL/USDT |
| 時間軸 | 15分足 |
| 資金比率 | 35% |
| エントリー条件 | RSI < 30（買い）/ RSI > 70（売り）+ BBの外側 |
| エグジット条件 | RSIが50に戻る or 損切り-5% |
| GPT役割 | 重大ニュース直後の誤シグナルをフィルター |

### Bot3: センチメントBot（司令塔）

| 項目 | 値 |
|---|---|
| 対象ペア | 全4ペアを監視（独自トレードも可） |
| 時間軸 | 30分毎チェック |
| 資金比率 | 25% |
| GPT出力 | `BULLISH` / `NEUTRAL` / `BEARISH` / `HALT` の4段階 |
| HALTの場合 | Bot1/Bot2の新規エントリーをブロック、既存ポジションは損切りラインで管理 |
| ニュースソース | CryptoPanic API（無料枠）/ KuCoin公式ニュースフィード |

## KuCoin固有の注意点

### Passphrase（第3認証）
KuCoinはAPIキー・シークレットに加えて **Passphrase** が必要。ccxt初期化時に必須。

```typescript
const exchange = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_API_KEY,
  secret: process.env.KUCOIN_API_SECRET,
  password: process.env.KUCOIN_PASSPHRASE,   // passphraseはccxtでは"password"キー
})
```

### テスト環境
- **Sandboxは2025年6月に廃止済み**
- テストは `DRY_RUN=true` で実行（発注せずログのみ）

### ペア表記
KuCoinはUSDTペアが基本。`BTC/USDT`, `ETH/USDT`, `XRP/USDT`, `SOL/USDT`。

### 規制リスク
2024年11月に金融庁から警告を受けており、将来的にサービス停止の可能性あり。
実弾運用時は**最小限の資金**に留めること。

## リスク管理ルール（コード全体で共通）

```
- 1ポジションあたりの損切り: -5%（risk.tsで強制）
- 同時保有上限: 各ボット1ポジションまで（合計最大3ポジション）
- Bot3がHALTを出したら新規エントリー全禁止
- DRY_RUN=trueの場合、発注処理をログ出力に差し替え
```

## 開発上の注意

- `exchange.ts` 以外でccxtを直接importしない（テスト切替の一元管理）
- `gpt.ts` 以外でOpenAI clientを直接使わない（プロンプトバージョン管理のため）
- エラーは握りつぶさず、必ず `logger.ts` に記録してからcontinue
- look-ahead bias防止: OHLCVの最新足（index 0）は未確定なので使用禁止、index 1以降を使う

## Railway デプロイ

```bash
# 初回
railway login
railway init
railway up

# 環境変数はRailwayダッシュボードで設定（.env.prodの内容をコピー）
# Procfile不要（package.jsonのstartスクリプトを自動検出）
```
