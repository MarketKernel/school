"""Shared helpers for the tools of the English materials: paths, .env loading and the word list."""

import os
import re
from pathlib import Path

HERE = Path(__file__).parent
FOLDER = HERE.parent  # lessons/english: data/, audio/, images/
WORDS_FILE = FOLDER / "data" / "words.tsv"


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


def slug(word: str) -> str:
    """File name for a word: «T-shirt» → «t-shirt», «ice cream» → «ice-cream».
    Same as slug() in ../words.mjs and tools/review.html."""
    return re.sub(r"[^a-z0-9]+", "-", word.lower()).strip("-")


def read_words(path: Path = WORDS_FILE) -> "list[dict]":
    """Reads words.tsv: topic, word, translation, picture description, other accepted answers."""
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:  # the first line is the header
        if not line.strip():
            continue
        topic, word, ru, picture, *rest = line.split("\t") + [""]
        rows.append({"topic": topic.strip(), "word": word.strip(), "ru": ru.strip(),
                     "picture": picture.strip(), "slug": slug(word)})
    return rows


def pick(rows: "list[dict]", limit: "int | None", only: "set[str]") -> "list[dict]":
    """Narrows the list: --only words (or topics) and --limit N."""
    if only:
        rows = [r for r in rows if r["word"] in only or r["topic"] in only]
    return rows[:limit] if limit else rows
