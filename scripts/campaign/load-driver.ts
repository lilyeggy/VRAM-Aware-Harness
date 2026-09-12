#!/usr/bin/env bun
/**
 * load-driver.ts — VRAM-Aware-Harness 统一发压器（P0 阻塞夹具）
 *
 * 覆盖 docs/full-scenario-test-guide.zh-CN.md §9.4 的全部结构：
 *   1) 固定 seed 读配置 / 任务样本 / 账号，预建 User / Workspace / Conversation 并记录 ID
 *      （准备耗时单独计时，不计入任务执行延迟）
 *   2) 闭环模式（closed）：固定 C 个客户端，每个任务终态后再发下一个
 *   3) 开环模式（open）：按固定或带抖动的到达率发送，不等上一个完成
 *   4) 独立采样器：每 1–5s append-only 写 requests.jsonl / resources.jsonl / process-samples.jsonl
 *   5) 每个请求唯一 caseId；POST 超时/网络错误进“接受情况未知”队列，严禁自动重发
 *   6) 集中 poller：1.6–5s 抖动错峰轮询，限制查询并发（不是每个任务一个 100ms 循环）
 *   7) 终态后采集 events/output/workspace-diff/artifacts，并跑确定性外部验收器（不复用模型自评）
 *   8) 客户端停止阈值（总量 / 时长 / 开环在途 / 控制面失联 / 队列上限）+ 有界排空；
 *      未收敛任务逐个记录，可选 API 中断
 *   9) 汇总满足守恒：计划发送 = 实际发送 + 未发；实际发送 = 202接受 + 明确拒绝 + 接受未知
 *
 * 只使用标准 HTTP（fetch）与 Node/Bun 标准库，不引第三方依赖。
 *
 * 用法（在远端实例目录下，先 source campaign.env 以便采样 SQLite WAL）：
 *   set -a; source campaign.env; set +a
 *   bun run load-driver.ts --mode closed --concurrency 2 --task t1 \
 *       --duration-s 60 --total 100000 --out evidence/load/smoke
 *
 * 关键参数见 --help。C（客户端在途数）与到达率都可由 CLI/配置覆盖，供后续
 * 并发阶梯 / 到达率阶梯 / 稳定吞吐复用。
 */

import {
    appendFileSync,
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    statfsSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { freemem, hostname, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// 配置与参数
// ---------------------------------------------------------------------------

type Mode = "closed" | "open";

interface Config {
    baseUrl: string;
    mode: Mode;
    concurrency: number;          // 闭环客户端数 C；开环不用于驱动
    arrivalRate: number;          // 开环到达率（任务/s）
    arrivalDist: "fixed" | "exponential";
    arrivalJitter: number;        // 0..1，固定间隔的 ±抖动比例
    taskFamily: string;
    users: number;
    workspaceRoot: string | null;   // 服务端 Workspace 根；用于投放夹具与磁盘外部验收
    fixtureRoot: string;            // 固定夹具快照根
    mixRatios: string;              // §9.2 混合比例，格式 a:b:c:d:e
    t8Stages: number;
    t8StageWait: number;
    t6FillerChars: number;          // T6 长输入填充字符数（L3/L4）
    t7Modules: number;              // T7 模块数（§6.1 全量为 20；7B 单轮可下调以跑通样本）
    t7Buggy: number[];              // T7 含缺陷模块编号（1-based）
    t7RequireAllReads: boolean;     // T7 是否要求读全 N 个模块（§6.1 严格档；默认宽松）
    planOnly: boolean;              // 只按 seed 生成任务族计划并落盘，不发请求（验证混合可复现）
    total: number;                // 计划提交上限（客户端停止阈值）
    durationS: number;            // 提交窗口上限（客户端停止阈值）
    drainS: number;               // 停止提交后的有界排空时长
    maxOpenInflight: number;      // 开环客户端在途（已 202 未终态）停止阈值
    queueLimit: number;           // 观测队列长度停止阈值；0=关闭
    pollMinMs: number;
    pollMaxMs: number;
    pollConcurrency: number;
    sampleMinMs: number;
    sampleMaxMs: number;
    requestTimeoutMs: number;     // POST 超时 → 接受未知
    getTimeoutMs: number;
    runTimeoutMs: number;         // 单 run 等待终态上限；0=只用排空窗口
    maxConsecutivePollErrors: number;
    seed: number;
    tag: string;
    out: string;
    overwrite: boolean;
    interruptRemaining: boolean;
    acceptorCmd: string | null;
    configPath: string | null;
    artifactMaxCount: number;
    artifactMaxBytes: number;
    accountPrefix: string;
}

const DEFAULTS: Config = {
    baseUrl: process.env.HARNESS_BASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:13010",
    mode: "closed",
    concurrency: 2,
    arrivalRate: 1,
    arrivalDist: "fixed",
    arrivalJitter: 0,
    taskFamily: "t1",
    users: 1,
    workspaceRoot: process.env.HARNESS_WORKSPACE_ROOT ?? null,
    fixtureRoot: process.env.HARNESS_FIXTURE_ROOT ?? "/home/f630/homePLUS/harness-fixtures",
    mixRatios: "25:30:20:15:10",
    t8Stages: 5,
    t8StageWait: 10,
    t6FillerChars: 0,
    t7Modules: 20,
    t7Buggy: [3, 7, 11, 15, 19],
    t7RequireAllReads: false,
    planOnly: false,
    total: 100000,
    durationS: 60,
    drainS: 120,
    maxOpenInflight: 1000,
    queueLimit: 0,
    pollMinMs: 1600,
    pollMaxMs: 5000,
    pollConcurrency: 4,
    sampleMinMs: 1000,
    sampleMaxMs: 5000,
    requestTimeoutMs: 20000,
    getTimeoutMs: 30000,
    runTimeoutMs: 0,
    maxConsecutivePollErrors: 20,
    seed: 13010,
    tag: "ld",
    out: "evidence/load/run",
    overwrite: false,
    interruptRemaining: true,
    acceptorCmd: null,
    configPath: null,
    artifactMaxCount: 50,
    artifactMaxBytes: 20 * 1024 * 1024,
    accountPrefix: "ld",
};

function parseArgs(argv: string[]): Config {
    const cfg: Config = { ...DEFAULTS };
    const num = (v: string) => Number(v);
    const bool = (v: string) => v === "1" || v.toLowerCase() === "true" || v === "yes";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`参数 ${a} 缺少值`);
            return v;
        };
        switch (a) {
            case "--help": case "-h": printHelp(); process.exit(0); break;
            case "--base-url": cfg.baseUrl = next().replace(/\/$/, ""); break;
            case "--mode": cfg.mode = next() as Mode; break;
            case "--concurrency": case "-C": cfg.concurrency = num(next()); break;
            case "--arrival-rate": case "--rate": cfg.arrivalRate = num(next()); break;
            case "--arrival-dist": cfg.arrivalDist = next() as Config["arrivalDist"]; break;
            case "--arrival-jitter": cfg.arrivalJitter = num(next()); break;
            case "--task": cfg.taskFamily = next(); break;
            case "--users": cfg.users = num(next()); break;
            case "--workspace-root": cfg.workspaceRoot = next(); break;
            case "--fixture-root": cfg.fixtureRoot = next(); break;
            case "--mix-ratios": cfg.mixRatios = next(); break;
            case "--t8-stages": cfg.t8Stages = num(next()); break;
            case "--t8-stage-wait": cfg.t8StageWait = num(next()); break;
            case "--t6-filler-chars": cfg.t6FillerChars = num(next()); break;
            case "--t7-modules": cfg.t7Modules = num(next()); break;
            case "--t7-buggy": cfg.t7Buggy = next().split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)); break;
            case "--t7-require-all-reads": cfg.t7RequireAllReads = bool(next()); break;
            case "--plan-only": cfg.planOnly = bool(next()); break;
            case "--total": cfg.total = num(next()); break;
            case "--duration-s": cfg.durationS = num(next()); break;
            case "--drain-s": cfg.drainS = num(next()); break;
            case "--max-open-inflight": cfg.maxOpenInflight = num(next()); break;
            case "--queue-limit": cfg.queueLimit = num(next()); break;
            case "--poll-min-ms": cfg.pollMinMs = num(next()); break;
            case "--poll-max-ms": cfg.pollMaxMs = num(next()); break;
            case "--poll-concurrency": cfg.pollConcurrency = num(next()); break;
            case "--sample-min-ms": cfg.sampleMinMs = num(next()); break;
            case "--sample-max-ms": cfg.sampleMaxMs = num(next()); break;
            case "--request-timeout-ms": cfg.requestTimeoutMs = num(next()); break;
            case "--get-timeout-ms": cfg.getTimeoutMs = num(next()); break;
            case "--run-timeout-ms": cfg.runTimeoutMs = num(next()); break;
            case "--max-consecutive-poll-errors": cfg.maxConsecutivePollErrors = num(next()); break;
            case "--seed": cfg.seed = num(next()); break;
            case "--tag": cfg.tag = next(); break;
            case "--out": cfg.out = next(); break;
            case "--overwrite": cfg.overwrite = bool(next()); break;
            case "--interrupt-remaining": cfg.interruptRemaining = bool(next()); break;
            case "--acceptor-cmd": cfg.acceptorCmd = next(); break;
            case "--config": cfg.configPath = next(); break;
            case "--artifact-max-count": cfg.artifactMaxCount = num(next()); break;
            case "--artifact-max-bytes": cfg.artifactMaxBytes = num(next()); break;
            case "--account-prefix": cfg.accountPrefix = next(); break;
            default: throw new Error(`未知参数：${a}（--help 查看用法）`);
        }
    }
    return cfg;
}

function printHelp(): void {
    console.log(`统一发压器 load-driver.ts

  --base-url <url>            Harness 地址（默认 $HARNESS_BASE_URL 或 127.0.0.1:13010）
  --mode closed|open          闭环 / 开环（默认 closed）
  -C, --concurrency <n>       闭环客户端数 C（默认 2）
  --rate, --arrival-rate <r>  开环到达率 任务/s（默认 1）
  --arrival-dist fixed|exponential  到达间隔分布（默认 fixed）
  --arrival-jitter <0..1>     固定间隔的 ±抖动比例（默认 0）
  --task <family>             任务族 t1|t2|t3|t4|t6|t7|t8|t10|mixed（默认 t1）
                              t4/t7/t8/t10 需要 bash → 必须 container/runsc 档
  --users <n>                 预建账号数（默认 1）
  --workspace-root <dir>      服务端 Workspace 根（$HARNESS_WORKSPACE_ROOT）；投夹具与磁盘验收必需
  --fixture-root <dir>        固定夹具快照根（默认 /home/f630/homePLUS/harness-fixtures）
  --mix-ratios <a:b:c:d:e>    混合模式比例，对应 [T1/T2]:[T3/T4/T10]:T6:T7:T8（默认 25:30:20:15:10）
  --t8-stages <n>             T8 slow-job 阶段数（默认 5）
  --t8-stage-wait <s>         T8 每阶段等待秒数（默认 10）
  --t6-filler-chars <n>       T6 输入追加的无关背景字符数（L3/L4，默认 0）
  --t7-modules <n>            T7 模块数（默认 20；7B 单轮可下调）
  --t7-buggy <a,b,...>        T7 含缺陷模块编号（默认 3,7,11,15,19）
  --t7-require-all-reads 0|1  1=严格按 §6.1 要求读全 N 个模块；0=只要求按序读过被修改的模块（默认 0）
  --total <n>                 计划提交上限（停止阈值）
  --duration-s <s>            提交窗口上限（停止阈值）
  --drain-s <s>               停止提交后的有界排空
  --max-open-inflight <n>     开环在途（已 202 未终态）停止阈值
  --queue-limit <n>           观测队列长度停止阈值；0=关闭
  --poll-min-ms/--poll-max-ms 轮询间隔抖动范围（默认 1600/5000）
  --poll-concurrency <n>      集中 poller 并发上限（默认 4）
  --sample-min-ms/--sample-max-ms  独立采样器间隔（默认 1000/5000）
  --request-timeout-ms <ms>   POST 超时→接受未知（默认 20000）
  --get-timeout-ms <ms>       采集 GET 超时（默认 30000）
  --run-timeout-ms <ms>       单 run 等待终态上限；0=只用排空窗口
  --max-consecutive-poll-errors <n>  控制面失联停止阈值（默认 20）
  --seed <n>                  固定随机种子
  --tag <s>                   本轮标签（caseId/账号前缀）
  --out <dir>                 证据目录
  --overwrite 1               允许写非空目录
  --interrupt-remaining 0|1   排空后是否中断未收敛 run（默认 1）
  --acceptor-cmd <cmd>        外部验收命令（可选，stdin=JSON / stdout=JSON）
  --config <file>             读取 campaign 配置（params 覆盖默认）
  --plan-only 0|1             只按 seed 生成任务族计划并写 plan-only.json，不发请求
  --help`);
}

