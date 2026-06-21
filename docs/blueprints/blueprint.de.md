<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-Available-green)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-Available-green)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-Available-green)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-Available-green)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-当前-blue)](blueprint.de.md)

</div>

# Produktbauplan / Deutsch

Produktflussdiagramm für Baibai Guochan LLM.

```mermaid
flowchart TD
  A["Benutzer öffnet die Desktop-App"] --> B["API-Schlüssel eingeben"]
  B --> C["Verfügbare Modelle vom Server abrufen"]
  C --> D["Modell, Inferenzstärke und Berechtigungsmodus wählen"]
  D --> E["Projektsitzung öffnen"]
  E --> F["Code lesen / suchen / bearbeiten"]
  E --> G["Befehle ausführen und Werkzeuge aufrufen"]
  E --> H["Websuche und Seitenabruf"]
  F --> I["Antworten, Codeänderungen und Sitzungsaufzeichnungen erzeugen"]
  G --> I
  H --> I
```
