
import { expect, test } from "bun:test";
import { buildWorkerEnvironment } from "../../src/runtime/worker-process-runtime.ts";

test("broker 模式下 worker 环境白名单不包含宿主 secret", () => {
    const previous = process.env.HARNESS_BOOTSTRAP_API_KEY;
    process.env.HARNESS_BOOTSTRAP_API_KEY = "super-secret";
    try {
        const environment = buildWorkerEnvironment("run-1", {
            inheritEnv: false,
            extraEnv: { HARNESS_SANDBOX_BROKER_SOCKET: "/tmp/broker.sock" },
            path: "/usr/bin",
        });
        expect(environment.HARNESS_RUN_ID).toBe("run-1");
        expect(environment.PATH).toBe("/usr/bin");
        expect(environment.HARNESS_SANDBOX_BROKER_SOCKET).toBe("/tmp/broker.sock");
        expect(environment.HARNESS_BOOTSTRAP_API_KEY).toBeUndefined();
    } finally {
        if (previous === undefined) {
            delete process.env.HARNESS_BOOTSTRAP_API_KEY;
        } else {
            process.env.HARNESS_BOOTSTRAP_API_KEY = previous;
        }
    }
});

test("默认继承模式仍保留历史行为", () => {
    process.env.HARNESS_TEST_INHERIT = "yes";
    try {
        const environment = buildWorkerEnvironment("run-2", {});
        expect(environment.HARNESS_TEST_INHERIT).toBe("yes");
    } finally {
        delete process.env.HARNESS_TEST_INHERIT;
    }
});
