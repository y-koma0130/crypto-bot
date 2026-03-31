# CLAUDE.md — crypto-bot

このファイルはClaude Codeがプロジェクトを理解するためのコンテキストです。
ボット設計・リスク管理・テクニカル指標・ディレクトリ構成などのドメイン知識は **README.md** を参照すること。

---

## プロジェクト概要

GPT-4o + テクニカル分析を組み合わせた仮想通貨トレードボット（KuCoin）。
3つの戦略ボット（Momentum / Range / Sentiment）が協調して動作する。
詳細は README.md の「ボット構成」「リスク管理」セクションを参照。

## 開発上の注意

### import 制約
- `exchange.ts` 以外で ccxt を直接 import しない（テスト切替の一元管理）
- `gpt.ts` 以外で OpenAI client を直接使わない（プロンプトバージョン管理のため）
- `news.ts` 以外で rss-parser を直接使わない（キャッシュ・フィルタの一元管理）

### エラーハンドリング
- エラーは握りつぶさず、必ず `logger.ts` に記録してから continue

### look-ahead bias 防止
- OHLCV の最新足（index 0）は未確定なので使用禁止、index 1 以降を使う

### ドキュメント同期
- ボットのエントリー条件・閾値・リスクパラメータを変更した場合は、README.md の該当セクション（ボット構成・リスク管理）も必ず同時に更新すること

### DRY_RUN モード
- `DRY_RUN=true` では発注処理をログ出力に差し替え。市場データの取得は通常通り行う

## KuCoin 固有の実装注意

### Passphrase（第3認証）
KuCoin は API キー・シークレットに加えて **Passphrase** が必要。ccxt では `password` キーにマッピングする。

```typescript
const exchange = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_API_KEY,
  secret: process.env.KUCOIN_API_SECRET,
  password: process.env.KUCOIN_PASSPHRASE,   // passphrase は ccxt では "password" キー
})
```

### テスト環境
- **Sandbox は 2025年6月に廃止済み**
- テストは `DRY_RUN=true` で実行（発注せずログのみ）

### 規制リスク
2024年11月に金融庁から警告を受けており、将来的にサービス停止の可能性あり。
実弾運用時は **最小限の資金** に留めること。
