import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { FirecrackerSandboxDriver } from "../src/sandbox/microvm/firecracker-sandbox-driver.ts";
import { MicrovmSandboxProvider } from "../src/sandbox/microvm/microvm-sandbox-provider.ts";
import { BrokerSandboxProvider } from "../src/sandbox/broker/broker-sandbox-provider.ts";
import { InMemorySandboxStore } from "../src/sandbox/broker/in-memory-sandbox-store.ts";
import { EnvironmentSecretProvider } from "../src/sandbox/managed-local-sandbox.ts";
import { unrestrictedPolicy } from "../src/policies/effective-policy.ts";
import type { SandboxStore } from "../src/sandbox/sandbox-store.ts";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`缺少 ${name}`); return value; };
const root = await mkdtemp("/data/harness/workspace-live-test-");
const workspace = join(root, "workspace");
const runtimeRoot = join(root, "vm");
const captures = join(root, "captures");
await mkdir(workspace);
await writeFile(join(workspace, "shared"), "initial");
const brokerMode = process.env.WORKSPACE_TEST_BROKER === "1";
const provider = brokerMode
    ? new BrokerSandboxProvider({ socketPath: required("HARNESS_SANDBOX_BROKER_SOCKET"), controlToken: required("HARNESS_SANDBOX_BROKER_CONTROL_TOKEN") })
    : (() => {
        const template = required("FIRECRACKER_WORKSPACE_DISK_TEMPLATE_PATH");
        const driver = new FirecrackerSandboxDriver({
            binaryPath: required("FIRECRACKER_BINARY_PATH"), jailerPath: required("FIRECRACKER_JAILER_PATH"),
            kernelPath: required("FIRECRACKER_KERNEL_PATH"), rootfsPath: required("FIRECRACKER_ROOTFS_PATH"),
            workspaceDiskTemplatePath: template, vmRuntimeRoot: runtimeRoot, useJailer: true, snapshotsEnabled: false,
        });
        const store = new InMemorySandboxStore();
        return new MicrovmSandboxProvider(store as unknown as SandboxStore, new EnvironmentSecretProvider({}), {
            driver, workspaceDiskTemplatePath: template, vmRuntimeRoot: runtimeRoot, workspaceCommitRoot: captures,
        });
    })();
const policy = { ...unrestrictedPolicy, id: "live-policy", runId: "live-run", userId: "live-user",
    sandboxProfile: "strict" as const, layers: [], createdAt: new Date().toISOString(),
    workspaceRoots: [workspace], allowNetwork: false, allowedSecrets: [] };
const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
let passed = false;
try {
    await Promise.all(ids.map((id) => provider.create({ id, runId: id, workspacePath: workspace, policy })));
    const commands = ["printf A > /workspace/shared", "printf B > /workspace/other", "printf C > /workspace/shared; printf C > /workspace/partial"];
    const results = await Promise.all(ids.map((id, index) => provider.execute(id, ["/bin/sh", "-c", commands[index]!] )));
    assert(results.every((result) => result.exitCode === 0), "guest commands failed");
    await Promise.all([provider.terminate(ids[0]!), provider.terminate(ids[1]!)]);
    await assert.rejects(provider.terminate(ids[2]!), /提交冲突/);
    assert.equal(await readFile(join(workspace, "shared"), "utf8"), "A");
    assert.equal(await readFile(join(workspace, "other"), "utf8"), "B");
    await assert.rejects(readFile(join(workspace, "partial")));
    console.log("LIVE PASS: real Firecracker VMs, parallel disjoint commits, same-file conflict, no partial commit");
    passed = true;
} finally {
    if ("close" in provider) await provider.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`LIVE TEST evidence retained: ${root}`);
}
