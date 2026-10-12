import json, time, urllib.request, uuid

BASE = "http://127.0.0.1:3100"
KEY = "live-flow-key-2026"
INVITE = "lab-harness-2026"

def call(method, path, token=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw or "{}")
        except Exception:
            return err.code, {"raw": raw}

email = "persist-" + uuid.uuid4().hex[:8] + "@probe.local"
status, body = call("POST", "/auth/register", body={"email": email, "password": "persist-check-1234", "inviteCode": INVITE})
print("register", status)
status, body = call("POST", "/auth/login", body={"email": email, "password": "persist-check-1234"})
token = body["token"]
print("login", status)
status, body = call("POST", "/workspaces", token=token, body={"name": "persist-" + uuid.uuid4().hex[:6]})
workspace = body["workspace"]["id"]
print("workspace", status, workspace)

def run(prompt):
    status, body = call("POST", "/runs", token=token, body={"workspaceId": workspace, "userInput": prompt})
    run_id = body["run"]["id"]
    for _ in range(80):
        time.sleep(3)
        st, detail = call("GET", "/runs/" + run_id, token=token)
        state = detail.get("run", {}).get("status")
        if state in ("COMPLETED", "FAILED", "INTERRUPTED"):
            break
    st, out = call("GET", "/runs/" + run_id + "/output", token=token)
    text = json.dumps(out, ensure_ascii=False)[:400]
    print("run", run_id, state, "output=", text)
    return run_id, state

rid1, s1 = run("请使用 bash 工具执行：echo persist-check-123 > persist.txt 。只做这一步。")
rid2, s2 = run("请使用 bash 工具执行：ls -1 。然后把你自己看到的内容原样告诉我。")
rid3, s3 = run("请使用 bash 工具执行：cat persist.txt 。只做这一步。")
