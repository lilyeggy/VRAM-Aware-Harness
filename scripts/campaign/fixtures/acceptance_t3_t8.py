#!/usr/bin/env python3
"""临时实例验收：在真实 Harness 实例上跑 T3 与 T8(5x10s)，并做外部验收。

为什么可能需要两个实例：
  - T3 只需要 write/read 工具，managed-local (E1) 可跑。
  - T8 需要 bash 工具；managed-local 的 enforcement.filesystemIsolation=false，
    在 WORKSPACE 策略 (workspaceRoots=[workspacePath]) 下会被 fail-closed 拒绝
    （见 src/policies/tool-policy-guard.ts:41）。因此 T8 必须在 container/runsc 实例上跑。

用法（在远端主机执行）:
  HARNESS_BASE_URL=http://127.0.0.1:13016 \
  HARNESS_WORKSPACE_ROOT=<managed-local实例>/runtime/workspaces \
  T8_BASE_URL=http://127.0.0.1:13017 \
  T8_WORKSPACE_ROOT=<container实例>/runtime/workspaces \
  FIXTURE_ROOT=/home/f630/homePLUS/harness-fixtures \
  EVID_DIR=/home/f630/homePLUS/harness-fixtures-verification/acceptance \
  SCENARIO_EMAIL=t3t8-accept@test.local SCENARIO_PASSWORD='...' \
  python3 acceptance_t3_t8.py

只使用标准库；不打印凭证；T3/T8 验收均为外部检查（磁盘文件/进程表），不看模型自评。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("HARNESS_BASE_URL", "").rstrip("/")
WS_ROOT = os.environ.get("HARNESS_WORKSPACE_ROOT", "").rstrip("/")
T3_BASE = os.environ.get("T3_BASE_URL", BASE).rstrip("/")
T3_WS = os.environ.get("T3_WORKSPACE_ROOT", WS_ROOT).rstrip("/")
T8_BASE = os.environ.get("T8_BASE_URL", BASE).rstrip("/")
T8_WS = os.environ.get("T8_WORKSPACE_ROOT", WS_ROOT).rstrip("/")
FIXTURES = os.environ.get("FIXTURE_ROOT", "/home/f630/homePLUS/harness-fixtures")
EVID = os.environ.get("EVID_DIR", os.path.join(FIXTURES, "verification", "acceptance"))
EMAIL = os.environ.get("SCENARIO_EMAIL", f"t3t8-{int(time.time())}@test.local")
PASSWORD = os.environ.get("SCENARIO_PASSWORD", "TestPass-2026-fixtures-01")
T3_EXPECTED = {"answer": 391, "ok": True}
if os.environ.get("T3_EXPECTED_JSON"):
    T3_EXPECTED = json.loads(os.environ["T3_EXPECTED_JSON"])
T3_EXPECTED_TEXT = json.dumps(T3_EXPECTED, separators=(",", ":"))
CASES = {c.strip() for c in os.environ.get("CASES", "t3,t8").split(",") if c.strip()}

os.makedirs(EVID, exist_ok=True)


def api(base: str, token: str, path: str, method: str = "GET", body=None, timeout: int = 60, raw: bool = False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"content-type": "application/json",
                 **({"authorization": "Bearer " + token} if token else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload.decode()[:1_000_000] or "{}"))
    except urllib.error.HTTPError as exc:
        return exc.code, (exc.read() if raw else {})


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def wait(base: str, token: str, run_id: str, timeout_s: int):
    t0 = time.monotonic()
    seen: list[str] = []
    status = "TIMEOUT"
    while time.monotonic() - t0 < timeout_s:
        _st, d = api(base, token, f"/runs/{run_id}")
        status = (d.get("run") or {}).get("status")
        if not seen or seen[-1] != status:
            seen.append(status)
        if status in ("COMPLETED", "FAILED", "INTERRUPTED"):
            return status, seen, time.monotonic() - t0
        time.sleep(1.6)
    return status, seen, time.monotonic() - t0


def make_tenant(base: str) -> tuple[str, str]:
    api(base, "", "/auth/register", "POST", {"email": EMAIL, "password": PASSWORD})
    st, d = api(base, "", "/auth/login", "POST", {"email": EMAIL, "password": PASSWORD})
    if st != 200:
        raise SystemExit(f"login failed on {base}: {st} {d}")
    return d["token"], d["tenantId"]


def make_workspace(base: str, token: str, ws_root: str, name: str):
    st, d = api(base, token, "/workspaces", "POST", {"name": name})
    if st not in (200, 201):
        raise SystemExit(f"create workspace failed: {st} {d}")
    ws = d["workspace"]
    root = os.path.join(ws_root, ws["tenantId"], ws["id"])
    os.makedirs(root, exist_ok=True)
    return ws["id"], root


def make_conversation(base: str, token: str, ws_id: str, title: str) -> str:
    st, d = api(base, token, f"/workspaces/{ws_id}/conversations", "POST", {"title": title})
    if st not in (200, 201):
        raise SystemExit(f"create conversation failed: {st} {d}")
    return d["conversation"]["id"]


def submit(base: str, token: str, conv_id: str, text: str):
    st, d = api(base, token, f"/conversations/{conv_id}/messages", "POST", {"userInput": text})
    if st != 202:
        raise SystemExit(f"submit failed: {st} {d}")
    return d["run"]["id"]


def running_slow_jobs(progress_dir: str | None = None) -> list[str]:
    """检测 slow-job 残留：优先用 slow-job 写入的 pid 文件，再退回进程表扫描。"""
    hits: list[str] = []
    if progress_dir:
        pid_file = os.path.join(progress_dir, "pid")
        if os.path.isfile(pid_file):
            try:
                pid = int(open(pid_file, encoding="utf-8").read().strip())
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    cmdline = fh.read().replace(b"\x00", b" ").decode(errors="replace")
                if "slow-job" in cmdline:
                    hits.append(f"pid={pid} cmdline={cmdline.strip()}")
            except (FileNotFoundError, ProcessLookupError, ValueError, PermissionError):
                pass
    try:
        ps = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        ps = ""
    for line in ps.splitlines():
        line = line.strip()
        if not line or "slow-job" not in line:
            continue
        if "acceptance_t3_t8" in line or "grep" in line or "ps -eo" in line:
            continue
        if line.split()[0] == str(os.getpid()):
            continue
        hits.append(line)
    return hits


def t3_attempt(base: str, token: str, ws_root: str, attempt: int) -> dict:
    ws_id, root = make_workspace(base, token, ws_root, f"t3-fixture-{attempt}-{int(time.time())}")
    shutil.copytree(os.path.join(FIXTURES, "base-project"), root, dirs_exist_ok=True)
    conv = make_conversation(base, token, ws_id, f"T3 外部验收 #{attempt}")
    if attempt == 1:
        prompt = (
            "请把下面这个 JSON 原样写入当前项目根目录下的 result.json"
            "（不要增加或删除任何字段，值必须完全一致），"
            "然后用 read 工具读回 result.json，并把它的完整内容原样输出。\n\n"
            + T3_EXPECTED_TEXT
        )
    else:
        prompt = (
            "上一次写入 result.json 时内容不完整。请用 write 工具把当前项目根目录下的 result.json "
            f"精确覆盖为下面这 {len(T3_EXPECTED_TEXT)} 个字符（注意结尾必须有最后一个右花括号 }}，"
            "不要加反引号、不要加说明、不要加换行）：\n\n"
            + T3_EXPECTED_TEXT
            + "\n\n写完后用 read 工具读回并确认。"
        )
    run_id = submit(base, token, conv, prompt)
    status, seen, dur = wait(base, token, run_id, 300)

    disk_path = os.path.join(root, "result.json")
    disk = {"path": disk_path, "exists": os.path.isfile(disk_path)}
    if disk["exists"]:
        raw = open(disk_path, "rb").read()
        disk["bytes"] = len(raw)
        disk["text"] = raw.decode("utf-8", errors="replace")
        try:
            actual = json.loads(disk["text"])
            disk["parsed"] = actual
            disk["exactMatch"] = actual == T3_EXPECTED
        except Exception as exc:  # noqa: BLE001
            disk["parseError"] = str(exc)
            disk["exactMatch"] = False
        disk["sha256"] = sha256(disk_path)
    else:
        disk["exactMatch"] = False

    artifact = {}
    st, arts = api(base, token, f"/runs/{run_id}/artifacts")
    art_list = (arts or {}).get("artifacts") or []
    target = next((a for a in art_list if a.get("path") == "result.json"), None)
    if target:
        st, blob = api(base, token, f"/runs/{run_id}/artifacts/{urllib.parse.quote('result.json', safe='')}",
                       raw=True, timeout=60)
        artifact = {"http": st, "bytes": len(blob) if isinstance(blob, bytes) else None,
                    "sha256": hashlib.sha256(blob).hexdigest() if isinstance(blob, bytes) else None}
        if disk.get("sha256"):
            artifact["matchesDisk"] = artifact["sha256"] == disk["sha256"]
    else:
        artifact = {"found": False, "artifactPaths": [a.get("path") for a in art_list]}

    return {
        "attempt": attempt, "runId": run_id, "status": status, "statusesSeen": seen,
        "durationSeconds": round(dur, 1), "workspaceId": ws_id, "workspaceRoot": root,
        "disk": disk, "artifact": artifact,
        "verdict": "PASS" if (status == "COMPLETED" and disk.get("exactMatch") is True) else "FAIL",
    }


def case_t3() -> dict:
    token, _tenant = make_tenant(T3_BASE)
    attempts = []
    for i in (1, 2, 3):
        rec = t3_attempt(T3_BASE, token, T3_WS, i)
        attempts.append(rec)
        if rec["verdict"] == "PASS":
            break
    best = next((a for a in attempts if a["verdict"] == "PASS"), attempts[-1])
    record = {
        "case": "T3", "baseUrl": T3_BASE, "expected": T3_EXPECTED,
        "attempts": attempts, "attemptCount": len(attempts),
        "runId": best["runId"], "workspaceRoot": best["workspaceRoot"],
        "verdict": "PASS" if best["verdict"] == "PASS" else "FAIL",
    }
    with open(os.path.join(EVID, f"T3-{best['runId']}.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return record


def case_t8() -> dict:
    token, _tenant = make_tenant(T8_BASE)
    ws_id, root = make_workspace(T8_BASE, token, T8_WS, f"t8-fixture-{int(time.time())}")
    shutil.copytree(os.path.join(FIXTURES, "slow-job"), os.path.join(root, "slow-job"))
    for path in (os.path.join(root, "slow-job", "slow-job.sh"), os.path.join(FIXTURES, "slow-job", "slow-job.sh")):
        os.chmod(path, 0o755)
    conv = make_conversation(T8_BASE, token, ws_id, "T8 外部验收 5x10s")
    prompt = (
        "当前项目根目录下有 slow-job/slow-job.sh。请用 bash 工具在前台执行下面这条命令，"
        "这是一次约 50 秒的可控慢任务，必须等待它执行结束（不要加 &、不要放到后台）：\n\n"
        "sh slow-job/slow-job.sh --stages 5 --stage-wait 10 --out progress --run-id t8-accept\n\n"
        "执行结束后，用 ls 读取 progress 目录，并报告其中有哪些 stage-*.done 文件以及 summary.json 的内容。"
    )
    run_id = submit(T8_BASE, token, conv, prompt)
    status, seen, dur = wait(T8_BASE, token, run_id, 600)

    progress = os.path.join(root, "progress")
    done_files = sorted(os.listdir(progress)) if os.path.isdir(progress) else []
    done_stages = []
    for name in done_files:
        if name.startswith("stage-") and name.endswith(".done"):
            try:
                done_stages.append(int(name[len("stage-"):-len(".done")]))
            except ValueError:
                pass
    unique_stages = sorted(set(done_stages))
    duplicates = sorted({s for s in done_stages if done_stages.count(s) > 1})
    summary = {}
    summary_path = os.path.join(progress, "summary.json")
    if os.path.isfile(summary_path):
        try:
            summary = json.loads(open(summary_path, encoding="utf-8").read())
        except Exception as exc:  # noqa: BLE001
            summary = {"parseError": str(exc)}
    leftovers = running_slow_jobs(progress)

    stages_ok = unique_stages == [1, 2, 3, 4, 5] and not duplicates
    no_bg = len(leftovers) == 0
    summary_ok = summary.get("stages") == 5 and summary.get("progressDoneFiles") == 5
    verdict = status == "COMPLETED" and stages_ok and no_bg and summary_ok
    record = {
        "case": "T8", "baseUrl": T8_BASE, "runId": run_id, "status": status, "statusesSeen": seen,
        "durationSeconds": round(dur, 1), "workspaceId": ws_id, "workspaceRoot": root,
        "progressDir": progress, "doneFiles": done_files, "uniqueStages": unique_stages,
        "duplicateStages": duplicates, "summary": summary,
        "backgroundProcesses": leftovers, "stagesComplete": stages_ok,
        "noBackgroundProcess": no_bg, "summaryConsistent": summary_ok,
        "verdict": "PASS" if verdict else "FAIL",
    }
    with open(os.path.join(EVID, f"T8-{run_id}.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return record


def main() -> int:
    print(json.dumps({"t3Base": T3_BASE, "t3WsRoot": T3_WS, "t8Base": T8_BASE,
                      "t8WsRoot": T8_WS, "fixtureRoot": FIXTURES, "cases": sorted(CASES)},
                     ensure_ascii=False))
    overall = {"evidenceDir": EVID}
    t3 = case_t3() if "t3" in CASES else None
    if t3 is not None:
        print(json.dumps({"case": "T3", "verdict": t3["verdict"], "attempts": t3["attemptCount"],
                          "runId": t3["runId"]}, ensure_ascii=False))
        overall.update({"t3": t3["verdict"], "t3Attempts": t3["attemptCount"], "t3RunId": t3["runId"]})
    t8 = case_t8() if "t8" in CASES else None
    if t8 is not None:
        print(json.dumps({k: t8[k] for k in ("case", "runId", "status", "verdict", "uniqueStages",
                                              "noBackgroundProcess")}, ensure_ascii=False))
        overall.update({"t8": t8["verdict"], "t8RunId": t8["runId"]})
    with open(os.path.join(EVID, "ACCEPTANCE-SUMMARY.json"), "w", encoding="utf-8") as fh:
        json.dump(overall, fh, ensure_ascii=False, indent=2)
    print(json.dumps(overall, ensure_ascii=False))
    ok = all(overall.get(c) == "PASS" for c in ("t3", "t8") if c in overall)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
