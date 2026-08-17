/**
 * Harness 的 SQLite 入口。
 *
 * 这一层只做基础设施工作：
 * 1. 打开或创建 SQLite 文件；
 * 2. 配置 SQLite 连接级别的行为，比如外键约束；
 * 3. 执行还没有应用过的 schema migration。
 *
 * 注意：这里不写 AgentRun / RunEvent 的业务读写方法。
 * 业务读写应该放到后续的 RunStore 里，这样 database.ts 保持成
 * “数据库连接 + schema 初始化”的小边界。
 */

import {Database} from "bun:sqlite"

import {migrations} from "./migrations.ts"


/**
 * 打开 Harness 使用的 SQLite 数据库。
 *
 * databasePath 可以是：
 * - 一个真实文件路径：用于本地开发或生产持久化；
 * - ":memory:"：用于测试，数据库只存在于当前进程内存里。
 *
 * 这里在返回 db 之前先执行 configureDatabase 和 runMigrations，
 * 目的是让调用方拿到的 Database 一定已经处于“可用 schema”状态。
 * 后续代码不需要每次都记得手动初始化数据库。
 */
export function openHarnessDatabase(databasePath:string): Database{
    const db = new Database(databasePath,{
        // 如果文件不存在就创建。SQLite 很适合这个项目早期阶段：
        // 单文件、无服务进程、测试里可以直接用内存库。
        create:true,

        // Bun SQLite 默认允许“参数名拼错但不报错”的宽松绑定。
        // strict: true 可以让 SQL 参数绑定错误尽早暴露，适合我们写基础设施代码。
        strict:true,
    });

    configureDatabase(db);
    runMigrations(db);

    return db;
}


/**
 * 配置当前 SQLite 连接。
 *
 * SQLite 的 PRAGMA 通常是“连接级别”的设置，不是永久写死在数据库文件里。
 * 所以每次打开一个新的 Database 连接，都需要重新开启这些行为。
 */
function configureDatabase(db:Database):void {
    // SQLite 默认不强制执行 FOREIGN KEY。
    // migration v1 里 run_events.run_id 引用了 agent_runs.id；
    // 如果不开启 foreign_keys，就算写入不存在的 run_id，SQLite 也可能放行。
    db.exec("PRAGMA foreign_keys = ON;")
}

/**
 * 创建 migration 账本表。
 *
 * schema_migrations 不是业务表，它记录“哪些数据库版本已经应用过”。
 * 有了这张表，runMigrations 就可以重复调用，而且不会重复执行同一个 migration。
 */
function ensureMigrationTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            -- version 是 migration 的唯一编号。
            -- 当前项目里 v1 会创建 agent_runs 和 run_events。
            version INTEGER PRIMARY KEY CHECK (version > 0),

            -- name 主要给人看，方便调试时知道某个 version 做了什么。
            name TEXT NOT NULL,

            -- applied_at 记录应用时间。
            -- 用 SQLite 的 CURRENT_TIMESTAMP 即可，不需要 TypeScript 传入时间。
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

/**
 * SELECT 当前 schema 版本时，Bun SQLite 返回的是普通对象。
 * 这个接口告诉 TypeScript：查询结果里会有一个 number 类型的 version 字段。
 */
interface CurrentVersionRow {
    version: number;
}

/**
 * 读取当前数据库已经应用到的最高 migration 版本。
 *
 * 新数据库里 schema_migrations 为空，此时 MAX(version) 会是 NULL。
 * COALESCE(..., 0) 把它转成 0，意思是“还没有应用任何 migration”。
 */
function getCurrentSchemaVersion(db: Database): number {
    const row = db
        .query<CurrentVersionRow, []>(`
            SELECT COALESCE(MAX(version), 0) AS version
            FROM schema_migrations;
        `)
        .get();

    return row?.version ?? 0;
}


/**
 * 执行所有还没有应用过的 migration。
 *
 * 这个函数可以安全重复调用：
 * - 第一次打开新库时，currentVersion 是 0，会执行 v1；
 * - 后续再打开同一个库时，currentVersion 已经是 1，不会重复建表。
 *
 * 这里用 transaction 包住所有 pending migrations。
 * 如果中途任何一个 migration 失败，SQLite 会回滚这次事务，
 * 避免出现“表创建了一半，但 schema_migrations 已经写入版本号”的不一致状态。
 */
export function runMigrations(db: Database): void {
    ensureMigrationTable(db);

    const currentVersion = getCurrentSchemaVersion(db);

    // 只执行版本号大于当前数据库版本的 migration。
    // 当前只有 v1；未来加 v2、v3 时，只要继续往 migrations 数组追加即可。
    const pendingMigrations = migrations.filter(
        (migration) => migration.version > currentVersion,
    );

    const applyPendingMigrations = db.transaction(() => {
        for (const migration of pendingMigrations) {
            // migration.up 是一整段 DDL，里面可能包含多条 CREATE TABLE / CREATE INDEX。
            // db.exec 适合执行这种“不需要返回行”的 SQL。
            db.exec(migration.up);

            // 业务 schema 创建成功之后，再把版本写入 migration 账本。
            // 这里使用参数绑定，而不是字符串拼接，保持 SQL 写法一致且避免注入风险。
            db.query<unknown, { version: number; name: string }>(`
                INSERT INTO schema_migrations (version, name)
                VALUES ($version, $name);
            `).run({
                version: migration.version,
                name: migration.name,
            });
        }
    });

    applyPendingMigrations();
}
