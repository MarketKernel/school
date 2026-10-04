# 🐷 Собери слово

Игра для тех, кто учится читать по слогам. Ребёнок слышит слово, собирает его из карточек-слогов и букв и строит три домика из сказки «Три поросёнка»:

| Уровень | Слова |
|---|---|
| 🌾 Соломенный домик | из 2–3 карточек: «до-мик» |
| 🪵 Домик из веток | из 4 карточек |
| 🧱 Каменный дом | из 5 карточек и больше |

Слова и картинки взяты из одного текста сказки ([data/text1.txt](data/text1.txt)).

Урок работает на общем движке [read-game](../read-game) — там описано, как устроена игра. Звуки букв и слогов — общие для всех уроков чтения, они лежат в [lessons/russian](../russian).

## Что где лежит

| Файл / папка | Что это |
|---|---|
| `lesson.json` | название, иконка, раздел на главной и команда сборки |
| `game.json` | домики, тексты окон, конфетти и стиль картинок — поля описаны в [read-game/README.md](../read-game/README.md) |
| `data/text1.txt` | сказка — источник всех слов |
| `data/words.txt` | слова сказки по частоте |
| `data/words_split.txt` | слова, разбитые на слоги: `поросенок → по-ро-се-но-к` |
| `data/pictures.tsv` | к каким словам рисовать картинку и что на ней |
| `images/`, `images.json` | **готовые картинки** к словам |

## Собрать и посмотреть

```bash
(cd ../read-game/game && npm install)               # один раз — TypeScript
node ../read-game/game/build_scripts/build.mjs .    # → build/
open build/index.html                               # открывается и двойным кликом, без сервера
```

## Как сделать всё заново или для другого текста

Команды даны из папки урока.

```bash
python3 ../read-game/tools/words.py data/text1.txt -o data/words.txt   # слова по частоте
python3 ../russian/tools/syllables.py       # → data/words_split.txt и общий список слогов
python3 ../russian/tools/speak.py --dry-run # каких звуков не хватает
python3 ../russian/tools/speak.py           # озвучить только недостающие
python3 ../read-game/tools/draw.py read-syllables --limit 3   # первые 3 картинки — проверить стиль
python3 ../read-game/tools/draw.py read-syllables             # нарисовать всё, чего ещё нет
```

Слог здесь — пара «согласная + гласная» (ма, ви, де). Остальное (одиночные гласные, согласные без гласной) в игре показывается отдельными буквами.

> ⚠️ **Не перегенерируйте звуки целиком без нужды.** Каждый звук подбирали на слух, многие записаны своим голосом (`../russian/audio/recorded.json`). Подробно про озвучку, свой голос и проверку на слух — в [lessons/russian/README.md](../russian/README.md).

Картинки рисует OpenAI Images по `data/pictures.tsv`; общий стиль — `pictureStyle` в `game.json`. Проверить и пометить неудачные — `read-game/tools/pictures.html?lesson=read-syllables`, см. [read-game/README.md](../read-game/README.md#картинки).
