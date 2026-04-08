from __future__ import annotations

from pathlib import Path

from cli import main


if __name__ == "__main__":
    data_path = Path(__file__).resolve().parent.parent / "data" / "vgsales.csv"
    raise SystemExit(
        main(
            [
                "--dataset",
                str(data_path),
                "--goal",
                "Summarize the main patterns in the dataset.",
            ]
        )
    )
