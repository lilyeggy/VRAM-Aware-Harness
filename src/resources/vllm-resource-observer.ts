/**
 * 真正连接底层基础设施，进行实际资源观测
 * 主要涉及几个层面
 * 1. 如何把promethus文本转化为 harness 的资源事实
 * 2. vllm 或者 Nvidia 单独失败的时候如何降级
 * 3. 如何通过两次累计 counter 计算input/output tokens/s
 */

import type {
    ResourceObservation,
    ResourceObservationFailureReason,
    ResourceObservationSource,
    ResourceObserver,
    ResourceSnapshot,
}   from "./resource-observer.ts";

export interface VllmResourceObserverConfig {
    metricsUrl:string;
    timeoutMs:number;
    gpuIds:readonly string[];
}

// vllm的原始观测内容
// 其实对应了部分ResourceObservation里的内容
export interface VllmMetricsSample {
    runningRequests : number | null;
    waitingRequests : number | null;
    kvCacheUsagePercent : number | null;

    promptTokensTotal : number | null;
    generationTokensTotal : number | null;
}

interface NvidiaGpuSample {
    gpuTotalMemoryMiB : number;
    gpuUsedMemoryMiB : number;
    gpuFreeMemoryMiB : number;
    gpuUtilizationPercent : number;
}

export interface CommandExecutionResult {
    exitCode:number;
    stdout:string;
    stderr:string;
    timedOut?:boolean;
}

export type MetricsFetcher = (
    url:string,
    init?:RequestInit,
) => Promise<Response>;

export type NvidiaSmiRunner = (
    args:readonly string[],
    timeoutMs:number,
) => Promise<CommandExecutionResult>;

export interface VllmResourceObserverDependencies {
    fetcher?:MetricsFetcher;
    runNvidiaSmi?:NvidiaSmiRunner;
    now?:() => Date;
    createSnapshotId?:() => string;
}

interface TokenCounterSample {
    observedAtMs : number;
    promptTokensTotal : number | null;
    generationTokensTotal : number | null;
}

/**
 * 把 vLLM /metrics 返回的 Prometheus 文本解析成 Observer 内部使用的结构。
 *
 * 相同指标可能因为 model_name 等标签出现多行：
 * - 请求数和 Token Counter 代表总工作量，因此求和；
 * - KV Cache 代表压力，因此取最大值，避免平均值掩盖高压实例。
 */
export function parseVllmMetrics(
    text:string,
):VllmMetricsSample {
    const runningRequests = sumMetric(
        text,
        "vllm:num_requests_running",
    );
    const waitingRequests = sumMetric(
        text,
        "vllm:num_requests_waiting",
    );
    const kvCacheUsageFraction = maxMetric(
        text,
        "vllm:kv_cache_usage_perc",
    );
    const promptTokensTotal = sumMetric(
        text,
        "vllm:prompt_tokens_total",
    );
    const generationTokensTotal = sumMetric(
        text,
        "vllm:generation_tokens_total",
    );

    if (
        runningRequests === null
        && waitingRequests === null
        && kvCacheUsageFraction === null
        && promptTokensTotal === null
        && generationTokensTotal === null
    ) {
        throw new Error(
            "metrics 中没有可识别的 vLLM 指标",
        );
    }

    assertNonNegativeInteger(
        "vllm:num_requests_running",
        runningRequests,
    );
    assertNonNegativeInteger(
        "vllm:num_requests_waiting",
        waitingRequests,
    );
    assertNonNegative(
        "vllm:prompt_tokens_total",
        promptTokensTotal,
    );
    assertNonNegative(
        "vllm:generation_tokens_total",
        generationTokensTotal,
    );

    if (
        kvCacheUsageFraction !== null
        && (
            kvCacheUsageFraction < 0
            || kvCacheUsageFraction > 1
        )
    ) {
        throw new Error(
            "vllm:kv_cache_usage_perc 必须位于 0 到 1",
        );
    }

    return {
        runningRequests,
        waitingRequests,
        kvCacheUsagePercent:
            kvCacheUsageFraction === null
                ? null
                : kvCacheUsageFraction * 100,
        promptTokensTotal,
        generationTokensTotal,
    };
}

/**
 * Prometheus sample 支持两种常见形式：
 * metric_name 1
 * metric_name{label="value"} 1
 *
 * HELP/TYPE 注释、其他指标和无效数值会被忽略。Sample 末尾可选的
 * timestamp 也不会参与本次资源观测。
 */
