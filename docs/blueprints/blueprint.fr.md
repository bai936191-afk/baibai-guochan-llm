<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-Available-green)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-Available-green)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-Available-green)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-当前-blue)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-Available-green)](blueprint.de.md)

</div>

# Diagramme de Produit / Français

Diagramme de flux du produit pour Baibai Guochan LLM.

```mermaid
flowchart TD
  A["L'utilisateur ouvre l'application de bureau"] --> B["Saisir la clé API"]
  B --> C["Récupérer les modèles disponibles depuis le serveur"]
  C --> D["Choisir le modèle, l'intensité de raisonnement et le mode d'autorisation"]
  D --> E["Entrer dans la session de projet"]
  E --> F["Lire / rechercher / éditer le code"]
  E --> G["Exécuter des commandes et appeler des outils"]
  E --> H["Recherche web et récupération de pages"]
  F --> I["Générer des réponses, des modifications de code et des enregistrements de session"]
  G --> I
  H --> I
```
