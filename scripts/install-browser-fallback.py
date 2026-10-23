#!/usr/bin/env python3
"""Use the official Chrome for Testing mirror if Playwright's CDN is unavailable."""
import json
import os
from pathlib import Path
import stat
import sys
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[1]
registry = json.loads((root / "node_modules/playwright-core/browsers.json").read_text())
version = next(item["browserVersion"] for item in registry["browsers"] if item["name"] == "chromium")
destination = root / ".cache/chrome-for-testing"
destination.mkdir(parents=True, exist_ok=True)
archive = destination / "chrome.zip"
url = "https://storage.googleapis.com/chrome-for-testing-public/" + version + "/linux64/chrome-linux64.zip"
with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
    if not response.headers.get("Content-Type", "").startswith(("application/zip", "application/octet-stream")):
        raise RuntimeError("Official browser mirror returned a non-ZIP response")
    while chunk := response.read(1024 * 1024):
        output.write(chunk)
with zipfile.ZipFile(archive) as zipped:
    for entry in zipped.infolist():
        resolved = (destination / entry.filename).resolve()
        if not resolved.is_relative_to(destination.resolve()):
            raise RuntimeError("Unexpected ZIP member")
    zipped.extractall(destination)
    for entry in zipped.infolist():
        mode = entry.external_attr >> 16
        if mode:
            (destination / entry.filename).chmod(stat.S_IMODE(mode))
archive.unlink()
executable = destination / "chrome-linux64/chrome"
if not os.access(executable, os.X_OK):
    executable.chmod(0o755)
if os.environ.get("GITHUB_ENV"):
    with open(os.environ["GITHUB_ENV"], "a") as env_file:
        env_file.write("CHROMIUM_EXECUTABLE_PATH=" + str(executable) + "\n")
print(str(executable))
