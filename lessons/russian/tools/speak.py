"""Voices syllables and letters with ElevenLabs or OpenAI Text-to-Speech.

The service is chosen by the TTS_PROVIDER setting (elevenlabs or openai), elevenlabs by default.
Keys — ELEVENLABS_API_KEY / OPENAI_API_KEY — come from the environment or from the .env file
at the repo root (template: .env.example next to it).

Output:
    audio/syllables/po.mp3, …   audio/syllables.json  — syllable -> file
    audio/letters/m.mp3, …      audio/letters.json    — letter -> file
    audio/soft/tmyagkij.mp3, …  audio/soft.json       — soft consonants «ть», «ль»… -> file

Letters are voiced as sounds (like in a primer): «м» is «ммм», not «эм».

Usage:
    python3 speak.py                     # syllables and letters (existing files are skipped)
    python3 speak.py --only letters      # letters only
    python3 speak.py --only soft         # soft consonants only («ть», «ль»…)
    python3 speak.py --only syllables --limit 3   # first 3 syllables — to check the voice
    python3 speak.py --force             # overwrite existing files
    python3 speak.py --redo сё,шо,ж      # re-voice only these syllables/letters
    python3 speak.py --dry-run           # show what would be done, without requests
    python3 speak.py --normalize         # boost volume and trim silence of existing files
    python3 speak.py --provider openai   # use the other service

The sounds are shared by every reading lesson: syllables come from data/syllables.txt, which tools/syllables.py
collects from the words of all of them. Paths are relative to lessons/russian; the script can be run from any directory.

Sounds recorded with one's own voice via record.html are marked in audio/recorded.json:
--force skips them; they can only be re-voiced explicitly via --redo.

Volume: every new file is normalized to a −1 dBFS peak and edge silence is trimmed.
This needs lame: brew install lame (without it files stay as the service returned them).
"""

import argparse
import array
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).parent
FOLDER = HERE.parent  # shared folder lessons/russian: data/, audio/
OPENAI_URL = "https://api.openai.com/v1/audio/speech"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"
WORKERS = {"openai": 4, "elevenlabs": 2}  # how many requests to send in parallel

TARGET_PEAK_DB = -1.0   # peak level to normalize to
SILENCE_DB = -40.0      # quieter than this (relative to peak) counts as edge silence
EDGE_MARGIN = 0.05      # seconds of silence to keep before and after the sound
QUIET_DB = -40.0        # a source peak below this means the file is most likely empty
RETRIES_ON_EMPTY = 4    # how many times to re-request when the service returns silence

# Defaults — override here or in .env
DEFAULTS = {
    "TTS_PROVIDER": "elevenlabs",
    "OPENAI_TTS_MODEL": "gpt-4o-mini-tts",
    "OPENAI_TTS_VOICE": "nova",
    # A native-speaker voice from the ElevenLabs library. Flash v2.5 sticks to Russian
    # (Multilingual v2 drifts into English pronunciation on short syllables)
    "ELEVENLABS_MODEL": "eleven_flash_v2_5",
    "ELEVENLABS_VOICE": "d60rsXo2p0OwikDR5bS7",  # Olga Orlova — a clear, calm Russian voice
    # Consonant letters: v2 reads a lone «С.» as the English "C" and «ссс» as «с-с-с».
    # Flash v2.5 sticks to Russian and gives a clean Russian sound for «С.».
    "ELEVENLABS_CONSONANT_MODEL": "eleven_flash_v2_5",
    "ELEVENLABS_CONSONANT_SUFFIX": "ъ",  # «Бъ.» — the sound without the letter name («бэ»)
    "ELEVENLABS_SOFT_MODEL": "eleven_flash_v2_5",  # model for soft consonants «ть», «ль»…
}

