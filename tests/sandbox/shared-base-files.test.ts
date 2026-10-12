import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareBaseFile, SHARED_BASE_FILE_MODE } from "../../src/sandbox/microvm/shared-base-files.ts";

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "share-base-"));
}

describe("shareBaseFile：共享只读基础文件", () => {
    test("优先硬链接：同 inode、零拷贝、权限 0444", async () => {
        const root = makeRoot();
        try {
            const src = join(root, "rootfs.ext4");
            const dst = join(root, "vm-a", "rootfs.ext4");
            writeFileSync(src, "rootfs-content");
            const outcome = await shareBaseFile(src, dst, {
                fallbackCopy: async () => {
                    throw new Error("不应走到复制兜底");
                },
                mode: SHARED_BASE_FILE_MODE,
            });
            expect(outcome).toBe("linked");
            expect(statSync(src).ino).toBe(statSync(dst).ino);
            expect(statSync(dst).mode & 0o777).toBe(SHARED_BASE_FILE_MODE);
            expect(readFileSync(dst, "utf8")).toBe("rootfs-content");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("跨设备/无权限时退化为复制，仍然只读", async () => {
        const root = makeRoot();
        try {
            const src = join(root, "mem.snap");
            const dst = join(root, "vm-b", "restore.mem");
            writeFileSync(src, "mem-content");
            let copied = 0;
            const outcome = await shareBaseFile(src, dst, {
                link: () => {
                    const err = new Error("EXDEV") as Error & { code?: string };
                    err.code = "EXDEV";
                    throw err;
                },
                fallbackCopy: async (from, to) => {
                    copied += 1;
                    writeFileSync(to, readFileSync(from));
                },
                mode: SHARED_BASE_FILE_MODE,
            });
            expect(outcome).toBe("copied");
            expect(copied).toBe(1);
            expect(statSync(src).ino).not.toBe(statSync(dst).ino);
            expect(statSync(dst).mode & 0o777).toBe(SHARED_BASE_FILE_MODE);
            expect(readFileSync(dst, "utf8")).toBe("mem-content");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("未显式传 mode 时保持源权限：硬链接不得改动操作员模板", async () => {
        const root = makeRoot();
        try {
            const src = join(root, "rootfs.ext4");
            mkdirSync(join(root, "vm-d"), { recursive: true });
            const dst = join(root, "vm-d", "rootfs.ext4");
            writeFileSync(src, "template");
            chmodSync(src, 0o664);
            const outcome = await shareBaseFile(src, dst, {
                fallbackCopy: async (from, to) => {
                    writeFileSync(to, readFileSync(from));
                },
            });
            expect(outcome).toBe("linked");
            // 硬链接共用 inode：这里若 chmod，模板本身会被改掉，
            // 后续走"复制"的路径会继承该权限（真机踩坑：0444 → Firecracker EACCES）
            expect(statSync(src).mode & 0o777).toBe(0o664);
            expect(statSync(dst).mode & 0o777).toBe(0o664);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("目标已存在时不重复链接（幂等）", async () => {
        const root = makeRoot();
        try {
            const src = join(root, "kernel.bin");
            const dst = join(root, "vm-c", "kernel.bin");
            writeFileSync(src, "kernel");
            mkdirSync(join(root, "vm-c"), { recursive: true });
            writeFileSync(dst, "already-there");
            const outcome = await shareBaseFile(src, dst, {
                link: () => {
                    throw new Error("不应再链接");
                },
                fallbackCopy: async () => {
                    throw new Error("不应再复制");
                },
            });
            expect(outcome).toBe("already-present");
            expect(existsSync(dst)).toBe(true);
            expect(readFileSync(dst, "utf8")).toBe("already-there");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
