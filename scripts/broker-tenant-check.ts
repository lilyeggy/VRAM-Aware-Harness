
import { connect } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";

const SOCKET = process.env.HARNESS_SANDBOX_BROKER_SOCKET ?? "/tmp/harness-sandbox-broker.sock";
const CONTROL_TOKEN = process.env.HARNESS_SANDBOX_BROKER_CONTROL_TOKEN;
if (CONTROL_TOKEN === undefined || CONTROL_TOKEN.length === 0) {
    throw new Error("必须设置 HARNESS_SANDBOX_BROKER_CONTROL_TOKEN");
}

function request(msg: unknown): Promise<Record<string, unknown>> {
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
                try { resolvePromise(JSON.parse(line) as Record<string, unknown>); }
                catch (err) { rejectPromise(err); }
            }
        });
        socket.on("error", rejectPromise);
    });
}

function ok(label: string, response: Record<string, unknown>): void {
    console.log(label, JSON.stringify(response));
}

const ws = resolve("data/live-full-flow/tenant-check");
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true, mode: 0o700 });
const sandboxId = "tenant-check-sb";
const runId = "tenant-check-run";
const capabilityToken = crypto.randomUUID();
const policy = {
    ...unrestrictedPolicy,
    id: "policy-tenant-A",
    runId,
    tenantId: "tenant-A",
    workspaceRoots: [ws],
    allowNetwork: false,
    allowedSecrets: [],
};

const badCreate = await request({
    id: "c-bad",
    op: "create",
    input: {
        id: "tenant-check-bad-sb",
        runId,
        workspacePath: ws,
        policy,
        controlToken: "wrong-control",
        token: crypto.randomUUID(),
    },
});
ok("CREATE_BAD_CONTROL", badCreate);

const create = await request({
    id: "c1",
    op: "create",
    input: { id: sandboxId, runId, workspacePath: ws, policy, controlToken: CONTROL_TOKEN, token: capabilityToken },
});
ok("CREATE", create);

const crossExec = await request({
    id: "e-b",
    op: "execute",
    sandboxId,
    tenantId: "tenant-B",
    token: capabilityToken,
    command: ["sh", "-c", "echo CROSS-TENANT"],
});
ok("EXEC_AS_B_WITH_A_TOKEN", crossExec);

const wrongExec = await request({
    id: "e-wrong",
    op: "execute",
    sandboxId,
    tenantId: "tenant-A",
    token: "wrong-token",
    command: ["sh", "-c", "echo WRONG-TOKEN"],
});
ok("EXEC_AS_A_WITH_WRONG_TOKEN", wrongExec);

const controlExec = await request({
    id: "e-control",
    op: "execute",
    sandboxId,
    tenantId: "tenant-A",
    token: CONTROL_TOKEN,
    command: ["sh", "-c", "echo CONTROL-TOKEN"],
});
ok("EXEC_AS_A_WITH_CONTROL_TOKEN", controlExec);

const ownExec = await request({
    id: "e-a",
    op: "execute",
    sandboxId,
    tenantId: "tenant-A",
    token: capabilityToken,
    command: ["sh", "-c", "echo HELLO-FROM-A"],
});
ok("EXEC_AS_A", ownExec);

const crossTerm = await request({
    id: "t-b",
    op: "terminate",
    sandboxId,
    tenantId: "tenant-B",
    token: capabilityToken,
});
ok("TERM_AS_B_WITH_A_TOKEN", crossTerm);

const ownTerm = await request({
    id: "t-a",
    op: "terminate",
    sandboxId,
    tenantId: "tenant-A",
    token: capabilityToken,
});
ok("TERM_AS_A", ownTerm);

console.log("TENANT_CHECK_DONE");