function readMetricValues(
    text:string,
    metricName:string,
):number[] {
    const values:number[] = [];

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (
            line.length === 0
            || line.startsWith("#")
        ) {
            continue;
        }

        const hasLabels = line.startsWith(
            `${metricName}{`,
        );
        const hasNoLabels = line.startsWith(
            `${metricName} `,
        );

        if (!hasLabels && !hasNoLabels) {
            continue;
        }

        const closingBraceIndex = hasLabels
            ? line.indexOf("}")
            : -1;

        // 有标签却没有结束花括号，说明这一行不是合法 sample。
        if (hasLabels && closingBraceIndex < 0) {
            continue;
        }

        const valueSection = hasLabels
            ? line.slice(closingBraceIndex + 1).trim()
            : line.slice(metricName.length).trim();
        const valueText = valueSection.split(/\s+/)[0];

        if (valueText === undefined) {
            continue;
        }

        const value = Number(valueText);
        if (Number.isFinite(value)) {
            values.push(value);
        }
    }

    return values;
}

function sumMetric(
    text:string,
    metricName:string,
):number | null {
    const values = readMetricValues(text, metricName);

    if (values.length === 0) {
        return null;
    }

    return values.reduce(
        (sum, value) => sum + value,
        0,
    );
}

function maxMetric(
    text:string,
    metricName:string,
):number | null {
    const values = readMetricValues(text, metricName);

    return values.length === 0
        ? null
        : Math.max(...values);
}

function assertNonNegative(
    metricName:string,
    value:number | null,
):void {
    if (value !== null && value < 0) {
        throw new Error(`${metricName} 不能为负数`);
    }
}

function assertNonNegativeInteger(
    metricName:string,
    value:number | null,
):void {
    if (
        value !== null
        && (!Number.isInteger(value) || value < 0)
    ) {
        throw new Error(
            `${metricName} 必须是非负整数`,
        );
    }
}


interface ProbeSuccess<T> {
    ok:true;
    value:T;
}

interface ProbeFailure {
    ok:false;
    reason:ResourceObservationFailureReason;
    message:string;
}

type ProbeResult<T> = ProbeSuccess<T> | ProbeFailure;

class ResourceProbeError extends Error {
    constructor(
        readonly reason:ResourceObservationFailureReason,
        message:string,
    ) {
        super(message);
        this.name = "ResourceProbeError";
    }
}

// 这个类是执行观测的
export class VllmResourceObserver implements ResourceObserver {
    private previousTokenCounters:TokenCounterSample | null = null;
    private readonly fetcher:MetricsFetcher;
    private readonly runNvidiaSmi:NvidiaSmiRunner;
    private readonly now:() => Date;
    private readonly createSnapshotId:() => string;

    constructor (
        private readonly config:VllmResourceObserverConfig,
        dependencies:VllmResourceObserverDependencies = {},
    )   {
        // 测试可以替换外部依赖，不需要真的启动 vLLM 或安装 NVIDIA GPU。
        this.fetcher = dependencies.fetcher ?? globalThis.fetch;
        this.runNvidiaSmi = dependencies.runNvidiaSmi
            ?? runNvidiaSmiCommand;
        this.now = dependencies.now ?? (() => new Date());
        this.createSnapshotId = dependencies.createSnapshotId
            ?? (() => crypto.randomUUID());

        if (
            !Number.isFinite(config.timeoutMs)
            || config.timeoutMs <= 0
        ) {
            throw new Error("timeoutMs 必须大于 0");
        }

        if (config.gpuIds.length === 0) {
            throw new Error("至少需要配置一个 gpuId");
        }
    }