// ---------------------------------------------------------------------------
// 固定种子 PRNG（mulberry32）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// 类型与全局状态
// ---------------------------------------------------------------------------

interface FamilyContext {
    family: string; fixture: string;
    workspaceId: string; conversationId: string; root: string;
}
interface Session {
    index: number; email: string; tenantId: string; userId: string;
    /** 兼容旧输出：首个任务族的 workspace/conversation。 */
    workspaceId: string; conversationId: string; token: string;
    /** 每个任务族独立的 Workspace（避免 T4 修改污染 T2/T6 等）。 */
    contexts: Record<string, FamilyContext>;
}
interface CaseDef { seq: number; caseId: string; taskFamily: string; input: string; expected?: unknown; }
interface AcceptanceResult {
    status: "PASS" | "FAIL" | "NOT_RUN" | "INCONCLUSIVE";
    checker: string; detail: string;
    checks: Array<{ name: string; ok: boolean | null; detail: string }>;
}
interface TerminalResult { status: string; seenAt: number; polls: number; acceptance: AcceptanceResult | null; nonConverged: boolean; }
interface Inflight {
    seq: number; caseId: string; runId: string; sess: Session;
    family: string; ctx: FamilyContext;
    sentAt: number; sentWall: number; nextPollAt: number; polls: number;
    lastStatus: string | null; settled: boolean;
    lastAcceptance: AcceptanceResult | null;
    resolve: (v: TerminalResult) => void;
}
interface Stats {
    planned: number; actualSent: number; accepted202: number; explicitReject: number;
    acceptUnknown: number; reconciledUnknown: number;
    completed: number; failed: number; interrupted: number; nonConverged: number; interruptedByDriver: number;
    acceptancePass: number; acceptanceFail: number; acceptanceNotRun: number;
    pollRequestsTotal: number; pollStatusChanges: number; pollErrors: number; consecutivePollErrors: number;
    harnessActiveMax: number; harnessActiveSamples: number[]; queuedMax: number;
    vllmRunningMax: number; vllmRunningSamples: number[];
    clientInflightMax: number; queueLenMax: number;
    samplerTicks: number; resourceSamples: number; processSamples: number;
    eventLoopLagMaxMs: number;
    byFamilyPlanned: Record<string, number>;
    byFamilyCompleted: Record<string, number>;
    byFamilyAccept: Record<string, { pass: number; fail: number; notRun: number }>;
}

const cfg: Config = parseArgs(process.argv.slice(2));
const prng = mulberry32(cfg.seed);
const rnd = () => prng();
const jitterMs = (min: number, max: number) => min + rnd() * Math.max(0, max - min);
const mono = () => performance.now();
const sleep = (ms: number) => Bun.sleep(Math.max(0, ms));
const iso = (wall: number) => new Date(wall).toISOString();

let stats: Stats;
let sessions: Session[] = [];
let tasks: Record<string, (c: { caseId: string; seq: number }) => { input: string; expected?: unknown }> = {};
const inflight = new Map<string, Inflight>();
const pendingCollect = new Set<Promise<void>>();
const pendingUnknown: Array<{ seq: number; caseId: string; taskFamily: string; ctx: FamilyContext; sess: Session }> = [];

// ---------------------------------------------------------------------------
// §6.1 任务族注册表：每个任务族的夹具、是否需要 bash、外部验收器
// ---------------------------------------------------------------------------

type FixtureKind = "none" | "base-project" | "slow-job" | "fault-project" | "t7-project";
const ALL_FAMILIES = ["t1", "t2", "t3", "t4", "t6", "t7", "t8", "t10"] as const;
const MIX_FAMILIES: readonly string[] = ALL_FAMILIES;
const FAMILY_FIXTURE: Record<string, FixtureKind> = {
    t1: "none", t2: "base-project", t3: "none", t4: "base-project", t6: "base-project",
    t7: "t7-project", t8: "slow-job", t10: "fault-project",
};
/** bash 被 tool-policy-guard fail-closed 绑定到 container/runsc 档（见 split-plan §3）。 */
const BASH_FAMILIES = new Set(["t4", "t7", "t8", "t10"]);
// 任务执行前基线（T4/T7/T10 的"先失败"证据）与启动时容器清单（T8 残留判定）
let baselineByFamily: Record<string, any> = {};
let harnessContainersBaseline: string[] = [];

let stopSubmitting = false;
let stopReason = "";
let pollerStop = false;
let samplerStop = false;
let observerStop = false;
let runStartWall = 0;
let runStartedAt = 0;
let plannerSeq = 0;
let acceptedInflight = 0;
let submitInflight = 0;
let eventLoopLagMax = 0;
let eventLoopLast = mono();
let forceExitCode: number | null = null;
let ledger: Ledger;

class Ledger {
    private pending: string[] = [];
    private linesWritten = 0;
    constructor(private readonly path: string) {}
    emit(kind: string, obj: Record<string, unknown>): void {
        this.pending.push(JSON.stringify({ kind, at: new Date().toISOString(), mono: mono(), ...obj }));
        if (this.pending.length >= 500) this.flush();
    }
    flush(): void {
        if (this.pending.length === 0) return;
        appendFileSync(this.path, this.pending.join("\n") + "\n");
        this.linesWritten += this.pending.length;
        this.pending = [];
    }
    get written(): number { return this.linesWritten; }
    get buffered(): number { return this.pending.length; }
}

// ---------------------------------------------------------------------------
// HTTP 与工具
// ---------------------------------------------------------------------------

async function api(
    token: string | null, path: string, method = "GET", body?: unknown,
    timeoutMs = cfg.getTimeoutMs,
): Promise<{ ok: boolean; status: number | null; data: any; error: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout>${timeoutMs}ms`)), timeoutMs);
    try {
        const res = await fetch(cfg.baseUrl + path, {
            method,
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await res.text();
        let data: any = null;
        try { data = text.length > 0 ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 500) }; }
        return { ok: res.ok, status: res.status, data, error: null };
    } catch (error) {
        return { ok: false, status: null, data: null, error: error instanceof Error ? error.message : String(error) };
    } finally { clearTimeout(timer); }
}

function hashFile(path: string): string {
    try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return "sha256:unavailable"; }
}

/** 两个文件哈希相等且都真实可用（避免夹具缺失时 "unavailable" == "unavailable" 误判）。 */
function sameFileHash(a: string, b: string): boolean {
    const ha = hashFile(a), hb = hashFile(b);
    return ha !== "sha256:unavailable" && hb !== "sha256:unavailable" && ha === hb;
}

function buildTasks(): void {
    tasks = {
        t1: ({ caseId }) => ({
            // 保持指南 §6.1 的固定样本措辞（验收标准固定为 391）；措辞变化会改变
            // 温度 0 下 7B 模型的确定性输出（见交付说明“已知限制/发现”）。
            // t1 措辞已冻结：不可改动。
            input: `计算 17×23，只返回整数，不要读写任何文件。caseId=${caseId}`,
            expected: 391,
        }),
        t3: ({ caseId }) => ({
            input: `请在工作区创建文件 result.json，内容恰好为 {"caseId":"${caseId}","answer":42}，随后读取该文件验证，最终回答文件路径和完整内容。caseId=${caseId}`,
            expected: { caseId, answer: 42 },
        }),
        t2: ({ caseId }) => ({
            // 外部验收：真实 read 轨迹必须含 README.md 与 calc.py；零文件修改；
            // 结论与夹具一致：add 当前返回 a-b；至少列出 README 中 3 个函数的 I/O。
            input: `请用 read 工具读取当前工作区的 README.md 和 calc.py。然后用简洁条目回答：\n`
                + `(1) calc.py 中 add(a, b) 当前实际返回的是 a 减 b 还是 a 加 b；\n`
                + `(2) 列出 README 中描述的函数及其输入/输出，至少覆盖 add、area、perimeter、mean、reverse_words 中的三个。\n`
                + `不要修改任何文件。caseId=${caseId}`,
            expected: { addCurrently: "a-b", minFunctionsListed: 3 },
        }),
        t4: ({ caseId }) => ({
            input: `当前工作区是一个 Python 小项目，calc.py 中的 add 函数存在边界缺陷，公开测试会失败。`
                + `请阅读相关代码，修复 calc.py 中的缺陷，并用 bash 工具运行 sh run_tests.sh，直到输出 RUN_TESTS_PASS。`
                + `不要修改公开测试或保留测试来绕开失败，只允许修改 calc.py。完成后简述你改了什么。caseId=${caseId}`,
            expected: { runTestsPass: true },
        }),
        t6: ({ caseId }) => ({
            input: `请用 read 工具读取当前工作区的 orders.json，按 category 汇总 amount 的总和。`
                + `然后用 write 工具把结果写入当前工作区的 summary.json，格式恰好为 `
                + `{"books":<books总和>,"food":<food总和>,"toys":<toys总和>}，只含这三个键，值必须是整数。`
                + `写完用 read 读回确认，最终报告三个数值。caseId=${caseId}` + t6Filler(),
            expected: { books: 200, food: 150, toys: 200 },
        }),
        t7: ({ caseId }) => ({
            input: `当前工作区 modules/ 目录下有 mod01.py 到 mod${String(cfg.t7Modules).padStart(2, "0")}.py 共 ${cfg.t7Modules} 个文件，`
                + `其中若干文件的 compute 行为不正确。请严格按步骤完成：\n`
                + `1) 先用 bash 工具运行 python3 check_all.py；它会输出 T7_FAIL 并列出返回值不正确的模块编号，这是权威的缺陷清单；\n`
                + `2) 用 read 工具按 mod01 → mod${String(cfg.t7Modules).padStart(2, "0")} 的顺序逐个读取全部 ${cfg.t7Modules} 个文件（每个模块至少读一次，必须覆盖到 mod${String(cfg.t7Modules).padStart(2, "0")}）；\n`
                + `3) 参考正确模块的实现规律（第 i 个正确模块返回 x * i + i），只修复 check_all.py 指出的那些模块，`
                + `不要改动本来正确的模块（改动正确模块会让 check_all 出现更多错误）；用 edit 或 write 工具实际修改文件；\n`
                + `4) 再次用 bash 运行 python3 check_all.py，直到输出 T7_PASS。完成后列出你实际修改了哪些文件。caseId=${caseId}`,
            expected: { t7Pass: true, buggyModules: cfg.t7Buggy },
        }),
        t8: ({ caseId }) => ({
            input: `当前工作区根目录有 slow-job.sh。请用 bash 工具在前台执行下面这条命令，这是一次约 `
                + `${cfg.t8Stages * cfg.t8StageWait} 秒的可控慢任务，必须等待它执行结束（不要加 &、不要放到后台、不要超时中断）：\n\n`
                + `sh slow-job.sh --stages ${cfg.t8Stages} --stage-wait ${cfg.t8StageWait} --out progress --run-id ${caseId}\n\n`
                + `执行结束后，用 ls 读取 progress 目录，并报告其中有哪些 stage-*.done 文件以及 summary.json 的内容。caseId=${caseId}`,
            expected: { stages: cfg.t8Stages, stageWait: cfg.t8StageWait },
        }),
        t10: ({ caseId }) => ({
            input: `当前工作区中 greeting.py 存在边界缺陷，test_greeting.py 目前会失败。请严格按步骤完成：\n`
                + `1) 用 bash 工具运行 python3 test_greeting.py，确认真实失败输出；\n`
                + `2) 用 read 工具读取 greeting.py；\n`
                + `3) 必须用 edit 或 write 工具真实修改 greeting.py 文件（不要只在回答里给出代码块）：`
                + `在 greet 函数开头加入空字符串校验（name 为空时 raise ValueError），`
                + `必须保留原有的 \`return "Hello " + name\` 作为非空分支，不要删除它；\n`
                + `4) 用 bash 工具再次运行 python3 test_greeting.py，直到输出 GREETING_PASS。\n`
                + `不要修改 test_greeting.py 等测试文件。完成后简述你实际修改了什么。caseId=${caseId}`,
            expected: { greetingPass: true },
        }),
    };
    const known = cfg.taskFamily === "mixed" ? "mixed" : cfg.taskFamily;
    if (known !== "mixed" && !tasks[known]) {
        throw new Error(`未知任务族 ${cfg.taskFamily}，已知：${Object.keys(tasks).join(", ")}, mixed`);
    }
    if (known === "mixed") validateMixRatios();
    if (!Number.isInteger(cfg.t7Modules) || cfg.t7Modules < 1) throw new Error(`--t7-modules 必须是正整数，当前=${cfg.t7Modules}`);
    for (const m of cfg.t7Buggy) {
        if (!Number.isInteger(m) || m < 1 || m > cfg.t7Modules) throw new Error(`--t7-buggy 越界：${m}（模块数 ${cfg.t7Modules}）`);
    }
}

