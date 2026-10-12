/*
 * guest/agent/agent.c — 小体积静态 guest agent（!9.8 v1.4 Phase 1 冷启动优化）
 *
 * 为什么存在：原实现是 `socat VSOCK-LISTEN:5000,fork EXEC:/agent/main`，其中
 * /agent/main 是 96MB 的 bun build --compile 产物。真机实测（172.17.43.193）：
 *   - socat 从 execve 到 listen 只有 5.3ms（strace 实测），不是瓶颈；
 *   - 96MB bun 产物在 guest 冷页缓存下从 exec 到能应答 ping 约 240ms；
 *   - 换成约 900KB 的静态应答器后，同样的宿主探测参数下冷启动从 442ms 掉到 208ms。
 * 因此把「监听 + 协议」合成一个约 30KB 的静态二进制，并让它自己监听 AF_VSOCK，
 * 既去掉 socat 这一层，也去掉 96MB 的加载成本。
 *
 * 协议与 guest/agent/main.ts 完全一致（newline-delimited JSON, v=1）：
 *   收到  {"v":1,"type":"ping","id":<any>}
 *   回    {"v":1,"type":"pong","id":<any>}
 *   收到  {"v":1,"type":"exec","id":<any>,"argv":[...],"cwd":str,"env":{k:v},
 *          "timeoutMs":int,"maxOutputBytes":int}
 *   回    {"v":1,"type":"exec_output","id":<any>,"stream":"stdout"|"stderr","data":"<base64>"}
 *   回    {"v":1,"type":"exec_result","id":<any>,"exitCode":int,"timedOut":bool,"truncated":bool}
 *   错误  {"v":1,"type":"error","id":<any>|null,"reason":"protocol"|"protocol_frame_too_large"}
 *
 * 用法：agent [--stdio] [--port=N]
 *   --stdio  在 stdin/stdout 上服务协议（宿主机/CI 测试用；非 Linux 也可编译运行）
 *   默认     在 Linux 上监听 AF_VSOCK N（默认 5000），每连接 fork 一个子进程服务
 *
 * 安全定位：本进程在不可信 guest 内运行，与 main.ts 版本等价（无网络、只做 exec）。
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/vm_sockets.h>
#endif

#define MAX_FRAME_BYTES 1048576
#define CHUNK_BYTES 65536
#define DEFAULT_MAX_OUTPUT_BYTES 1048576
#define DEFAULT_TIMEOUT_MS 60000
#define KILL_GRACE_MS 2000
#define DRAIN_SILENCE_MS 1000
#define DEFAULT_PATH "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
#define DEFAULT_PORT 5000
#define ARENA_BYTES (2 * 1024 * 1024)

/* ------------------------------------------------------------------ 时钟 */

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ------------------------------------------------------- 请求级内存池（arena）
 * 每处理完一条请求帧整体重置；JSON DOM、argv/envp 都从这里分配，
 * 避免在 1MiB 帧大小下反复 malloc/free。处理是串行的，生命周期够用。 */

static char *g_arena;
static size_t g_arena_used;

static void arena_init(void)
{
    if (g_arena == NULL) {
        g_arena = (char *)malloc(ARENA_BYTES);
    }
    g_arena_used = 0;
}

static void arena_reset(void)
{
    g_arena_used = 0;
}

static void *arena_alloc(size_t n)
{
    if (g_arena == NULL) {
        return NULL;
    }
    n = (n + 7u) & ~(size_t)7u;
    if (g_arena_used + n > ARENA_BYTES) {
        return NULL;
    }
    void *p = g_arena + g_arena_used;
    g_arena_used += n;
    return p;
}

static char *arena_strndup(const char *s, size_t n)
{
    char *out = (char *)arena_alloc(n + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, s, n);
    out[n] = 0;
    return out;
}

