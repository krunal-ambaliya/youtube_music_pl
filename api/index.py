import os
import sys
from pathlib import Path

# Add project root to sys.path so app and static assets can be resolved
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Mark environment as Vercel serverless (uses /tmp/downloads)
os.environ["VERCEL"] = "1"

# Import the FastAPI application instance
from app import app
