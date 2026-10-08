"""Prepares the riddles for voicing: splits data/source.txt into riddles and annotates them for Yandex SpeechKit.

Splitting is done here, by the text's own format: the lines of a riddle are followed by its answer in parentheses
«(Молния)»; a line starting with «Загадки» outside a riddle is a section title. OpenAI (OPENAI_API_KEY from the
environment or the .env file at the repo root) cleans each riddle up — joined verse lines, typos, «ё» — and writes
the text for the speech synthesizer with SpeechKit TTS markup: «+» before a stressed vowel, pauses «<[small]>».

Output: data/riddles.json — a list of riddles in source order:
    id         file name for the future sound (answer in latin letters: «Дни недели» → dni-nedeli)
    section    section title from the source
    lines      riddle text by verse lines, as shown on screen
    answer     the answer
    tts        riddle text with the markup, for SpeechKit
    fixes      what the model changed compared to the source — check these by eye
    source     the riddle as it is in source.txt (to notice when it changes)

Riddles already in riddles.json are kept as they are (they may be fixed by hand), unless their source text changed.

Usage:
    python3 prepare.py --dry-run            # show the split, without requests
    python3 prepare.py --limit 3            # the first 3 — to check the result
    python3 prepare.py                      # everything that's missing or changed
    python3 prepare.py --redo molniya,klyuch    # redo these riddles (by id)
    python3 prepare.py --force              # redo everything
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).parent
FOLDER = HERE.parent  # lessons/riddles
SOURCE = FOLDER / "data" / "source.txt"
OUT = FOLDER / "data" / "riddles.json"
sys.path.insert(0, str(FOLDER.parent / "russian" / "tools"))
from speak import TRANSLIT, load_envs  # noqa: E402 — shared helpers live next to the sounds

API_URL = "https://api.openai.com/v1/chat/completions"
WORKERS = 4

DEFAULTS = {
    "OPENAI_TEXT_MODEL": "gpt-5.5",
}

# Instructions for the model (data, so in Russian). SpeechKit markup: https://aistudio.yandex.ru/docs/ru/speechkit/tts/markup/tts-markup
PROMPT = """Ты готовишь детские загадки к озвучке синтезатором речи Yandex SpeechKit: голос читает загадку ребёнку 6–8 лет, ребёнок угадывает ответ.
Тебе дают одну загадку и её ответ так, как они записаны в исходнике.

Верни поля:

lines — текст загадки по строкам стиха, как его покажут на экране.
Слова не меняй, не добавляй и не переставляй. Можно только:
- разбить строку, если в исходнике две строки стиха слиты в одну («Белый камешек растаял, На доске следы оставил.» → две строки; вторая строка с маленькой буквы, если это не начало предложения);
- исправить явную опечатку («сеяю» → «сияю»);
- поставить «ё» там, где она произносится («пришел» → «пришёл»);
- заменить дефис или короткое тире между словами на «—», кавычки — на «ёлочки».
Многоточие в конце, где ребёнок должен досказать ответ в рифму, оставь как «…»; лишние знаки вроде «…?» сократи до «…».

answer — ответ с заглавной буквы, без скобок, с «ё» («Берёза», «Гадкий утёнок»).

tts — тот же текст (с твоими исправлениями) для синтезатора, одной строкой, строки стиха соединены пробелом. Разметка:
- «+» перед ударной гласной: «з+амок», «зам+ок». Ставь ударение в каждом слове, где синтезатор может ошибиться: омографы (м+уку / мук+у, в+олны / волн+ы, ст+оит / сто+ит), редкие и устаревшие слова, имена сказочных героев, слова с ударением, сдвинутым ради рифмы или размера. В очевидных словах ударение не ставь. Перед «ё» не ставь — «ё» всегда ударная.
- «<[small]>» в конце строки стиха, если строка не кончается знаком препинания (запятые, точки, тире синтезатор сам читает как паузы).
- Больше никакой разметки: без «**», «sil<[…]>», «[[…]]» и SSML.

