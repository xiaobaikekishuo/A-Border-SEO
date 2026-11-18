import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("extract_safe", Path(__file__).parents[1] / "deploy/extract-safe.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveSafetyTest(unittest.TestCase):
    def run_archive(self, entries, rejected=False):
        with tempfile.TemporaryDirectory(prefix="aborder-archive-test-") as root:
            archive = Path(root) / "fixture.tar.gz"
            destination = Path(root) / "new-release"
            with tarfile.open(archive, "w:gz") as output:
                for name, kind, value in entries:
                    member = tarfile.TarInfo(name)
                    if kind == "link":
                        member.type = tarfile.SYMTYPE
                        member.linkname = value
                        output.addfile(member)
                    else:
                        data = value.encode()
                        member.size = len(data)
                        output.addfile(member, io.BytesIO(data))
            if rejected:
                with self.assertRaises(ValueError):
                    module.extract(archive, destination)
            else:
                module.extract(archive, destination)
                self.assertEqual((destination / "app/server.js").read_text(), "fixture")

    def test_regular_release(self):
        self.run_archive([("./app/server.js", "file", "fixture")])

    def test_traversal_and_absolute_paths(self):
        for name in ["../outside", "/etc/aborder", "C:/outside", "app/../../outside"]:
            self.run_archive([(name, "file", "bad")], rejected=True)

    def test_symlink_escape(self):
        self.run_archive([("app/escape", "link", "../../outside")], rejected=True)

    def test_write_through_symlink(self):
        self.run_archive([("app/link", "link", "other"), ("app/link/server.js", "file", "bad")], rejected=True)

    def test_duplicate_members(self):
        self.run_archive([("app/server.js", "file", "first"), ("./app/server.js", "file", "second")], rejected=True)


if __name__ == "__main__":
    unittest.main()
