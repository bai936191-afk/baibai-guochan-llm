<div align="center">

[![简体中文](https://img.shields.io/badge/🇨🇳_简体中文-Available-green)](blueprint.zh-CN.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](blueprint.en.md)
[![繁體中文](https://img.shields.io/badge/🇹🇼_繁體中文-Available-green)](blueprint.zh-TW.md)
[![日本語](https://img.shields.io/badge/🇯🇵_日本語-Available-green)](blueprint.ja.md)
[![한국어](https://img.shields.io/badge/🇰🇷_한국어-Available-green)](blueprint.ko.md)
[![Español](https://img.shields.io/badge/🇪🇸_Español-当前-blue)](blueprint.es.md)
[![Français](https://img.shields.io/badge/🇫🇷_Français-Available-green)](blueprint.fr.md)
[![Deutsch](https://img.shields.io/badge/🇩🇪_Deutsch-Available-green)](blueprint.de.md)

</div>

# Diagrama de Producto / Español

Diagrama de flujo del producto para Baibai Guochan LLM.

```mermaid
flowchart TD
  A["El usuario abre la app de escritorio"] --> B["Introducir la clave de API"]
  B --> C["Obtener modelos disponibles del servidor"]
  C --> D["Seleccionar modelo, intensidad de razonamiento y modo de permisos"]
  D --> E["Entrar en la sesión del proyecto"]
  E --> F["Leer / buscar / editar código"]
  E --> G["Ejecutar comandos e invocar herramientas"]
  E --> H["Búsqueda web y captura de páginas"]
  F --> I["Generar respuestas, cambios de código y registros de sesión"]
  G --> I
  H --> I
```
