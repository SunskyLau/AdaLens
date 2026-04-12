"""
CSV delimiter detection helpers shared by backend dataset loading.
"""

from __future__ import annotations

import csv
from collections import Counter

CSV_DELIMITER_CANDIDATES = [",", ";", "\t", "|"]
CSV_DELIMITER_FALLBACK = ","
CSV_SNIFF_SAMPLE_CHARS = 16384


def _count_delimiters_outside_quotes(text: str, delimiter: str) -> list[int]:
    counts: list[int] = []
    in_quotes = False
    count = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            if in_quotes and i + 1 < len(text) and text[i + 1] == '"':
                i += 2
                continue
            in_quotes = not in_quotes
            i += 1
            continue
        if not in_quotes and ch == delimiter:
            count += 1
            i += 1
            continue
        if not in_quotes and ch in {"\n", "\r"}:
            if count > 0:
                counts.append(count)
            count = 0
            if ch == "\r" and i + 1 < len(text) and text[i + 1] == "\n":
                i += 2
                continue
        i += 1
    if count > 0:
        counts.append(count)
    return counts


def sniff_csv_delimiter_from_text(text: str) -> str:
    sample = (text or "")[:CSV_SNIFF_SAMPLE_CHARS]
    if not sample.strip():
        return CSV_DELIMITER_FALLBACK

    try:
        dialect = csv.Sniffer().sniff(sample, delimiters="".join(CSV_DELIMITER_CANDIDATES))
        delimiter = getattr(dialect, "delimiter", CSV_DELIMITER_FALLBACK)
        if delimiter in CSV_DELIMITER_CANDIDATES:
            return delimiter
    except csv.Error:
        pass

    best_delimiter = CSV_DELIMITER_FALLBACK
    best_score = (-1, -1, -1)
    for delimiter in CSV_DELIMITER_CANDIDATES:
        counts = _count_delimiters_outside_quotes(sample, delimiter)
        if not counts:
            continue
        dominant = Counter(counts).most_common(1)[0][1]
        score = (dominant, len(counts), sum(counts))
        if score > best_score:
            best_score = score
            best_delimiter = delimiter
    return best_delimiter
