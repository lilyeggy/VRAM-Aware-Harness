#!/usr/bin/env python3
"""从固定夹具快照实际复制一份，逐文件复核 SHA-256，证明快照可复现。

用法:
  python3 verify_snapshot.py [--root DIR] [--dest DIR] [--keep]

默认 root=/home/f630/homePLUS/harness-fixtures，dest=<root>-copy-verify-<pid>。
默认校验完删除 dest，只保留日志（--keep 保留副本）。
退出码 0 = VERIFY_OK，非零 = VERIFY_FAIL。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path

FIXTURES = ("base-project", "big-dir", "fault-project", "slow-job", "isolation")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree(root: Path) -> dict[str, tuple[str, int]]:
    """返回 {相对路径: (类型, sha256/链接目标)}；类型 f=file, l=symlink。"""
    out: dict[str, tuple[str, str]] = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            out[rel] = ("l", os.readlink(path))
        elif path.is_file():
            out[rel] = ("f", sha256_file(path))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/home/f630/homePLUS/harness-fixtures")
    ap.add_argument("--dest", default=None)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    dest = Path(args.dest).resolve() if args.dest else Path(f"{root}-copy-verify-{os.getpid()}")
    if not root.is_dir():
        print(f"VERIFY_FAIL: 找不到快照 {root}", file=sys.stderr)
        return 2
    if dest.exists():
        shutil.rmtree(dest)

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"copy {root} -> {dest}")
    shutil.copytree(root, dest, symlinks=True)

    src_tree = tree(root)
    dst_tree = tree(dest)
    failures: list[str] = []

    s_keys, d_keys = set(src_tree), set(dst_tree)
    if s_keys != d_keys:
        failures.append(f"文件集合不一致：仅源={sorted(s_keys - d_keys)[:5]} 仅副本={sorted(d_keys - s_keys)[:5]}")
    for rel in sorted(s_keys & d_keys):
        if src_tree[rel] != dst_tree[rel]:
            failures.append(f"内容不一致：{rel}")

    # 逐个夹具核对已落地的 SHA-256 清单
    manifest_checks: dict[str, int] = {}
    mdir = root / "manifests"
    for fixture in FIXTURES:
        manifest = mdir / f"{fixture}.sha256"
        froot = dest / fixture
        if not manifest.is_file() or not froot.is_dir():
            continue
        count = 0
        for line in manifest.read_text().splitlines():
            if not line.strip():
                continue
            digest, rel = line.split("  ", 1)
            target = froot / rel
            if not target.is_file():
                failures.append(f"清单文件缺失（副本）：{fixture}/{rel}")
                continue
            if sha256_file(target) != digest:
                failures.append(f"清单哈希不符：{fixture}/{rel}")
            count += 1
        manifest_checks[fixture] = count

    # 权限与特殊文件断言
    special_path = mdir / "SPECIAL.json"
    special_checks: list[str] = []
    if special_path.is_file():
        special = json.loads(special_path.read_text())
        for rel in special.get("readonlyFiles", []):
            actual = stat.S_IMODE((dest / rel).stat().st_mode)
            if actual != 0o444:
                failures.append(f"只读权限不符：{rel} = {oct(actual)}")
            special_checks.append(f"readonly {rel} {oct(actual)}")
        for rel in special.get("executableFiles", []):
            actual = stat.S_IMODE((dest / rel).stat().st_mode)
            if not actual & 0o111:
                failures.append(f"可执行位丢失：{rel} = {oct(actual)}")
            special_checks.append(f"exec {rel} {oct(actual)}")
        for link in special.get("symlinks", []):
            lp = dest / link["path"]
            if not lp.is_symlink() or os.readlink(lp) != link["target"]:
                failures.append(f"符号链接不符：{link['path']}")

    verdict = "VERIFY_OK" if not failures else "VERIFY_FAIL"
    log_dir = root.parent / "harness-fixtures-verification"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"copy-verify-{time.strftime('%Y%m%d-%H%M%S')}.log"
    report = {
        "verdict": verdict,
        "startedUtc": started,
        "snapshot": str(root),
        "copy": str(dest),
        "sourceFileCount": len(src_tree),
        "manifestChecks": manifest_checks,
        "specialChecks": special_checks,
        "failures": failures,
        "kept": args.keep,
    }
    log_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"LOG {log_path}")

    if not args.keep:
        shutil.rmtree(dest)
    return 0 if verdict == "VERIFY_OK" else 1


if __name__ == "__main__":
    sys.exit(main())
