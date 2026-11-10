"""Builds hostile and valid archives and runs deploy/myapp-safe-extract on each."""
import io
import os
import subprocess
import sys
import tarfile
import tempfile

HELPER = sys.argv[1]
work = tempfile.mkdtemp(prefix="safe-extract-test-")


def add(tar, name, data=b"x", **kw):
    info = tarfile.TarInfo(name)
    for key, value in kw.items():
        setattr(info, key, value)
    if info.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    else:
        tar.addfile(info)


def build(name, mode, entries):
    path = os.path.join(work, name)
    with tarfile.open(path, mode) as tar:
        for entry in entries:
            add(tar, *entry[:2], **(entry[2] if len(entry) > 2 else {}))
    return path


def run(label, kind, path, expect_ok):
    dest = os.path.join(work, "out-" + os.path.basename(path))
    proc = subprocess.run([sys.executable, HELPER, kind, path, dest], capture_output=True, text=True)
    ok = proc.returncode == 0
    verdict = "PASS" if ok == expect_ok else "FAIL"
    detail = proc.stderr.strip().replace(work, "<tmp>") or "extracted"
    print(f"{verdict}  {label:<44} -> {detail[:110]}")
    return verdict == "PASS", dest


results = []
inner = build("inner.tar.gz", "w:gz", [("index.js", b"ok")])
inner_bytes = open(inner, "rb").read()
REG = {}

# ---- outer bundle -------------------------------------------------------
results.append(run("bundle: valid (release + app.env)", "bundle",
    build("b-ok.tar", "w", [("release.tar.gz", inner_bytes), ("app.env", b"A=1\n")]), True)[0])
results.append(run("bundle: valid (release only)", "bundle",
    build("b-ok2.tar", "w", [("release.tar.gz", inner_bytes)]), True)[0])
results.append(run("bundle: extra entry", "bundle",
    build("b-extra.tar", "w", [("release.tar.gz", inner_bytes), ("app.env", b"A=1"), ("evil.sh", b"x")]), False)[0])
results.append(run("bundle: duplicate release.tar.gz", "bundle",
    build("b-dup.tar", "w", [("release.tar.gz", inner_bytes), ("release.tar.gz", b"evil")]), False)[0])
results.append(run("bundle: ./release.tar.gz spelling", "bundle",
    build("b-dot.tar", "w", [("./release.tar.gz", inner_bytes)]), False)[0])
results.append(run("bundle: app.env is a symlink to /etc/shadow", "bundle",
    build("b-link.tar", "w", [("release.tar.gz", inner_bytes), ("app.env", b"", {"type": tarfile.SYMTYPE, "linkname": "/etc/shadow"})]), False)[0])
results.append(run("bundle: oversized app.env (100 KB)", "bundle",
    build("b-big.tar", "w", [("release.tar.gz", inner_bytes), ("app.env", b"A" * 100_000)]), False)[0])
results.append(run("bundle: gzip instead of plain tar", "bundle",
    build("b-gz.tar", "w:gz", [("release.tar.gz", inner_bytes)]), False)[0])

# ---- release archive ----------------------------------------------------
ok, dest = run("release: valid, with relative internal symlink", "release",
    build("r-ok.tar.gz", "w:gz", [("./pkg/a.js", b"a"), ("./link", b"", {"type": tarfile.SYMTYPE, "linkname": "pkg/a.js"}),
                                  ("./setuid", b"s", {"mode": 0o4777})]), True)
results.append(ok)
if ok:
    mode = os.stat(os.path.join(dest, "setuid")).st_mode & 0o7777
    print(f"      setuid file extracted with mode {oct(mode)} (setuid stripped: {not mode & 0o4000})")
results.append(run("release: absolute path /etc/cron.d/x", "release",
    build("r-abs.tar.gz", "w:gz", [("/etc/cron.d/x", b"evil")]), False)[0])
results.append(run("release: ../ traversal", "release",
    build("r-dotdot.tar.gz", "w:gz", [("../../outside.txt", b"evil")]), False)[0])
results.append(run("release: symlink escaping the release", "release",
    build("r-symesc.tar.gz", "w:gz", [("./up", b"", {"type": tarfile.SYMTYPE, "linkname": "../../.."})]), False)[0])
results.append(run("release: absolute symlink", "release",
    build("r-symabs.tar.gz", "w:gz", [("./etc", b"", {"type": tarfile.SYMTYPE, "linkname": "/etc"})]), False)[0])
results.append(run("release: symlink then write through it", "release",
    build("r-symwrite.tar.gz", "w:gz", [("./d", b"", {"type": tarfile.SYMTYPE, "linkname": "/tmp"}), ("./d/pwn", b"evil")]), False)[0])
results.append(run("release: hard link", "release",
    build("r-hard.tar.gz", "w:gz", [("./a", b"a"), ("./b", b"", {"type": tarfile.LNKTYPE, "linkname": "a"})]), False)[0])
results.append(run("release: character device", "release",
    build("r-dev.tar.gz", "w:gz", [("./null", b"", {"type": tarfile.CHRTYPE, "devmajor": 1, "devminor": 3})]), False)[0])
results.append(run("release: FIFO", "release",
    build("r-fifo.tar.gz", "w:gz", [("./fifo", b"", {"type": tarfile.FIFOTYPE})]), False)[0])
results.append(run("release: not gzip", "release",
    build("r-plain.tar.gz", "w", [("./a", b"a")]), False)[0])
existing = os.path.join(work, "exists")
os.mkdir(existing)
proc = subprocess.run([sys.executable, HELPER, "release", os.path.join(work, "r-ok.tar.gz"), existing], capture_output=True, text=True)
results.append(proc.returncode != 0)
print(f"{'PASS' if proc.returncode else 'FAIL'}  {'release: destination already exists':<44} -> {proc.stderr.strip().replace(work, '<tmp>')}")

print(f"\n{sum(results)}/{len(results)} cases behaved as expected")
sys.exit(0 if all(results) else 1)