static char *arena_printf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int need = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (need < 0) {
        va_end(ap2);
        return NULL;
    }
    char *out = (char *)arena_alloc((size_t)need + 1);
    if (out != NULL) {
        vsnprintf(out, (size_t)need + 1, fmt, ap2);
    }
    va_end(ap2);
    return out;
}

/* ------------------------------------------------------------- JSON 最小解析 */

enum { J_NULL = 0, J_FALSE, J_TRUE, J_NUM, J_STR, J_ARR, J_OBJ };

typedef struct JVal {
    int type;
    double num;
    char *raw;              /* J_NUM：原样文本，回写 id 时保持字面一致 */
    char *str;              /* J_STR：已解码 */
    char *key;              /* 对象成员键；数组元素为 NULL */
    struct JVal *first;
    struct JVal *next;
} JVal;

typedef struct {
    const char *p;
    const char *end;
    int depth;
} JParser;

static JVal *jnew(int type)
{
    JVal *v = (JVal *)arena_alloc(sizeof(JVal));
    if (v != NULL) {
        memset(v, 0, sizeof(JVal));
        v->type = type;
    }
    return v;
}

static void jskip_ws(JParser *ps)
{
    while (ps->p < ps->end) {
        char c = *ps->p;
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            ps->p++;
            continue;
        }
        break;
    }
}

static int hex4(const char *p, unsigned *out)
{
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') {
            v |= (unsigned)(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            v |= (unsigned)(c - 'a' + 10);
        } else if (c >= 'A' && c <= 'F') {
            v |= (unsigned)(c - 'A' + 10);
        } else {
            return 0;
        }
    }
    *out = v;
    return 1;
}

