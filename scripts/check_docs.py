#!/usr/bin/env python3
"""Check local Markdown destinations and duplicate declared story IDs.

Supports inline links/images and full, collapsed, or defined shortcut references.
Fenced code, inline code, external URLs, and heading anchors are not checked.
This is a small repository check, not a full CommonMark or language validator.
"""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit


IGNORED_DIRS = {".git", ".local", ".venv", "__pycache__", "node_modules", "dist", "build"}
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
INLINE_CODE = re.compile(r"(`+).*?\1")
STORY_ID = re.compile(r"^Story ID:\s*([A-Z][A-Z0-9]*-\d{3})\s*$")
REFERENCE = re.compile(r"^ {0,3}\[([^\]]+)\]:\s*(.*)$")
INLINE_LINK = re.compile(r"!?\[[^\]\n]*\]\(")
REFERENCE_LINK = re.compile(r"!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?")


@dataclass
class CheckResult:
    files_checked: int
    errors: list[str]


def prose_lines(text: str) -> list[str]:
    """Blank supported code examples while retaining source line numbers."""
    text = re.sub(r"<!--.*?-->", lambda m: "\n" * m[0].count("\n"), text, flags=re.S)
    lines = []
    fence_char = ""
    fence_length = 0
    for line in text.splitlines():
        match = FENCE.match(line)
        if fence_char:
            if match and match[1][0] == fence_char and len(match[1]) >= fence_length and not match[2].strip():
                fence_char = ""
            lines.append("")
        elif match:
            fence_char, fence_length = match[1][0], len(match[1])
            lines.append("")
        else:
            # Spaces preserve positions and prevent code from becoming a link target.
            lines.append(INLINE_CODE.sub(lambda m: " " * len(m[0]), line))
    return lines


def destination(text: str, start: int = 0) -> str:
    """Read an angle-wrapped or balanced bare Markdown destination."""
    text = text[start:].lstrip()
    if text.startswith("<"):
        end = text.find(">", 1)
        return text[1:end] if end != -1 else ""
    result = []
    depth = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            result.append(text[index + 1])
            index += 2
            continue
        if char.isspace() or (char == ")" and depth == 0):
            break
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        result.append(char)
        index += 1
    return "".join(result)


def reference_key(label: str) -> str:
    return " ".join(label.split()).casefold()


def markdown_files(root: Path):
    for directory, dirs, names in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in IGNORED_DIRS)
        for name in sorted(names):
            if name.lower().endswith(".md"):
                yield Path(directory) / name


def check_repository(root: Path) -> CheckResult:
    root = root.resolve()
    errors: list[str] = []
    declarations: dict[str, str] = {}
    files = list(markdown_files(root))
    if not files:
        return CheckResult(0, ["No Markdown files found; nothing was validated."])

    for path in files:
        relative = path.relative_to(root).as_posix()
        try:
            lines = prose_lines(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as error:
            errors.append(f"{relative}: cannot read Markdown: {error}")
            continue
        references: dict[str, tuple[str, int]] = {}
        definition_lines = set()

        def check_target(target: str, line_number: int):
            if not target or target.startswith(("#", "//")):
                return
            try:
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc:
                    return
                decoded = unquote(parsed.path)
                if not decoded:
                    return
                resolved = (root / decoded.lstrip("/") if decoded.startswith("/") else path.parent / decoded).resolve()
                if not resolved.is_relative_to(root):
                    errors.append(f"{relative}:{line_number}: local link leaves repository: {target}")
                elif not resolved.exists():
                    errors.append(f"{relative}:{line_number}: missing local destination: {target}")
            except (ValueError, OSError) as error:
                errors.append(f"{relative}:{line_number}: invalid local destination {target!r}: {error}")

        for number, line in enumerate(lines, 1):
            story = STORY_ID.fullmatch(line)
            if story:
                identifier = story[1]
                location = f"{relative}:{number}"
                if identifier in declarations:
                    errors.append(f"{location}: duplicate story ID {identifier}; first declared at {declarations[identifier]}")
                else:
                    declarations[identifier] = location
            definition = REFERENCE.match(line)
            if definition:
                target = destination(definition[2])
                references[reference_key(definition[1])] = (target, number)
                definition_lines.add(number)
                check_target(target, number)

        for number, line in enumerate(lines, 1):
            if number in definition_lines:
                continue
            for match in INLINE_LINK.finditer(line):
                check_target(destination(line, match.end()), number)
            for match in REFERENCE_LINK.finditer(line):
                if line[match.end():].startswith("("):
                    continue
                explicit = match[2] is not None
                label = reference_key(match[2] or match[1])
                if label in references:
                    # Destinations were checked at the definition, once per definition.
                    continue
                if explicit:
                    errors.append(f"{relative}:{number}: undefined Markdown reference: {label}")

    return CheckResult(len(files), errors)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error(f"not a directory: {args.root}")
    result = check_repository(args.root)
    if result.errors:
        for error in result.errors:
            print(error)
        print(f"FAIL: {len(result.errors)} issue(s) in {result.files_checked} Markdown files.")
        return 1
    print(f"PASS: {result.files_checked} Markdown files; local destinations resolve and declared story IDs are unique.")
    print("Not checked: remote URLs, heading anchors, prose quality, or application behavior.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
