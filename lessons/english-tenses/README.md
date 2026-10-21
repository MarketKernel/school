# ⏳ Английский: времена

Общая папка для уроков про английские времена: 100 глаголов, каждый — в предложении про «вчера», «сейчас» и «завтра», с переводом и озвучкой. Это не урок — на главной её нет.

| Урок | Что делаем |
|---|---|
| [⏳ Вчера, сейчас или завтра?](../english-tenses-listen) | слушаем предложение и выбираем, когда это было |
| [🔁 Скажи вчера и завтра](../english-tenses-say) | говорим предложение в другом времени, браузер проверяет |

Для детей взяты три времени, которые легче всего услышать и различить:

| | Время | Пример | Как узнать |
|---|---|---|---|
| ⏪ Вчера | Past Simple | I **played** football. / I **went** to the park. | окончание «-ed» или особая форма глагола |
| 🟢 Сейчас | Present Continuous | I **am playing** football. | am / is / are + «-ing» |
| ⏩ Завтра | Future Simple | I **will play** football. | will |

Present Simple («I play football every day») не взят: его легко спутать с «сейчас», а для детей важнее сначала услышать разницу между вчера, сейчас и завтра.

## Что где лежит

| Файл / папка | Что это |
|---|---|
| `data/topics.tsv` | темы: `regular` — 🧱 глаголы с «-ed» (50), `irregular` — 🎩 особые глаголы (50) |
| `data/sentences.tsv` | тема, предложение «вчера», «сейчас», «завтра», те же три по-русски |
| `audio/` | **готовые звуки**: `i-played-football.mp3`, `i-am-playing-football.mp3`, `i-will-play-football.mp3`… |
| `tools/speak.py` | озвучка предложений (ElevenLabs или OpenAI) |
| `tools/review.html` | послушать все предложения и пометить неудачные звуки |
| `shared.json` | помечает папку общей: корневая сборка публикует только `audio/` |

Код игры здесь не лежит: уроки времён собираются движком [lessons/english-phrases](../english-phrases) (режимы `tenses-listen` и `tenses-say`). Глагол попадает в игру, только если озвучены все три его предложения.

## Добавить глаголы

1. Допишите строку в `data/sentences.tsv`: подлежащее и остальные слова во всех трёх предложениях одинаковые, меняется только глагол. Глагол «сейчас» должен быть действием, которое может идти прямо сейчас: «is playing», а не «is liking».
2. `python3 tools/speak.py --dry-run`, потом `python3 tools/speak.py`: озвучится только то, чего ещё нет.
3. Послушайте в `tools/review.html` и пересоберите уроки (`npm run build` в корне).

## Озвучка

Тот же голос, что у английских слов и фраз: ElevenLabs, Sarah, `eleven_multilingual_v2`, настройки `EN_`. `tools/speak.py` использует код `../english/tools/speak.py`. Ключ — `ELEVENLABS_API_KEY` в `.env`.

```bash
python3 tools/speak.py --dry-run                   # что будет озвучено и сколько символов
python3 tools/speak.py                             # озвучить всё, чего нет
python3 tools/speak.py --redo i-played-football    # переозвучить (по имени файла)
python3 -m http.server 8000                        # → http://localhost:8000/tools/review.html
```
