<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-Available-green)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-当前-blue)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-Available-green)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-Available-green)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-Available-green)](blueprint.de.md)

</div>

# 제품 청사진 / 한국어

白白 국산 대모델의 제품 흐름도.

```mermaid
flowchart TD
  A["사용자가 데스크톱 앱 실행"] --> B["API 키 입력"]
  B --> C["서버에서 사용 가능한 모델 가져오기"]
  C --> D["모델, 추론 강도, 권한 모드 선택"]
  D --> E["프로젝트 세션 진입"]
  E --> F["코드 읽기 / 검색 / 편집"]
  E --> G["명령 실행 및 도구 호출"]
  E --> H["웹 검색 및 페이지 가져오기"]
  F --> I["응답, 코드 변경, 세션 기록 생성"]
  G --> I
  H --> I
```
