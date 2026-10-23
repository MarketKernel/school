"""Voices the reward texts from data/pairs.json with ElevenLabs.

The child reads the short "read" sentence aloud; the "reward" text is the prize and is voiced here.
An optional "tts" field replaces "reward" for the voice (how to pronounce «/e dance» and the like).
«+» before a stressed vowel becomes an acute accent after it («Р+облокс» → «Ро́блокс»), unless --plain:
fix a wrong stress in "tts" and run --redo <id>.
ElevenLabs: ELEVENLABS_API_KEY; voice ROBLOX_ELEVENLABS_VOICE (by default the Russian voice of the reading
lessons, ELEVENLABS_VOICE, Olga Orlova), model ROBLOX_ELEVENLABS_MODEL. Keys and settings come from
the environment or the .env file at the repo root.

Output: audio/<id>.mp3 — one file per pair.

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed (needs lame: brew install lame).

Usage:
    python3 voice.py --dry-run                  # show what would be voiced, without requests
    python3 voice.py --limit 2                  # the first two texts — to check the voice
    python3 voice.py                            # everything that's missing
    python3 voice.py --redo 004,037             # re-voice these texts (by id)
    python3 voice.py --force                    # re-voice everything
    python3 voice.py --redo 004 --compare eleven_flash_v2_5,eleven_multilingual_v2
        # the same text with several models → compare/<model>/ (git-ignored), audio/ is not touched
    python3 voice.py --redo 004 --voices kwajW3Xh5svCeKU5ky2S,MWyJiWDobXN8FX3CJTdE
        # the same text with several voices (Voice Library ids) → compare/<voice id>/
"""

import argparse
import json
import os
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).parent
FOLDER = HERE.parent  # lessons/read-roblox
PAIRS = FOLDER / "data" / "pairs.json"
AUDIO = FOLDER / "audio"
COMPARE = FOLDER / "compare"
sys.path.insert(0, str(FOLDER.parent / "russian" / "tools"))
import speak as russian  # noqa: E402 — shared helpers and the ElevenLabs voice live next to the letter sounds

WORKERS = 2
VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
DEFAULTS = {"ROBLOX_ELEVENLABS_MODEL": "eleven_multilingual_v2"}  # long texts sound more natural than with flash


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def default_voice() -> str:
    return os.environ.get("ROBLOX_ELEVENLABS_VOICE") or russian.setting("ELEVENLABS_VOICE")


def voice_text(pair: dict, plain: bool = False) -> str:
    """The text to voice: "tts" or "reward", «+а» → «а́» (or the «+» just goes with plain)."""
    text = pair.get("tts") or pair["reward"]
    return re.sub(f"\\+([{VOWELS}])", lambda m: m.group(1) if plain else m.group(1) + "́", text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="озвучить только первые N текстов")
    parser.add_argument("--force", action="store_true", help="переозвучить всё")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить эти тексты, id через запятую")
    parser.add_argument("--compare", type=lambda v: v.split(","),
                        help="модели ElevenLabs через запятую: озвучить каждой в compare/<модель>/, audio/ не трогать")
    parser.add_argument("--voices", type=lambda v: v.split(","),
                        help="id голосов ElevenLabs через запятую: озвучить каждым в compare/<id>/, audio/ не трогать")
    parser.add_argument("--plain", action="store_true", help="без знаков ударения")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет озвучено, без запросов")
    args = parser.parse_args()

    russian.load_envs()
    pairs = json.loads(PAIRS.read_text(encoding="utf-8"))
    unknown = args.redo - {p["id"] for p in pairs}
    if unknown:
        sys.exit(f"Нет таких пар: {', '.join(sorted(unknown))}")
    if args.redo:
        pairs = [p for p in pairs if p["id"] in args.redo]
    if args.limit:
        pairs = pairs[:args.limit]

    # A job is (text, model, voice, file); comparing writes every model or voice into its own folder
    models = args.compare or [setting("ROBLOX_ELEVENLABS_MODEL")]
    voices = args.voices or [default_voice()]
    comparing = bool(args.compare or args.voices)
    jobs = []
    for voice in voices:
        for model in models:
            name = "-".join(([voice] if args.voices else []) + ([model] if args.compare else []))
            out = COMPARE / (name + ("-plain" if args.plain else "")) if comparing else AUDIO
            for p in pairs:
                file = out / f"{p['id']}.mp3"
                if comparing or args.force or args.redo or not file.exists():
                    jobs.append((voice_text(p, args.plain), model, voice, file))

    print(f"ElevenLabs, голос: {', '.join(voices)}, модель: {', '.join(models)}"
          + (", без ударений" if args.plain else "") + ".", end=" ")
    print(f"Пар: {len(pairs)}, файлов озвучить: {len(jobs)}, символов: {sum(len(job[0]) for job in jobs)}")
    if args.dry_run:
        for text, _, _, file in jobs:
            print(f"  {file.relative_to(FOLDER)}  {text}")
        return

    api_key = os.environ.get("ELEVENLABS_API_KEY") or sys.exit("Нет ключа: впишите ELEVENLABS_API_KEY в .env")
    can_normalize = shutil.which("lame") is not None
    if not can_normalize:
        print("  lame не найден — громкость не выравниваем (brew install lame)")

    def work(job):
        text, model, _, file = job
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(russian.synthesize(text, "", "elevenlabs", api_key, model=model, verbatim=True))
        if can_normalize:
            russian.normalize(file)

    failed, n = [], 0
    for voice in voices:
        # russian.synthesize takes the voice from ELEVENLABS_VOICE, so each voice gets its own pool
        os.environ["ELEVENLABS_VOICE"] = voice
        with ThreadPoolExecutor(WORKERS) as pool:
            futures = {pool.submit(work, job): job[3] for job in jobs if job[2] == voice}
            for future in as_completed(futures):
                n += 1
                name = futures[future].relative_to(FOLDER)
                try:
                    future.result()
                    print(f"  [{n}/{len(jobs)}] {name}")
                except Exception as e:
                    failed.append(str(name))
                    print(f"  [{n}/{len(jobs)}] {name} — ОШИБКА: {e}")
    print(f"Готово: {len(jobs) - len(failed)} файлов, ошибок: {len(failed)} {failed or ''}")


if __name__ == "__main__":
    main()
