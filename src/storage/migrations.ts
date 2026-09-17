import { readFileSync } from "node:fs";

export interface SchemaMigration {
    readonly version: number;
    readonly name: string;
    readonly up: string;
}

const initialSchema = readFileSync(
    new URL("./schema.sql", import.meta.url),
    "utf8",
);

/**
 * 精简后的数据库只有一版初始 schema。
 *
 * 旧项目的 22 个增量 migration 已在简历项目阶段压平；尚未部署过需要
 * 在线升级的生产数据库，因此不再保留历史迁移链。
 */
export const migrations: readonly SchemaMigration[] = [
    {
        version: 1,
        name: "initial_schema",
        up: initialSchema,
    },
];
