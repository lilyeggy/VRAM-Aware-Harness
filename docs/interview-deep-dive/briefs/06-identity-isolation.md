# Module 6: 可信身份与六道防串防线（深挖④）

## Teaching Arc
- **Metaphor:** 机场安检的登机牌。你出示护照（API Key），安检系统打印登机牌（RequestPrincipal：tenantId + scopes）。之后全程——贵宾室、登机口、机上餐食——只看登机牌，没人再问"你自称是谁"。有人捡到别人的登机牌想混进另一家航空公司的贵宾室？每个闸口都核对归属，对不上的一律回答"查无此人"（404），而不是"这不是你的"（403 泄露存在性）。
- **Opening hook:** 客户端请求体里写着 `tenantId: "tenant-a"`——你敢信吗？这个系统的回答是：身份只在认证那一刻产生一次，之后一路固化，永不采信自报。
- **Key insight:** "Agent 运行时代码是'敌方'，不是'可信基础设施'"——所以它对文件、网络、权限的一切访问都要经过外面包着的 ToolGateway + 策略 + 沙箱拦截。
- **Why should I care:** 多租户隔离是 agent infra 的核心焦虑。六道防线是逐层设防（defense-in-depth）的教科书案例，每一道都能单独讲 2 分钟。

## 归因链（必须能默写）
```
HTTP 请求 (Authorization: Bearer <key>)
  → requirePrincipal(request, scope)            // src/http/harness-http-api.ts
  → ApiCredentialStore.authenticate(digest)      // src/auth/api-credential-store.ts
  → 命中凭证行 { tenantId, scopes }              // key 创建时就绑定死归属
  → RequestPrincipal { tenantId, scopes }
  → submitRun：tenantId = principal.tenantId     // 写入 agent_runs.tenant_id，固化
  → 下游(调度/沙箱/策略/查询)永远用 run.tenantId，不再"猜归属"
```
产品决定：`tenant = 用户`；RequestPrincipal 精简为 `{ tenantId, scopes }`（migration v15 删除冗余 subject_id）。

## Code Snippets (pre-extracted)

### Snippet A — requirePrincipal 统一强制点（src/http/harness-http-api.ts 节选）
```typescript
    private requirePrincipal(request: Request, scope: string): RequestPrincipal {
        if (this.accessControl === undefined) {
            // Retained only for direct legacy unit tests; composition always injects auth.
            return { tenantId: "legacy", scopes: ["*"] };
        }
        const authorization = request.headers.get("authorization");
        const rawKey = authorization?.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length).trim()
            : request.headers.get("x-api-key")?.trim();
        if (rawKey === undefined || rawKey.length === 0) {
            this.audit("AUTHENTICATE", "DENY", null, "missing_api_key");
            throw new HttpError(401, "缺少 API Key");
        }
        const principal = this.accessControl.authenticate(rawKey);
        if (principal === null) {
            this.audit("AUTHENTICATE", "DENY", null, "invalid_or_revoked_api_key");
            throw new HttpError(401, "API Key 无效或已撤销");
        }
        if (!hasScope(principal, scope)) {
            this.audit(scope, "DENY", principal, "missing_scope");
            throw new HttpError(403, `缺少权限：${scope}`);
        }
        this.audit(scope, "ALLOW", principal, "scope_granted");
        return principal;
    }
```
讲解点：每条受保护路由声明自己的 scope（tasks:read / tasks:write / workspaces:write / models:generate / audits:read…）；ALLOW/DENY 全部进 access_audit_events。

### Snippet B — IDOR 反枚举：跨租户一律 404（同文件 getRequiredRun）
```typescript
        if (request !== undefined && this.accessControl !== undefined) {
            const principal = this.requirePrincipal(request, scope);
            if (run.tenantId !== principal.tenantId) {
                throw new HttpError(404, `找不到 AgentRun：${runId}`);
            }
        }
```
讲解点：404 与"不存在"不可区分——返回 403 等于告诉攻击者"这个 id 存在，只是你看不了"。

### Snippet C — 提交时忽略 body 自报身份（submitRun 节选）
```typescript
        const run = this.application.submitRun({
            tenantId:this.accessControl === undefined
                ? requiredString(body, "tenantId")
                : principal.tenantId,
            harnessSessionId:
                optionalString(body, "sessionId")
                ?? optionalString(body, "harnessSessionId")
                ?? crypto.randomUUID(),
            userInput:requiredString(body, "userInput"),
            workspacePath:this.accessControl === undefined
                ? requiredString(body, "workspacePath")
                : (workspace as NonNullable<typeof workspace>).rootPath,
        });
```
讲解点：有 accessControl 时 tenantId 一律取 principal；workspacePath 取服务端 Workspace 记录里的 rootPath——客户端只能提交 workspaceId（不透明 ID），永远不能提交宿主机路径。

