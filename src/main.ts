import {
    createHarnessApplication,
    type HarnessComposition,
    type HarnessCompositionDependencies,
} from "./app/create-harness-application.ts";
import {
    loadHarnessConfig,
    type HarnessConfig,
    type HarnessEnvironment,
} from "./app/harness-config.ts";
import {
    startHarnessHttpServer,
} from "./http/harness-http-server.ts";

type HarnessServer = ReturnType<typeof startHarnessHttpServer>;

export interface StartHarnessProcessOptions {
    config?:HarnessConfig;
    environment?:HarnessEnvironment;
    cwd?:string;
    compositionDependencies?:HarnessCompositionDependencies;
    installSignalHandlers?:boolean;
}

export interface RunningHarnessProcess {
    config:HarnessConfig;
    composition:HarnessComposition;
    server:HarnessServer;
    baseUrl:string;
    close():Promise<void>;
}

/**
 * 启动一个完整 Harness 进程。
 *
 * 启动顺序保证：恢复和 QueuePump 就绪后才开放 HTTP；关闭顺序相反，
 * 先停止接收新请求，再停止 Pump 并关闭 SQLite。
 */
export async function startHarnessProcess(
    options:StartHarnessProcessOptions = {},
):Promise<RunningHarnessProcess> {
    const config = options.config ?? loadHarnessConfig(
        options.environment ?? process.env,
        options.cwd ?? process.cwd(),
    );
    const composition = await createHarnessApplication(
        config,
        options.compositionDependencies,
    );
    let server:HarnessServer;

    try {
        await composition.application.start();
        composition.resourceMetrics.start();
        server = startHarnessHttpServer(composition.httpApi, {
            hostname:config.httpHost,
            port:config.httpPort,
        });
    } catch (error) {
        await composition.close();
        throw error;
    }

    let closePromise:Promise<void> | null = null;
    const signalHandlers = new Map<
        NodeJS.Signals,
        () => void
    >();

    const close = ():Promise<void> => {
        if (closePromise !== null) {
            return closePromise;
        }

        closePromise = (async () => {
            for (const [signal, handler] of signalHandlers) {
                process.off(signal, handler);
            }
            signalHandlers.clear();

            await server.stop(true);
            await composition.close();
        })();

        return closePromise;
    };

    if (options.installSignalHandlers !== false) {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const handler = () => {
                console.log(`收到 ${signal}，正在安全关闭 Harness`);

                void close().catch((error) => {
                    console.error("Harness 安全关闭失败", error);
                    process.exitCode = 1;
                });
            };

            signalHandlers.set(signal, handler);
            process.once(signal, handler);
        }
    }

    const clientHost = config.httpHost === "0.0.0.0"
        ? "127.0.0.1"
        : config.httpHost;
    const baseUrl = `http://${clientHost}:${server.port}`;

    return {
        config,
        composition,
        server,
        baseUrl,
        close,
    };
}

if (import.meta.main) {
    try {
        const runningHarness = await startHarnessProcess();

        console.log(`VRAM-Aware Harness 已启动：${runningHarness.baseUrl}`);
        console.log(
            `模型：${runningHarness.config.piProvider}/${runningHarness.config.piModelId}`,
        );
        console.log(`数据库：${runningHarness.config.databasePath}`);
    } catch (error) {
        console.error(
            "VRAM-Aware Harness 启动失败",
            error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
    }
}
