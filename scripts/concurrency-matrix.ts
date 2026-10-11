// scripts/concurrency-matrix.ts
const BASE = process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3200";
const INVITE = process.env.HARNESS_SMOKE_INVITE_CODE ?? "";
const USERS = (process.env.HARNESS_MATRIX_USERS ?? "2,4,6,8,10").split(",").map((v) => Number(v.trim())).filter((v) => v > 0);
const ROUNDS = Number(process.env.HARNESS_MATRIX_ROUNDS ?? "2");
const TIMEOUT_MS = Number(process.env.HARNESS_MATRIX_TIMEOUT_MS ?? "600000");
const POLL_MS = Number(process.env.HARNESS_MATRIX_POLL_MS ?? "1000");
const USER_INPUT = process.env.HARNESS_MATRIX_USER_INPUT ?? "请使用 bash 工具执行 `echo matrix-ok > result.txt && uname -r`，并只回答内核版本。";
const OUT = process.env.HARNESS_MATRIX_OUTPUT ?? "concurrency-matrix-report.json";
const LABEL = process.env.HARNESS_MATRIX_LABEL ?? "matrix";
const EXPECTED = "4.14.174";
type ApiResult = { status: number; body: any; headers: Headers };
async function api(path: string, token: string | null, init: RequestInit = {}): Promise<ApiResult> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string") {
    if (headers.has("content-type")) {
      // keep
    } else {
      headers.set("content-type", "application/json");
    }
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers };
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function register(email: string, password: string): Promise<{ token: string; tenantId: string; userId: string }> {
  const r = await api("/auth/register", null, { method: "POST", body: JSON.stringify({ email, password, inviteCode: INVITE }) });
  if (r.status === 201) {
    // ok
  } else {
    throw new Error(`register ${email} failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  const l = await api("/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) });
  if (l.status === 200) {
    // ok
  } else {
    throw new Error(`login ${email} failed ${l.status} ${JSON.stringify(l.body)}`);
  }
  return { token: l.body.token, tenantId: l.body.tenantId, userId: l.body.userId };
}
async function createWorkspace(token: string, name: string): Promise<{ id: string; rootPath: string }> {
  const r = await api("/workspaces", token, { method: "POST", body: JSON.stringify({ name }) });
  if (r.status === 201) {
    // ok
  } else {
    throw new Error(`workspace failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { id: r.body.workspace.id, rootPath: r.body.workspace.rootPath };
}
async function submitRun(token: string, workspaceId: string): Promise<string> {
  const r = await api("/runs", token, { method: "POST", body: JSON.stringify({ workspaceId, userInput: USER_INPUT }) });
  if (r.status === 202) {
    // ok
  } else {
    throw new Error(`submit failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.run.id;
}
async function getRun(token: string, runId: string): Promise<{ status: number; run: any }> {
  const r = await api(`/runs/${runId}`, token);
  return { status: r.status, run: r.body?.run ?? r.body };
}
async function getOutput(token: string, runId: string): Promise<{ status: number; body: any }> {
  const r = await api(`/runs/${runId}/output`, token);
  return { status: r.status, body: r.body };
}
async function getEvents(token: string, runId: string): Promise<{ status: number; body: any }> {
  const r = await api(`/runs/${runId}/events`, token);
  return { status: r.status, body: r.body };
}
async function getArtifacts(token: string, runId: string): Promise<{ status: number; body: any }> {
  const r = await api(`/runs/${runId}/artifacts`, token);
  return { status: r.status, body: r.body };
}
function hostMetrics(): Record<string, string> {
  const cmd = [
    "echo firecracker=$(pgrep -f '[f]c117' | wc -l)",
    "echo jailer=$(pgrep -f '[j]ailer117' | wc -l)",
    "echo workers=$(systemctl list-units --state=running --no-legend --type=service | grep -c harness-worker-)",
    "echo memline=$(free -m | grep Mem)",
    "echo loadline=$(cat /proc/loadavg)",
    "echo dfline=$(df -P /data | grep /data)",
    "echo established443=$(ss -Htn state established | grep -c :443)",
  ].join("; ");
  const p = Bun.spawnSync(["bash", "-lc", cmd]);
  const out = p.stdout.toString();
  const metrics: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) metrics[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return metrics;
}
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}
type RunRecord = {
  user: number;
  email: string;
  token: string;
  workspaceId: string;
  runId: string;
  submitAt: number;
  completedAt: number | null;
  status: string;
  finalText: string;
  events: string[];
  artifacts: string[];
  sandboxWarmHit: boolean | null;
  sandboxDurationMs: number | null;
  error: string | null;
};
async function getArtifactsWithRetry(token: string, runId: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let paths: string[] = [];
  while (Date.now() < deadline) {
    const ar = await getArtifacts(token, runId);
    if (ar.status === 200) {
      paths = (ar.body?.artifacts ?? []).map((a: any) => a.path ?? a.name ?? "");
      if (paths.length > 0) return paths;
    }
    await sleep(200);
  }
  return paths;
}
async function runRound(n: number, round: number): Promise<any> {
  const stamp = `${Date.now().toString(36)}-${round}-${n}`;
  const users: RunRecord[] = [];
  for (let i = 0; i < n; i++) {
    const email = `matrix-${stamp}-${i}@smoke.local`;
    const { token } = await register(email, "matrix-pass-1234");
    const ws = await createWorkspace(token, `matrix-${stamp}-${i}`);
    users.push({ user: i, email, token, workspaceId: ws.id, runId: "", submitAt: 0, completedAt: null, status: "QUEUED", finalText: "", events: [], artifacts: [], error: null, sandboxWarmHit: null, sandboxDurationMs: null });
  }
  const before = hostMetrics();
  const samples: Array<{ at: number; metrics: Record<string, string> }> = [];
  const sampler = setInterval(() => { samples.push({ at: Date.now(), metrics: hostMetrics() }); }, 1000);
  const startedAt = Date.now();
  try {
    await Promise.all(users.map(async (u) => {
      try {
        u.submitAt = Date.now();
        u.runId = await submitRun(u.token, u.workspaceId);
      } catch (error) {
        u.error = String(error);
      }
    }));
    const deadline = startedAt + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pending = users.filter((u) => {
        if (u.error === null) {
          const done = u.status === "COMPLETED" || u.status === "FAILED" || u.status === "INTERRUPTED";
          return done === false;
        }
        return false;
      });
      if (pending.length === 0) break;
      await Promise.all(pending.map(async (u) => {
        if (u.runId.length === 0) return;
        try {
          const r = await getRun(u.token, u.runId);
          if (r.status === 200 && r.run) {
            u.status = r.run.status;
            const done = u.status === "COMPLETED" || u.status === "FAILED" || u.status === "INTERRUPTED";
            if (done) u.completedAt = Date.now();
          }
        } catch {
          // ignore transient poll errors
        }
      }));
      const allDone = users.every((u) => {
        const errored = u.error === null ? false : true;
        const completed = u.completedAt === null ? false : true;
        return errored || completed;
      });
      if (allDone) break;
      await sleep(POLL_MS);
    }
    await Promise.all(users.map(async (u) => {
      if (u.error === null && u.runId.length > 0) {
        try {
          const out = await getOutput(u.token, u.runId);
          if (out.status === 200) u.finalText = out.body?.finalText ?? "";
          const ev = await getEvents(u.token, u.runId);
          if (ev.status === 200) {
            const rawEvents = ev.body?.events ?? [];
            u.events = rawEvents.map((e: any) => e.type ?? e.eventType ?? "");
            const acquired = rawEvents.find((e: any) => (e.type ?? e.eventType) === "SANDBOX_ACQUIRED");
            if (acquired) {
              const payload = acquired.payload ?? {};
              u.sandboxWarmHit = typeof payload.warmHit === "boolean" ? payload.warmHit : null;
              u.sandboxDurationMs = typeof payload.durationMs === "number" ? payload.durationMs : null;
            }
          }
          u.artifacts = await getArtifactsWithRetry(u.token, u.runId, 8000);
        } catch (error) {
          u.error = String(error);
        }
      }
    }));
  } finally {
    clearInterval(sampler);
  }
  const after = hostMetrics();
  const crossTenant: Array<{ from: number; to: number; check: string; status: number; ok: boolean }> = [];
  for (let i = 0; i < users.length; i++) {
    const actor = users[i];
    const victim = users[(i + 1) % users.length];
    if (actor === undefined || victim === undefined) continue;
    if (victim.runId.length === 0) continue;
    const checks: Array<[string, () => Promise<{ status: number }>]> = [
      ["getRun", () => getRun(actor.token, victim.runId)],
      ["getEvents", () => getEvents(actor.token, victim.runId)],
      ["getOutput", () => getOutput(actor.token, victim.runId)],
      ["getArtifacts", () => getArtifacts(actor.token, victim.runId)],
      ["interrupt", () => api(`/runs/${victim.runId}/interrupt`, actor.token, { method: "POST" })],
      ["submitIntoVictimWorkspace", () => api("/runs", actor.token, { method: "POST", body: JSON.stringify({ workspaceId: victim.workspaceId, userInput: USER_INPUT }) })],
    ];
    for (const entry of checks) {
      const name = entry[0];
      const fn = entry[1];
      try {
        const r = await fn();
        crossTenant.push({ from: actor.user, to: victim.user, check: name, status: r.status, ok: r.status === 404 });
      } catch {
        crossTenant.push({ from: actor.user, to: victim.user, check: name, status: -1, ok: false });
      }
    }
  }
  const durations = users.filter((u) => (u.completedAt === null ? false : true)).map((u) => (u.completedAt as number) - u.submitAt);
  const wallClockMs = Math.max(...users.map((u) => (u.completedAt === null ? Date.now() : u.completedAt) - startedAt));
  const maxConcurrent = samples.reduce((max, s) => Math.max(max, Number(s.metrics.firecracker ?? 0)), 0);
  const validations = {
    allCompleted: users.every((u) => u.status === "COMPLETED"),
    allOutputKernel: users.every((u) => u.finalText.includes(EXPECTED)),
    allSandbox: users.every((u) => u.events.includes("SANDBOX_ACQUIRED")),
    allToolCompleted: users.every((u) => u.events.includes("TOOL_COMPLETED")),
    allArtifacts: users.every((u) => u.artifacts.some((p) => p === "result.txt" || p.endsWith("/result.txt"))),
    crossTenantAll404: crossTenant.length > 0 && crossTenant.every((c) => c.ok),
    noErrors: users.every((u) => u.error === null),
  };
  const pass = Object.values(validations).every((v) => v);
  return { n, round, stamp, users: users.map((u) => ({ user: u.user, email: u.email, runId: u.runId, status: u.status, durationMs: u.completedAt === null ? null : u.completedAt - u.submitAt, finalText: u.finalText, events: u.events, artifacts: u.artifacts, error: u.error, sandboxWarmHit: u.sandboxWarmHit, sandboxDurationMs: u.sandboxDurationMs })), wallClockMs, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), maxConcurrentFirecracker: maxConcurrent, hostBefore: before, hostAfter: after, hostSamples: samples, crossTenant, validations, pass };
}
async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const rounds: any[] = [];
  for (const n of USERS) {
    for (let round = 1; round <= ROUNDS; round++) {
      console.log(`[matrix] starting n=${n} round=${round}`);
      const result = await runRound(n, round);
      rounds.push(result);
      console.log(`[matrix] n=${n} round=${round} pass=${result.pass} wall=${result.wallClockMs}ms p50=${result.p50Ms} p95=${result.p95Ms} maxFC=${result.maxConcurrentFirecracker}`);
      if (result.pass === false) {
        console.log(`[matrix] failures: ${JSON.stringify(result.validations)} crossTenantBad=${result.crossTenant.filter((c: any) => c.ok === false).length}`);
      }
    }
  }
  const allPass = rounds.every((r) => r.pass);
  const report = { label: LABEL, baseUrl: BASE, startedAt, finishedAt: new Date().toISOString(), rounds, pass: allPass };
  await Bun.write(OUT, JSON.stringify(report, null, 2));
  console.log(`[matrix] report written to ${OUT}`);
  console.log(allPass ? "CONCURRENCY_MATRIX_OK" : "CONCURRENCY_MATRIX_FAIL");
  process.exit(allPass ? 0 : 1);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