fixes — короткий список по-русски, что ты изменил по сравнению с исходником («сеяю» → «сияю»; «пришел» → «пришёл»; разбил строку «…» на две). Пустой список, если ничего."""

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {"type": "array", "items": {"type": "string"}},
        "answer": {"type": "string"},
        "tts": {"type": "string"},
        "fixes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["lines", "answer", "tts", "fixes"],
    "additionalProperties": False,
}

SLUG = {**TRANSLIT, "ь": "", "ъ": ""}  # «Дождь» → «dozhd», not the letter names speak.py uses for «ь»


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def slug(answer: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", "".join(SLUG.get(ch, ch) for ch in answer.lower())).strip("-")


def split_source(text: str) -> "list[dict]":
    """Riddles from source.txt: lines up to an «(answer)» line; «Загадки …» between riddles is a section title."""
    riddles, lines, section = [], [], ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        answer = re.fullmatch(r"\((.+)\)", line)
        if answer:
            if not lines:
                sys.exit(f"Ответ «{line}» без загадки перед ним")
            riddles.append({"section": section, "text": "\n".join(lines), "answer": answer.group(1).strip()})
            lines = []
        elif not lines and line.startswith("Загадки"):
            section = line
        else:
            lines.append(line)
    if lines:
        sys.exit("В конце source.txt текст без ответа в скобках:\n" + "\n".join(lines))
    seen: "dict[str, int]" = {}
    for riddle in riddles:
        base = slug(riddle["answer"])
        seen[base] = seen.get(base, 0) + 1
        riddle["id"] = base if seen[base] == 1 else f"{base}-{seen[base]}"
        riddle["source"] = f"{riddle['text']}\n({riddle['answer']})"
    return riddles


def words(text: str) -> "list[str]":
    """Words only, to compare texts: lower case, «ё» = «е», no markup or punctuation."""
    text = re.sub(r"<\[[^\]]*\]>|sil<\[\d+\]>", " ", text).replace("+", "")
    return re.findall(r"[а-яa-z0-9-]+", text.lower().replace("ё", "е"))


def check(riddle: dict, result: dict) -> "list[str]":
    """Warnings about the model's answer that are worth a look."""
    warnings = []
    if words(" ".join(result["lines"])) != words(riddle["text"]):
        warnings.append("слова в lines отличаются от исходника")
    if words(result["tts"]) != words(" ".join(result["lines"])):
        warnings.append("слова в tts отличаются от lines")
    if words(result["answer"]) != words(riddle["answer"]):
        warnings.append("ответ отличается от исходника")
    if re.search(r"\*\*|\[\[|sil<|<speak|\n", result["tts"]):
        warnings.append("в tts лишняя разметка")
    return warnings


def annotate(riddle: dict, api_key: str) -> dict:
    body = {
        "model": setting("OPENAI_TEXT_MODEL"),
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": f"Загадка:\n{riddle['text']}\n\nОтвет: {riddle['answer']}"},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "riddle", "strict": True, "schema": SCHEMA}},
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                message = json.load(response)["choices"][0]["message"]
                if message.get("refusal"):
                    raise RuntimeError(f"модель отказалась: {message['refusal']}")
                return json.loads(message["content"])
        except urllib.error.HTTPError as e:
            # 429 — rate limit, 5xx — OpenAI failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(15 * (attempt + 1))
                continue
            raise RuntimeError(f"OpenAI вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e
    raise RuntimeError("OpenAI не ответил")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="подготовить только первые N загадок")
    parser.add_argument("--force", action="store_true", help="подготовить заново все загадки")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="подготовить заново эти загадки, id через запятую")
    parser.add_argument("--dry-run", action="store_true", help="показать разбивку, без запросов")
    args = parser.parse_args()

    every = split_source(SOURCE.read_text(encoding="utf-8"))
    riddles = every[:args.limit] if args.limit else every
    old = {r["id"]: r for r in json.loads(OUT.read_text(encoding="utf-8"))} if OUT.exists() else {}
    unknown = args.redo - {r["id"] for r in every}
    if unknown:
        sys.exit(f"Нет таких загадок: {', '.join(sorted(unknown))}")
    todo = [r for r in riddles if args.force or r["id"] in args.redo
            or r["id"] not in old or old[r["id"]].get("source") != r["source"]]

    print(f"Модель: {setting('OPENAI_TEXT_MODEL')}. Загадок: {len(riddles)}, подготовить: {len(todo)}")
    if args.dry_run:
        section = None
        for r in riddles:
            if r["section"] != section:
                section = r["section"]
                print(f"\n{section or '(без раздела)'}")
            mark = "*" if r in todo else " "
            print(f"  {mark} {r['id']:<20} {r['answer']}  ({r['text'].count(chr(10)) + 1} стр.)")
        print("\n* — будет отправлено в OpenAI")
        return

    load_envs()
    api_key = os.environ.get("OPENAI_API_KEY") or sys.exit("Нет ключа: впишите OPENAI_API_KEY в .env")

    done, failed = {}, []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(annotate, r, api_key): r for r in todo}
        for n, future in enumerate(as_completed(futures), 1):
            riddle = futures[future]
            try:
                result = future.result()
            except Exception as e:
                failed.append(riddle["id"])
                print(f"  [{n}/{len(todo)}] {riddle['id']} — ОШИБКА: {e}")
                continue
            done[riddle["id"]] = {"id": riddle["id"], "section": riddle["section"], **result,
                                  "source": riddle["source"]}
            warnings = check(riddle, result)
            print(f"  [{n}/{len(todo)}] {riddle['id']}" + (f" — проверьте: {'; '.join(warnings)}" if warnings else ""))
            for fix in result["fixes"]:
                print(f"        {fix}")

    # Source order; a riddle that failed now (or is beyond --limit) keeps its previous version, if there was one
    out = [done.get(r["id"]) or old[r["id"]] for r in every if r["id"] in done or r["id"] in old]
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Готово: {len(out)} загадок в {OUT.relative_to(FOLDER.parent.parent)}, "
          f"ошибок: {len(failed)} {failed or ''}")


if __name__ == "__main__":
    main()
