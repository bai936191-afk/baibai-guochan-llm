<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-当前-blue)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-Available-green)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-Available-green)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-Available-green)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-Available-green)](blueprint.de.md)

</div>

# 製品ブループリント / 日本語

白白国産大モデルの製品フロー図。

```mermaid
flowchart TD
  A["ユーザーがデスクトップアプリを開く"] --> B["APIキーを入力"]
  B --> C["サーバーから利用可能なモデルを取得"]
  C --> D["モデル、推論強度、権限モードを選択"]
  D --> E["プロジェクトセッションに入る"]
  E --> F["コードの読み取り / 検索 / 編集"]
  E --> G["コマンドの実行とツールの呼び出し"]
  E --> H["Web検索とページ取得"]
  F --> I["回答、コード変更、セッション記録を生成"]
  G --> I
  H --> I
```
