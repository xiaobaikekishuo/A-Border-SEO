"""Inspect the final bundle's actual Prisma CLI closure without executing it."""
import hashlib
import json
import pathlib
import sys
import tarfile


def fingerprint(filename):
    packages = {}
    observed = {}
    manifest = None
    with tarfile.open(filename, mode="r|gz") as archive:
        for member in archive:
            name = member.name.removeprefix("./")
            parts = name.split("/")
            inspected = name.startswith(("app/node_modules/", "app/prisma/"))
            if member.issym() and inspected:
                observed[name] = {"link": member.linkname}
                continue
            if not member.isfile():
                continue
            if name == "server-bundle.json":
                manifest = json.load(archive.extractfile(member))
            elif inspected:
                direct = parts[:2] == ["app", "node_modules"] and parts[-1] == "package.json" and (
                    len(parts) == 4 or (len(parts) == 5 and parts[2].startswith("@")))
                stream = archive.extractfile(member)
                if direct:
                    body = stream.read()
                    packages["/".join(parts[2:-1])] = json.loads(body)
                    digest = hashlib.sha256(body)
                else:
                    digest = hashlib.sha256()
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                observed[name] = {"sha256": digest.hexdigest(), "executable": bool(member.mode & 0o111)}
    if not manifest or "prisma" not in packages:
        raise ValueError("Missing bundle manifest or Prisma CLI")
    seen = set()
    pending = ["prisma"]
    while pending:
        name = pending.pop()
        if name in seen or name not in packages:
            continue
        seen.add(name)
        package = packages[name]
        pending.extend(package.get("dependencies", {}))
        pending.extend(package.get("optionalDependencies", {}))
    prefixes = tuple("app/node_modules/" + name + "/" for name in sorted(seen))
    files = sorted((entry for entry in manifest["files"] if entry["path"].startswith(prefixes)
                    or entry["path"].startswith("app/prisma/")), key=lambda entry: entry["path"])
    for entry in files:
        expected = {key: value for key, value in entry.items() if key != "path"}
        if observed.get(entry["path"]) != expected:
            raise ValueError("Migration runtime differs from the bundle manifest")
    identity = {"runtime": manifest["runtime"], "files": files, "migrations": manifest["migrations"]}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    archive_hash = hashlib.sha256()
    with open(filename, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            archive_hash.update(chunk)
    return {"file": pathlib.Path(filename).name, "sha256": archive_hash.hexdigest(),
            "migrationFingerprint": digest, "cliPackages": len(seen), "migrationFiles": len(files),
            "schemaMigrations": len(manifest["migrations"])}


if __name__ == "__main__":
    result = {"tested": fingerprint(sys.argv[1])}
    if len(sys.argv) > 2:
        result["final"] = fingerprint(sys.argv[2])
        result["sameMigrationRuntime"] = result["tested"]["migrationFingerprint"] == result["final"]["migrationFingerprint"]
    print(json.dumps(result))
