"""Voices the phrases from data/phrases.tsv with ElevenLabs or OpenAI Text-to-Speech:
the English phrases into audio/<slug>.mp3 and, with --ru, their Russian translations into audio/ru/<slug>.mp3.

English: same voice and settings as the English words (lessons/english/tools/speak.py, whose code this reuses):
EN_TTS_PROVIDER, EN_ELEVENLABS_VOICE, EN_ELEVENLABS_MODEL…
Russian (--ru): the voice of the reading lessons (lessons/russian/tools/speak.py): TTS_PROVIDER, ELEVENLABS_VOICE
(Olga Orlova), PHRASES_RU_MODEL (eleven_flash_v2_5), OPENAI_TTS_VOICE.
Keys — ELEVENLABS_API_KEY / OPENAI_API_KEY — come from the environment or from the .env file at the repo root
(template: .env.example next to it).

A phrase is named by the slug of its English text: «How are you?» → how-are-you.mp3. --only and --redo take
slugs (phrases themselves contain commas) or topic keys.

Usage:
    python3 speak.py --dry-run                  # what would be voiced and how many characters, without requests
    python3 speak.py --limit 5                  # first 5 phrases — to check the voice
    python3 speak.py                            # voice everything that's missing
    python3 speak.py --only greetings,food      # only these topics (or phrases)
    python3 speak.py --redo how-are-you,thank-you   # re-voice these phrases
    python3 speak.py --force                    # re-voice everything
    python3 speak.py --ru --dry-run             # the same for the Russian translations: --ru with any option
    python3 speak.py --ru --limit 5 --model eleven_multilingual_v2 --out compare/ru-v2   # try another model

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed (needs lame).
"""

import argparse
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FOLDER = HERE.parent  # lessons/english-phrases: data/, audio/
PHRASES_FILE = FOLDER / "data" / "phrases.tsv"
ENGLISH_TOOLS = FOLDER.parent / "english" / "tools"

# The TTS code of the English words: lessons/english/tools/speak.py and its common.py
sys.path.append(str(ENGLISH_TOOLS))
_spec = importlib.util.spec_from_file_location("english_speak", ENGLISH_TOOLS / "speak.py")
en = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(en)
from common import load_envs, slug  # noqa: E402 — lessons/english/tools/common.py

# Russian voice defaults: the same voice as the letters and syllables of the reading lessons
RU_DEFAULTS = {
    "TTS_PROVIDER": "elevenlabs",
    "ELEVENLABS_VOICE": "d60rsXo2p0OwikDR5bS7",  # Olga Orlova
    "PHRASES_RU_MODEL": "eleven_flash_v2_5",
    "OPENAI_TTS_VOICE": "nova",
}
RU_INSTRUCTIONS = (
    "You are voicing Russian phrases for a young child. Say the phrase in Russian clearly and a little slowly, "
    "in a warm, friendly voice, with correct Russian stress and natural intonation. Say it once and add nothing else."
)

INSTRUCTIONS = (
    "You are voicing phrases for a young child who is learning English. "
    "Say the phrase clearly and a little slowly, in a warm, friendly voice, with a standard American accent, "
    "with natural intonation. Say it once and add nothing else."
)


def read_phrases(path: Path = PHRASES_FILE) -> "list[dict]":
    """Reads phrases.tsv: topic, phrase, translation, other translations, other English variants."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:  # the first line is the header
        if not line.strip():
            continue
        topic, phrase, ru, *_ = line.split("\t") + ["", ""]
        rows.append({"topic": topic.strip(), "phrase": phrase.strip(), "ru": ru.strip(), "slug": slug(phrase)})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ru", action="store_true", help="озвучить русские переводы (в audio/ru/), а не английские фразы")
    parser.add_argument("--out", type=Path, help="папка для звуков (по умолчанию audio/ или audio/ru/)")
    parser.add_argument("--model", help="модель ElevenLabs вместо настройки — сравнить на нескольких фразах с --out compare/…")
    parser.add_argument("--limit", type=int, help="озвучить только первые N")
    parser.add_argument("--only", type=lambda v: set(v.split(",")), default=set(),
                        help="только эти темы или фразы (имена файлов), через запятую: greetings,how-are-you")
    parser.add_argument("--force", action="store_true", help="перезаписать готовые файлы")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить только эти фразы (имена файлов), через запятую: how-are-you,thank-you")
    parser.add_argument("--provider", choices=list(en.API_KEYS), help="сервис озвучки (по умолчанию из EN_TTS_PROVIDER)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять в сервис")
    args = parser.parse_args()

    load_envs()
    ru_setting = lambda name: os.environ.get(name) or RU_DEFAULTS[name]
    provider = args.provider or (ru_setting("TTS_PROVIDER") if args.ru else en.setting("EN_TTS_PROVIDER"))
    out = args.out or (FOLDER / "audio" / "ru" if args.ru else FOLDER / "audio")
    text = "ru" if args.ru else "phrase"
    if args.ru:
        voice = {"language": "ru", "eleven_voice": ru_setting("ELEVENLABS_VOICE"),
                 "eleven_model": args.model or ru_setting("PHRASES_RU_MODEL"), "openai_voice": ru_setting("OPENAI_TTS_VOICE")}
        label = (f"ElevenLabs, модель: {voice['eleven_model']}, голос: {voice['eleven_voice']}" if provider == "elevenlabs"
                 else f"OpenAI, голос: {voice['openai_voice']}")
    else:
        voice = {"eleven_model": args.model} if args.model else {}
        label = en.provider_label(provider) + (f" → модель {args.model}" if args.model else "")
    key_name = en.API_KEYS.get(provider) or sys.exit(f"Неизвестный EN_TTS_PROVIDER: {provider}. Можно: {', '.join(en.API_KEYS)}")
    api_key = os.environ.get(key_name, "")
    if not api_key and not args.dry_run:
        sys.exit(f"Нет ключа: впишите {key_name} в .env в корне репозитория (пример — .env.example)")

    rows = read_phrases()
    names = {r["slug"] for r in rows} | {r["topic"] for r in rows}
    unknown = (args.only | args.redo) - names
    if unknown:
        sys.exit(f"Нет таких тем или фраз: {', '.join(sorted(unknown))}. Фразу называйте по имени файла: how-are-you")
    wanted = args.only | args.redo
    if wanted:
        rows = [r for r in rows if r["slug"] in wanted or r["topic"] in wanted]
    rows = rows[:args.limit] if args.limit else rows

    todo = [r for r in rows
            if args.force or r["slug"] in args.redo or r["topic"] in args.redo
            or not (out / f"{r['slug']}.mp3").exists()]

    print(("Русские переводы. " if args.ru else "") + label)
    print(f"Фраз: {len(rows)}, озвучить: {len(todo)} ({sum(len(r[text]) for r in todo)} символов), "
          f"уже готово: {len(rows) - len(todo)}")
    if args.dry_run:
        for r in todo:
            print(f"  {r[text]} -> {out.name}/{r['slug']}.mp3")
        return

    failed = en.voice_all([(r["slug"], r[text], out / f"{r['slug']}.mp3") for r in todo],
                          provider, api_key, RU_INSTRUCTIONS if args.ru else INSTRUCTIONS, **voice)
    print(f"Готово: озвучено {len(todo) - len(failed)}, ошибок: {len(failed)}"
          + (f". Повторить: python3 tools/speak.py {'--ru ' if args.ru else ''}--redo {','.join(failed)}" if failed else ""))


if __name__ == "__main__":
    main()