# Letters and soft consonants whose ElevenLabs text and model were picked by ear.
# The text is sent exactly as written: no capitalization or trailing period is added.
ELEVENLABS_SOFT_OVERRIDES = {
    "ть": ("Ть.", "eleven_flash_v2_5"),
    "ль": ("ль", "eleven_flash_v2_5"),
    "сь": ("Сь.", "eleven_flash_v2_5"),
    "нь": ("нь", "eleven_flash_v2_5"),
    "рь": ("рь", "eleven_multilingual_v2"),
}
ELEVENLABS_LETTER_OVERRIDES = {
    "с": ("С.", "eleven_flash_v2_5"),
    "й": ("Йь.", "eleven_flash_v2_5"),  # «Йъ.» sounds like «я»
    "р": ("Ррр.", "eleven_flash_v2_5"),
    "л": ("Лыъ.", "eleven_flash_v2_5"),  # «Л.», «Ллл.», «Лъ.» all sound wrong; temporary
    "ё": ("Ё.", "eleven_multilingual_v2"),
    "э": ("Э.", "eleven_multilingual_v2"),
}
API_KEYS = {"openai": "OPENAI_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}

SYLLABLE_INSTRUCTIONS = (
    "Ты озвучиваешь слоги для ребёнка, который учится читать по-русски. "
    "Произнеси слог слитно, как один звук-слог, чётко, спокойно и чуть медленно. "
    "Не называй буквы по отдельности и ничего не добавляй."
)

SOFT_INSTRUCTIONS = (
    "Ты учишь ребёнка читать по-русски звуковым методом, как в букваре. "
    "Произнеси только мягкий согласный звук [{c}'] — как в конце слова, без гласной после него. "
    "Не называй буквы и не говори «мягкий знак». Один раз, чётко и спокойно."
)

LETTER_INSTRUCTIONS = (
    "Ты учишь ребёнка читать по-русски звуковым методом, как в букваре. "
    "Произнеси только звук буквы, а не её название. {hint} "
    "Произнеси один раз, чётко и спокойно, ничего не добавляй."
)

VOWELS = "аеёиоуыэюя"
CONTINUANTS = "вжзлмнрсфхшщй"  # consonants that can be drawn out: «ммм», «ссс»
STOPS = "бгдкптцч"              # short consonants that can't be drawn out
SOFTABLE = "бвгдзклмнпрстфх"    # consonants that have a soft pair: «ть», «ль»…

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "j", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "tverdyj", "ы": "y", "ь": "myagkij", "э": "eh", "ю": "yu", "я": "ya",
}


def letter_job(letter: str) -> tuple[str, str]:
    """Returns (text to speak, hint for the model) for a single letter."""
    if letter in VOWELS:
        return letter, f"Это гласная — протяни звук «{letter}» чуть дольше обычного."
    if letter in CONTINUANTS:
        return letter * 3, (f"Это согласная — протяни только звук [{letter}] без гласной после него, "
                            f"не говори «{letter}э» или «э{letter}».")
    if letter in STOPS:
        return letter, (f"Это согласная — коротко произнеси только звук [{letter}] без гласной после него, "
                        f"не говори «{letter}э» и не называй букву.")
    if letter == "ь":
        return "мягкий знак", "Это буква без звука — просто скажи её название: «мягкий знак»."
    if letter == "ъ":
        return "твёрдый знак", "Это буква без звука — просто скажи её название: «твёрдый знак»."
    raise ValueError(letter)