    // 具体执行一次观测
    async observe():Promise<ResourceObservation> {
        const observedAtDate = this.now();
        const observedAt = observedAtDate.toISOString();

        // 两个来源并行采集，避免最坏情况下串行等待两次 timeout。
        const [vllmResult, nvidiaResult] = await Promise.all([
            this.captureProbe(() => this.readVllmMetrics()),
            this.captureProbe(() => this.readNvidiaGpu()),
        ]);

        if (!vllmResult.ok && !nvidiaResult.ok) {
            return {
                ok:false,
                observedAt,
                attemptedSources:[
                    "VLLM_METRICS",
                    "NVIDIA_SMI",
                ],
                reason:combineFailureReasons(
                    vllmResult.reason,
                    nvidiaResult.reason,
                ),
                message:
                    `vLLM: ${vllmResult.message}; NVIDIA: ${nvidiaResult.message}`,
            };
        }

        const sources:ResourceObservationSource[] = [];
        if (vllmResult.ok) {
            sources.push("VLLM_METRICS");
        }
        if (nvidiaResult.ok) {
            sources.push("NVIDIA_SMI");
        }

        const tokenRates = vllmResult.ok
            ? this.calculateTokenRates(
                observedAtDate.getTime(),
                vllmResult.value,
            )
            : {
                inputTokensPerSecond:null,
                outputTokensPerSecond:null,
            };

        const snapshot:ResourceSnapshot = {
            snapshotId:this.createSnapshotId(),
            observedAt,
            sources,
            gpuTotalMemoryMiB:nvidiaResult.ok
                ? nvidiaResult.value.gpuTotalMemoryMiB
                : null,
            gpuUsedMemoryMiB:nvidiaResult.ok
                ? nvidiaResult.value.gpuUsedMemoryMiB
                : null,
            gpuFreeMemoryMiB:nvidiaResult.ok
                ? nvidiaResult.value.gpuFreeMemoryMiB
                : null,
            gpuUtilizationPercent:nvidiaResult.ok
                ? nvidiaResult.value.gpuUtilizationPercent
                : null,
            runningRequests:vllmResult.ok
                ? vllmResult.value.runningRequests
                : null,
            waitingRequests:vllmResult.ok
                ? vllmResult.value.waitingRequests
                : null,
            kvCacheUsagePercent:vllmResult.ok
                ? vllmResult.value.kvCacheUsagePercent
                : null,
            inputTokensPerSecond:
                tokenRates.inputTokensPerSecond,
            outputTokensPerSecond:
                tokenRates.outputTokensPerSecond,
        };

        return {
            ok:true,
            snapshot,
        };
    }

    private async readVllmMetrics():Promise<VllmMetricsSample> {
        try {
            const response = await this.fetcher(
                this.config.metricsUrl,
                {
                    signal:AbortSignal.timeout(
                        this.config.timeoutMs,
                    ),
                },
            );

            if (!response.ok) {
                throw new ResourceProbeError(
                    "UNAVAILABLE",
                    `vLLM metrics 请求失败：HTTP ${response.status}`,
                );
            }

            const text = await response.text();

            try {
                return parseVllmMetrics(text);
            } catch (error) {
                throw new ResourceProbeError(
                    "INVALID_RESPONSE",
                    errorMessage(error),
                );
            }
        } catch (error) {
            if (error instanceof ResourceProbeError) {
                throw error;
            }

            throw new ResourceProbeError(
                isTimeoutError(error)
                    ? "TIMEOUT"
                    : "UNAVAILABLE",
                errorMessage(error),
            );
        }
    }

    private async readNvidiaGpu():Promise<NvidiaGpuSample> {
        const args = [
            "--query-gpu=memory.total,memory.used,memory.free,utilization.gpu",
            "--format=csv,noheader,nounits",
            `--id=${this.config.gpuIds.join(",")}`,
        ];

        let result:CommandExecutionResult;

        try {
            result = await this.runNvidiaSmi(
                args,
                this.config.timeoutMs,
            );
        } catch (error) {
            throw new ResourceProbeError(
                "UNAVAILABLE",
                errorMessage(error),
            );
        }

        if (result.timedOut) {
            throw new ResourceProbeError(
                "TIMEOUT",
                "nvidia-smi 执行超时",
            );
        }

        if (result.exitCode !== 0) {
            throw new ResourceProbeError(
                "UNAVAILABLE",
                result.stderr.trim()
                    || `nvidia-smi 退出码 ${result.exitCode}`,
            );
        }

        try {
            return parseNvidiaSmiCsv(result.stdout);
        } catch (error) {
            throw new ResourceProbeError(
                "INVALID_RESPONSE",
                errorMessage(error),
            );
        }
    }

    private async captureProbe<T>(
        probe:() => Promise<T>,
    ):Promise<ProbeResult<T>> {
        try {
            return {
                ok:true,
                value:await probe(),
            };
        } catch (error) {
            if (error instanceof ResourceProbeError) {
                return {
                    ok:false,
                    reason:error.reason,
                    message:error.message,
                };
            }

            return {
                ok:false,
                reason:"UNAVAILABLE",
                message:errorMessage(error),
            };
        }
    }