static int utf8_put(char *out, size_t cap, size_t *len, unsigned cp)
{
    if (cp < 0x80u) {
        if (*len + 1 > cap) {
            return 0;
        }
        out[(*len)++] = (char)cp;
    } else if (cp < 0x800u) {
        if (*len + 2 > cap) {
            return 0;
        }
        out[(*len)++] = (char)(0xC0u | (cp >> 6));
        out[(*len)++] = (char)(0x80u | (cp & 0x3Fu));
    } else if (cp < 0x10000u) {
        if (*len + 3 > cap) {
            return 0;
        }
        out[(*len)++] = (char)(0xE0u | (cp >> 12));
        out[(*len)++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[(*len)++] = (char)(0x80u | (cp & 0x3Fu));
    } else {
        if (*len + 4 > cap) {
            return 0;
        }
        out[(*len)++] = (char)(0xF0u | (cp >> 18));
        out[(*len)++] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
        out[(*len)++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
        out[(*len)++] = (char)(0x80u | (cp & 0x3Fu));
    }
    return 1;
}

/* 先把整段字面量扫出来定长，再原地解码（arena 不支持 realloc）。 */
static char *jparse_string(JParser *ps)
{
    if (ps->p >= ps->end || *ps->p != '"') {
        return NULL;
    }
    const char *start = ps->p + 1;
    const char *q = start;
    while (q < ps->end) {
        if (*q == '\\') {
            q += 2;
            continue;
        }
        if (*q == '"') {
            break;
        }
        q++;
    }
    if (q >= ps->end || *q != '"') {
        return NULL;
    }
    size_t raw_len = (size_t)(q - start);
    char *out = (char *)arena_alloc(raw_len + 1);
    if (out == NULL) {
        return NULL;
    }
    size_t len = 0;
    const char *c = start;
    while (c < q) {
        if (*c != '\\') {
            out[len++] = *c++;
            continue;
        }
        c++;
        if (c >= q) {
            return NULL;
        }
        switch (*c) {
        case '"': out[len++] = '"'; c++; break;
        case '\\': out[len++] = '\\'; c++; break;
        case '/': out[len++] = '/'; c++; break;
        case 'b': out[len++] = '\b'; c++; break;
        case 'f': out[len++] = '\f'; c++; break;
        case 'n': out[len++] = '\n'; c++; break;
        case 'r': out[len++] = '\r'; c++; break;
        case 't': out[len++] = '\t'; c++; break;
        case 'u': {
            unsigned cp = 0;
            if (c + 5 > q || hex4(c + 1, &cp) == 0) {
                return NULL;
            }
            c += 5;
            if (cp >= 0xD800u && cp <= 0xDBFFu && c + 6 <= q && c[0] == '\\' && c[1] == 'u') {
                unsigned lo = 0;
                if (hex4(c + 2, &lo) != 0 && lo >= 0xDC00u && lo <= 0xDFFFu) {
                    cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                    c += 6;
                }
            }
            if (utf8_put(out, raw_len, &len, cp) == 0) {
                return NULL;
            }
            break;
        }
        default:
            return NULL;
        }
    }
    out[len] = 0;
    ps->p = q + 1;
    return out;
}

static JVal *jparse_value(JParser *ps);

static JVal *jparse_container(JParser *ps, int type)
{
    char open_ch = (type == J_ARR) ? '[' : '{';
    char close_ch = (type == J_ARR) ? ']' : '}';
    if (ps->p >= ps->end || *ps->p != open_ch) {
        return NULL;
    }
    if (ps->depth++ > 32) {
        return NULL;
    }
    ps->p++;
    JVal *root = jnew(type);
    if (root == NULL) {
        return NULL;
    }
    JVal *tail = NULL;
    jskip_ws(ps);
    if (ps->p < ps->end && *ps->p == close_ch) {
        ps->p++;
        ps->depth--;
        return root;
    }
    for (;;) {
        jskip_ws(ps);
        char *key = NULL;
        if (type == J_OBJ) {
            key = jparse_string(ps);
            if (key == NULL) {
                return NULL;
            }
            jskip_ws(ps);
            if (ps->p >= ps->end || *ps->p != ':') {
                return NULL;
            }
            ps->p++;
            jskip_ws(ps);
        }
        JVal *item = jparse_value(ps);
        if (item == NULL) {
            return NULL;
        }
        item->key = key;
        if (tail == NULL) {
            root->first = item;
        } else {
            tail->next = item;
        }
        tail = item;
        jskip_ws(ps);
        if (ps->p < ps->end && *ps->p == ',') {
            ps->p++;
            continue;
        }
        if (ps->p < ps->end && *ps->p == close_ch) {
            ps->p++;
            break;
        }
        return NULL;
    }
    ps->depth--;
    return root;
}

static JVal *jparse_value(JParser *ps)
{
    jskip_ws(ps);
    if (ps->p >= ps->end) {
        return NULL;
    }
    char c = *ps->p;
    if (c == '{') {
        return jparse_container(ps, J_OBJ);
    }
    if (c == '[') {
        return jparse_container(ps, J_ARR);
    }
    if (c == '"') {
        char *s = jparse_string(ps);
        if (s == NULL) {
            return NULL;
        }
        JVal *v = jnew(J_STR);
        if (v != NULL) {
            v->str = s;
        }
        return v;
    }
    if (ps->end - ps->p >= 4 && strncmp(ps->p, "true", 4) == 0) {
        ps->p += 4;
        return jnew(J_TRUE);
    }
    if (ps->end - ps->p >= 5 && strncmp(ps->p, "false", 5) == 0) {
        ps->p += 5;
        return jnew(J_FALSE);
    }
    if (ps->end - ps->p >= 4 && strncmp(ps->p, "null", 4) == 0) {
        ps->p += 4;
        return jnew(J_NULL);
    }
    const char *start = ps->p;
    if (c == '-' || c == '+') {
        ps->p++;
    }
    int digits = 0;
    while (ps->p < ps->end && ((*ps->p >= '0' && *ps->p <= '9') || *ps->p == '.' || *ps->p == 'e' || *ps->p == 'E' || *ps->p == '+' || *ps->p == '-')) {
        if (*ps->p >= '0' && *ps->p <= '9') {
            digits++;
        }
        ps->p++;
    }
    if (digits == 0) {
        return NULL;
    }
    JVal *v = jnew(J_NUM);
    if (v != NULL) {
        v->raw = arena_strndup(start, (size_t)(ps->p - start));
        v->num = v->raw == NULL ? 0 : strtod(v->raw, NULL);
    }
    return v;
}

static JVal *jparse(const char *text, size_t len)
{
    JParser ps;
    ps.p = text;
    ps.end = text + len;
    ps.depth = 0;
    JVal *root = jparse_value(&ps);
    if (root == NULL) {
        return NULL;
    }
    jskip_ws(&ps);
    if (ps.p != ps.end) {
        return NULL;
    }
    return root;
}

static JVal *jget(JVal *obj, const char *key)
{
    if (obj == NULL || obj->type != J_OBJ) {
        return NULL;
    }
    for (JVal *c = obj->first; c != NULL; c = c->next) {
        if (c->key != NULL && strcmp(c->key, key) == 0) {
            return c;
        }
    }
    return NULL;
}

/* --------------------------------------------------------------- 帧写出 */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void write_b64(FILE *out, const unsigned char *d, size_t n)
{
    size_t i = 0;
    while (i + 3 <= n) {
        unsigned v = ((unsigned)d[i] << 16) | ((unsigned)d[i + 1] << 8) | (unsigned)d[i + 2];
        fputc(B64[(v >> 18) & 63u], out);
        fputc(B64[(v >> 12) & 63u], out);
        fputc(B64[(v >> 6) & 63u], out);
        fputc(B64[v & 63u], out);
        i += 3;
    }
    if (n - i == 1) {
        unsigned v = (unsigned)d[i] << 16;
        fputc(B64[(v >> 18) & 63u], out);
        fputc(B64[(v >> 12) & 63u], out);
        fputs("==", out);
    } else if (n - i == 2) {
        unsigned v = ((unsigned)d[i] << 16) | ((unsigned)d[i + 1] << 8);
        fputc(B64[(v >> 18) & 63u], out);
        fputc(B64[(v >> 12) & 63u], out);
        fputc(B64[(v >> 6) & 63u], out);
        fputc('=', out);
    }
}

static void write_json_string(FILE *out, const char *s)
{
    fputc('"', out);
    for (const unsigned char *p = (const unsigned char *)s; *p != 0; p++) {
        switch (*p) {
        case '"': fputs("\\\"", out); break;
        case '\\': fputs("\\\\", out); break;
        case '\n': fputs("\\n", out); break;
        case '\r': fputs("\\r", out); break;
        case '\t': fputs("\\t", out); break;
        default:
            if (*p < 0x20u) {
                fprintf(out, "\\u%04x", *p);
            } else {
                fputc(*p, out);
            }
        }
    }
    fputc('"', out);
}

/* id 回写保持字面一致：字符串加引号、数字照抄、其余写 null（与 main.ts 的 ?? null 一致）。 */
static void write_id(FILE *out, JVal *id)
{
    if (id == NULL || id->type == J_NULL) {
        fputs("null", out);
        return;
    }
    if (id->type == J_STR) {
        write_json_string(out, id->str);
        return;
    }
    if (id->type == J_NUM && id->raw != NULL) {
        fputs(id->raw, out);
        return;
    }
    fputs("null", out);
}

static void emit_error(FILE *out, JVal *id, const char *reason)
{
    fputs("{\"v\":1,\"type\":\"error\",\"id\":", out);
    write_id(out, id);
    fputs(",\"reason\":", out);
    write_json_string(out, reason);
    fputs("}\n", out);
    fflush(out);
}

static void emit_pong(FILE *out, JVal *id)
{
    fputs("{\"v\":1,\"type\":\"pong\",\"id\":", out);
    write_id(out, id);
    fputs("}\n", out);
    fflush(out);
}

static void emit_exec_output(FILE *out, JVal *id, const char *stream, const unsigned char *data, size_t len)
{
    fputs("{\"v\":1,\"type\":\"exec_output\",\"id\":", out);
    write_id(out, id);
    fputs(",\"stream\":\"", out);
    fputs(stream, out);
    fputs("\",\"data\":\"", out);
    write_b64(out, data, len);
    fputs("\"}\n", out);
    fflush(out);
}

static void emit_exec_result(FILE *out, JVal *id, int exit_code, int timed_out, int truncated)
{
    fputs("{\"v\":1,\"type\":\"exec_result\",\"id\":", out);
    write_id(out, id);
    fprintf(out, ",\"exitCode\":%d,\"timedOut\":%s,\"truncated\":%s}\n",
            exit_code, timed_out ? "true" : "false", truncated ? "true" : "false");
    fflush(out);
}

/* ------------------------------------------------------------- exec 执行 */

static const char *envp_get(char **envp, const char *key)
{
    size_t klen = strlen(key);
    for (size_t i = 0; envp[i] != NULL; i++) {
        if (strncmp(envp[i], key, klen) == 0 && envp[i][klen] == '=') {
            return envp[i] + klen + 1;
        }
    }
    return NULL;
}

/* 与 execvp 等价的解析：带 '/' 直接 execve，否则按 PATH 逐项拼接。 */
static void child_exec(char **argv, char **envp)
{
    if (strchr(argv[0], '/') != NULL) {
        execve(argv[0], argv, envp);
        return;
    }
    const char *path = envp_get(envp, "PATH");
    if (path == NULL) {
        path = DEFAULT_PATH;
    }
    const char *seg = path;
    for (;;) {
        const char *colon = strchr(seg, ':');
        size_t seg_len = colon == NULL ? strlen(seg) : (size_t)(colon - seg);
        if (seg_len > 0) {
            size_t need = seg_len + 1 + strlen(argv[0]) + 1;
            char *cand = (char *)arena_alloc(need);
            if (cand != NULL) {
                memcpy(cand, seg, seg_len);
                cand[seg_len] = '/';
                strcpy(cand + seg_len + 1, argv[0]);
                execve(cand, argv, envp);
            }
        }
        if (colon == NULL) {
            break;
        }
        seg = colon + 1;
    }
}

static void emit_spawn_failure(FILE *out, JVal *id, const char *cmd, int err)
{
    char msg[512];
    snprintf(msg, sizeof(msg), "Failed to spawn: %s: %s", cmd, strerror(err));
    emit_exec_output(out, id, "stderr", (const unsigned char *)msg, strlen(msg));
    emit_exec_result(out, id, 127, 0, 0);
}

static void handle_exec(FILE *out, JVal *req)
{
    JVal *idv = jget(req, "id");
    JVal *argvv = jget(req, "argv");
    JVal *cwdv = jget(req, "cwd");
    JVal *envv = jget(req, "env");
    JVal *timeoutv = jget(req, "timeoutMs");
    JVal *maxv = jget(req, "maxOutputBytes");

    /* 与 main.ts 一致：id 与 argv[0] 缺失即协议错误。 */
    if (idv == NULL || idv->type == J_NULL || argvv == NULL || argvv->type != J_ARR || argvv->first == NULL) {
        emit_error(out, idv, "protocol");
        return;
    }

    long long timeout_ms = (timeoutv != NULL && timeoutv->type == J_NUM) ? (long long)timeoutv->num : DEFAULT_TIMEOUT_MS;
    long long max_output = (maxv != NULL && maxv->type == J_NUM) ? (long long)maxv->num : DEFAULT_MAX_OUTPUT_BYTES;
    if (timeout_ms < 0) {
        timeout_ms = 0;
    }
    if (max_output < 0) {
        max_output = 0;
    }
    const char *cwd = (cwdv != NULL && cwdv->type == J_STR && cwdv->str[0] != 0) ? cwdv->str : "/workspace";

    size_t argc = 0;
    for (JVal *c = argvv->first; c != NULL; c = c->next) {
        argc++;
    }
    char **argvp = (char **)arena_alloc((argc + 1) * sizeof(char *));
    if (argvp == NULL) {
        emit_error(out, idv, "protocol");
        return;
    }
    size_t ai = 0;
    for (JVal *c = argvv->first; c != NULL; c = c->next) {
        argvp[ai++] = (c->type == J_STR) ? c->str : NULL;
    }
    argvp[argc] = NULL;
    if (argvp[0] == NULL) {
        emit_error(out, idv, "protocol");
        return;
    }

    /* env 整体替换：默认 PATH + 调用方传入（与 main.ts 的 {...{PATH}, ...env} 等价）。 */
    size_t envc = 1;
    JVal *env_first = (envv != NULL && envv->type == J_OBJ) ? envv->first : NULL;
    for (JVal *c = env_first; c != NULL; c = c->next) {
        if (c->key != NULL && c->type == J_STR) {
            envc++;
        }
    }
    char **envpp = (char **)arena_alloc((envc + 1) * sizeof(char *));
    if (envpp == NULL) {
        emit_error(out, idv, "protocol");
        return;
    }
    size_t ei = 0;
    char *path_entry = arena_printf("PATH=%s", DEFAULT_PATH);
    envpp[ei++] = path_entry != NULL ? path_entry : (char *)("PATH=" DEFAULT_PATH);
    for (JVal *c = env_first; c != NULL; c = c->next) {
        if (c->key == NULL || c->type != J_STR) {
            continue;
        }
        char *kv = arena_printf("%s=%s", c->key, c->str);
        if (kv != NULL) {
            envpp[ei++] = kv;
        }
    }
    envpp[ei] = NULL;

    int outp[2];
    int errp[2];
    if (pipe(outp) != 0 || pipe(errp) != 0) {
        emit_exec_result(out, idv, 1, 0, 0);
        return;
    }

    pid_t pid = fork();
    if (pid < 0) {
        close(outp[0]);
        close(outp[1]);
        close(errp[0]);
        close(errp[1]);
        emit_spawn_failure(out, idv, argvp[0], errno);
        return;
    }
    if (pid == 0) {
        close(outp[0]);
        close(errp[0]);
        dup2(outp[1], STDOUT_FILENO);
        dup2(errp[1], STDERR_FILENO);
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            close(devnull);
        }
        close(outp[1]);
        close(errp[1]);
        if (chdir(cwd) != 0) {
            fprintf(stderr, "Failed to spawn: cwd %s: %s\n", cwd, strerror(errno));
            _exit(127);
        }
        child_exec(argvp, envpp);
        fprintf(stderr, "Failed to spawn: %s: %s\n", argvp[0], strerror(errno));
        _exit(127);
    }

    close(outp[1]);
    close(errp[1]);

    long long started = now_ms();
    long long deadline = timeout_ms > 0 ? started + timeout_ms : 0;
    long long kill_at = 0;
    long long last_data = started;
    long long total = 0;
    int truncated = 0;
    int timed_out = 0;
    int child_exited = 0;
    int status = 0;
    int open_fds = 2;
    unsigned char buf[CHUNK_BYTES];

    while (open_fds > 0) {
        if (!child_exited) {
            pid_t w = waitpid(pid, &status, WNOHANG);
            if (w == pid) {
                child_exited = 1;
            }
        }

        long long now = now_ms();
        if (!child_exited && deadline > 0 && now >= deadline && !timed_out) {
            timed_out = 1;
            kill(pid, SIGTERM);
            kill_at = now + KILL_GRACE_MS;
        }
        if (!child_exited && timed_out && kill_at > 0 && now >= kill_at) {
            kill(pid, SIGKILL);
            kill_at = 0;
        }
        /* 子进程已退出但孙进程仍占着管道：静默 DRAIN_SILENCE_MS 后收尾，避免永久阻塞。 */
        if (child_exited && now - last_data >= DRAIN_SILENCE_MS) {
            break;
        }

        struct pollfd fds[2];
        int n = 0;
        int idx_out = -1;
        int idx_err = -1;
        if (outp[0] >= 0) {
            fds[n].fd = outp[0];
            fds[n].events = POLLIN;
            idx_out = n;
            n++;
        }
        if (errp[0] >= 0) {
            fds[n].fd = errp[0];
            fds[n].events = POLLIN;
            idx_err = n;
            n++;
        }
        if (n == 0) {
            break;
        }

        int wait_ms = 100;
        if (!child_exited && deadline > 0 && !timed_out) {
            long long remain = deadline - now;
            if (remain < 0) {
                remain = 0;
            }
            if (remain < wait_ms) {
                wait_ms = (int)remain;
            }
        }

        int pr = poll(fds, (nfds_t)n, wait_ms);
        if (pr < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (pr == 0) {
            continue;
        }

        for (int pass = 0; pass < 2; pass++) {
            int idx = pass == 0 ? idx_out : idx_err;
            if (idx < 0) {
                continue;
            }
            int fd = fds[idx].fd;
            if (fd < 0 || (fds[idx].revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
                continue;
            }
            ssize_t rv = read(fd, buf, sizeof(buf));
            if (rv > 0) {
                last_data = now_ms();
                size_t take = (size_t)rv;
                if (total >= max_output) {
                    truncated = 1;
                    continue;
                }
                if (total + (long long)take > max_output) {
                    take = (size_t)(max_output - total);
                    truncated = 1;
                }
                total += (long long)take;
                if (take > 0) {
                    emit_exec_output(out, idv, pass == 0 ? "stdout" : "stderr", buf, take);
                }
                continue;
            }
            if (rv == 0) {
                close(fd);
                if (pass == 0) {
                    outp[0] = -1;
                    idx_out = -1;
                } else {
                    errp[0] = -1;
                    idx_err = -1;
                }
                open_fds--;
                continue;
            }
            if (errno == EINTR || errno == EAGAIN) {
                continue;
            }
            close(fd);
            if (pass == 0) {
                outp[0] = -1;
                idx_out = -1;
            } else {
                errp[0] = -1;
                idx_err = -1;
            }
            open_fds--;
        }
    }

    if (outp[0] >= 0) {
        close(outp[0]);
    }
    if (errp[0] >= 0) {
        close(errp[0]);
    }
    if (!child_exited) {
        if (timed_out) {
            kill(pid, SIGKILL);
        }
        waitpid(pid, &status, 0);
    }

    int exit_code;
    if (timed_out) {
        exit_code = 124;
    } else if (WIFEXITED(status)) {
        exit_code = WEXITSTATUS(status);
    } else {
        exit_code = 1;
    }
    emit_exec_result(out, idv, exit_code, timed_out, truncated);
}

/* ----------------------------------------------------------- 请求分发 */

/* 返回 1=读到一行 2=行超长（已丢弃到行尾） 0=EOF。buf 容量 cap 固定为 MAX_FRAME_BYTES+2。 */
static int read_line(FILE *in, char *buf, size_t cap, size_t *out_len)
{
    size_t n = 0;
    int too_long = 0;
    for (;;) {
        int ch = fgetc(in);
        if (ch == EOF) {
            if (n == 0 && !too_long) {
                return 0;
            }
            break;
        }
        if (ch == '\n') {
            break;
        }
        if (n + 1 >= cap) {
            too_long = 1;
            continue;
        }
        buf[n++] = (char)ch;
    }
    buf[n] = 0;
    *out_len = n;
    return too_long ? 2 : 1;
}

static void process_frame(FILE *out, const char *line, size_t len)
{
    int only_ws = 1;
    for (size_t i = 0; i < len; i++) {
        char c = line[i];
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') {
            only_ws = 0;
            break;
        }
    }
    if (only_ws) {
        return;
    }

    JVal *req = jparse(line, len);
    if (req == NULL || req->type != J_OBJ) {
        emit_error(out, NULL, "protocol");
        return;
    }
    JVal *v = jget(req, "v");
    JVal *typev = jget(req, "type");
    if (v == NULL || v->type != J_NUM || v->num != 1.0 || typev == NULL || typev->type != J_STR) {
        emit_error(out, NULL, "protocol");
        return;
    }
    if (strcmp(typev->str, "ping") == 0) {
        emit_pong(out, jget(req, "id"));
        return;
    }
    if (strcmp(typev->str, "exec") == 0) {
        handle_exec(out, req);
        return;
    }
    emit_error(out, jget(req, "id"), "protocol");
}

/* in/out 可以是同一个 FILE*（socket 的 "r+" 流）。 */
static void serve(FILE *in, FILE *out)
{
    size_t cap = MAX_FRAME_BYTES + 2;
    char *buf = (char *)malloc(cap);
    if (buf == NULL) {
        return;
    }
    size_t len = 0;
    int r;
    while ((r = read_line(in, buf, cap, &len)) != 0) {
        if (r == 2) {
            emit_error(out, NULL, "protocol_frame_too_large");
            continue;
        }
        arena_reset();
        process_frame(out, buf, len);
    }
    free(buf);
}

/* ------------------------------------------------------------- 监听入口 */

static int listen_vsock(int port)
{
#ifdef __linux__
    int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (fd < 0) {
        fprintf(stderr, "harness-agent: socket(AF_VSOCK) 失败：%s\n", strerror(errno));
        return 1;
    }
    struct sockaddr_vm addr;
    memset(&addr, 0, sizeof(addr));
    addr.svm_family = AF_VSOCK;
    addr.svm_cid = VMADDR_CID_ANY;
    addr.svm_port = (unsigned int)port;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        fprintf(stderr, "harness-agent: bind(vsock:%d) 失败：%s\n", port, strerror(errno));
        return 1;
    }
    if (listen(fd, 16) != 0) {
        fprintf(stderr, "harness-agent: listen 失败：%s\n", strerror(errno));
        return 1;
    }
    signal(SIGCHLD, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);
    /* 这行会进 guest 串口，宿主用它精确测量「监听就绪」时刻。 */
    fprintf(stderr, "harness-agent listening on vsock:%d\n", port);
    fflush(stderr);

    for (;;) {
        int conn = accept(fd, NULL, NULL);
        if (conn < 0) {
            if (errno == EINTR || errno == ECONNABORTED) {
                continue;
            }
            usleep(10000);
            continue;
        }
        pid_t pid = fork();
        if (pid == 0) {
            close(fd);
            FILE *s = fdopen(conn, "r+");
            if (s != NULL) {
                serve(s, s);
                fclose(s);
            }
            _exit(0);
        }
        close(conn);
    }
#else
    (void)port;
    fprintf(stderr, "harness-agent: 监听模式只在 Linux 支持，本机测试请用 --stdio\n");
    return 1;
#endif
}

int main(int argc, char **argv)
{
    signal(SIGPIPE, SIG_IGN);
    arena_init();

    int stdio_mode = 0;
    int port = DEFAULT_PORT;
    const char *env_port = getenv("HARNESS_AGENT_PORT");
    if (env_port != NULL && atoi(env_port) > 0) {
        port = atoi(env_port);
    }
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--stdio") == 0 || strcmp(argv[i], "-") == 0) {
            stdio_mode = 1;
        } else if (strncmp(argv[i], "--port=", 7) == 0) {
            port = atoi(argv[i] + 7);
        } else if (argv[i][0] >= '0' && argv[i][0] <= '9') {
            port = atoi(argv[i]);
        }
    }

    if (stdio_mode) {
        setvbuf(stdout, NULL, _IOLBF, 0);
        serve(stdin, stdout);
        return 0;
    }
    return listen_vsock(port);
}