def load_env(path: Path):
    """Loads variables from .env without overriding ones already set in the environment."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if value[:1] in "\"'" and value[:1] and value.count(value[0]) >= 2:
            value = value[1:value.index(value[0], 1)]  # quoted value — take it verbatim
        else:
            value = value.split(" #", 1)[0].strip()  # strip a trailing comment
        os.environ.setdefault(key.strip(), value)


def load_envs():
    """Looks for .env next to the script and in every parent folder — usually it's at the repo root.
    If there are several, the one closest to the script wins."""
    for folder in [HERE, *HERE.resolve().parents]:
        load_env(folder / ".env")


def setting(name: str) -> str:
    return os.environ.get(name) or DEFAULTS[name]


def translit(text: str) -> str:
    return "".join(TRANSLIT.get(ch, ch) for ch in text.lower())


def read_syllables(path: Path) -> list[str]:
    """Reads syllables.txt (format "count<TAB>syllable")."""
    return [line.split("\t")[-1].strip()
            for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def provider_label(provider: str) -> str:
    if provider == "elevenlabs":
        return f"ElevenLabs, модель: {setting('ELEVENLABS_MODEL')}, голос: {setting('ELEVENLABS_VOICE')}"
    return f"OpenAI, модель: {setting('OPENAI_TTS_MODEL')}, голос: {setting('OPENAI_TTS_VOICE')}"


def synthesize(text: str, instructions: str, provider: str, api_key: str, model: "str | None" = None,
               verbatim: bool = False) -> bytes:
    if provider == "elevenlabs":
        # ElevenLabs has no text instructions — the model only gets the text itself.
        # On a bare «ле» or «жжж» v3 often returns silence; «Ле.» / «Жжж.» work reliably.
        url = ELEVENLABS_URL.format(voice=setting("ELEVENLABS_VOICE"))
        if not verbatim:
            text = text[:1].upper() + text[1:]
            if text[-1] not in ".!?…":
                text += "."
        body = {"text": text, "model_id": model or setting("ELEVENLABS_MODEL"), "language_code": "ru"}
        headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    else:
        url = OPENAI_URL
        body = {
            "model": setting("OPENAI_TTS_MODEL"),
            "voice": setting("OPENAI_TTS_VOICE"),
            "input": text,
            "response_format": "mp3",
        }
        # instructions are supported only by gpt-4o-mini-tts and newer; tts-1 ignores them
        if not body["model"].startswith("tts-1"):
            body["instructions"] = instructions
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            # 429 — rate limited, 5xx — service failure: wait and retry
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"{provider} вернул {e.code}: {e.read().decode('utf-8', 'replace')}") from e


def normalize(file: Path) -> float:
    """Normalizes the peak to TARGET_PEAK_DB and trims edge silence.
    Returns the source file's peak in dBFS (used to detect empty files)."""
    with tempfile.TemporaryDirectory() as tmp:
        raw, out = Path(tmp) / "raw.wav", Path(tmp) / "out.wav"
        subprocess.run(["lame", "--quiet", "--decode", str(file), str(raw)], check=True, stderr=subprocess.DEVNULL)
        with wave.open(str(raw)) as w:
            channels, rate = w.getnchannels(), w.getframerate()
            samples = array.array("h", w.readframes(w.getnframes()))
        if channels != 1:
            samples = samples[::channels]  # TTS returns mono; take one channel just in case

        peak = max((abs(x) for x in samples), default=0)
        peak_db = 20 * math.log10(max(peak, 1) / 32768)
        if peak_db < QUIET_DB:
            return peak_db  # leave an empty file alone — it needs to be re-voiced

        threshold = peak * 10 ** (SILENCE_DB / 20)
        loud = [i for i, x in enumerate(samples) if abs(x) >= threshold]
        margin = int(EDGE_MARGIN * rate)
        samples = samples[max(0, loud[0] - margin):loud[-1] + margin]

        gain = 32767 * 10 ** (TARGET_PEAK_DB / 20) / peak
        samples = array.array("h", (max(-32768, min(32767, round(x * gain))) for x in samples))

        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(samples.tobytes())
        subprocess.run(["lame", "--quiet", "-m", "m", "-b", "96", str(out), str(file)], check=True)
    return peak_db


def normalize_all(kind: str, out_dir: Path):
    files = sorted((out_dir / kind).glob("*.mp3"))
    print(f"\n== {kind}: нормализуем {len(files)} файлов")
    with ThreadPoolExecutor(os.cpu_count() or 4) as pool:
        peaks = dict(zip(files, pool.map(normalize, files)))
    quiet = [f.name for f, db in peaks.items() if db < QUIET_DB]
    if quiet:
        print(f"  Пустые файлы (переозвучьте через --redo): {', '.join(quiet)}")


def build_jobs(kind: str, syllables_file: Path, limit: "int | None",
               provider: str) -> "list[tuple[str, str, str, str | None, bool]]":
    """List of (item being voiced, text for the model, instructions, model or None for the default,
    send text verbatim)."""
    eleven = provider == "elevenlabs"
    if kind == "syllables":
        items = read_syllables(syllables_file)
        jobs = [(s, s, SYLLABLE_INSTRUCTIONS, None, False) for s in items]
    elif kind == "soft":
        jobs = []
        for c in SOFTABLE:
            item, hint = c + "ь", SOFT_INSTRUCTIONS.format(c=c)
            if eleven and item in ELEVENLABS_SOFT_OVERRIDES:
                text, model = ELEVENLABS_SOFT_OVERRIDES[item]
                jobs.append((item, text, hint, model, True))
            else:
                jobs.append((item, item, hint, setting("ELEVENLABS_SOFT_MODEL") if eleven else None, False))
    else:
        alphabet = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
        jobs = []
        for letter in alphabet:
            text, hint = letter_job(letter)
            model, verbatim = None, False
            if eleven and letter in ELEVENLABS_LETTER_OVERRIDES:
                (text, model), verbatim = ELEVENLABS_LETTER_OVERRIDES[letter], True
            elif eleven and letter in CONTINUANTS + STOPS:
                text = letter + setting("ELEVENLABS_CONSONANT_SUFFIX")
                model = setting("ELEVENLABS_CONSONANT_MODEL")  # «С.» on Flash v2.5
            jobs.append((letter, text, LETTER_INSTRUCTIONS.format(hint=hint), model, verbatim))
    return jobs[:limit] if limit else jobs


