<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-当前-blue)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-Available-green)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-Available-green)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-Available-green)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-Available-green)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-Available-green)](blueprint.de.md)

</div>

# Product Blueprint / English

Product flow diagram for Baibai Guochan LLM.

```mermaid
flowchart TD
  A["User opens desktop app"] --> B["Enter API key"]
  B --> C["Fetch available models from server"]
  C --> D["Select model, reasoning effort, and permission mode"]
  D --> E["Enter project session"]
  E --> F["Read / search / edit code"]
  E --> G["Run commands and invoke tools"]
  E --> H["Web search and page fetching"]
  F --> I["Generate replies, code changes, and session records"]
  G --> I
  H --> I
```
