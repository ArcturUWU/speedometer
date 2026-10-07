# Fonts

The interface self-hosts **Roboto Condensed Regular (400)**, by the Roboto Project Authors, for Latin and Cyrillic text. The unmodified Google Fonts WOFF2 files are bundled so the app does not need to contact a font service at runtime.

- Official family source: https://github.com/google/fonts/tree/main/ofl/robotocondensed
- Google Fonts CSS used to obtain the static 400 subsets: https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400&display=swap
- License: SIL Open Font License 1.1, included in [`web/fonts/OFL.txt`](../web/fonts/OFL.txt).
- License source: https://raw.githubusercontent.com/google/fonts/main/ofl/robotocondensed/OFL.txt
- Retrieved: 2026-10-07.

## Bundled files

| Local file | Source | SHA-256 |
| --- | --- | --- |
| `web/fonts/RobotoCondensed-Regular.woff2` | https://fonts.gstatic.com/s/robotocondensed/v31/ieVo2ZhZI2eCN5jzbjEETS9weq8-_d6T_POl0fRJeyWyosBO5Xw.woff2 | `543c03fff71d1b39590af102e0852c2dbce46f4dbe4faaebafbef6edc82e78f5` |
| `web/fonts/RobotoCondensed-Cyrillic.woff2` | https://fonts.gstatic.com/s/robotocondensed/v31/ieVo2ZhZI2eCN5jzbjEETS9weq8-_d6T_POl0fRJeyWyosBK5XxxKA.woff2 | `c4afc8bd4b1886495a93a274e179a27962732a83176b79f7109608f2d08cb94a` |

Both files have a valid `wOF2` signature and identify themselves as Roboto Condensed / Regular, `OS/2.usWeightClass = 400`. They are static font files; declare `font-weight: 400` for each face.

## Subset declarations

Google Fonts supplies these Unicode ranges for the downloaded subsets:

```css
/* Cyrillic */
unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;

/* Latin */
unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
```

No proprietary Lamborghini font is included.
