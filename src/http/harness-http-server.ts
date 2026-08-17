import type {
    HarnessHttpApi,
} from "./harness-http-api.ts";

export interface HarnessHttpServerOptions {
    hostname?:string;
    port?:number;
}

export function startHarnessHttpServer(
    api:HarnessHttpApi,
    options:HarnessHttpServerOptions = {},
):ReturnType<typeof Bun.serve> {
    return Bun.serve({
        hostname:options.hostname ?? "127.0.0.1",
        port:options.port ?? 3000,
        fetch(request) {
            return api.fetch(request);
        },
    });
}
