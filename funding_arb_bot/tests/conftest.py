import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1].parent
ROOT_STR = str(ROOT)
if ROOT_STR not in sys.path:
    sys.path.insert(0, ROOT_STR)
