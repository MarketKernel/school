"""Voices the riddles from data/riddles.json with Yandex SpeechKit (API v1).

Reads the "tts" field (riddle text with SpeechKit markup, made by prepare.py). Answers are not voiced:
kids type them in.
Key: YANDEX_API_KEY (a service account API key) from the environment or the .env file at the repo root.
Settings: YANDEX_VOICE, YANDEX_EMOTION, YANDEX_SPEED (see DEFAULTS).

Output: audio/<id>.mp3 — one file per riddle.

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed (needs lame: brew install lame).

Usage:
    python3 voice.py --dry-run                  # show what would be voiced, without requests
    python3 voice.py --limit 1                  # the first riddle — to check the voice
    python3 voice.py                            # everything that's missing
    python3 voice.py --redo molniya,klyuch      # re-voice these riddles (by id)
    python3 voice.py --force                    # re-voice everything
    python3 voice.py --limit 1 --compare filipp,ermil,alena,jane
        # the same riddle in several voices → compare/<voice>/ (git-ignored), audio/ is not touched
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).parent
FOLDER = HERE.parent  # lessons/riddles
RIDDLES = FOLDER / "data" / "riddles.json"
AUDIO = FOLDER / "audio"
COMPARE = FOLDER / "compare"
sys.path.insert(0, str(FOLDER.parent / "russian" / "tools"))
from speak import load_envs, normalize  # noqa: E402 — shared helpers live next to the sounds

API_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize"
WORKERS = 4

DEFAULTS = {
    "YANDEX_VOICE": "filipp",   # API v1 voices: filipp, ermil, zahar, alena, jane, marina, omazh
    "YANDEX_EMOTION": "good",   # neutral / good (not every voice has it; see the SpeechKit voice list)
    "YANDEX_SPEED": "0.9",      # 0.1–3.0; a bit slower than normal for kids
}


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def synthesize(text: str, voice: str, api_key: str) -> bytes:
    data = {"text": text, "lang": "ru-RU", "voice": voice, "emotion": setting("YANDEX_EMOTION"),
            "speed": setting("YANDEX_SPEED"), "format": "mp3"}
    request = urllib.request.Request(API_URL, data=urllib.parse.urlencode(data).encode("utf-8"),
                                     headers={"Authorization": f"Api-Key {api_key}"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            # 429 — rate limit, 5xx — SpeechKit failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"SpeechKit вернул {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e
    raise RuntimeError("SpeechKit не ответил")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="озвучить только первые N загадок")
    parser.add_argument("--force", action="store_true", help="переозвучить всё")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить эти загадки, id через запятую")
    parser.add_argument("--compare", type=lambda v: v.split(","),
                        help="голоса через запятую: озвучить каждым в compare/<голос>/, audio/ не трогать")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет озвучено, без запросов")
    args = parser.parse_args()

    riddles = json.loads(RIDDLES.read_text(encoding="utf-8"))
    unknown = args.redo - {r["id"] for r in riddles}
    if unknown:
        sys.exit(f"Нет таких загадок: {', '.join(sorted(unknown))}")
    if args.redo:
        riddles = [r for r in riddles if r["id"] in args.redo]
    if args.limit:
        riddles = riddles[:args.limit]

    # A job is (text, voice, file); comparing writes every voice into its own folder
    voices = args.compare or [setting("YANDEX_VOICE")]
    jobs = []
    for voice in voices:
        out = COMPARE / voice if args.compare else AUDIO
        for r in riddles:
            file = out / f"{r['id']}.mp3"
            if args.compare or args.force or args.redo or not file.exists():
                jobs.append((r["tts"], voice, file))

    print(f"Голос: {', '.join(voices)}, эмоция: {setting('YANDEX_EMOTION')}, скорость: {setting('YANDEX_SPEED')}. "
          f"Загадок: {len(riddles)}, файлов озвучить: {len(jobs)}, "
          f"символов: {sum(len(text) for text, _, _ in jobs)}")
    if args.dry_run:
        for text, voice, file in jobs:
            print(f"  {file.relative_to(FOLDER)}  {text}")
        return

    load_envs()
    api_key = os.environ.get("YANDEX_API_KEY") or sys.exit("Нет ключа: впишите YANDEX_API_KEY в .env")
    can_normalize = shutil.which("lame") is not None
    if not can_normalize:
        print("  lame не найден — громкость не выравниваем (brew install lame)")

    def work(job):
        text, voice, file = job
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(synthesize(text, voice, api_key))
        if can_normalize:
            normalize(file)

    failed = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(work, job): job[2] for job in jobs}
        for n, future in enumerate(as_completed(futures), 1):
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
