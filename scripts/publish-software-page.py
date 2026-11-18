"""Publish only the A-Border SEO product page and its verified Windows download."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from html.parser import HTMLParser
from pathlib import Path


PUBLIC = Path("/www/wwwroot/aborder/backend/public/software")
PAGE = "seo/index.html"
PUBLISH_CONFIG = Path(__file__).resolve().parent / "private" / "website-publish.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def installer_path(version):
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}", version):
        raise ValueError("Expected a release version such as 1.5.6")
    return f"releases/a-border-seo/{version}/A-Border-SEO-Setup-{version}-x64.exe"


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = set()

    def handle_starttag(self, tag, attrs):
        self.urls.update(value for name, value in attrs if name in {"href", "src"} and value)


def asset_name(name):
    return re.fullmatch(r"assets/seo-[a-z0-9-]+\.[0-9a-f]{8,64}\.(?:css|svg|png|webp|woff2)", name)


def release_files(folder, version):
    exe = installer_path(version)
    checksum = exe + ".sha256"
    parser = Links()
    parser.feed((folder / PAGE).read_text(encoding="utf-8"))
    urls = {url.removeprefix("/software/") for url in parser.urls if url.startswith("/software/")}
    if exe not in urls:
        raise ValueError("Page does not link to this release's installer")
    assets = sorted(url for url in urls if asset_name(url))
    if not assets:
        raise ValueError("Page has no versioned SEO assets")
    names = [exe, checksum, *assets, PAGE]
    for name in names:
        path = folder / name
        if not path.is_file() or path.resolve() != path or path.stat().st_size == 0:
            raise ValueError(f"Missing or unsafe release file: {name}")
    with (folder / exe).open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Installer is not a Windows executable")
    manifest = (folder / checksum).read_text(encoding="ascii").strip().split()
    if len(manifest) != 2 or manifest[0].lower() != digest(folder / exe) or manifest[1].lstrip("*") != Path(exe).name:
        raise ValueError("Installer checksum mismatch")
    return names


def deployment_target(key_override=None):
    if not PUBLISH_CONFIG.is_file():
        raise ValueError("Configure scripts/private/website-publish.json as described in docs/RELEASE.md")
    settings = json.loads(PUBLISH_CONFIG.read_text(encoding="utf-8-sig"))
    host = settings["host"]
    if not isinstance(host, str) or not re.fullmatch(r"(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][\w.-]*", host):
        raise ValueError("Invalid SSH destination in website-publish.json")
    key = Path(key_override or settings["key"]).expanduser().resolve(strict=True)
    if not key.is_file():
        raise ValueError("The configured SSH identity is not a file")
    return host, key


def upload(folder, version, host, key):
    names = release_files(folder, version)
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=20", "-i", str(key), host]
    with tempfile.TemporaryDirectory(prefix="aborder-seo-publish-") as temp:
        package = Path(temp) / "payload.tar"
        with tarfile.open(package, "w") as tar:
            for name in names:
                tar.add(folder / name, arcname=name, recursive=False)
        command = (
            "set -eu; umask 077; cd /www/backup; stage=$(mktemp -d seo-download-XXXXXXXX); cd \"$stage\"; "
            "tar -xf - payload.tar publish.py; "
            f"python3 publish.py {version} --activate {digest(package)}"
        )
        with subprocess.Popen([*ssh, command], stdin=subprocess.PIPE) as process:
            with process.stdin, tarfile.open(fileobj=process.stdin, mode="w|") as output:
                output.add(package, arcname="payload.tar", recursive=False)
                output.add(__file__, arcname="publish.py", recursive=False)
            if process.wait():
                raise RuntimeError("Upload or activation failed")


def activate(version, expected):
    import fcntl

    stage = Path.cwd()
    if stage.parent != Path("/www/backup") or not re.fullmatch(r"seo-download-[a-zA-Z0-9]{8}", stage.name):
        raise ValueError("Unexpected staging directory")
    exe = installer_path(version)
    archive = stage / "payload.tar"
    if digest(archive) != expected:
        raise ValueError("Upload checksum mismatch")
    with tempfile.TemporaryDirectory(dir=stage) as temp:
        source = Path(temp)
        members = set()
        with tarfile.open(archive, "r:") as tar:
            for item in tar:
                name = item.name
                if (not item.isfile() or name in members or item.size > 512 * 1024**2
                        or (name not in (PAGE, exe, exe + ".sha256") and not asset_name(name))):
                    raise ValueError("Unexpected release archive contents")
                members.add(name)
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(item) as payload, target.open("xb") as dst:
                    shutil.copyfileobj(payload, dst)
        names = release_files(source, version)
        if set(names) != members:
            raise ValueError("Unreferenced release files")
        if not PUBLIC.is_dir() or PUBLIC.resolve() != PUBLIC:
            raise ValueError("Unexpected website root")
        with Path("/www/backup/nxitek-software-publish.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            # Check all immutable paths before copying. Only the product HTML is mutable.
            for name in names:
                dst = PUBLIC / name
                if dst.resolve() != dst:
                    raise ValueError(f"Unexpected destination: {name}")
                if dst.exists() and name != PAGE and digest(dst) != digest(source / name):
                    raise ValueError(f"Version already contains different bytes: {name}")
            if (PUBLIC / PAGE).is_file():
                shutil.copy2(PUBLIC / PAGE, stage / "previous-index.html")
            for name in names:
                dst = PUBLIC / name
                if name != PAGE and dst.exists():
                    continue
                # Existing website files are public; create only the named product directories.
                parent = PUBLIC
                for part in Path(name).parent.parts:
                    parent /= part
                    if not parent.exists():
                        parent.mkdir()
                        parent.chmod(0o755)
                with tempfile.NamedTemporaryFile(dir=dst.parent, prefix=".seo-", delete=False) as output:
                    pending = Path(output.name)
                try:
                    shutil.copyfile(source / name, pending)
                    if digest(pending) != digest(source / name):
                        raise ValueError("Destination copy verification failed")
                    pending.chmod(0o644)
                    os.replace(pending, dst)
                finally:
                    pending.unlink(missing_ok=True)
    archive.unlink()
    print(f"Published {version} at https://nxitek.cn/software/seo/")
    print(f"Release records: {stage}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--site-dir", type=Path)
    group.add_argument("--activate", metavar="EXPECTED_ARCHIVE_SHA256")
    parser.add_argument("--key", type=Path, help="Override the SSH key path from the private publishing configuration")
    args = parser.parse_args()
    installer_path(args.version)
    if args.site_dir:
        host, key = deployment_target(args.key)
        upload(args.site_dir.resolve(strict=True), args.version, host, key)
    else:
        activate(args.version, args.activate)
