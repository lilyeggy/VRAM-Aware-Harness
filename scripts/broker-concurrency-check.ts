
import { connect } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

const SOCKET = process.env.HARNESS_SANDBOX_BROKER_SOCKET ?? "/tmp/harness-sandbox-broker.sock";
const CONTROL_TOKEN = process.env.HARNESS_SANDBOX_BROKER_CONTROL_TOKEN;
if (CONTROL_TOKEN === undefined || CONTROL_TOKEN.length === 0) {
    throw new Error("必须设置 HARNESS_SANDBOX_BROKER_CONTROL_TOKEN");
}
const concurrency = Number(process.argv[2] ?? "5");
if (Number.isInteger(concurrency) === false || concurrency < 1) {
    throw new Error("并发数必须是正整数");
}

type BrokerResponse = { id?: string; ok?: boolean; error?: string; result?: unknown };

function request(msg: unknown): Promise<BrokerResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
        const socket = connect(SOCKET);
        let buf = "";
        socket.on("connect", () => socket.write(JSON.stringify(msg) + "\n"));
        socket.on("data", (chunk) => {
            buf += chunk.toString();
            const idx = buf.indexOf("\n");
            if (idx >= 0) {
                const line = buf.slice(0, idx);
                socket.end();
                try { resolvePromise(JSON.parse(line) as BrokerResponse); }
                catch (err) { rejectPromise(err); }
            }
        });
        socket.on("error", rejectPromise);
    });
}

function expectOk(label: string, response: BrokerResponse): void {
    if (response.ok === true) {
        return;
    }
    throw new Error(label + " 失败: " + JSON.stringify(response));
}

function expectFail(label: string, response: BrokerResponse, fragment: string): void {
    if (response.ok === false && typeof response.error === "string" && response.error.includes(fragment)) {
        return;
    }
    throw new Error(label + " 未按预期拒绝: " + JSON.stringify(response));
}

const base = resolve("data/live-full-flow/broker-conc");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true, mode: 0o700 });

type User = {
    userId: string;
    sandboxId: string;
    runId: string;
    workspacePath: string;
    token: string;
    policy: Record<string, unknown>;
};

const users: User[] = Array.from({ length: concurrency }, (_value, index) => {
    const suffix = String(index).padStart(2, "0");
    const userId = "user-" + suffix;
    const sandboxId = "conc-sb-" + suffix;
    const runId = "conc-run-" + suffix;
    const workspacePath = resolve(base, userId);
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const policy = {
        ...unrestrictedPolicy,
        id: "policy-" + userId,
        runId,
        userId,
        workspaceRoots: [workspacePath],
        allowNetwork: false,
        allowedSecrets: [],
    };
    return { userId, sandboxId, runId, workspacePath, token: crypto.randomUUID(), policy };
});

const created = await Promise.all(users.map((user) => request({
    id: "create-" + user.userId,
    op: "create",
    input: {
        id: user.sandboxId,
        runId: user.runId,
        workspacePath: user.workspacePath,
        policy: user.policy,
        controlToken: CONTROL_TOKEN,
        token: user.token,
    },
})));
created.forEach((response, index) => expectOk("create " + (users[index] as User).userId, response));

const own = await Promise.all(users.map((user) => request({
    id: "exec-" + user.userId,
    op: "execute",
    sandboxId: user.sandboxId,
    userId: user.userId,
    token: user.token,
    command: ["sh", "-c", "echo HELLO-" + user.userId],
})));
own.forEach((response, index) => expectOk("execute " + (users[index] as User).userId, response));

const cross = await Promise.all(users.map((user, index) => {
    const other = users[(index + 1) % users.length] as User;
    return request({
        id: "cross-" + user.userId,
        op: "execute",
        sandboxId: other.sandboxId,
        userId: user.userId,
        token: other.token,
        command: ["sh", "-c", "echo CROSS-USER"],
    });
}));
cross.forEach((response, index) => expectFail("cross " + (users[index] as User).userId, response, "拒绝跨用户操作"));

const forged = await Promise.all(users.map((user) => request({
    id: "forged-" + user.userId,
    op: "execute",
    sandboxId: user.sandboxId,
    userId: user.userId,
    token: "forged-token",
    command: ["sh", "-c", "echo FORGED"],
})));
forged.forEach((response, index) => expectFail("forged " + (users[index] as User).userId, response, "capability token 不匹配"));

const badWorkspace = resolve(base, "user-bad");
mkdirSync(badWorkspace, { recursive: true, mode: 0o700 });
const badCreate = await request({
    id: "bad-create",
    op: "create",
    input: {
        id: "bad-sb",
        runId: "bad-run",
        workspacePath: badWorkspace,
        policy: {
            ...unrestrictedPolicy,
            id: "policy-user-bad",
            runId: "bad-run",
            userId: "user-bad",
            workspaceRoots: [badWorkspace],
            allowNetwork: false,
            allowedSecrets: [],
        },
        controlToken: "wrong-control",
        token: crypto.randomUUID(),
    },
});
expectFail("bad control create", badCreate, "control token 不匹配");

const terminated = await Promise.all(users.map((user) => request({
    id: "term-" + user.userId,
    op: "terminate",
    sandboxId: user.sandboxId,
    userId: user.userId,
    token: user.token,
})));
terminated.forEach((response, index) => expectOk("terminate " + (users[index] as User).userId, response));

const afterTerminate = await request({
    id: "after-terminate",
    op: "execute",
    sandboxId: (users[0] as User).sandboxId,
    userId: (users[0] as User).userId,
    token: (users[0] as User).token,
    command: ["sh", "-c", "echo AFTER"],
});
expectFail("after terminate", afterTerminate, "不认识 sandbox");

console.log("BROKER_CONCURRENCY_CHECK_OK", JSON.stringify({
    concurrency,
    users: users.map((user) => user.userId),
}));
console.log("BROKER_CONCURRENCY_CHECK_DONE");
