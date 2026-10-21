"""Voices the English sentences from data/sentences.tsv (each verb as «yesterday / now / tomorrow»)
with ElevenLabs or OpenAI Text-to-Speech into audio/<slug>.mp3.

Same voice and settings as the English words and phrases (lessons/english/tools/speak.py, whose code this
reuses): EN_TTS_PROVIDER, EN_ELEVENLABS_VOICE, EN_ELEVENLABS_MODEL… The key — ELEVENLABS_API_KEY or
OPENAI_API_KEY — comes from the environment or from the .env file at the repo root (template: .env.example).

A sentence is named by its slug: «I played football.» → audio/i-played-football.mp3. --only and --redo take
slugs or topic keys (regular, irregular).

Usage:
    python3 speak.py --dry-run                       # what would be voiced and how many characters
    python3 speak.py --limit 6                       # first 6 sentences — to check the voice
    python3 speak.py                                 # voice everything that's missing
    python3 speak.py --redo i-played-football        # re-voice these sentences
"""

import argparse
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FOLDER = HERE.parent  # lessons/english-tenses: data/, audio/
SENTENCES_FILE = FOLDER / "data" / "sentences.tsv"
ENGLISH_TOOLS = FOLDER.parent / "english" / "tools"
TENSES = ("past", "now", "future")  # columns 2–4 of sentences.tsv

# The TTS code of the English words: lessons/english/tools/speak.py and its common.py
sys.path.append(str(ENGLISH_TOOLS))
_spec = importlib.util.spec_from_file_location("english_speak", ENGLISH_TOOLS / "speak.py")
en = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(en)
from common import load_envs, slug  # noqa: E402 — lessons/english/tools/common.py

INSTRUCTIONS = (
    "You are voicing short sentences for a young child who is learning English tenses. "
    "Say the sentence clearly and a little slowly, in a warm, friendly voice, with a standard American accent; "
    "pronounce the verb ending and «will» distinctly. Say it once and add nothing else."
)


def read_sentences(path: Path = SENTENCES_FILE) -> "list[dict]":
    """Reads sentences.tsv: topic, three English forms, three Russian ones; one row per English sentence."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:  # the first line is the header
        if not line.strip():
            continue
        topic, *forms = [cell.strip() for cell in line.split("\t")]
        for tense, text in zip(TENSES, forms[:3]):
            rows.append({"topic": topic, "tense": tense, "text": text, "slug": slug(text)})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="озвучить только первые N")
    parser.add_argument("--only", type=lambda v: set(v.split(",")), default=set(),
                        help="только эти темы или предложения (имена файлов), через запятую")
    parser.add_argument("--force", action="store_true", help="перезаписать готовые файлы")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить только эти предложения (имена файлов), через запятую")
    parser.add_argument("--provider", choices=list(en.API_KEYS), help="сервис озвучки (по умолчанию из EN_TTS_PROVIDER)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять в сервис")
    args = parser.parse_args()

    load_envs()
    provider = args.provider or en.setting("EN_TTS_PROVIDER")
    key_name = en.API_KEYS.get(provider) or sys.exit(f"Неизвестный EN_TTS_PROVIDER: {provider}. Можно: {', '.join(en.API_KEYS)}")
    api_key = os.environ.get(key_name, "")
    if not api_key and not args.dry_run:
        sys.exit(f"Нет ключа: впишите {key_name} в .env в корне репозитория (пример — .env.example)")

    rows = read_sentences()
    wanted = args.only | args.redo
    unknown = wanted - {r["slug"] for r in rows} - {r["topic"] for r in rows}
    if unknown:
        sys.exit(f"Нет таких тем или предложений: {', '.join(sorted(unknown))}. Называйте по имени файла: i-played-football")
    if wanted:
        rows = [r for r in rows if r["slug"] in wanted or r["topic"] in wanted]
    rows = rows[:args.limit] if args.limit else rows

    out = FOLDER / "audio"
    todo = [r for r in rows
            if args.force or r["slug"] in args.redo or r["topic"] in args.redo or not (out / f"{r['slug']}.mp3").exists()]
    print(en.provider_label(provider))
    print(f"Предложений: {len(rows)}, озвучить: {len(todo)} ({sum(len(r['text']) for r in todo)} символов), "
          f"уже готово: {len(rows) - len(todo)}")
    if args.dry_run:
        for r in todo:
            print(f"  {r['text']} -> audio/{r['slug']}.mp3")
        return

    failed = en.voice_all([(r["slug"], r["text"], out / f"{r['slug']}.mp3") for r in todo], provider, api_key, INSTRUCTIONS)
    print(f"Готово: озвучено {len(todo) - len(failed)}, ошибок: {len(failed)}"
          + (f". Повторить: python3 tools/speak.py --redo {','.join(failed)}" if failed else ""))


if __name__ == "__main__":
    main()