### Snippet D — WorkspaceService 服务端目录生成（src/workspaces/workspace-service.ts 节选）
```typescript
    create(tenantId: string, name: string): Workspace {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
            throw new Error("Workspace 名称只能包含字母、数字、_ 或 -，且最长 64 位");
        }
        const id = crypto.randomUUID();
        const workspace: Workspace = {
            id,
            tenantId,
            name,
            rootPath: resolve(this.root, tenantId, id),
            createdAt: new Date().toISOString(),
        };
        if (!workspace.rootPath.startsWith(`${this.root}/`)) {
            throw new Error("非法 Workspace 根目录");
        }
        mkdirSync(workspace.rootPath, { recursive: true, mode: 0o700 });
        if (this.executionUid !== undefined) {
            try {
                // A non-root container UID must own its single bind-mounted root.
                if (statSync(workspace.rootPath).uid !== this.executionUid) {
                    chownSync(workspace.rootPath, this.executionUid, -1);
                }
            } catch (error) {
                rmSync(workspace.rootPath, { recursive: true, force: true });
                throw new Error(`无法将 Workspace 交给容器 UID ${this.executionUid}: ${String(error)}`);
            }
        }
        this.store.create(workspace);
        return workspace;
    }
```
讲解点：路径 = root/tenantId/workspaceId（服务端拼装）；前缀校验防穿越；0o700 权限；chown 给容器 UID 失败就删除目录并拒绝——"失败比创建一个永远无法访问的 Run 更安全"。

## 六道防线（本模块骨架，用 pattern cards 呈现）
1. **tenant 只来自身份** — submitRun 用 principal.tenantId，忽略请求体
2. **归属链一致性校验** — ManagedAgentRuntime.execute 四元组（instance.tenantId、templateVersionId、session.tenantId、session.instanceId）与 run 全对得上才放行
3. **Session 复用校验** — DefaultPiControlPlane.resolve 对已存在 session 检查 tenant/instance 归属
4. **查询侧按 tenant 收口** — listForTenant(tenantId)、getForTenant(id, tenantId) 双参数
5. **IDOR 反枚举** — 跨租户统一 404
6. **数据库约束兜底** — 外键、UNIQUE、CHECK 拒绝孤儿/非法状态

## 写新代码检查清单（面试可展示工程素养）
新路由过 requirePrincipal+scope？查询按 principal.tenantId 过滤？跨租户回 404？错误信息不泄露存在性？新表带 tenant_id+约束？该动审计吗？

## 当前短板（诚实边界）
API Key 无 TTL（泄露即长期有效）→ 方向：会话登录作为第二认证器接到同一 RequestPrincipal 主干；网关无 per-tenant 限流配额；development profile 沙箱弱（产品化须 container/strict）。

## Interactive Elements
- [ ] **Group chat animation（本模块主视觉）** — actors: 攻击者(红) / HTTP API / RunStore / ManagedAgentRuntime / SQLite。剧本：①攻击者用 Tenant-A 的 key GET /runs/tenant-B 的 runId →②HTTP 验 key 通过(A 是合法用户) →③getRequiredRun 发现 run.tenantId=B ≠ A →④返回 404"找不到 AgentRun" →⑤攻击者换姿势：提交任务时 body 自报 tenantId=B →⑥submitRun 直接忽略 body，用 principal.tenantId=A →⑦审计记录 DENY。
- [ ] **Code↔English translation ×2** — Snippet B（404 反枚举）、Snippet D（WorkspaceService create）。
- [ ] **Pattern cards** — 六道防线六张卡。
- [ ] **Quiz** — 3 题：(1) 为什么跨租户返回 404 而不是 403；(2) 场景：攻击者拿到 A 的合法 key，能否读 B 的 run？哪道防线拦住；(3) 为什么说"Agent Runtime 是被隔离的对象/敌方"，这句话如何影响架构（ToolGateway 在它外面而不是里面）。
- [ ] **Callout** — "信任边界思维"：每层明确信谁、不信谁（HTTP 信 key、Service 信 DB 固化的 tenantId、策略信快照、Runtime 不被信）。

## Reference Files to Read
- `references/content-philosophy.md` → 全文
- `references/gotchas.md` → 全文
- `references/interactive-elements.md` → Group Chat Animation, Code↔English, Pattern/Feature Cards, Multiple-Choice Quizzes, Callout Boxes, Glossary Tooltips

## Connections
- **Previous:** Module 5 的队列按 tenantId 分列——那个 tenantId 就是本模块固化的身份。
- **Next:** Module 7——身份之外，五层策略交集与 runsc 沙箱如何把权限落到操作系统层面。