function t6Filler(): string {
    if (cfg.t6FillerChars <= 0) return "";
    const line = "背景资料（与订单汇总无关，请忽略，不要据此编造 category）：这是用于构造 L3/L4 长输入的占位段落。\n";
    let s = "";
    while (s.length < cfg.t6FillerChars) s += line;
    return "\n\n" + s.slice(0, cfg.t6FillerChars);
}

function validateMixRatios(): void {
    const parts = cfg.mixRatios.split(":").map((x) => Number(x));
    if (parts.length !== 5 || parts.some((x) => !Number.isFinite(x) || x < 0)) {
        throw new Error(`--mix-ratios 必须是 5 个非负数 a:b:c:d:e，当前=${cfg.mixRatios}`);
    }
}

/** 按 §9.2 比例抽取任务族；使用固定 seed 的 PRNG，可复现。 */
function pickMixedFamily(): string {
    // validateMixRatios 已保证恰好 5 个非负数；默认值只为满足 noUncheckedIndexedAccess
    const [a = 0, b = 0, c = 0, d = 0, e = 0] = cfg.mixRatios.split(":").map((x) => Number(x));
    const total = a + b + c + d + e;
    const r = rnd() * total;
    if (r < a) return rnd() < 0.5 ? "t1" : "t2";
    if (r < a + b) { const k = rnd(); return k < 1 / 3 ? "t3" : (k < 2 / 3 ? "t4" : "t10"); }
    if (r < a + b + c) return "t6";
    if (r < a + b + c + d) return "t7";
    return "t8";
}

// ---------------------------------------------------------------------------
// 夹具投放 / 本地外部验收工具
// ---------------------------------------------------------------------------

function requiredFamilies(): string[] {
    if (cfg.taskFamily === "mixed") return [...MIX_FAMILIES];
    if (!FAMILY_FIXTURE[cfg.taskFamily]) throw new Error(`未知任务族 ${cfg.taskFamily}`);
    return [cfg.taskFamily];
}

function anyFixtureNeeded(): boolean {
    return requiredFamilies().some((f) => FAMILY_FIXTURE[f] !== "none");
}

/** 把夹具快照投放到某任务的独立 Workspace 根。准备耗时不计入任务延迟。 */
function seedWorkspace(family: string, root: string): { fixture: string; seededFiles: number } {
    const fixture = FAMILY_FIXTURE[family]!;
    if (fixture === "none") return { fixture, seededFiles: 0 };
    if (!cfg.workspaceRoot) throw new Error(`任务族 ${family} 需要 --workspace-root 才能在服务端投放夹具`);
    mkdirSync(root, { recursive: true });
    if (fixture === "t7-project") {
        const n = createT7Project(root);
        return { fixture, seededFiles: n };
    }
    const src = join(cfg.fixtureRoot, fixture);
    if (!existsSync(src)) throw new Error(`夹具不存在：${src}`);
    cpSync(src, root, { recursive: true });
    // 保证可执行夹具保留执行位（cpSync 一般保留，这里显式兜底）。
    for (const rel of ["run_tests.sh", "slow-job.sh", "exit_nonzero.sh", "wait_controlled.sh"]) {
        try { chmodSync(join(root, rel), 0o755); } catch { /* 该夹具没有此文件 */ }
    }
    return { fixture, seededFiles: walkFiles(root).length };
}

/** T7 夹具：确定性生成 20 个模块 + check_all.py（5 个模块含缺陷）。 */
function createT7Project(root: string): number {
    const modulesDir = join(root, "modules");
    mkdirSync(modulesDir, { recursive: true });
    for (let i = 1; i <= cfg.t7Modules; i++) {
        const nn = String(i).padStart(2, "0");
        const buggy = cfg.t7Buggy.includes(i);
        const expr = buggy ? `x * ${i}` : `x * ${i} + ${i}`;
        const body = `"""T7 module ${nn}."""\n\n\ndef compute(x):\n    return ${expr}\n`;
        writeFileSync(join(modulesDir, `mod${nn}.py`), body);
    }
    writeFileSync(join(root, "check_all.py"),
        `"""T7 独立测试：所有模块正确时输出 T7_PASS，否则列出错误并退出 1。"""\n`
        + `import importlib\nimport os\nimport sys\n\n`
        + `sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "modules"))\n\n`
        + `def main():\n`
        + `    broken = []\n`
        + `    for i in range(1, ${cfg.t7Modules + 1}):\n`
        + `        mod = importlib.import_module(f"mod{i:02d}")\n`
        + `        want = 2 * i + i\n`
        + `        got = mod.compute(2)\n`
        + `        if got != want:\n`
        + `            broken.append((i, got, want))\n`
        + `    if broken:\n`
        + `        print("T7_FAIL", broken)\n`
        + `        return 1\n`
        + `    print("T7_PASS")\n`
        + `    return 0\n\n`
        + `if __name__ == "__main__":\n`
        + `    sys.exit(main())\n`);
    return cfg.t7Modules + 1;
}

function walkFiles(dir: string, base = dir, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        const rel = p.slice(base.length + 1);
        if (entry.isDirectory()) walkFiles(p, base, acc);
        else acc.push(rel);
    }
    return acc.sort();
}