    private calculateTokenRates(
        observedAtMs:number,
        sample:VllmMetricsSample,
    ): {
        inputTokensPerSecond:number | null;
        outputTokensPerSecond:number | null;
    } {
        const previous = this.previousTokenCounters;

        // 当前 Counter 总要保存下来，下一次观测才能计算时间差和增量。
        this.previousTokenCounters = {
            observedAtMs,
            promptTokensTotal:sample.promptTokensTotal,
            generationTokensTotal:sample.generationTokensTotal,
        };

        if (previous === null) {
            return {
                inputTokensPerSecond:null,
                outputTokensPerSecond:null,
            };
        }

        const elapsedSeconds =
            (observedAtMs - previous.observedAtMs) / 1_000;

        return {
            inputTokensPerSecond:counterRate(
                previous.promptTokensTotal,
                sample.promptTokensTotal,
                elapsedSeconds,
            ),
            outputTokensPerSecond:counterRate(
                previous.generationTokensTotal,
                sample.generationTokensTotal,
                elapsedSeconds,
            ),
        };
    }
}

/** 多 GPU 时显存求和，利用率取最大值，避免平均值掩盖高压 GPU。 */
export function parseNvidiaSmiCsv(text:string):NvidiaGpuSample {
    const rows = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line
            .split(",")
            .map((value) => value.trim())
        );

    if (rows.length === 0) {
        throw new Error("nvidia-smi 没有返回 GPU 数据");
    }

    const values = rows.map((row) => {
        if (row.length !== 4) {
            throw new Error("nvidia-smi CSV 必须包含 4 列");
        }

        return row.map((rawValue) => {
            const value = Number(rawValue);

            if (!Number.isFinite(value) || value < 0) {
                throw new Error(
                    `nvidia-smi 返回非法数值：${rawValue}`,
                );
            }

            return value;
        });
    });
    const gpuUtilizationPercent = Math.max(
        ...values.map((row) => row[3] ?? 0),
    );

    if (gpuUtilizationPercent > 100) {
        throw new Error("GPU utilization 不能超过 100");
    }

    return {
        gpuTotalMemoryMiB:sumColumn(values, 0),
        gpuUsedMemoryMiB:sumColumn(values, 1),
        gpuFreeMemoryMiB:sumColumn(values, 2),
        gpuUtilizationPercent,
    };
}

function sumColumn(
    rows:readonly (readonly number[])[],
    column:number,
):number {
    return rows.reduce(
        (sum, row) => sum + (row[column] ?? 0),
        0,
    );
}

function counterRate(
    previous:number | null,
    current:number | null,
    elapsedSeconds:number,
):number | null {
    // Counter 在 vLLM 重启后会归零，这种区间不能计算可信 rate。
    if (
        previous === null
        || current === null
        || elapsedSeconds <= 0
        || current < previous
    ) {
        return null;
    }

    return (current - previous) / elapsedSeconds;
}

function combineFailureReasons(
    first:ResourceObservationFailureReason,
    second:ResourceObservationFailureReason,
):ResourceObservationFailureReason {
    const reasons = [first, second];

    if (reasons.includes("TIMEOUT")) {
        return "TIMEOUT";
    }

    if (reasons.includes("INVALID_RESPONSE")) {
        return "INVALID_RESPONSE";
    }

    return "UNAVAILABLE";
}

function isTimeoutError(error:unknown):boolean {
    return error instanceof Error
        && (
            error.name === "TimeoutError"
            || error.name === "AbortError"
        );
}

function errorMessage(error:unknown):string {
    return error instanceof Error
        ? error.message
        : String(error);
}

async function runNvidiaSmiCommand(
    args:readonly string[],
    timeoutMs:number,
):Promise<CommandExecutionResult> {
    const process = Bun.spawn(
        ["nvidia-smi", ...args],
        {
            stdout:"pipe",
            stderr:"pipe",
        },
    );
    const stdoutPromise = new Response(process.stdout).text();
    const stderrPromise = new Response(process.stderr).text();
    let timeoutId:ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<"TIMEOUT">((resolve) => {
        timeoutId = setTimeout(
            () => resolve("TIMEOUT"),
            timeoutMs,
        );
    });
    const exited = process.exited.then((exitCode) => ({
        exitCode,
    }));
    const outcome = await Promise.race([exited, timeout]);

    if (outcome === "TIMEOUT") {
        process.kill();
        await process.exited;

        return {
            exitCode:-1,
            stdout:await stdoutPromise,
            stderr:await stderrPromise,
            timedOut:true,
        };
    }

    if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
    }

    return {
        exitCode:outcome.exitCode,
        stdout:await stdoutPromise,
        stderr:await stderrPromise,
    };
}
