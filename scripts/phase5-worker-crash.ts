/**
 * §9.9 v1.5 Phase 5 真机故障注入（F1 Worker 崩溃 / F2 Broker 不可达 / F7 故障态隔离）。
 *
 * 必须在 Harness 所在主机上运行（需要 systemctl + sudo）。环境变量：
 *   HARNESS_BASE_URL（默认 http://127.0.0.1:3100）
 *   HARNESS_SMOKE_INVITE_CODE（注册模式为 invite 时必填）
 *   HARNESS_PHASE5_SUDO_PASSWORD（不设时用 sudo -n）
 *   HARNESS_PHASE5_CRASH_TIMEOUT_MS（默认 180000）
 *   HARNESS_PHASE5_BROKER_SOCKET（默认 /run/harness/sandbox-broker.sock）
 *   HARNESS_PHASE5_SKIP_BROKER（=1 时跳过 F2）
 *   HARNESS_PHASE5_LABEL（可选）
 *
 * 成功时输出最后一行：PHASE5_WORKER_CRASH_OK
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const baseUrl = (process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const timeoutMs = positiveInt(process.env.HARNESS_PHASE5_CRASH_TIMEOUT_MS, 180_000);
const label = process.env.HARNESS_PHASE5_LABEL ?? crypto.randomUUID().slice(0, 8);
const inviteCode = process.env.HARNESS_SMOKE_INVITE_CODE;
const brokerSocket = process.env.HARNESS_PHASE5_BROKER_SOCKET ?? "/run/harness/sandbox-broker.sock";
const skipBroker = process.env.HARNESS_PHASE5_SKIP_BROKER === "1";

type Principal = { userId: string; token: string; email: string };

const TERMINAL = new Set<string>(["COMPLETED", "FAILED", "INTERRUPTED"]);

function positiveInt(rawValue: string | undefined, fallback: number): number {
    if (rawValue === undefined || rawValue.trim() === "") {
        return fallback;
    }
    const value = Number(rawValue);
    if (Number.isInteger(value) === false || value <= 0) {
        throw new Error("必须是正整数: " + rawValue);
    }
    return value;
}

function sh(command: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(command[0] as string, command.slice(1), { encoding: "utf8" });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

function sudo(args: string[]): { status: number; stdout: string; stderr: string } {
    const password = process.env.HARNESS_PHASE5_SUDO_PASSWORD;
    if (password === undefined || password === "") {
        return sh(["sudo", "-n", ...args]);
    }
    const result = spawnSync("sudo", ["-S", "-p", "", ...args], {
        encoding: "utf8",
        input: password + "\n",
    });
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

function countProcesses(pattern: string): number {
    const result = sh(["pgrep", "-c", "-f", pattern]);
    if (result.status !== 0) {
        return 0;
    }
    const value = Number(result.stdout.trim());
    return Number.isInteger(value) ? value : 0;
}

async function requestJson(
    path: string,
    init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
    const response = await fetch(baseUrl + path, init);
    const text = await response.text();
    let payload: unknown = text;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = text;
    }
    return { response, payload };
}

function authHeaders(token: string): Record<string, string> {
    return { authorization: "Bearer " + token, "content-type": "application/json" };
}

async function registerUser(prefix: string): Promise<Principal> {
    const email = prefix + "-" + label + "-" + Date.now() + "@crash.local";
    const password = "crash-password-1234";
    const registration = await requestJson("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            email,
            password,
            ...(inviteCode === undefined ? {} : { inviteCode }),
        }),
    });
    if (registration.response.status !== 201) {
        throw new Error("注册失败 HTTP " + registration.response.status + ": " + JSON.stringify(registration.payload));
    }
    const login = await requestJson("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (login.response.status !== 200) {
        throw new Error("登录失败 HTTP " + login.response.status);
    }
    const payload = login.payload as { token: string; userId: string };
    return { userId: payload.userId, token: payload.token, email };
}

async function createWorkspace(principal: Principal, name: string): Promise<string> {
    const result = await requestJson("/workspaces", {
        method: "POST",
        headers: authHeaders(principal.token),
        body: JSON.stringify({ name }),
    });
    if (result.response.status !== 200 && result.response.status !== 201) {
        throw new Error("创建 Workspace 失败 HTTP " + result.response.status);
    }
    return (result.payload as { workspace: { id: string } }).workspace.id;
}

async function submitRun(
    principal: Principal,
    workspaceId: string,
    userInput: string,
): Promise<string> {
    const result = await requestJson("/runs", {
        method: "POST",
        headers: authHeaders(principal.token),
        body: JSON.stringify({ workspaceId, userInput }),
    });
    if (result.response.status !== 202) {
        throw new Error("提交 Run 失败 HTTP " + result.response.status + ": " + JSON.stringify(result.payload));
    }
    return (result.payload as { run: { id: string } }).run.id;
}

async function runStatus(principal: Principal, runId: string): Promise<string> {
    const result = await requestJson("/runs/" + runId, { headers: authHeaders(principal.token) });
    if (result.response.status !== 200) {
        return "HTTP_" + result.response.status;
    }
    return (result.payload as { run: { status: string } }).run.status;
}

async function waitForStatus(
    principal: Principal,
    runId: string,
    predicate: (status: string) => boolean,
    timeout: number,
): Promise<string> {
    const deadline = Date.now() + timeout;
    let status = "UNKNOWN";
    while (Date.now() < deadline) {
        status = await runStatus(principal, runId);
        if (predicate(status)) {
            return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return status;
}

async function events(principal: Principal, runId: string): Promise<Array<{ type: string; payload: unknown }>> {
    const result = await requestJson("/runs/" + runId + "/events", { headers: authHeaders(principal.token) });
    if (result.response.status !== 200) {
        throw new Error("读取 events 失败 HTTP " + result.response.status);
    }
    return (result.payload as { events: Array<{ type: string; payload: unknown }> }).events;
}

function payloadText(payload: unknown): string {
    return JSON.stringify(payload ?? null);
}

async function assertCrossUserHidden(other: Principal, runId: string): Promise<void> {
    for (const path of [
        "/runs/" + runId,
        "/runs/" + runId + "/events",
        "/runs/" + runId + "/output",
    ]) {
        const result = await requestJson(path, { headers: authHeaders(other.token) });
        if (result.response.status !== 404) {
            throw new Error("F7 跨用户 GET " + path + " 期望 404，实际 " + result.response.status);
        }
    }
}

async function waitForWorkerUnit(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastOutput = "";
    while (Date.now() < deadline) {
        const units = sh([
            "systemctl", "list-units", "--type=service", "--state=running",
            "--no-legend", "harness-worker-*",
        ]);
        lastOutput = units.stdout + units.stderr;
        const unit = units.stdout.trim().split("\n")[0]?.trim().split(/\s+/)[0];
        if (unit !== undefined && unit !== "") {
            return unit;
        }
        await Bun.sleep(2000);
    }
    throw new Error("F1 找不到运行中的 harness-worker-* 单元（已等待 " + timeoutMs + "ms）：" + lastOutput);
}

async function faultInjectionF1(owner: Principal, other: Principal, workspaceId: string): Promise<string> {
    const baselineFirecracker = countProcesses("firecracker");
    const runId = await submitRun(owner, workspaceId, "请使用 bash 工具执行 sleep 180，然后只回答 CRASH-DONE。");
    const running = await waitForStatus(owner, runId, (status) => status === "RUNNING", 60_000);
    if (running !== "RUNNING") {
        throw new Error("F1 Run 未进入 RUNNING，当前 " + running);
    }

    // RUNNING 先落库、Worker 单元随后才创建（sandbox.create → spawn worker），
    // 所以这里必须轮询等待，否则会在真机上偶发“找不到运行中的单元”。
    const unit = await waitForWorkerUnit(90_000);

    const killed = sudo(["systemctl", "kill", "-s", "KILL", unit]);
    if (killed.status !== 0) {
        throw new Error("F1 kill worker 失败：" + killed.stderr);
    }

    const terminalStatus = await waitForStatus(
        owner,
        runId,
        (status) => TERMINAL.has(status),
        timeoutMs,
    );

    const list = await events(owner, runId);
    // 两条真实路径（2026-10-11 真机观察）：
    //   lease       —— Master 观察不到 Worker 之死（例如 Master 自身重启），租约过期由 reaper 回收为 INTERRUPTED + 恢复决策；
    //   supervisor  —— Master 能观察到 Worker 进程退出（systemd/process 隔离），立即以 WORKER_CRASHED 收尾为 FAILED。
    let crashPath: string;
    if (terminalStatus === "INTERRUPTED") {
        const leaseExpired = list.some((event) =>
            event.type === "RUN_INTERRUPTED" && payloadText(event.payload).includes("LEASE_EXPIRED"));
        if (leaseExpired === false) {
            throw new Error("F1 观察到 INTERRUPTED 但缺少 LEASE_EXPIRED 事件：" + JSON.stringify(list.map((event) => event.type)));
        }
        const recovered = list.some((event) =>
            payloadText(event.payload).includes("MANUAL_REVIEW_REQUIRED")
            || payloadText(event.payload).includes("AUTO_RECOVERY"));
        if (recovered === false) {
            throw new Error("F1 未观察到恢复决策（MANUAL_REVIEW / AUTO_RESUME）");
        }
        crashPath = "lease";
    } else if (terminalStatus === "FAILED") {
        const crashed = list.some((event) => payloadText(event.payload).includes("WORKER_CRASHED"));
        if (crashed === false) {
            throw new Error("F1 期望 FAILED 带 WORKER_CRASHED，实际事件：" + JSON.stringify(list.map((event) => event.type)));
        }
        crashPath = "supervisor";
    } else {
        throw new Error("F1 期望 INTERRUPTED（租约回收）或 FAILED（WORKER_CRASHED），实际 " + terminalStatus);
    }

    await assertCrossUserHidden(other, runId);

    // 回收后不应残留 microVM 进程。
    let firecracker = countProcesses("firecracker");
    const cleanupDeadline = Date.now() + 60_000;
    while (firecracker > baselineFirecracker && Date.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        firecracker = countProcesses("firecracker");
    }
    if (firecracker > baselineFirecracker) {
        throw new Error("F1 残留 Firecracker 进程：" + firecracker + " > baseline " + baselineFirecracker);
    }

    return "path=" + crashPath + " unit=" + unit + " run=" + runId;
}

async function faultInjectionF2(owner: Principal, workspaceId: string): Promise<string> {
    const stopped = sudo(["systemctl", "stop", "harness-broker.service"]);
    if (stopped.status !== 0) {
        throw new Error("F2 停止 Broker 失败：" + stopped.stderr);
    }
    try {
        const runId = await submitRun(owner, workspaceId, "只回答 BROKER-DOWN。");
        const status = await waitForStatus(owner, runId, (value) => TERMINAL.has(value), timeoutMs);
        if (status !== "INTERRUPTED") {
            throw new Error("F2 Broker 不可达时期望 INTERRUPTED，实际 " + status);
        }
        const list = await events(owner, runId);
        const failed = list.some((event) =>
            event.type === "RUN_INTERRUPTED" && payloadText(event.payload).includes("START_FAILED"));
        if (failed === false) {
            throw new Error("F2 未观察到 START_FAILED 事件");
        }
    } finally {
        const started = sudo(["systemctl", "start", "harness-broker.service"]);
        if (started.status !== 0) {
            throw new Error("F2 重启 Broker 失败：" + started.stderr);
        }
    }

    const socketDeadline = Date.now() + 30_000;
    while (existsSync(brokerSocket) === false && Date.now() < socketDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (existsSync(brokerSocket) === false) {
        throw new Error("F2 Broker socket 未恢复：" + brokerSocket);
    }

    const recoveredRun = await submitRun(owner, workspaceId, "只回答 BROKER-BACK。");
    const recoveredStatus = await waitForStatus(
        owner,
        recoveredRun,
        (value) => TERMINAL.has(value),
        timeoutMs,
    );
    if (recoveredStatus !== "COMPLETED") {
        throw new Error("F2 Broker 恢复后期望 COMPLETED，实际 " + recoveredStatus);
    }
    return "recoveredRun=" + recoveredRun;
}

async function main(): Promise<void> {
    const owner = await registerUser("phase5-crash-owner");
    const other = await registerUser("phase5-crash-other");
    const ownerWorkspace = await createWorkspace(owner, "phase5-crash-owner");
    await createWorkspace(other, "phase5-crash-other");

    const f1 = await faultInjectionF1(owner, other, ownerWorkspace);
    const f2 = skipBroker ? "skipped" : await faultInjectionF2(owner, ownerWorkspace);

    console.log("PHASE5_WORKER_CRASH_OK label=" + label + " f1=" + f1 + " f2=" + f2);
}

await main();