def run(kind: str, args, api_key: str):
    provider = args.provider
    jobs = build_jobs(kind, args.file, args.limit, provider)
    folder = args.out / kind
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / f"{kind}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    # Leave self-recorded sounds (record.html) alone unless explicitly requested via --redo
    recorded_path = args.out / "recorded.json"
    recorded = json.loads(recorded_path.read_text(encoding="utf-8")) if recorded_path.exists() else {}

    todo = []
    for item, text, instructions, model, verbatim in jobs:
        file = folder / f"{translit(item)}.mp3"
        manifest[item] = file.relative_to(args.out).as_posix()
        if item in recorded and item not in args.redo and file.exists():
            continue
        if args.force or item in args.redo or not file.exists():
            todo.append((item, text, instructions, model, verbatim, file))

    print(f"\n== {kind}: всего {len(jobs)}, озвучить {len(todo)}, уже готово {len(jobs) - len(todo)}")
    if args.dry_run:
        for item, text, _, model, _, file in todo:
            print(f"  {item} («{text}»{', ' + model if model else ''}) -> {file.relative_to(args.out)}")
        return

    can_normalize = shutil.which("lame") is not None
    if not can_normalize:
        print("  lame не найден — громкость не выравниваем (brew install lame)")

    def work(job):
        item, text, instructions, model, verbatim, file = job
        # On short text the service sometimes returns an empty file or silence — ask again
        for _ in range(RETRIES_ON_EMPTY):
            file.write_bytes(synthesize(text, instructions, provider, api_key, model, verbatim))
            try:
                if file.stat().st_size and (not can_normalize or normalize(file) >= QUIET_DB):
                    return item
            except subprocess.CalledProcessError:
                pass  # lame couldn't read the response — corrupt file
        file.unlink(missing_ok=True)
        raise RuntimeError(f"{RETRIES_ON_EMPTY} раза пришла тишина или битый файл — попробуйте позже: --redo {item}")

    failed = []
    with ThreadPoolExecutor(WORKERS[provider]) as pool:
        futures = {pool.submit(work, job): job[0] for job in todo}
        for n, future in enumerate(as_completed(futures), 1):
            item = futures[future]
            try:
                future.result()
                print(f"  [{n}/{len(todo)}] {item}")
            except Exception as e:
                failed.append(item)
                print(f"  [{n}/{len(todo)}] {item} — ОШИБКА: {e}")

    # The manifest lists only files that actually exist on disk
    manifest = {k: v for k, v in manifest.items() if (args.out / v).exists()}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Готово: {len(manifest)} файлов, ошибок: {len(failed)} {failed or ''}. Список: {manifest_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", nargs="?", default=FOLDER / "data" / "syllables.txt", type=Path, help="файл со слогами")
    parser.add_argument("--only", choices=["syllables", "letters", "soft"],
                        help="озвучить только слоги, буквы или мягкие согласные")
    parser.add_argument("--out", type=Path, default=FOLDER / "audio", help="папка для звуков")
    parser.add_argument("--limit", type=int, help="озвучить только первые N")
    parser.add_argument("--force", action="store_true", help="перезаписать готовые файлы")
    parser.add_argument("--redo", type=lambda v: set(v.split(",")), default=set(),
                        help="переозвучить только эти слоги/буквы, через запятую: сё,шо,ж")
    parser.add_argument("--provider", choices=list(API_KEYS), help="сервис озвучки (по умолчанию из TTS_PROVIDER)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не отправлять в сервис")
    parser.add_argument("--normalize", action="store_true",
                        help="только выровнять громкость готовых файлов (без запросов в сервис)")
    args = parser.parse_args()
    kinds = [args.only] if args.only else ["syllables", "letters", "soft"]

    if args.normalize:
        if not shutil.which("lame"):
            sys.exit("Нужен lame: brew install lame")
        for kind in kinds:
            normalize_all(kind, args.out)
        return

    load_envs()
    args.provider = args.provider or setting("TTS_PROVIDER")
    key_name = API_KEYS.get(args.provider)
    if not key_name:
        sys.exit(f"Неизвестный TTS_PROVIDER: {args.provider}. Можно: {', '.join(API_KEYS)}")
    api_key = os.environ.get(key_name, "")
    if not api_key and not args.dry_run:
        sys.exit(f"Нет ключа: впишите {key_name} в .env в корне репозитория (пример — .env.example)")

    print(provider_label(args.provider))
    for kind in kinds:
        run(kind, args, api_key)


if __name__ == "__main__":
    main()