/** 在宿主/服务端对 Workspace 跑独立测试（外部验收，不看模型自评）。 */
function runLocalTest(root: string, argv: string[]): { exitCode: number | null; stdout: string; stderr: string } {
    try {
        const proc = Bun.spawnSync(argv, {
            cwd: root,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
            stdout: "pipe", stderr: "pipe",
        });
        return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (e) {
        return { exitCode: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
}

/** 任务执行前基线：证明 T4/T7/T10 的"先失败"。 */
function captureBaselines(): void {
    for (const family of requiredFamilies()) {
        const ctx = sessions[0]?.contexts[family];
        if (!ctx?.root || !existsSync(ctx.root)) continue;
        let rec: any = null;
        if (family === "t4") rec = { cmd: ["sh", "run_tests.sh"], ...runLocalTest(ctx.root, ["sh", "run_tests.sh"]) };
        else if (family === "t7") rec = { cmd: ["python3", "-B", "check_all.py"], ...runLocalTest(ctx.root, ["python3", "-B", "check_all.py"]) };
        else if (family === "t10") rec = { cmd: ["python3", "-B", "test_greeting.py"], ...runLocalTest(ctx.root, ["python3", "-B", "test_greeting.py"]) };
        if (rec) {
            rec.failedAsExpected = rec.exitCode !== 0;
            baselineByFamily[family] = rec;
        }
    }
}

/** 检测本实例可能泄漏的 agent-harness-* 运行容器（排除 warm 池）。 */
function harnessRunContainers(): string[] {
    try {
        const proc = Bun.spawnSync(["docker", "ps", "-a", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "pipe" });
        return proc.stdout.toString().split("\n").map((s) => s.trim())
            .filter((n) => n.startsWith("agent-harness-") && !n.includes("-warm-"));
    } catch { return []; }
}

// ---------------------------------------------------------------------------
// 准备阶段（不计入任务执行延迟）
// ---------------------------------------------------------------------------

async function prepare(): Promise<{ durationMs: number }> {
    const t0 = mono();
    const prepRecords: any[] = [];
    const families = requiredFamilies();
    if (anyFixtureNeeded() && !cfg.workspaceRoot) {
        throw new Error(`任务族 [${families.join(",")}] 需要 --workspace-root（或 $HARNESS_WORKSPACE_ROOT）投放夹具并做磁盘验收`);
    }
    for (let i = 0; i < Math.max(1, cfg.users); i++) {
        const email = `${cfg.accountPrefix}-${cfg.tag}-u${i}@test.local`;
        const password = `LoadPass-${cfg.tag}-${cfg.seed}-${i}`;
        const reg = await api(null, "/auth/register", "POST", { email, password });
        if (!reg.ok && reg.status !== 409) throw new Error(`注册失败 ${email}: ${reg.status} ${JSON.stringify(reg.data)}`);
        const login = await api(null, "/auth/login", "POST", { email, password });
        if (!login.ok) throw new Error(`登录失败 ${email}: ${login.status} ${JSON.stringify(login.data)}`);
        const token: string = login.data.token;
        const tenantId: string = login.data.tenantId;
        const contexts: Record<string, FamilyContext> = {};
        const seeded: any[] = [];
        for (const family of families) {
            const ws = await api(token, "/workspaces", "POST", { name: `${cfg.tag}-ws-${i}-${family}` });
            if (!ws.ok) throw new Error(`建 Workspace 失败 (${family}): ${ws.status} ${JSON.stringify(ws.data)}`);
            const workspaceId: string = ws.data.workspace.id;
            const root = resolve(cfg.workspaceRoot ?? ".", tenantId, workspaceId);
            const seed = seedWorkspace(family, root);
            const cv = await api(token, `/workspaces/${workspaceId}/conversations`, "POST", { title: `${cfg.tag}-conv-${i}-${family}` });
            if (!cv.ok) throw new Error(`建 Conversation 失败 (${family}): ${cv.status} ${JSON.stringify(cv.data)}`);
            const conversationId: string = cv.data.conversation.id;
            contexts[family] = { family, fixture: seed.fixture, workspaceId, conversationId, root };
            seeded.push({ family, fixture: seed.fixture, workspaceId, root, seededFiles: seed.seededFiles });
        }
        const primary = contexts[families[0]!]!;
        sessions.push({
            index: i, email, tenantId, userId: login.data.userId, token,
            workspaceId: primary.workspaceId, conversationId: primary.conversationId, contexts,
        });
        prepRecords.push({
            index: i, email, tenantId, userId: login.data.userId,
            // 兼容旧字段：保留首个任务族的 ID
            workspaceId: primary.workspaceId, conversationId: primary.conversationId,
            workspaces: seeded,
        });
    }
    if (anyFixtureNeeded()) captureBaselines();
    writeFileSync(join(cfg.out, "preparation.json"), JSON.stringify({
        prepDurationMs: mono() - t0, prepNotCountedInLatency: true,
        taskFamily: cfg.taskFamily,
        users: prepRecords,
        baselines: baselineByFamily,
    }, null, 2));
    return { durationMs: mono() - t0 };
}

// ---------------------------------------------------------------------------
// 工单生成 / 发送（闭环与开环共用）
// ---------------------------------------------------------------------------

function makeCase(): CaseDef {
    const seq = ++plannerSeq;
    const caseId = `${cfg.tag}-${cfg.seed}-${String(seq).padStart(6, "0")}`;
    const taskFamily = cfg.taskFamily === "mixed" ? pickMixedFamily() : cfg.taskFamily;
    const task = tasks[taskFamily]!({ caseId, seq });
    return { seq, caseId, taskFamily, input: task.input, expected: task.expected };
}

interface SendOutcome { outcome: "accepted" | "rejected" | "unknown" | "skipped"; terminal: Promise<TerminalResult> | null; }

async function planAndSend(sess: Session): Promise<SendOutcome> {
    if (stopSubmitting) return { outcome: "skipped", terminal: null };
    const c = makeCase();
    const ctx = sess.contexts[c.taskFamily]!;
    stats.planned++;
    stats.byFamilyPlanned[c.taskFamily] = (stats.byFamilyPlanned[c.taskFamily] ?? 0) + 1;
    ledger.emit("planned", {
        seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, inputLen: c.input.length,
        userId: sess.userId, tenantId: sess.tenantId, workspaceId: ctx.workspaceId, conversationId: ctx.conversationId,
    });

    const sentWall = Date.now();
    const sentAt = mono();
    if (runStartedAt === 0) { runStartedAt = sentAt; runStartWall = sentWall; }
    ledger.emit("send_attempt", { seq: c.seq, caseId: c.caseId, sentAt: sentWall });
    stats.actualSent++;
    submitInflight++;
    try {
        const res = await api(sess.token, `/conversations/${ctx.conversationId}/messages`, "POST", { userInput: c.input }, cfg.requestTimeoutMs);
        const recvWall = Date.now();
        if (res.ok && res.status === 202 && res.data?.run?.id) {
            const runId: string = res.data.run.id;
            stats.accepted202++;
            acceptedInflight++;
            ledger.emit("send_result", { seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, http: 202, outcome: "accepted", runId, sentAt: sentWall, recvAt: recvWall, latencyMs: recvWall - sentWall });
            const terminal = registerInflight(sess, c, ctx, runId, sentAt, sentWall);
            terminal.then((t) => ledger.emit("terminal", {
                seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, runId, status: t.status, nonConverged: t.nonConverged,
                polls: t.polls, latencyMs: mono() - sentAt, sentAt: sentWall, terminalAt: Date.now(),
            })).catch(() => { /* 内部已记录 */ });
            return { outcome: "accepted", terminal };
        }
        if (res.status === null) {
            stats.acceptUnknown++;
            pendingUnknown.push({ seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, ctx, sess });
            ledger.emit("send_result", { seq: c.seq, caseId: c.caseId, http: null, outcome: "unknown", runId: null, error: res.error, sentAt: sentWall, recvAt: recvWall, latencyMs: recvWall - sentWall });
            return { outcome: "unknown", terminal: null };
        }
        stats.explicitReject++;
        ledger.emit("send_result", {
            seq: c.seq, caseId: c.caseId, http: res.status, outcome: "rejected", runId: null,
            error: JSON.stringify(res.data)?.slice(0, 300) ?? null, sentAt: sentWall, recvAt: recvWall, latencyMs: recvWall - sentWall,
        });
        return { outcome: "rejected", terminal: null };
    } catch (error) {
        stats.acceptUnknown++;
        pendingUnknown.push({ seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, ctx, sess });
        ledger.emit("send_result", {
            seq: c.seq, caseId: c.caseId, http: null, outcome: "unknown", runId: null,
            error: error instanceof Error ? error.message : String(error), sentAt: sentWall, recvAt: Date.now(),
        });
        return { outcome: "unknown", terminal: null };
    } finally { submitInflight--; }
}

// ---------------------------------------------------------------------------
// 集中 poller
// ---------------------------------------------------------------------------

function registerInflight(sess: Session, c: CaseDef, ctx: FamilyContext, runId: string, sentAt: number, sentWall: number): Promise<TerminalResult> {
    return new Promise<TerminalResult>((resolve) => {
        inflight.set(runId, {
            seq: c.seq, caseId: c.caseId, runId, sess, family: c.taskFamily, ctx, sentAt, sentWall,
            nextPollAt: mono() + jitterMs(cfg.pollMinMs, cfg.pollMaxMs),
            polls: 0, lastStatus: null, settled: false, lastAcceptance: null, resolve,
        });
        if (inflight.size > stats.clientInflightMax) stats.clientInflightMax = inflight.size;
    });
}

async function pollerLoop(): Promise<void> {
    while (!pollerStop || inflight.size > 0) {
        const now = mono();
        const due = [...inflight.values()].filter((r) => !r.settled && r.nextPollAt <= now);
        if (due.length === 0) {
            if (pollerStop && inflight.size === 0) break;
            await sleep(50);
            continue;
        }
        // 限制并发：每轮最多 pollConcurrency 个，天然错峰（每个 run 的 nextPollAt 独立抖动）
        await Promise.all(due.slice(0, Math.max(1, cfg.pollConcurrency)).map((r) => pollOne(r)));
    }
}

async function pollOne(r: Inflight): Promise<void> {
    if (r.settled) return;
    r.nextPollAt = mono() + jitterMs(cfg.pollMinMs, cfg.pollMaxMs);
    r.polls++;
    stats.pollRequestsTotal++;
    const res = await api(r.sess.token, `/runs/${r.runId}`, "GET", undefined, cfg.getTimeoutMs);
    if (!res.ok || !res.data?.run) {
        stats.pollErrors++;
        stats.consecutivePollErrors++;
        if (stats.consecutivePollErrors >= cfg.maxConsecutivePollErrors && !stopSubmitting) {
            requestStop(`control_plane_lost:${stats.consecutivePollErrors}_consecutive_poll_errors`);
        }
        return;
    }
    stats.consecutivePollErrors = 0;
    const status: string = res.data.run.status;
    if (status !== r.lastStatus) {
        r.lastStatus = status;
        stats.pollStatusChanges++;
        ledger.emit("status_change", { runId: r.runId, caseId: r.caseId, status, polls: r.polls });
    }
    const activeNow = [...inflight.values()].filter((x) => x.lastStatus === "RUNNING" || x.lastStatus === "WAITING_TOOL").length;
    if (activeNow > stats.harnessActiveMax) stats.harnessActiveMax = activeNow;
    if (stats.harnessActiveSamples.length < 20000) stats.harnessActiveSamples.push(activeNow);

    if (cfg.runTimeoutMs > 0 && mono() - r.sentAt > cfg.runTimeoutMs) { settle(r, "TIMEOUT", true); return; }
    if (status === "COMPLETED" || status === "FAILED" || status === "INTERRUPTED") settle(r, status, false);
}

function settle(r: Inflight, status: string, nonConverged: boolean): void {
    if (r.settled) return;
    r.settled = true;
    inflight.delete(r.runId);
    acceptedInflight = Math.max(0, acceptedInflight - 1);
    if (status === "COMPLETED") stats.completed++;
    else if (status === "FAILED") stats.failed++;
    else if (status === "INTERRUPTED") stats.interrupted++;
    if (status === "COMPLETED" || status === "FAILED" || status === "INTERRUPTED") {
        stats.byFamilyCompleted[r.family] = (stats.byFamilyCompleted[r.family] ?? 0) + 1;
    }
    if (nonConverged) stats.nonConverged++;
    const p = collectAndAccept(r, status, nonConverged)
        .catch(() => { /* 采集失败也继续 */ })
        .finally(() => {
            r.resolve({ status, seenAt: mono(), polls: r.polls, acceptance: r.lastAcceptance, nonConverged });
        });
    pendingCollect.add(p);
    p.finally(() => pendingCollect.delete(p));
}

async function collectAndAccept(r: Inflight, status: string, nonConverged: boolean): Promise<void> {
    const dir = join(cfg.out, "runs", r.runId);
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const evidence: Record<string, any> = {};
    const fetches: Array<[string, string]> = [
        ["run", `/runs/${r.runId}`], ["events", `/runs/${r.runId}/events`], ["output", `/runs/${r.runId}/output`],
        ["workspace-diff", `/runs/${r.runId}/workspace-diff`], ["artifacts", `/runs/${r.runId}/artifacts`],
    ];
    for (const [name, path] of fetches) {
        let last: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            last = await api(r.sess.token, path, "GET", undefined, cfg.getTimeoutMs);
            if (last.ok) break;
            await sleep(300);
        }
        evidence[name] = last?.data ?? { _fetchError: last?.error ?? `http ${last?.status}` };
        try { writeFileSync(join(dir, `${name}.json`), JSON.stringify(evidence[name], null, 2)); } catch { /* ignore */ }
    }
    // 首 chunk 时间（TTFT 原始事实）
    const chunks: any[] = Array.isArray(evidence.output?.chunks) ? evidence.output.chunks : [];
    if (chunks.length > 0 && typeof chunks[0]?.createdAt === "string") {
        ledger.emit("first_chunk", { seq: r.seq, caseId: r.caseId, runId: r.runId, createdAt: Date.parse(chunks[0].createdAt), sequence: chunks[0].sequence });
    }

    // Artifact 下载 + 哈希（有界）
    const artifactList: any[] = Array.isArray(evidence.artifacts?.artifacts) ? evidence.artifacts.artifacts : [];
    const hashes: Record<string, string> = {};
    let bytes = 0;
    for (const a of artifactList.slice(0, cfg.artifactMaxCount)) {
        const apath = typeof a?.path === "string" ? a.path : null;
        if (!apath) continue;
        if (bytes > cfg.artifactMaxBytes) { hashes[apath] = "skipped:size_budget"; continue; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.getTimeoutMs);
        try {
            const res = await fetch(`${cfg.baseUrl}/runs/${r.runId}/artifacts/${encodeURIComponent(apath)}`, {
                headers: { authorization: `Bearer ${r.sess.token}` }, signal: controller.signal,
            });
            const buf = Buffer.from(await res.arrayBuffer());
            bytes += buf.length;
            hashes[apath] = createHash("sha256").update(buf).digest("hex");
            const safe = apath.replace(/[^a-zA-Z0-9._-]/g, "_");
            try { mkdirSync(join(dir, "artifacts"), { recursive: true }); writeFileSync(join(dir, "artifacts", safe), buf); } catch { /* ignore */ }
        } catch (e) {
            hashes[apath] = `error:${e instanceof Error ? e.message : String(e)}`;
        } finally { clearTimeout(timer); }
    }
    try { writeFileSync(join(dir, "artifact-hashes.json"), JSON.stringify(hashes, null, 2)); } catch { /* ignore */ }

    const acceptance = await runAcceptance(r, evidence, status);
    r.lastAcceptance = acceptance;
    try { writeFileSync(join(dir, "acceptance.json"), JSON.stringify(acceptance, null, 2)); } catch { /* ignore */ }
    ledger.emit("evidence", { seq: r.seq, caseId: r.caseId, taskFamily: r.family, runId: r.runId, status, nonConverged, artifactCount: artifactList.length, acceptance: acceptance.status });
    const fam = stats.byFamilyAccept[r.family] ?? (stats.byFamilyAccept[r.family] = { pass: 0, fail: 0, notRun: 0 });
    if (acceptance.status === "PASS") { stats.acceptancePass++; fam.pass++; }
    else if (acceptance.status === "FAIL") { stats.acceptanceFail++; fam.fail++; }
    else { stats.acceptanceNotRun++; fam.notRun++; }
}

// ---------------------------------------------------------------------------
// 外部验收器（确定性，不复用模型自评）
// ---------------------------------------------------------------------------

/**
 * T1 归一化：目标“归一化输出等于 391”。
 * 规则（显式、可复核，不依赖模型自评）：
 *   1) 去 code fence / 千分位逗号；
 *   2) 整串就是一个整数 → 用它；
 *   3) 含 "=" → 取最后一个 "=" 之后的整数（模型常写 "17 × 23 = 391"）；
 *   4) 否则全文去重后只有一个整数 → 用它；
 *   5) 否则取最后一个整数（宽松兜底；不唯一时不判 PASS 由调用方决定）。
 * 返回 {value, method}，method 记录命中规则，便于证据复核。
 */
function normalizeInt(text: string): { value: number | null; method: string } {
    const cleaned = text.replace(/```[a-zA-Z0-9]*/g, "").replace(/```/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1").trim();
    if (/^-?\d+$/.test(cleaned)) return { value: Number(cleaned), method: "whole_string" };
    const eq = cleaned.lastIndexOf("=");
    if (eq >= 0) {
        const rhs = cleaned.slice(eq + 1).trim();
        const rhsNums = rhs.match(/-?\d+/g);
        if (rhsNums && rhsNums.length >= 1) {
            const uniqRhs = [...new Set(rhsNums.map(Number))];
            if (uniqRhs.length === 1) return { value: uniqRhs[0]!, method: "rhs_of_equals_unique" };
            return { value: Number(rhsNums[rhsNums.length - 1]!), method: "rhs_of_equals_last" };
        }
    }
    const nums = cleaned.match(/-?\d+/g);
    if (nums && nums.length >= 1) {
        const uniq = [...new Set(nums.map(Number))];
        if (uniq.length === 1) return { value: uniq[0]!, method: "global_unique" };
        return { value: Number(nums[nums.length - 1]!), method: "global_last_lenient" };
    }
    return { value: null, method: "no_integer" };
}
function diffCount(diff: any): number {
    if (!diff) return 0;
    return (Array.isArray(diff.added) ? diff.added.length : 0) + (Array.isArray(diff.modified) ? diff.modified.length : 0) + (Array.isArray(diff.deleted) ? diff.deleted.length : 0);
}

// ---- 外部验收公共工具 -------------------------------------------------------

function isIgnoreDiffPath(p: string): boolean {
    return p.includes("__pycache__") || p.endsWith(".pyc");
}
/** 真实 Harness 的 diff 条目形态多样：字符串 / {path} / {before:{path},after:{path}}。 */
function pathOf(x: any): string {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
        if (typeof x.path === "string") return x.path;
        if (x.after && typeof x.after.path === "string") return x.after.path;
        if (x.before && typeof x.before.path === "string") return x.before.path;
    }
    return "";
}
function diffBuckets(diff: any): { added: string[]; modified: string[]; deleted: string[] } {
    const clean = (arr: any) => (Array.isArray(arr) ? arr.map(pathOf) : []).filter((p) => p.length > 0 && !isIgnoreDiffPath(p));
    return { added: clean(diff?.added), modified: clean(diff?.modified), deleted: clean(diff?.deleted) };
}
function eventList(ev: any): any[] {
    const e = ev?.events;
    if (Array.isArray(e)) return e;
    if (Array.isArray(e?.events)) return e.events;
    return [];
}
function argObj(a: any): any {
    if (a == null) return {};
    if (typeof a === "string") { try { return JSON.parse(a); } catch { return { _raw: a }; } }
    return a;
}
interface ToolStep { toolName: string; args: any; resultText: string; }
/** 从 run events 重建真实工具轨迹（不只信提示词/模型自评）。 */
function toolSteps(ev: any): ToolStep[] {
    const out: ToolStep[] = [];
    const byId = new Map<string, ToolStep>();
    for (const e of eventList(ev)) {
        const t = String(e?.type ?? "");
        if (t === "TOOL_STARTED") {
            const step: ToolStep = { toolName: String(e?.payload?.toolName ?? ""), args: argObj(e?.payload?.arguments), resultText: "" };
            out.push(step);
            const id = String(e?.payload?.toolCallId ?? out.length);
            byId.set(id, step);
        } else if (t === "TOOL_COMPLETED" || t === "TOOL_FAILED") {
            const step = byId.get(String(e?.payload?.toolCallId ?? ""));
            if (step) step.resultText = JSON.stringify(e?.payload?.result ?? "").slice(0, 40000);
        }
    }
    return out;
}
function readPaths(ev: any): string[] {
    return toolSteps(ev).filter((s) => s.toolName === "read")
        .map((s) => String(s.args?.path ?? "")).filter((p) => p.length > 0);
}
function writeOrEditPaths(ev: any): string[] {
    return toolSteps(ev).filter((s) => s.toolName === "write" || s.toolName === "edit")
        .map((s) => String(s.args?.path ?? "")).filter((p) => p.length > 0);
}
function bashOutputs(ev: any): string {
    return toolSteps(ev).filter((s) => s.toolName === "bash").map((s) => s.resultText).join("\n@@BASH@@\n");
}
function finish(status: string, ok: boolean, checker: string, checks: AcceptanceResult["checks"], detail: string): AcceptanceResult {
    return { status: status !== "COMPLETED" ? "INCONCLUSIVE" : (ok ? "PASS" : "FAIL"), checker, checks, detail };
}
function blockedOrInconclusive(r: Inflight, status: string, checker: string, why: string): AcceptanceResult {
    return { status: status === "COMPLETED" ? "NOT_RUN" : "INCONCLUSIVE", checker, checks: [{ name: "precondition", ok: null, detail: why }], detail: why };
}
function readDiskText(root: string, rel: string): string | null {
    try { return readFileSync(join(root, rel), "utf8"); } catch { return null; }
}
function readDiskJson(root: string, rel: string): any {
    const t = readDiskText(root, rel);
    if (t === null) return null;
    try { return JSON.parse(t); } catch { return { _parseError: t.slice(0, 200) }; }
}
function slowJobProcessHits(): string[] {
    try {
        const p = Bun.spawnSync(["ps", "-eo", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
        return p.stdout.toString().split("\n").map((s) => s.trim())
            .filter((l) => l.includes("slow-job") && !l.includes("load-driver") && !l.includes("ps -eo"));
    } catch { return []; }
}

// ---- 各任务族外部验收器 -----------------------------------------------------

/** T2：读项目。要求真实 read 轨迹读过 README.md 与 calc.py；最终 JSON 与夹具一致；零文件修改。 */
async function acceptT2(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const checks: AcceptanceResult["checks"] = [];
    const reads = readPaths(ev);
    const readReadme = reads.some((p) => /(^|\/)README\.md$/i.test(p));
    const readCalc = reads.some((p) => /(^|\/)calc\.py$/i.test(p));
    checks.push({ name: "read_trace_readme", ok: readReadme, detail: `reads=${JSON.stringify(reads).slice(0, 400)}` });
    checks.push({ name: "read_trace_calc", ok: readCalc, detail: `reads=${JSON.stringify(reads).slice(0, 400)}` });
    const b = diffBuckets(ev["workspace-diff"]?.diff);
    const changed = b.added.length + b.modified.length + b.deleted.length;
    checks.push({ name: "no_file_modification", ok: changed === 0, detail: `changed=${changed} buckets=${JSON.stringify(b).slice(0, 300)}` });
    const text = String(ev.output?.finalText ?? "");
    // 与夹具一致：add 当前实现是 a - b（缺陷）。
    const subOk = /a\s*[-−]\s*b/.test(text) || /(减|减法|减去|subtract)/i.test(text);
    checks.push({ name: "add_currently_subtracts", ok: subOk, detail: `text=${JSON.stringify(text.slice(0, 240))}` });
    // "列出对应文件/函数及 I/O"：至少覆盖 README 中 3 个已知函数名。
    const fns = ["add", "area", "perimeter", "mean", "reverse_words"];
    const listed = fns.filter((f) => new RegExp(`\\b${f}\\b`).test(text));
    checks.push({ name: "lists_fixture_functions", ok: listed.length >= 3, detail: `listed=${JSON.stringify(listed)}` });
    const ok = readReadme && readCalc && changed === 0 && subOk && listed.length >= 3;
    return finish(status, ok, "builtin:t2(v1)", checks, `status=${status} reads=${reads.length} changed=${changed} listed=${listed.length}`);
}

/** T4：修复并运行测试。外部基线先失败 + 独立运行 run_tests.sh 通过 + 测试文件未被改 + 仅改 calc.py。 */
async function acceptT4(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const root = r.ctx.root;
    if (!root || !existsSync(root)) return blockedOrInconclusive(r, status, "builtin:t4(v1)", `找不到 Workspace 根 ${root}`);
    const checks: AcceptanceResult["checks"] = [];
    const base = baselineByFamily["t4"];
    checks.push({ name: "baseline_failed_before_task", ok: base?.failedAsExpected === true, detail: JSON.stringify(base).slice(0, 300) });
    const post = runLocalTest(root, ["sh", "run_tests.sh"]);
    const pass = post.exitCode === 0 && post.stdout.includes("RUN_TESTS_PASS");
    checks.push({ name: "independent_run_tests_pass", ok: pass, detail: `exit=${post.exitCode} tail=${JSON.stringify(post.stdout.slice(-260))} stderr=${JSON.stringify(post.stderr.slice(-160))}` });
    const testsUnchanged = ["test_calc.py", "tests/test_public_suite.py", "tests/test_reserved.py"]
        .every((rel) => sameFileHash(join(root, rel), join(cfg.fixtureRoot, "base-project", rel)));
    checks.push({ name: "test_files_unmodified", ok: testsUnchanged, detail: "对比夹具快照 sha256" });
    const b = diffBuckets(ev["workspace-diff"]?.diff);
    const badMods = [...b.modified, ...b.deleted].filter((p) => p !== "calc.py");
    checks.push({ name: "diff_modified_deleted_only_calc", ok: badMods.length === 0, detail: `bad=${JSON.stringify(badMods)} buckets=${JSON.stringify(b).slice(0, 300)}` });
    const out = bashOutputs(ev);
    const iFail = out.indexOf("RUN_TESTS_FAIL"), iPass = out.indexOf("RUN_TESTS_PASS");
    checks.push({ name: "tool_trace_fail_then_pass", ok: iFail >= 0 && iPass > iFail, detail: `failAt=${iFail} passAt=${iPass} (informational)` });
    const ok = base?.failedAsExpected === true && pass && testsUnchanged && badMods.length === 0;
    return finish(status, ok, "builtin:t4(v1)", checks, `status=${status} postExit=${post.exitCode}`);
}

/** T6：数据汇总。用独立实现从夹具 orders.json 计算期望值，精确比对 summary.json。 */
async function acceptT6(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const root = r.ctx.root;
    if (!root || !existsSync(root)) return blockedOrInconclusive(r, status, "builtin:t6(v1)", `找不到 Workspace 根 ${root}`);
    const checks: AcceptanceResult["checks"] = [];
    let expected: Record<string, number> | null = null;
    try {
        const arr = JSON.parse(readFileSync(join(cfg.fixtureRoot, "base-project", "orders.json"), "utf8"));
        expected = {};
        for (const o of arr) expected[o.category] = (expected[o.category] ?? 0) + Number(o.amount);
    } catch { expected = null; }
    checks.push({ name: "independent_expected_from_fixture", ok: expected !== null, detail: `expected=${JSON.stringify(expected)}` });
    const got = readDiskJson(root, "summary.json");
    const keys = expected ? Object.keys(expected) : [];
    const valuesOk = expected !== null && got !== null && typeof got === "object"
        && keys.every((k) => Number(got[k]) === expected![k]) && Object.keys(got).length === keys.length;
    checks.push({ name: "summary_values_exact", ok: valuesOk, detail: `expected=${JSON.stringify(expected)} got=${JSON.stringify(got)?.slice(0, 300)}` });
    const reads = readPaths(ev), writes = writeOrEditPaths(ev);
    checks.push({ name: "trace_read_orders", ok: reads.some((p) => /orders\.json$/.test(p)), detail: `reads=${JSON.stringify(reads).slice(0, 200)}` });
    checks.push({ name: "trace_write_summary", ok: writes.some((p) => /summary\.json$/.test(p)), detail: `writes=${JSON.stringify(writes).slice(0, 200)}` });
    const ok = valuesOk && expected !== null;
    return finish(status, ok, "builtin:t6(v1)", checks, `status=${status} expected=${JSON.stringify(expected)}`);
}

/** T7：工具密集。真实轨迹须按序读全 20 个模块、修复 5 个缺陷模块，独立 check_all.py 通过。 */
async function acceptT7(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const root = r.ctx.root;
    if (!root || !existsSync(root)) return blockedOrInconclusive(r, status, "builtin:t7(v1)", `找不到 Workspace 根 ${root}`);
    const checks: AcceptanceResult["checks"] = [];
    const base = baselineByFamily["t7"];
    checks.push({ name: "baseline_failed_before_task", ok: base?.failedAsExpected === true, detail: JSON.stringify(base).slice(0, 300) });
    const post = runLocalTest(root, ["python3", "-B", "check_all.py"]);
    const pass = post.exitCode === 0 && post.stdout.includes("T7_PASS");
    checks.push({ name: "independent_check_all_pass", ok: pass, detail: `exit=${post.exitCode} out=${JSON.stringify(post.stdout.slice(-200))}` });

    const reads = readPaths(ev);
    const modReadOrder: number[] = [];
    for (const p of reads) {
        const m = /modules\/mod(\d{2})\.py$/.exec(p);
        if (m) modReadOrder.push(Number(m[1]));
    }
    const unique = [...new Set(modReadOrder)];
    const modSet = new Set(unique);
    const buggyRead = cfg.t7Buggy.every((m) => modSet.has(m));
    const covered = cfg.t7RequireAllReads ? unique.length >= cfg.t7Modules : buggyRead;
    const inOrder = modReadOrder.every((v, i) => i === 0 || v >= modReadOrder[i - 1]!);
    checks.push({
        name: "trace_read_module_coverage", ok: covered,
        detail: `uniqueRead=${unique.length}/${cfg.t7Modules} buggyRead=${buggyRead} requireAllReads=${cfg.t7RequireAllReads} order=${JSON.stringify(modReadOrder)}`,
    });
    checks.push({ name: "trace_read_in_ascending_order", ok: inOrder, detail: `order=${JSON.stringify(modReadOrder)}` });

    const edited = [...new Set(writeOrEditPaths(ev).map((p) => (/modules\/mod(\d{2})\.py$/.exec(p) ?? [])[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
    const fixedAll = cfg.t7Buggy.every((m) => edited.includes(m));
    const onlyBuggy = edited.every((m) => cfg.t7Buggy.includes(m));
    checks.push({ name: "trace_edit_buggy_modules", ok: fixedAll && onlyBuggy, detail: `edited=${JSON.stringify(edited)} expected=${JSON.stringify(cfg.t7Buggy)}` });

    const b = diffBuckets(ev["workspace-diff"]?.diff);
    const badMods = [...b.modified, ...b.deleted].filter((p) => !/modules\/mod\d{2}\.py$/.test(p));
    checks.push({ name: "diff_modified_only_modules", ok: badMods.length === 0, detail: `bad=${JSON.stringify(badMods)}` });
    const ok = base?.failedAsExpected === true && pass && covered && inOrder && fixedAll && onlyBuggy && badMods.length === 0;
    return finish(status, ok, "builtin:t7(v1)", checks, `status=${status} uniqueRead=${unique.length} edited=${JSON.stringify(edited)}`);
}

/** T8：可控慢任务。阶段序号完整不重复、summary 一致、结束后无后台进程/无泄漏容器。 */
async function acceptT8(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const root = r.ctx.root;
    if (!root || !existsSync(root)) return blockedOrInconclusive(r, status, "builtin:t8(v1)", `找不到 Workspace 根 ${root}`);
    const checks: AcceptanceResult["checks"] = [];
    const progress = join(root, "progress");
    let names: string[] = [];
    try { names = readdirSync(progress); } catch { names = []; }
    const stages = names.filter((n) => /^stage-\d{4}\.done$/.test(n)).map((n) => Number(n.slice(6, 10))).sort((a, b) => a - b);
    const expectedStages = Array.from({ length: cfg.t8Stages }, (_, i) => i + 1);
    const uniqueStages = [...new Set(stages)];
    const complete = uniqueStages.length === cfg.t8Stages && expectedStages.every((s) => uniqueStages.includes(s));
    const noDup = stages.length === uniqueStages.length;
    checks.push({ name: "stage_files_complete_unique", ok: complete && noDup, detail: `found=${JSON.stringify(stages)} expected=${cfg.t8Stages} dup=${!noDup}` });
    const summary = readDiskJson(root, "progress/summary.json");
    const summaryOk = summary && Number(summary.stages) === cfg.t8Stages
        && Number(summary.progressDoneFiles) === cfg.t8Stages && Number(summary.backgroundProcessesLeft) === 0;
    checks.push({ name: "summary_consistent", ok: summaryOk === true, detail: `summary=${JSON.stringify(summary)?.slice(0, 300)}` });
    const minDuration = cfg.t8Stages * cfg.t8StageWait * 0.8;
    checks.push({ name: "duration_matches_stages", ok: Number(summary?.durationSeconds ?? 0) >= minDuration, detail: `duration=${summary?.durationSeconds} minExpected=${minDuration}` });
    const hits = slowJobProcessHits();
    checks.push({ name: "no_background_process_host_ps", ok: hits.length === 0, detail: hits.length ? JSON.stringify(hits).slice(0, 300) : "host ps 无 slow-job 残留（gVisor 内进程通常不可见，见容器检查）" });
    // 并发安全：只检查"本 run 的 sandbox 容器"是否已终止，不用全局泄漏数（C>1 时兄弟 run 的容器会误判）。
    const acquired = eventList(ev).find((e) => String(e?.type) === "SANDBOX_ACQUIRED");
    const sandboxId = acquired?.payload?.sandboxId ?? null;
    const containerName = sandboxId ? `agent-harness-${sandboxId}` : null;
    const present = containerName !== null && harnessRunContainers().includes(containerName);
    checks.push({ name: "run_sandbox_container_terminated", ok: containerName !== null && !present, detail: `sandboxId=${sandboxId} container=${containerName} stillPresent=${present}` });
    const ok = complete && noDup && summaryOk === true && Number(summary?.durationSeconds ?? 0) >= minDuration && hits.length === 0 && containerName !== null && !present;
    return finish(status, ok, "builtin:t8(v1)", checks, `status=${status} stages=${stages.length}/${cfg.t8Stages} sandboxTerminated=${containerName !== null && !present}`);
}

/** T10：失败与自修复。先有真实失败证据、修复后独立测试通过、仅改 greeting.py。 */
async function acceptT10(r: Inflight, ev: any, status: string): Promise<AcceptanceResult> {
    const root = r.ctx.root;
    if (!root || !existsSync(root)) return blockedOrInconclusive(r, status, "builtin:t10(v1)", `找不到 Workspace 根 ${root}`);
    const checks: AcceptanceResult["checks"] = [];
    const base = baselineByFamily["t10"];
    checks.push({ name: "baseline_failed_before_task", ok: base?.failedAsExpected === true, detail: JSON.stringify(base).slice(0, 300) });
    const post = runLocalTest(root, ["python3", "-B", "test_greeting.py"]);
    const pass = post.exitCode === 0 && post.stdout.includes("GREETING_PASS");
    checks.push({ name: "independent_test_greeting_pass", ok: pass, detail: `exit=${post.exitCode} out=${JSON.stringify(post.stdout.slice(-200))}` });
    const greeting = readDiskText(root, "greeting.py") ?? "";
    checks.push({ name: "greeting_raises_valueerror", ok: /raise\s+ValueError/.test(greeting) && /if\s+not\s+name|name\s*==\s*['"]{2}|len\(name\)/.test(greeting), detail: `greeting.py=${JSON.stringify(greeting.slice(0, 200))}` });
    const testsUnchanged = sameFileHash(join(root, "test_greeting.py"), join(cfg.fixtureRoot, "fault-project", "test_greeting.py"));
    checks.push({ name: "test_file_unmodified", ok: testsUnchanged, detail: "对比夹具快照 sha256" });
    const b = diffBuckets(ev["workspace-diff"]?.diff);
    const badMods = [...b.modified, ...b.deleted].filter((p) => p !== "greeting.py");
    checks.push({ name: "diff_modified_deleted_only_greeting", ok: badMods.length === 0, detail: `bad=${JSON.stringify(badMods)}` });
    const out = bashOutputs(ev);
    const iFail = out.search(/FAIL|Traceback|AssertionError/), iPass = out.indexOf("GREETING_PASS");
    checks.push({ name: "tool_trace_fail_then_pass", ok: iFail >= 0 && iPass > iFail, detail: `failAt=${iFail} passAt=${iPass}` });
    const ok = base?.failedAsExpected === true && pass && testsUnchanged && badMods.length === 0;
    return finish(status, ok, "builtin:t10(v1)", checks, `status=${status} postExit=${post.exitCode}`);
}

async function runAcceptance(r: Inflight, ev: Record<string, any>, status: string): Promise<AcceptanceResult> {
    if (cfg.acceptorCmd) return runExternalAcceptor(r, ev);
    const checks: AcceptanceResult["checks"] = [];
    const finalText: string = ev.output?.finalText ?? "";
    const diff = ev["workspace-diff"]?.diff ?? null;
    const changed = diffCount(diff);

    // t1/t3 验收逻辑保持不变（t1 措辞已冻结）。
    if (r.family === "t1") {
        const norm = normalizeInt(finalText);
        const outputOk = norm.value === 391;
        checks.push({ name: "output_normalized_equals_391", ok: outputOk, detail: `normalized=${norm.value} method=${norm.method} raw=${JSON.stringify(finalText.slice(0, 120))}` });
        const noFiles = changed === 0;
        checks.push({ name: "no_file_modification", ok: noFiles, detail: `diffChanged=${changed}` });
        const allOk = outputOk && noFiles;
        return { status: status === "COMPLETED" ? (allOk ? "PASS" : "FAIL") : "INCONCLUSIVE", checker: "builtin:t1(v1)", checks, detail: `status=${status} normalized=${norm.value} method=${norm.method} changed=${changed}` };
    }

    if (r.family === "t3") {
        // 兼容修复：真实 API 的 diff 条目是 {path,hash,size} 对象，artifacts 不含 content。
        // 因此"已创建 + 内容精确"改为：diff 命中 result.json（对象或字符串）→ 优先读磁盘，
        // 退化为 artifact.content。判据语义不变（JSON parse 成功且 caseId/answer 精确匹配）。
        const added = diffBuckets(diff).added;
        const hasResult = added.some((p) => p.endsWith("result.json"));
        checks.push({ name: "result_json_created", ok: hasResult, detail: `added=${JSON.stringify(added).slice(0, 200)}` });
        const art = (ev.artifacts?.artifacts ?? []).find((a: any) => String(a?.path ?? "").endsWith("result.json"));
        let contentOk: boolean | null = null;
        let detail = "artifact 未记录 result.json 内容且无 Workspace 根，无法独立核对";
        const diskText = r.ctx.root ? readDiskText(r.ctx.root, "result.json") : null;
        const source = diskText !== null ? diskText : (art?.content !== undefined ? (typeof art.content === "string" ? art.content : JSON.stringify(art.content)) : null);
        if (source !== null) {
            try {
                const parsed = JSON.parse(source);
                contentOk = parsed?.caseId === r.caseId && parsed?.answer === 42;
                detail = `source=${diskText !== null ? "disk" : "artifact.content"} parsed=${JSON.stringify(parsed)}`;
            } catch (e) { contentOk = false; detail = `parse失败 ${e} source=${JSON.stringify(source).slice(0, 120)}`; }
        }
        checks.push({ name: "result_json_content", ok: contentOk, detail });
        const allOk = hasResult && contentOk === true;
        return { status: status === "COMPLETED" ? (allOk ? "PASS" : "FAIL") : "INCONCLUSIVE", checker: "builtin:t3(v1)", checks, detail: `status=${status}` };
    }

    if (r.family === "t2") return acceptT2(r, ev, status);
    if (r.family === "t4") return acceptT4(r, ev, status);
    if (r.family === "t6") return acceptT6(r, ev, status);
    if (r.family === "t7") return acceptT7(r, ev, status);
    if (r.family === "t8") return acceptT8(r, ev, status);
    if (r.family === "t10") return acceptT10(r, ev, status);

    checks.push({ name: "acceptor_registered", ok: null, detail: `无 ${r.family} 的内置验收器` });
    return { status: status === "COMPLETED" ? "NOT_RUN" : "INCONCLUSIVE", checker: "builtin:none", checks, detail: `family=${r.family}` };
}

async function runExternalAcceptor(r: Inflight, ev: Record<string, any>): Promise<AcceptanceResult> {
    try {
        const payload = JSON.stringify({
            taskFamily: r.family, caseId: r.caseId, runId: r.runId,
            finalText: ev.output?.finalText ?? "", diff: ev["workspace-diff"]?.diff ?? null,
            artifacts: ev.artifacts?.artifacts ?? [], evidenceDir: join(cfg.out, "runs", r.runId),
        });
        const proc = Bun.spawnSync(["/bin/sh", "-c", cfg.acceptorCmd!], { stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe" });
        const out = proc.stdout.toString().trim();
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* non-json */ }
        const passed = proc.exitCode === 0 && (parsed === null || parsed.status === "PASS");
        return {
            status: passed ? "PASS" : "FAIL", checker: `external:${cfg.acceptorCmd}`,
            checks: [{ name: "external_exit", ok: proc.exitCode === 0, detail: `exit=${proc.exitCode} stderr=${proc.stderr.toString().slice(0, 200)}` }],
            detail: parsed ? JSON.stringify(parsed) : out.slice(0, 300),
        };
    } catch (e) {
        return { status: "INCONCLUSIVE", checker: `external:${cfg.acceptorCmd}`, checks: [{ name: "external_spawn", ok: false, detail: String(e) }], detail: "外部验收器调用失败" };
    }
}

// ---------------------------------------------------------------------------
// 生产者
// ---------------------------------------------------------------------------

function requestStop(reason: string): void {
    if (stopSubmitting) return;
    stopSubmitting = true;
    stopReason = reason;
    ledger.emit("stop_submitting", { reason, planned: stats.planned, sent: stats.actualSent });
}

async function closedClient(idx: number): Promise<void> {
    const sess = sessions[idx % sessions.length]!;
    while (!stopSubmitting) {
        if (stats.planned >= cfg.total) { requestStop("total_reached"); break; }
        if (cfg.durationS > 0 && runStartedAt > 0 && mono() - runStartedAt >= cfg.durationS * 1000) { requestStop("duration_reached"); break; }
        if (cfg.queueLimit > 0 && stats.queueLenMax >= cfg.queueLimit) { requestStop("queue_limit_reached"); break; }
        const { outcome, terminal } = await planAndSend(sess);
        if (outcome === "skipped") break;
        // 闭环语义：本客户端必须等自己的任务到终态，才发下一个
        if (terminal) await terminal;
    }
}

async function openLoop(): Promise<void> {
    const interval = cfg.arrivalRate > 0 ? 1000 / cfg.arrivalRate : 1000;
    let nextAt = mono();
    while (!stopSubmitting) {
        const wait = nextAt - mono();
        if (wait > 0) await sleep(wait);
        if (stopSubmitting) break;
        if (runStartedAt > 0 && cfg.durationS > 0 && mono() - runStartedAt >= cfg.durationS * 1000) { requestStop("duration_reached"); break; }
        if (stats.planned >= cfg.total) { requestStop("total_reached"); break; }
        if (acceptedInflight >= cfg.maxOpenInflight) { requestStop("max_open_inflight_reached"); break; }
        if (cfg.queueLimit > 0 && stats.queueLenMax >= cfg.queueLimit) { requestStop("queue_limit_reached"); break; }
        const sess = sessions[plannerSeq % sessions.length]!;
        void planAndSend(sess).catch(() => { /* 已分类 */ });   // 开环：不等完成
        // 计算下一次到达
        let d: number;
        if (cfg.arrivalDist === "exponential") d = Math.max(1, -Math.log(1 - rnd()) * interval);
        else d = Math.max(1, interval * (1 + (rnd() * 2 - 1) * cfg.arrivalJitter));
        nextAt += d;
        if (nextAt < mono()) nextAt = mono();   // 生产者落后时重新锚定，避免突发补偿
    }
}

// ---------------------------------------------------------------------------
// 独立采样器（append-only，1–5s）
// ---------------------------------------------------------------------------

async function samplerLoop(): Promise<void> {
    while (!samplerStop) {
        stats.samplerTicks++;
        ledger.flush();
        await sampleResources();
        sampleProcess();
        if (samplerStop) break;
        const wait = jitterMs(cfg.sampleMinMs, cfg.sampleMaxMs);
        await sleep(wait);
    }
    ledger.flush();
}

async function sampleResources(): Promise<void> {
    const token = sessions[0]?.token ?? "";
    const res = await api(token, "/resources", "GET", undefined, cfg.getTimeoutMs);
    const obs = res.data?.observation;
    const snapshot = obs?.ok ? obs.snapshot : null;
    appendFileSync(join(cfg.out, "resources.jsonl"), JSON.stringify({
        at: new Date().toISOString(), http: res.status, observationOk: obs?.ok ?? false,
        observationReason: obs?.ok === false ? obs.reason : null,
        gpuUsedMemoryMiB: snapshot?.gpuUsedMemoryMiB ?? null,
        gpuUtilizationPercent: snapshot?.gpuUtilizationPercent ?? null,
        runningRequests: snapshot?.runningRequests ?? null,   // vLLM running_requests
        waitingRequests: snapshot?.waitingRequests ?? null,
        kvCacheUsagePercent: snapshot?.kvCacheUsagePercent ?? null,
        error: res.error,
    }) + "\n");
    stats.resourceSamples++;
    if (typeof snapshot?.runningRequests === "number") {
        stats.vllmRunningSamples.push(snapshot.runningRequests);
        if (snapshot.runningRequests > stats.vllmRunningMax) stats.vllmRunningMax = snapshot.runningRequests;
    }
}

function sampleProcess(): void {
    const lag = eventLoopLagMax; eventLoopLagMax = 0;
    let rss: number | null = null, fds: number | null = null, diskFree: number | null = null;
    let walBytes: number | null = null, shmBytes: number | null = null;
    try { rss = process.memoryUsage().rss; } catch { /* ignore */ }
    try { fds = readdirSync("/proc/self/fd").length; } catch { /* ignore */ }
    try { const st: any = statfsSync(cfg.out); diskFree = Number(st.bavail) * Number(st.bsize); } catch { /* ignore */ }
    const dbPath = process.env.HARNESS_DATABASE_PATH;
    if (dbPath) {
        try { walBytes = statSync(`${dbPath}-wal`).size; } catch { /* ignore */ }
        try { shmBytes = statSync(`${dbPath}-shm`).size; } catch { /* ignore */ }
    }
    appendFileSync(join(cfg.out, "process-samples.jsonl"), JSON.stringify({
        at: new Date().toISOString(), loadavg: loadavg().map((x) => Number(x.toFixed(2))),
        memFreeBytes: freemem(), memTotalBytes: totalmem(), driverRssBytes: rss, driverOpenFds: fds,
        eventLoopLagMaxMs: Number(lag.toFixed(1)), diskFreeBytes: diskFree,
        sqliteWalBytes: walBytes, sqliteShmBytes: shmBytes,
        inflight: inflight.size, acceptedInflight, submitInflight, planned: stats.planned, sent: stats.actualSent,
    }) + "\n");
    stats.processSamples++;
    if (lag > stats.eventLoopLagMaxMs) stats.eventLoopLagMaxMs = Number(lag.toFixed(1));
}

async function queueObserver(): Promise<void> {
    while (!observerStop) {
        const token = sessions[0]?.token;
        if (token) {
            const res = await api(token, "/queue", "GET", undefined, cfg.getTimeoutMs);
            const q = Array.isArray(res.data?.queue) ? res.data.queue.length : null;
            if (q !== null) {
                stats.queueLenMax = Math.max(stats.queueLenMax, q);
                stats.queuedMax = Math.max(stats.queuedMax, q);
                if (cfg.queueLimit > 0 && q >= cfg.queueLimit && !stopSubmitting) requestStop("queue_limit_reached");
            }
        }
        await sleep(2000);
    }
}

// ---------------------------------------------------------------------------
// 接受未知对账（不重发）
// ---------------------------------------------------------------------------

async function reconcileUnknown(): Promise<void> {
    for (const item of pendingUnknown) {
        const res = await api(item.sess.token, "/runs", "GET", undefined, cfg.getTimeoutMs);
        const runs: any[] = Array.isArray(res.data?.runs) ? res.data.runs : [];
        const hit = runs.find((r) => typeof r.userInput === "string" && r.userInput.includes(item.caseId));
        if (hit) {
            stats.reconciledUnknown++;
            ledger.emit("unknown_reconciled", { seq: item.seq, caseId: item.caseId, runId: hit.id, status: hit.status, note: "GET /runs 按 caseId 反查命中；未重发" });
            if (!["COMPLETED", "FAILED", "INTERRUPTED"].includes(hit.status)) {
                acceptedInflight++;
                const p = registerInflight(item.sess, { seq: item.seq, caseId: item.caseId, taskFamily: item.taskFamily, input: "" }, item.ctx, hit.id, mono(), Date.now());
                p.then((t) => ledger.emit("terminal", { seq: item.seq, caseId: item.caseId, taskFamily: item.taskFamily, runId: hit.id, status: t.status, nonConverged: t.nonConverged, polls: t.polls, reconciled: true }));
            }
        } else {
            ledger.emit("unknown_unreconciled", { seq: item.seq, caseId: item.caseId, note: "GET /runs 未找到，保持未知，不重发" });
        }
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    if (cfg.configPath) {
        const raw = JSON.parse(readFileSync(cfg.configPath, "utf8"));
        if (raw.params && typeof raw.params === "object") Object.assign(cfg, raw.params);
    }
    buildTasks();
    if (cfg.mode !== "closed" && cfg.mode !== "open") throw new Error(`mode 只能是 closed/open：${cfg.mode}`);
    if (existsSync(cfg.out) && readdirSync(cfg.out).length > 0 && !cfg.overwrite) {
        throw new Error(`证据目录非空：${cfg.out}（加 --overwrite 1 或换目录）`);
    }
    mkdirSync(join(cfg.out, "runs"), { recursive: true });

    // --plan-only：只按固定 seed 生成任务族计划（验证 §9.2 混合比例可复现），不发任何请求。
    if (cfg.planOnly) {
        const plan: Array<{ seq: number; caseId: string; taskFamily: string; inputLen: number }> = [];
        const distribution: Record<string, number> = {};
        for (let i = 0; i < cfg.total; i++) {
            const c = makeCase();
            plan.push({ seq: c.seq, caseId: c.caseId, taskFamily: c.taskFamily, inputLen: c.input.length });
            distribution[c.taskFamily] = (distribution[c.taskFamily] ?? 0) + 1;
        }
        writeFileSync(join(cfg.out, "plan-only.json"), JSON.stringify({
            task: cfg.taskFamily, seed: cfg.seed, ratios: cfg.mixRatios, total: cfg.total,
            distribution, plan,
        }, null, 2));
        console.log(JSON.stringify({ planOnly: true, seed: cfg.seed, ratios: cfg.mixRatios, total: cfg.total, distribution }, null, 2));
        return;
    }

    stats = {
        planned: 0, actualSent: 0, accepted202: 0, explicitReject: 0, acceptUnknown: 0, reconciledUnknown: 0,
        completed: 0, failed: 0, interrupted: 0, nonConverged: 0, interruptedByDriver: 0,
        acceptancePass: 0, acceptanceFail: 0, acceptanceNotRun: 0,
        pollRequestsTotal: 0, pollStatusChanges: 0, pollErrors: 0, consecutivePollErrors: 0,
        harnessActiveMax: 0, harnessActiveSamples: [], queuedMax: 0,
        vllmRunningMax: 0, vllmRunningSamples: [], clientInflightMax: 0, queueLenMax: 0,
        samplerTicks: 0, resourceSamples: 0, processSamples: 0, eventLoopLagMaxMs: 0,
        byFamilyPlanned: {}, byFamilyCompleted: {}, byFamilyAccept: {},
    };
    harnessContainersBaseline = harnessRunContainers();
    ledger = new Ledger(join(cfg.out, "requests.jsonl"));

    const lagTimer = setInterval(() => {
        const n = mono();
        const drift = n - eventLoopLast - 250;
        if (drift > eventLoopLagMax) eventLoopLagMax = drift;
        eventLoopLast = n;
    }, 250);
    (lagTimer as any).unref?.();

    const startedWall = Date.now();
    const scriptHash = hashFile(new URL(import.meta.url).pathname);
    const prep = await prepare();

    writeFileSync(join(cfg.out, "manifest.json"), JSON.stringify({
        driver: "scripts/campaign/load-driver.ts", scriptSha256: scriptHash,
        host: hostname(), bun: Bun.version, baseUrl: cfg.baseUrl,
        params: { ...cfg, configPath: cfg.configPath }, seed: cfg.seed, tag: cfg.tag, startedAt: iso(startedWall),
        env: { HARNESS_PORT: process.env.HARNESS_PORT ?? null, HARNESS_DATABASE_PATH: process.env.HARNESS_DATABASE_PATH ?? null },
        harnessContainersBaseline,
        note: "共享主机、含邻居负载：load≈31、vLLM 预留约 44G。延迟/吞吐数字不可当独占容量。",
    }, null, 2));

    const families = requiredFamilies();
    const needsBash = families.some((f) => BASH_FAMILIES.has(f));
    if (needsBash) {
        console.warn(`[load-driver] 注意：任务族 [${families.filter((f) => BASH_FAMILIES.has(f)).join(",")}] 需要 bash。`
            + ` managed-local 会 fail-closed 拒绝 bash，必须使用 container/runsc 档，且镜像需含 python（如 python:3.12-alpine）。`);
    }
    console.log(`[load-driver] prepared ${sessions.length} user(s) in ${prep.durationMs.toFixed(0)}ms; base=${cfg.baseUrl} mode=${cfg.mode} C=${cfg.concurrency} task=${cfg.taskFamily} families=${families.join(",")}`);

    const pollerP = pollerLoop();
    const samplerP = samplerLoop();
    const queueP = queueObserver();

    const productionStart = mono();
    if (cfg.mode === "closed") {
        await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, (_, i) => closedClient(i)));
    } else {
        await openLoop();
    }
    if (!stopSubmitting) requestStop("production_finished");
    const productionEnd = mono();

    // 有界排空
    const drainDeadline = mono() + cfg.drainS * 1000;
    while (inflight.size > 0 && mono() < drainDeadline) await sleep(200);

    // 未收敛任务：逐个记录 + 可选中断
    for (const r of [...inflight.values()].filter((x) => !x.settled)) {
        ledger.emit("non_converged", {
            seq: r.seq, caseId: r.caseId, runId: r.runId, status: r.lastStatus, polls: r.polls,
            ageMs: mono() - r.sentAt, action: cfg.interruptRemaining ? "interrupt" : "record_only",
        });
        if (cfg.interruptRemaining) {
            const res = await api(r.sess.token, `/runs/${r.runId}/interrupt`, "POST", {}, cfg.getTimeoutMs);
            stats.interruptedByDriver++;
            ledger.emit("interrupt_result", { runId: r.runId, caseId: r.caseId, http: res.status, ok: res.ok });
        }
        settle(r, r.lastStatus ?? "UNKNOWN", true);
    }

    // 停采样/轮询，等尾部采集落盘
    pollerStop = true;
    samplerStop = true;
    observerStop = true;
    await Promise.allSettled([pollerP, samplerP, queueP]);
    await Promise.allSettled([...pendingCollect]);
    ledger.flush();

    // 对接受未知尽力对账（不重发）
    if (pendingUnknown.length > 0) {
        await reconcileUnknown();
        // 给对账进来的 run 一点采集时间，但不阻塞过久
        if (inflight.size > 0) {
            pollerStop = false;
            const p2 = pollerLoop();
            const dd = mono() + Math.min(cfg.drainS, 60) * 1000;
            while (inflight.size > 0 && mono() < dd) await sleep(200);
            for (const r of [...inflight.values()].filter((x) => !x.settled)) settle(r, r.lastStatus ?? "UNKNOWN", true);
            pollerStop = true;
            await Promise.allSettled([p2]);
            await Promise.allSettled([...pendingCollect]);
        }
        ledger.flush();
    }

    runEndedAt = mono();
    const audit = auditLedger();
    const summary = buildSummary(audit, prep.durationMs, productionEnd - productionStart, runEndedAt - (runStartedAt || productionStart));
    writeFileSync(join(cfg.out, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(cfg.out, "report.md"), buildReport(summary));
    ledger.flush();

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.conservation.ok || audit.mismatches.length > 0) forceExitCode = 1;
}

let runEndedAt = 0;

// ---------------------------------------------------------------------------
// 汇总 / 守恒 / 账本自审
// ---------------------------------------------------------------------------

interface LedgerAudit {
    parsedLines: number; kinds: Record<string, number>;
    planned: number; sendAttempts: number; sendResults: number; terminals: number;
    outcomes: { accepted: number; rejected: number; unknown: number };
    mismatches: string[];
}

function auditLedger(): LedgerAudit {
    const path = join(cfg.out, "requests.jsonl");
    const out: LedgerAudit = { parsedLines: 0, kinds: {}, planned: 0, sendAttempts: 0, sendResults: 0, terminals: 0, outcomes: { accepted: 0, rejected: 0, unknown: 0 }, mismatches: [] };
    if (!existsSync(path)) { out.mismatches.push("requests.jsonl 不存在"); return out; }
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const attemptSeqs = new Set<number>();
    const resultSeqs = new Set<number>();
    for (const line of lines) {
        let rec: any;
        try { rec = JSON.parse(line); } catch { out.mismatches.push(`无法解析的 JSON 行：${line.slice(0, 80)}`); continue; }
        out.parsedLines++;
        out.kinds[rec.kind] = (out.kinds[rec.kind] ?? 0) + 1;
        if (rec.kind === "planned") out.planned++;
        if (rec.kind === "send_attempt") { out.sendAttempts++; attemptSeqs.add(rec.seq); }
        if (rec.kind === "send_result") {
            out.sendResults++; resultSeqs.add(rec.seq);
            if (rec.outcome === "accepted") out.outcomes.accepted++;
            else if (rec.outcome === "rejected") out.outcomes.rejected++;
            else out.outcomes.unknown++;
        }
        if (rec.kind === "terminal") out.terminals++;
    }
    for (const s of attemptSeqs) if (!resultSeqs.has(s)) out.mismatches.push(`seq=${s} 有 send_attempt 但无 send_result（疑似丢数据）`);
    const notSent = out.kinds["not_sent"] ?? 0;
    if (out.planned !== out.sendAttempts + notSent) out.mismatches.push(`账本守恒失败 planned=${out.planned} sent=${out.sendAttempts} notSent=${notSent}`);
    return out;
}

function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(1));
}

function buildSummary(audit: LedgerAudit, prepMs: number, productionMs: number, windowMs: number) {
    const notSent = stats.planned - stats.actualSent;
    const sentPartition = stats.accepted202 + stats.explicitReject + stats.acceptUnknown;
    const conservationOk = notSent >= 0 && sentPartition === stats.actualSent;
    const windowS = windowMs / 1000;
    const terminalTotal = stats.completed + stats.failed + stats.interrupted + stats.nonConverged;
    return {
        runTag: cfg.tag, seed: cfg.seed, mode: cfg.mode, params: cfg, baseUrl: cfg.baseUrl,
        startedAt: runStartWall ? iso(runStartWall) : null,
        timings: {
            prepDurationMs: Number(prepMs.toFixed(1)), prepNotCountedInLatency: true,
            productionDurationMs: Number(productionMs.toFixed(1)), runWindowMs: Number(windowMs.toFixed(1)), stopReason,
        },
        counts: {
            planned: stats.planned, actualSent: stats.actualSent, notSent,
            accepted202: stats.accepted202, explicitReject: stats.explicitReject, acceptUnknown: stats.acceptUnknown,
            reconciledUnknown: stats.reconciledUnknown,
            completed: stats.completed, failed: stats.failed, interrupted: stats.interrupted,
            nonConverged: stats.nonConverged, interruptedByDriver: stats.interruptedByDriver, terminalTotal,
            acceptancePass: stats.acceptancePass, acceptanceFail: stats.acceptanceFail, acceptanceNotRun: stats.acceptanceNotRun,
            correctTasks: stats.acceptancePass,
        },
        conservation: {
            ok: conservationOk,
            plannedEqualsSentPlusNotSent: stats.planned === stats.actualSent + notSent,
            sentEquals202PlusRejectedPlusUnknown: sentPartition === stats.actualSent,
            identity: "planned = actualSent + notSent ; actualSent = accepted202 + explicitReject + acceptUnknown",
            numbers: { planned: stats.planned, actualSent: stats.actualSent, notSent, accepted202: stats.accepted202, explicitReject: stats.explicitReject, acceptUnknown: stats.acceptUnknown },
        },
        concurrencyDistinction: {
            note: "C=客户端在途数；harnessActiveRunCountObserved=本驱动 run 中 RUNNING/WAITING_TOOL 观测最大值（非调度器全局容量）；vllmRunningRequestsObserved=GET /resources observation.snapshot.runningRequests 最大值。",
            clientInFlightConfigured: cfg.mode === "closed" ? cfg.concurrency : null,
            clientInFlightObservedMax: stats.clientInflightMax,
            harnessActiveRunCountObservedMax: stats.harnessActiveMax,
            harnessActiveRunCountObservedP50: percentile(stats.harnessActiveSamples, 50),
            vllmRunningRequestsObservedMax: stats.vllmRunningMax,
            vllmRunningRequestsObservedP50: percentile(stats.vllmRunningSamples, 50),
            harnessQueuedObservedMax: stats.queuedMax,
        },
        metrics: {
            throughputTasksPerSecCompleted: windowS > 0 ? Number((stats.completed / windowS).toFixed(4)) : null,
            submissionRateTasksPerSec: windowS > 0 ? Number((stats.actualSent / windowS).toFixed(4)) : null,
            pollRequestsTotal: stats.pollRequestsTotal, pollStatusChanges: stats.pollStatusChanges, pollErrors: stats.pollErrors,
            pollConcurrencyLimit: cfg.pollConcurrency, pollIntervalMs: [cfg.pollMinMs, cfg.pollMaxMs],
            samplerTicks: stats.samplerTicks, resourceSamples: stats.resourceSamples, processSamples: stats.processSamples,
            eventLoopLagMaxMs: stats.eventLoopLagMaxMs,
        },
        ledgerAudit: audit,
        latency: latencySummary(),
        byFamily: {
            note: "每个任务族的计划数 / 终态完成数 / 外部验收 PASS/FAIL/NOT_RUN。",
            planned: stats.byFamilyPlanned, completed: stats.byFamilyCompleted, acceptance: stats.byFamilyAccept,
        },
        mixed: cfg.taskFamily === "mixed"
            ? { ratios: cfg.mixRatios, seed: cfg.seed, families: [...MIX_FAMILIES], reproducible: true }
            : null,
        baselines: baselineByFamily,
        hostDisclaimer: "共享主机、含邻居负载：本机 load≈31，GPU 显存被 vLLM 预留约 44G（空闲时算力与 KV 占用可能为 0）。吞吐/延迟数字不可当作独占容量；仅 pass/fail 与守恒成立与否是有效结论。",
    };
}

function latencySummary() {
    const path = join(cfg.out, "requests.jsonl");
    const sentAtBySeq = new Map<number, number>();
    const e2e: number[] = [];
    const ttft: number[] = [];
    if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line.trim()) continue;
            let rec: any; try { rec = JSON.parse(line); } catch { continue; }
            if (rec.kind === "send_result" && rec.sentAt) sentAtBySeq.set(rec.seq, rec.sentAt);
            if (rec.kind === "terminal" && rec.terminalAt && sentAtBySeq.has(rec.seq)) e2e.push(rec.terminalAt - sentAtBySeq.get(rec.seq)!);
            if (rec.kind === "first_chunk" && rec.seq && sentAtBySeq.has(rec.seq) && rec.createdAt) ttft.push(rec.createdAt - sentAtBySeq.get(rec.seq)!);
        }
    }
    return {
        sampleCount: e2e.length,
        e2eMs: { p50: percentile(e2e, 50), p95: percentile(e2e, 95), max: e2e.length ? Math.max(...e2e) : null },
        ttftMs: { sampleCount: ttft.length, p50: percentile(ttft, 50), p95: percentile(ttft, 95), max: ttft.length ? Math.max(...ttft) : null },
    };
}

function buildReport(s: any): string {
    const c = s.counts, cons = s.conservation;
    return `# load-driver 运行小结（自动生成）

- runTag: ${s.runTag}  seed: ${s.seed}  mode: ${s.mode}  task: ${s.params.taskFamily}
- baseUrl: ${s.baseUrl}
- 准备耗时（不计入延迟）: ${s.timings.prepDurationMs} ms
- 运行窗口: ${s.timings.runWindowMs} ms  停止原因: ${s.timings.stopReason}

## 守恒
- planned = actualSent + notSent : ${cons.plannedEqualsSentPlusNotSent}  (${c.planned} = ${c.actualSent} + ${c.notSent})
- actualSent = 202 + 拒绝 + 未知 : ${cons.sentEquals202PlusRejectedPlusUnknown}  (${c.actualSent} = ${c.accepted202} + ${c.explicitReject} + ${c.acceptUnknown})
- 总守恒: ${cons.ok ? "OK" : "FAIL"}

## 计数
- planned=${c.planned} sent=${c.actualSent} notSent=${c.notSent}
- 202=${c.accepted202} 明确拒绝=${c.explicitReject} 接受未知=${c.acceptUnknown}（反查命中=${c.reconciledUnknown}）
- 完成=${c.completed} 失败=${c.failed} 中断=${c.interrupted} 未收敛=${c.nonConverged} 驱动中断=${c.interruptedByDriver}
- 外部验收 PASS=${c.acceptancePass} FAIL=${c.acceptanceFail} NOT_RUN=${c.acceptanceNotRun}

## 三种并发口径（不可混用）
- 客户端在途 C（配置/观测最大）: ${s.concurrencyDistinction.clientInFlightConfigured} / ${s.concurrencyDistinction.clientInFlightObservedMax}
- Harness activeRunCount（本驱动 run 观测最大）: ${s.concurrencyDistinction.harnessActiveRunCountObservedMax}
- vLLM running_requests（/resources 观测最大）: ${s.concurrencyDistinction.vllmRunningRequestsObservedMax}

## 指标
- 完成吞吐: ${s.metrics.throughputTasksPerSecCompleted} 任务/s
- poll 请求总数=${s.metrics.pollRequestsTotal} 错误=${s.metrics.pollErrors} 并发上限=${s.metrics.pollConcurrencyLimit}
- 采样器 tick=${s.metrics.samplerTicks} resources=${s.metrics.resourceSamples} process=${s.metrics.processSamples}
- 事件循环最大延迟=${s.metrics.eventLoopLagMaxMs} ms

## 账本自审
- 解析行数=${s.ledgerAudit.parsedLines}  attempt=${s.ledgerAudit.sendAttempts} result=${s.ledgerAudit.sendResults} terminal=${s.ledgerAudit.terminals}
- 异常=${s.ledgerAudit.mismatches.length === 0 ? "无" : JSON.stringify(s.ledgerAudit.mismatches)}

## 各任务族外部验收
${Object.keys(s.byFamily.planned).length === 0 ? "- （无）" : Object.keys(s.byFamily.planned).sort().map((f) => {
        const acc = s.byFamily.acceptance[f] ?? { pass: 0, fail: 0, notRun: 0 };
        return `- ${f}: planned=${s.byFamily.planned[f]} completed=${s.byFamily.completed[f] ?? 0} PASS=${acc.pass} FAIL=${acc.fail} NOT_RUN=${acc.notRun}`;
    }).join("\n")}
${s.mixed ? `\n## 混合模式（§9.2）\n- 比例=${s.mixed.ratios} seed=${s.mixed.seed} 任务族=${s.mixed.families.join(",")}（固定 seed 可复现）\n` : ""}${s.baselines && Object.keys(s.baselines).length ? `\n## 任务前基线（"先失败"证据）\n${Object.entries(s.baselines).map(([k, v]: any) => `- ${k}: cmd=${JSON.stringify(v.cmd)} exit=${v.exitCode} failedAsExpected=${v.failedAsExpected}`).join("\n")}\n` : ""}
> ${s.hostDisclaimer}
`;
}

main()
    .then(() => { if (forceExitCode !== null) process.exit(forceExitCode); })
    .catch((e) => {
        console.error(`[load-driver] 致命错误: ${e instanceof Error ? e.stack : e}`);
        try { ledger?.flush(); } catch { /* ignore */ }
        process.exit(2);
    });
