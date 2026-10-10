
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

type Tenant = {
    tenantId: string;
    sandboxId: string;
    runId: string;
    workspacePath: string;
    token: string;
    policy: Record<string, unknown>;
};

const tenants: Tenant[] = Array.from({ length: concurrency }, (_value, index) => {
    const suffix = String(index).padStart(2, "0");
    const tenantId = "tenant-" + suffix;
    const sandboxId = "conc-sb-" + suffix;
    const runId = "conc-run-" + suffix;
    const workspacePath = resolve(base, tenantId);
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    const policy = {
        ...unrestrictedPolicy,
        id: "policy-" + tenantId,
        runId,
        tenantId,
        workspaceRoots: [workspacePath],
        allowNetwork: false,
        allowedSecrets: [],
    };
    return { tenantId, sandboxId, runId, workspacePath, token: crypto.randomUUID(), policy };
});

const created = await Promise.all(tenants.map((tenant) => request({
    id: "create-" + tenant.tenantId,
    op: "create",
    input: {
        id: tenant.sandboxId,
        runId: tenant.runId,
        workspacePath: tenant.workspacePath,
        policy: tenant.policy,
        controlToken: CONTROL_TOKEN,
        token: tenant.token,
    },
})));
created.forEach((response, index) => expectOk("create " + (tenants[index] as Tenant).tenantId, response));

const own = await Promise.all(tenants.map((tenant) => request({
    id: "exec-" + tenant.tenantId,
    op: "execute",
    sandboxId: tenant.sandboxId,
    tenantId: tenant.tenantId,
    token: tenant.token,
    command: ["sh", "-c", "echo HELLO-" + tenant.tenantId],
})));
own.forEach((response, index) => expectOk("execute " + (tenants[index] as Tenant).tenantId, response));

const cross = await Promise.all(tenants.map((tenant, index) => {
    const other = tenants[(index + 1) % tenants.length] as Tenant;
    return request({
        id: "cross-" + tenant.tenantId,
        op: "execute",
        sandboxId: other.sandboxId,
        tenantId: tenant.tenantId,
        token: other.token,
        command: ["sh", "-c", "echo CROSS-TENANT"],
    });
}));
cross.forEach((response, index) => expectFail("cross " + (tenants[index] as Tenant).tenantId, response, "拒绝跨租户操作"));

const forged = await Promise.all(tenants.map((tenant) => request({
    id: "forged-" + tenant.tenantId,
    op: "execute",
    sandboxId: tenant.sandboxId,
    tenantId: tenant.tenantId,
    token: "forged-token",
    command: ["sh", "-c", "echo FORGED"],
})));
forged.forEach((response, index) => expectFail("forged " + (tenants[index] as Tenant).tenantId, response, "capability token 不匹配"));

const badWorkspace = resolve(base, "tenant-bad");
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
            id: "policy-tenant-bad",
            runId: "bad-run",
            tenantId: "tenant-bad",
            workspaceRoots: [badWorkspace],
            allowNetwork: false,
            allowedSecrets: [],
        },
        controlToken: "wrong-control",
        token: crypto.randomUUID(),
    },
});
expectFail("bad control create", badCreate, "control token 不匹配");

const terminated = await Promise.all(tenants.map((tenant) => request({
    id: "term-" + tenant.tenantId,
    op: "terminate",
    sandboxId: tenant.sandboxId,
    tenantId: tenant.tenantId,
    token: tenant.token,
})));
terminated.forEach((response, index) => expectOk("terminate " + (tenants[index] as Tenant).tenantId, response));

const afterTerminate = await request({
    id: "after-terminate",
    op: "execute",
    sandboxId: (tenants[0] as Tenant).sandboxId,
    tenantId: (tenants[0] as Tenant).tenantId,
    token: (tenants[0] as Tenant).token,
    command: ["sh", "-c", "echo AFTER"],
});
expectFail("after terminate", afterTerminate, "不认识 sandbox");

console.log("BROKER_CONCURRENCY_CHECK_OK", JSON.stringify({
    concurrency,
    tenants: tenants.map((tenant) => tenant.tenantId),
}));
console.log("BROKER_CONCURRENCY_CHECK_DONE");
