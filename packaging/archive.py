"""Create portable release archives with no links or host ownership metadata."""
import pathlib
import sys
import tarfile

root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()


def normalize(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    if not (info.isfile() or info.isdir()):
        raise ValueError(f"Special archive entry: {info.name}")
    return info


with tarfile.open(output, "w:gz", dereference=True) as archive:
    for child in sorted(root.iterdir()):
        archive.add(child, arcname=child.name, filter=normalize)
