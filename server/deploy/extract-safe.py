#!/usr/bin/env python3
"""Extract a verified release into a NEW directory without archive traversal."""
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def extract(source, destination):
    root = Path(destination)
    root.mkdir(mode=0o755, parents=False, exist_ok=False)
    with tarfile.open(source, "r:gz") as archive:
        members = archive.getmembers()
        seen = set()
        links = set()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or "\\" in member.name or ":" in member.name or "\x00" in member.name:
                raise ValueError("Unsafe archive path")
            normalized = str(name)
            if normalized == ".":
                if not member.isdir():
                    raise ValueError("Invalid root entry")
                continue
            if normalized in seen or not (member.isdir() or member.isfile() or member.issym()):
                raise ValueError("Duplicate or unsupported archive entry")
            seen.add(normalized)
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or "\\" in member.linkname or "\x00" in member.linkname:
                    raise ValueError("Unsafe symlink")
                resolved = os.path.abspath(root / name.parent / member.linkname)
                if os.path.commonpath([str(root.resolve()), resolved]) != str(root.resolve()):
                    raise ValueError("Escaping symlink")
                links.add(normalized)
        for name in seen:
            if any(str(parent) in links for parent in PurePosixPath(name).parents):
                raise ValueError("Archive writes through a symlink")
        total_bytes = sum(member.size for member in members if member.isfile())
        if shutil.disk_usage(root).free < total_bytes * 1.2 + 64 * 1024 * 1024:
            raise ValueError("Insufficient disk space to extract the release")
        for member in members:
            if member.issym() or str(PurePosixPath(member.name)) == ".":
                continue
            target = root / member.name
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with archive.extractfile(member) as stream, target.open("xb") as output:
                    shutil.copyfileobj(stream, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        for member in members:
            if member.issym():
                target = root / member.name
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
        for name in links:
            resolved = (root / name).resolve()
            if root.resolve() not in resolved.parents and resolved != root.resolve():
                raise ValueError("Escaping symlink chain")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract-safe.py archive.tar.gz NEW-directory")
    extract(sys.argv[1], sys.argv[2])
