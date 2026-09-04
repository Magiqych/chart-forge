"""Allows `python -m analyzer <audio-file> --output-dir <directory>`."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
