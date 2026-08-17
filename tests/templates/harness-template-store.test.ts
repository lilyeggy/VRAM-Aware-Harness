import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createHarnessTemplate,
    createPiTemplateVersion,
} from "../../src/templates/harness-template.ts";
import type {
    CreatePiTemplateVersionInput,
} from "../../src/templates/harness-template.ts";
import {
    HarnessTemplateStore,
} from "../../src/templates/harness-template-store.ts";
import {
    openHarnessDatabase,
} from "../../src/storage/database.ts";

const createdAt = "2026-08-09T10:00:00.000Z";

function template(id = "template-1") {
    return createHarnessTemplate({
        id,
        tenantId: "tenant-1",
        createdAt,
    });
}

function version(
    overrides: Partial<CreatePiTemplateVersionInput> = {},
) {
    return createPiTemplateVersion({
        id: "template-version-1",
        templateId: "template-1",
        version: 1,
        provider: "openai-compatible",
        modelId: "qwen3-coder",
        tools: ["read"],
        createdAt,
        ...overrides,
    });
}

test("创建并读取带租户归属的 HarnessTemplate", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new HarnessTemplateStore(db);

    try {
        const created = template();
        store.createTemplate(created);

        const restored = store.getTemplate(created.id);
        expect(restored).toEqual(created);
        expect(Object.isFrozen(restored)).toBe(true);
        expect(store.getTemplate("missing")).toBeNull();
    } finally {
        db.close();
    }
});

test("按连续版本发布并按版本号读取不可变配置", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new HarnessTemplateStore(db);

    try {
        store.createTemplate(template());
        const first = version();
        const second = version({
            id: "template-version-2",
            version: 2,
            modelId: "qwen3-coder-next",
            tools: ["read", "write"],
            createdAt: "2026-08-09T11:00:00.000Z",
        });

        store.publishVersion("template-1", first);
        store.publishVersion("template-1", second);

        expect(store.getVersion(first.id)).toEqual(first);
        expect(store.getVersion("missing")).toBeNull();
        expect(store.listVersions("template-1")).toEqual([
            first,
            second,
        ]);

        const restored = store.getVersion(second.id);
        expect(Object.isFrozen(restored)).toBe(true);
        expect(Object.isFrozen(restored?.spec)).toBe(true);
        expect(Object.isFrozen(restored?.spec.tools)).toBe(true);
    } finally {
        db.close();
    }
});

test("发布版本拒绝不存在或不匹配的目标模板", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new HarnessTemplateStore(db);

    try {
        expect(() => {
            store.publishVersion("missing", version());
        }).toThrow("找不到 HarnessTemplate：missing");

        store.createTemplate(template());
        expect(() => {
            store.publishVersion(
                "template-1",
                version({ templateId: "template-2" }),
            );
        }).toThrow(
            "模板 ID 不匹配：期望 template-1，实际 template-2",
        );
        expect(store.listVersions("template-1")).toEqual([]);
    } finally {
        db.close();
    }
});

test("发布版本拒绝首版错误、跳号和覆盖已有版本", () => {
    const db = openHarnessDatabase(":memory:");
    const store = new HarnessTemplateStore(db);

    try {
        store.createTemplate(template());

        expect(() => {
            store.publishVersion(
                "template-1",
                version({ id: "version-2", version: 2 }),
            );
        }).toThrow("模板版本号不连续：期望 1，实际 2");

        const first = version();
        store.publishVersion("template-1", first);

        expect(() => {
            store.publishVersion(
                "template-1",
                version({ id: "version-3", version: 3 }),
            );
        }).toThrow("模板版本号不连续：期望 2，实际 3");

        expect(() => {
            store.publishVersion(
                "template-1",
                version({ modelId: "changed-model" }),
            );
        }).toThrow("模板版本号不连续：期望 2，实际 1");

        expect(store.getVersion(first.id)).toEqual(first);
    } finally {
        db.close();
    }
});

test("模板和版本在关闭并重新打开数据库后仍可恢复", () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-template-store-"));
    const databasePath = join(directory, "harness.sqlite");
    const createdTemplate = template();
    const createdVersion = version();

    try {
        const firstDatabase = openHarnessDatabase(databasePath);
        try {
            const firstStore = new HarnessTemplateStore(firstDatabase);
            firstStore.createTemplate(createdTemplate);
            firstStore.publishVersion(createdTemplate.id, createdVersion);
        } finally {
            firstDatabase.close();
        }

        const reopenedDatabase = openHarnessDatabase(databasePath);
        try {
            const reopenedStore = new HarnessTemplateStore(reopenedDatabase);
            expect(reopenedStore.getTemplate(createdTemplate.id)).toEqual(
                createdTemplate,
            );
            expect(reopenedStore.getVersion(createdVersion.id)).toEqual(
                createdVersion,
            );
        } finally {
            reopenedDatabase.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
