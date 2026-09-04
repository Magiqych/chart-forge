"""Chart Forge Analyzer.

Turns an audio file into an Analysis document: guide information about what happens in
the music and when. It does not produce charts - see README.md and
../docs/architecture.md for the boundary this component must not cross.

`__version__` is the version of this implementation. It is NOT the version of the
Analysis document format, which is declared separately in document.py as
ANALYSIS_VERSION.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
