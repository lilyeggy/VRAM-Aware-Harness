/**
 * 日志/审计落盘前的 Secret 脱敏。
 *
 * 形如 `API_KEY=xxx` 的环境变量赋值统一打码并截断，原先在
 * container-sandbox-provider 与 container-runtime-adapter 各有一份。
 */
export function redact(value: string): string {
    return value.replace(/(?:[A-Z][A-Z0-9_]{2,})=\S+/g, "$1=[REDACTED]").slice(0, 1_000);
}
