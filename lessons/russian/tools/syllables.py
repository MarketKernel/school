"""Splits the words of every reading lesson into syllables and counts how often each syllable occurs.

Reading lessons are the ones whose lesson.json lists "uses": ["russian"]. Their words are data/words.txt
("count<TAB>word" or one word per line) or, without it, the words of data/pictures.tsv — the same rule as
the engine build (lessons/read-game/game/build_scripts/build.mjs). A lesson whose game.json names a shared
word folder ("words": "potter") takes them from that folder; a folder shared by several lessons counts once.

A syllable is a consonant + vowel pair (ма, ви, де…). Other letters
(single vowels, consonants without a following vowel) are shown separately
in the split but are not counted as syllables:
    увидев -> у-ви-де-в   (syllables: ви, де)

Output:
    <words folder>/data/words_split.txt — the words of every lesson or shared word folder split into parts
    russian/data/syllables.txt      — syllables of all lessons by frequency; tools/speak.py voices them

Usage:
    python3 syllables.py
"""

import argparse
import json
from collections import Counter
from pathlib import Path

FOLDER = Path(__file__).parent.parent  # lessons/russian
LESSONS = FOLDER.parent

VOWELS = set("аеёиоуыэюя")
SIGNS = set("ьъ")  # neither vowels nor consonants — attach to the previous part


def is_consonant(ch: str) -> bool:
    return ch.isalpha() and ch not in VOWELS and ch not in SIGNS


def split_word(word: str) -> list[str]:
    """Splits a word into parts: consonant + vowel pairs and single letters."""
    parts = []
    i = 0
    while i < len(word):
        ch = word[i]
        nxt = word[i + 1] if i + 1 < len(word) else ""
        if is_consonant(ch) and nxt in VOWELS:
            parts.append(ch + nxt)
            i += 2
            continue
        if ch in SIGNS and parts:
            parts[-1] += ch
        elif ch != "-":
            parts.append(ch)
        i += 1
    return parts


def is_syllable(part: str) -> bool:
    return len(part) == 2 and is_consonant(part[0]) and part[1] in VOWELS


def reading_lessons() -> list[Path]:
    """Lesson folders that take their sounds from lessons/russian."""
    found = []
    for meta in sorted(LESSONS.glob("*/lesson.json")):
        if FOLDER.name in json.loads(meta.read_text(encoding="utf-8")).get("uses", []):
            found.append(meta.parent)
    return found


def word_folders() -> list[Path]:
    """Folders with the words of the reading lessons: the lesson itself or the shared folder from its game.json."""
    found = []
    for lesson in reading_lessons():
        game = lesson / "game.json"
        shared = json.loads(game.read_text(encoding="utf-8")).get("words") if game.exists() else None
        folder = LESSONS / shared if shared else lesson
        if folder not in found:
            found.append(folder)
    return found


def read_words(folder: Path) -> list[str]:
    """Words in lower case: data/words.txt or, without it, the words of data/pictures.tsv."""
    words_file, pictures = folder / "data" / "words.txt", folder / "data" / "pictures.tsv"
    if words_file.exists():
        cells = [line.split("\t")[-1] for line in words_file.read_text(encoding="utf-8").splitlines()]
    elif pictures.exists():
        cells = [(line.split("\t") + ["", ""])[1] for line in pictures.read_text(encoding="utf-8").splitlines()[1:]]
    else:
        raise SystemExit(f"{folder.name}: нет ни data/words.txt, ни data/pictures.tsv")
    return list(dict.fromkeys(c.strip().lower() for c in cells if c.strip()))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.parse_args()

    counts = Counter()
    for folder in word_folders():
        words = read_words(folder)
        split_lines = []
        folder_syllables = set()
        for word in words:
            parts = split_word(word)
            split_lines.append(f"{word}\t{'-'.join(parts)}")
            counts.update(p for p in parts if is_syllable(p))
            folder_syllables.update(p for p in parts if is_syllable(p))
        (folder / "data" / "words_split.txt").write_text("\n".join(split_lines) + "\n", encoding="utf-8")
        print(f"{folder.name}: слов {len(words)}, слогов {len(folder_syllables)} → {folder.name}/data/words_split.txt")

    # Most frequent syllables first, ties broken alphabetically
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    out = FOLDER / "data" / "syllables.txt"
    out.write_text("\n".join(f"{n}\t{s}" for s, n in ranked) + "\n", encoding="utf-8")
    print(f"Всего уникальных слогов: {len(counts)} → {out.relative_to(LESSONS)}")
    print("Озвучить недостающие: python3 tools/speak.py --dry-run, затем без --dry-run")


if __name__ == "__main__":
    main()
