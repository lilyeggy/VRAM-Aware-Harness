import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { FirecrackerSandboxDriver } from "../../src/sandbox/microvm/firecracker-sandbox-driver.ts";

interface PutSocketAccess {
    putSocket(
        socketPath: string,
        path: string,
        payload: unknown,
        method?: "PUT" | "PATCH",
        timeoutMs?: number,
    ): Promise<void>;
}

test("putSocket 在 Firecracker API 无响应时超时失败，不无限挂起", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-api-timeout-"));
    const socketPath = join(dir, "firecracker.socket");
    // 只接受连接、不返回任何 HTTP 响应：模拟 Firecracker API 卡死。
    const server = Bun.listen({
        unix: socketPath,
        socket: {
            data() {
                // 故意不响应。
            },
        },
    });
    try {
        const driver = new FirecrackerSandboxDriver({ useJailer: true });
        const access = driver as unknown as PutSocketAccess;
        const startedAt = Date.now();
        await expect(
            access.putSocket(socketPath, "/machine-config", {}, "PUT", 100),
        ).rejects.toThrow("Firecracker API 超时");
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
        server.stop(true);
        rmSync(dir, { recursive: true, force: true });
    }
});
