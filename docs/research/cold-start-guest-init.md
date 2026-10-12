# 冷启动：guest 用户态就绪路径调研（socat → 静态监听器 / agent 自监听）

> 范围：只回答「guest 内核起来之后，到 agent 能收发第一条 JSON-RPC 帧」这段路径怎么优化。
> 不涉及快照/恢复（见 `docs/research/cold-start-snapshot-cost.md`）、不涉及内核选型。
> 标注约定：**[已验证]** = 我读过一手源码/在本机或真机上跑过并看到输出；**[官方文档]** = 厂商/项目官方文档；
> **[第三方]** = 博客、二手文章；**[推测]** = 由已知事实推出的判断，未经直接测量。
> 基线数字出处：真机台账 `/home/cxr/agent-harness-mt/docs/vm-startup-optimizations.zh-CN.md`（O4/O5/O6）与本地工作区代码。

---

## 0. 结论速览（TL;DR）

1. **业界没有一家用 `socat` 做 guest 内监听器。** 三个能读到一手代码的案例（Fly.io、Apple containerization、
   microsandbox）都把 agent 做成**静态链接单二进制**，并且**直接当 guest 的 PID 1（`init=<agent>`）**；E2B 用 `init=` 指定
   自己的 busybox-init 或 systemd，再由 systemd/OpenRC 单元拉起静态 Go 的 `envd`。**[已验证]**
2. **「socat 启动→监听 ~340ms」这条旧归因已经作废**（台账 O8，2026-10-12 真机 A/B：2KB 静态 vsock 监听器
   523~542ms vs socat 539ms，只差 ~16ms）。本次调研独立给出了**为什么这条归因从一开始就测不出来**的解释：
   `connect()` 只在收到 `pong` 时 resolve，且握手阶段没有把「Firecracker 主动关掉宿主连接」当成一次失败
   （见 §3.2），所以在 `(intervalMs=100, attemptTimeoutMs=300)` 下 `vsock-connect-ok` 会被**量化到 ~400ms**——
   O6 记的 `404ms` 正是这个量化值，它与「socat 5ms 就绪」和「socat 300ms 就绪」都兼容。
   **[已验证]（代码级）+ [已验证]（台账 O8 实测）**
3. **真正剩下的大头是 96MB 的 Bun agent 本身。** O8 实验 2：把 `/agent/main`（96,352,640 B）换成 900KB 静态应答器，
   其余（内核、inittab、socat、共享只读基础文件）不变 → 冷启动 `total` 从 ~442ms 降到 **208~228ms**（−230ms）；
   实验 3 进一步证明「把 agent 预读进 page cache」无效（96MB 在 256MB guest 里留不住）。**[已验证]（台账 O8）**
4. **本调研中的全部候选方案都不需要换内核。** 4.14.174 guest 已支持 `AF_VSOCK`、`init=`、静态 ELF；
   Firecracker 的 vsock 是 VMM 侧设备模型，与 guest 内核版本无关。**[已验证]**
5. **排序（与 O8 的"下一步"一致，见 §6）**：① 把 guest agent 换成小体积静态二进制（−230ms，已实测）；
   ② 修宿主握手循环（把 FIN 当失败、限制在飞去重试、单次超时必须大于 agent 加载时间——O8 实测 20/30 会把热恢复
   97ms 打到 229~653ms）；③ `init=<agent>`（与①合并做）；④ 去掉 socat（只值 ~16ms，收益主要是镜像卫生：
   少 6.9MB 动态库与 ~25k 条重定位）。

---


## 1. 我们现在的路径与基线

冷启动（spawn → pong，256MB guest、jailer、共享只读基础文件）的构成，按台账 O6 与 O8 的实测：

| 阶段 | 值 | 来源 |
| --- | --- | --- |
| 内核开始执行 → 到 init（串口第一行 `serial-first-line`） | 15ms（宿主视角）；guest init 时刻 uptime 0.05~0.06s | 台账 O6 [已验证] |
| init 链（mount proc/sysfs → `mdev -s` → 3 个 tmpfs → mount /dev/vdb /workspace → 5 个 boot mark） | ≤10ms | 台账 O6 [已验证] |
| init 链 + `socat` 进入监听（含 init 之后到 socket 可用的全部 guests 侧） | **~90ms，其中 socat 本体 ~16ms** | 台账 O8 [已验证] |
| ~~「socat 启动→监听 ~340ms」~~ | **作废**：O6 的这个残差是宿主重试循环的量化值，不是 socat 的时间 | 台账 O8 + 本文 §3.2 [已验证] |
| **96MB Bun agent 加载** | **~240ms**（O8 用 900KB 静态应答器替换后 `total` 442 → 208~228ms） | 台账 O8 [已验证] |
| 冷启动总计（O6 口径） | 539ms（O8 的若干次同口径运行在 344~542ms 之间波动） | 台账 O6/O8 [已验证] |
| 池空后首台另付 `make-snapshot` | ~750ms（O7） | 台账 O7 [已验证] |

关键代码锚点（本地工作区，2026-10-12 18:00 之后的提交 `ad7eafa`）：

- `src/sandbox/microvm/firecracker-sandbox-driver.ts:931` → `await vsockBridge.connectWithRetry(20000, 100, 300);`
  上一行注释：*「冷启动：短超时（300ms）+ 密重试（100ms）。握手本身亚毫秒级，缩短单次超时只是把"等一个注定失败的连接"从 1000ms 降到 300ms。」*
  （台账 O8 记录：曾改成 20/30，因**热恢复回归**（97ms → 229~653ms，一次恢复里出现 50 次 `vsock-connect-ok`，反复 fork 96MB agent）已回滚。）
- `src/sandbox/microvm/firecracker-vsock-bridge.ts:85-113` → `connectWithRetry(overallTimeoutMs=20000, intervalMs=150, attemptTimeoutMs=1000)`；
  失败即 `this.close()` + `setTimeout(intervalMs)` 重试。
- `src/sandbox/microvm/firecracker-vsock-bridge.ts:132-241` → `connect(handshakeTimeoutMs)`：
  `connect` 事件里写 `CONNECT <port>\n`；收到 `OK` 行时 `onPhase("vsock-connect-ok")` 并发 ping；
  **只有收到同 id `pong` 才 `resolve()`（`:226-232`）**；`error` 会 `reject`（`:160`），`close` 只通知 `activeHandlers`（`:172`）。
- `src/sandbox/microvm/firecracker-sandbox-driver.ts:465` 起 `onSerialOutput(...)`：宿主**已经在读 guest 串口**，可用于事件驱动的就绪探测。
- `scripts/microvm/build-guest-rootfs.sh`（inittab 生成）、`scripts/microvm/patch-guest-rootfs-bootmarks.sh`（对存量镜像补 mark，幂等）。
- agent：`guest/agent/main.ts`（181 行 JSON-RPC：`ping` + `exec`，base64 64KB 分片、1MiB 截断、`timeoutMs` 到点 SIGTERM→2s→SIGKILL），
  `bun build --compile` 产物 96,352,640 B。

---


## 2. 问题 1：业界怎么让 guest 里的 agent 尽快开始监听

### 2.1 一手证据汇总（都读到源码，非二手转述）

| 项目 | guest 第一个用户态进程 | 语言/链接方式 | 控制通道 | 来源 |
| --- | --- | --- | --- | --- |
| Fly.io Machines | **自己的 init**（`/fly/init`，挂在独立的 64MB ext2 init 盘 `/dev/vda`，rootfs 是 `/dev/vdb`） | Rust，`x86_64-unknown-linux-musl` 静态 | virtio-vsock | [已验证] https://github.com/superfly/init-snapshot |
| Apple containerization | **`init=/sbin/vminitd`**（内核命令行里显式写死） | Swift + Static Linux SDK（musl 静态） | GRPC over vsock | [已验证] https://github.com/apple/containerization/blob/main/Sources/Containerization/Kernel%2BCommandline.swift 、`/README.md` |
| microsandbox | **`agentd` 就是 PID 1**（bin/main.rs 注释：*Runs as PID 1 inside the microVM guest*） | Rust，`rust:alpine`+`musl-dev` 构建，产物 `COPY` 进 `FROM scratch` | **virtio-serial**（`/sys/class/virtio-ports` 发现端口）；宿主**在 guest 启动前就把 bootstrap 帧排队**进去 | [已验证] https://github.com/microsandbox/microsandbox （`Dockerfile.agentd`、`crates/agentd/bin/main.rs`、`crates/agentd/lib/serial.rs`、`crates/agentd/lib/init.rs`） |
| E2B | `init=<InitScriptPath>`，orchestrator 按镜像族选：Alpine/distroless 用 busybox init（`usr/bin/init`），其余用 systemd | `envd` 是 Go，`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -a`（**全静态、无动态加载器、无 OpenSSL**） | HTTP over guest 网络，默认端口 49983（`Addr: 0.0.0.0:49983`），不是 vsock | [已验证] `packages/orchestrator/pkg/sandbox/fc/kernel_args.go`、`pkg/template/build/core/rootfs/rootfs.go:86`、`files/inittab.tpl`、`files/envd.service.tpl`、`files/envd.openrc.tpl`、`packages/envd/Makefile`、`packages/envd/main.go`（均在 https://github.com/e2b-dev/infra ） |
| Kata Containers | 完整发行版 rootfs 的 systemd | kata-agent 是静态 Go/Rust 二进制，由 systemd 单元拉起 | vsock（agent） | [已验证] https://github.com/kata-containers/kata-containers/blob/main/src/agent/kata-agent.service.in |
| gVisor / Modal | **没有 guest 用户态**（runsc 在宿主进程内跑用户态内核） | — | `urpc` = UNIX socket + SCM_RIGHTS；**不用 vsock** | [已验证] https://github.com/google/gvisor/blob/master/pkg/urpc/urpc.go ；https://modal.com/blog/mem-snapshots |
| CodeSandbox / Cubesandbox / Arrakis / Morph / Blaxel / Daytona | 未找到公开的 guest-init 一手细节（见 §2.8） | — | — | [第三方]/[推测] |

### 2.2 E2B 的细节（最接近我们的 roadmap）

- **内核命令行由 orchestrator 生成**（`kernel_args.go`），并且把 `init`、`root`、`console`、`clocksource`、`maxcpus`、`random.trust_cpu` 等列为
  「保留参数」，用户不得覆盖；默认值里有我们熟悉的几条：`quiet loglevel=1`、`pci=off`、`random.trust_cpu=on`、
  `i8042.nokbd`、`i8042.noaux`、`selinux=0`、`panic=1`、`reboot=k`、`maxcpus=<boot cpus>`。**[已验证]**
  → 说明「把开机工作量压到最小」是行业普遍做法，而且与我们已做的 i8042 优化同源。
- **`envd` 服务的启动顺序是刻意裁剪过的**（`envd.service.tpl` 的注释原文很值钱）：*"Default dependencies would gate it on
  sysinit/basic.target (~0.5s), and the previous After=multi-user.target on chrony-wait (~8s)"* → 它用
  `DefaultDependencies=no` + `After=systemd-journald.socket systemd-remount-fs.service local-fs.target systemd-tmpfiles-setup.service`
  把启动钉死在最靠前的时刻，并给 `Nice=-20`、`IOSchedulingClass=realtime`、`OOMScoreAdjust=-1000`。**[已验证]**
- 把**启动期的重活挪走**：`ExecStartPre=/usr/local/bin/e2b-seed-certs` 用构建期打包的 CA tar 灌 tmpfs，
  目的是「避免冷启动时散落读盘」（注释原文：*its scattered rootfs reads are the cost we avoid*）。**[已验证]**
- Alpine 家族对应实现 `envd.openrc.tpl`（`supervise-daemon`、`--nicelevel -20 --ionice 1:4 --oom-score-adj -1000`）。**[已验证]**

### 2.3 Fly.io：`init` 就是 agent 本身

README 原文：*"This is a public snapshot of Fly's init code. It powers every Firecracker microvm we run for our users."*
使用方式：`cargo build --release`（目标三元组 `x86_64-unknown-linux-musl`）→ 把 `init` 和 `run.json` 写进一个 64MB ext2 盘 →
**作为 `/dev/vda` 挂给 VM，rootfs 作为 `/dev/vdb`，再挂一个 virtio-vsock 设备**；README 还说明它也能装成 initrd。**[已验证]**
→ 要点：**没有 busybox init、没有 inittab、没有 socat**；配置（`/fly/run.json`）由宿主注入，init 自己挂载并 exec 负载。

### 2.4 Apple `vminitd`：`init=` 显式指向 agent

```swift
args.append("init=/sbin/vminitd")
// rootfs is always mounted read-only.
args.append("ro")
```
并且 README 描述：*"`vminitd` is a small init system … spawned as the initial process inside of the virtual machine and
provides a GRPC API over vsock"*；`vminitd/Makefile` 用 Swift Static Linux SDK（`--swift-sdk <arch>-swift-linux-musl`）产出静态二进制；
同一份 `vminitd` 契约同时用于 VZ 与 Cloud Hypervisor 两个 VMM 后端。**[已验证]**

### 2.5 microsandbox：agent 做 PID 1 + 宿主预排队

- `crates/agentd/lib/init.rs` 首行注释：*"PID 1 init: mount filesystems, apply tmpfs mounts, prepare runtime directories."*，
  即 agent 自己承担了我们 inittab 里那几件事（挂 proc/sys、tmpfs、准备运行时目录、必要时 pivot 到块设备 root）。**[已验证]**
- 通道不是 vsock 而是 **virtio-serial**：`lib/serial.rs` 通过 `/sys/class/virtio-ports` 找端口；`bin/main.rs` 在
  mount 之后 `open_serial_port()` → `receive_bootstrap()`，注释说明 *"receive the typed bootstrap frame that the host queued
  before entering the VM"* —— **宿主在 VM 启动前就把第一条控制帧塞进串口队列**，agent 一起来就能读，省掉一整轮握手往返。**[已验证]**
- 构建方式：`FROM rust:alpine` + `apk add musl-dev` + `cargo build --release`，然后 `FROM scratch` 只拷贝 `/agentd`。
  → 镜像里**没有 libc、没有 shell、没有动态加载器**。**[已验证]**

### 2.6 Kata Containers：反例（用完整 systemd）

`src/agent/kata-agent.service.in`：`Type=simple`、`StandardOutput=tty`、`OOMScoreAdjust=-997`、`LimitNOFILE=1073741824`，
由 systemd 拉起 —— Kata 选择「完整发行版 + systemd」，代价就是 guest 用户态链路长。**[已验证]**
对我们的意义：如果不换 rootfs 家族，就要接受 init 的存在；但可以把 init **裁剪到只做 mount**，甚至不要 init。

### 2.7 gVisor / Modal：根本没有「guest 用户态」

gVisor 的控制面是 `urpc`（`pkg/urpc/urpc.go` 头注释：*minimal RPC package based on unet*，可传文件描述符），
sentry 与 gofer 之间走 UNIX socket，不碰 vsock。Modal 官方博客说明它用 gVisor（runsc）+ CRIU 系快照，
「sub-second startup」靠 checkpoint/restore 而不是靠缩短 guest 用户态。**[已验证]/[官方文档]**
→ 结论：这条路（快照）与我们的 socat 优化不冲突，属于另一个维度（见兄弟文档）。

### 2.8 公开信息不足的几家（避免编造）

- **CodeSandbox**：其 microVM 博客只讲内存快照压缩（8GiB→412MiB zstd）与 userfaultfd 懒加载，没有 guest init 细节。**[第三方]**
  https://codesandbox.stream/blog/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression
- **CubeSandbox（腾讯）**、**Arrakis**、**Morph**：仓库/文档页存在，但我这次没有取到 guest-init 一手材料（仓库 README 未覆盖，
  站点为 JS 渲染）。**[推测]**：按同类架构推断是「静态 agent + vsock/unix 通道」。
- **Blaxel**：官方文档明确卖点是「standby 恢复 <25ms」（*resume from standby under 25ms even after weeks*），
  即它的冷启动路径本来就是快照/standby，不靠缩短 init 链。**[官方文档]** https://docs.blaxel.ai/
- **Daytona**：官方架构文档只描述「interface plane / control plane」，未描述 guest 内 init。**[官方文档]**
- **Cloud Hypervisor**：本身不定义 guest 用户态（只提供 virtio 设备；Apple 那条 Linux 路径把 `vminitd` 塞进 CH 的 hybrid vsock）。**[官方文档]**
- **Firecracker**：只提供 vsock 设备模型与 `CONNECT/OK` 文本协议，不含 guest 侧任何用户态。**[官方文档]**
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md

### 2.9 有没有公开的「别用 socat + 动态 libcrypto」经验？

没有找到直接以这句话形式写出来的公开材料（E2B/Fly/Apple/microsandbox 都没有提到 socat —— 他们**根本不用**）。**[已验证]（缺席证据）**
但可以从他们的选择里读出等价结论：
1. 监听器/agent **必须是无动态加载器的静态二进制**（4/4 家）；E2B 明确 `CGO_ENABLED=0` 并解释「*must not need a dynamic loader*」
   （原文出现在 `build-debug` 目标注释里，说明他们把「不需要动态加载器」当成硬约束）。**[已验证]**
2. **没有一家为「开一个 socket」引入 SSL/OpenSSL 依赖**；socat 因为把 `libssl3+libcrypto3` 拖进来，在体积（4.48MB+0.8MB）、
   重定位（约 2.2 万条，见 §3.1）与冷页缓存缺页上都属于最差解。**[已验证]（socat 侧）/ [推测]（对启动时间的影响，见 §3.3）**
3. **agent 越小越好、能当 init 就当 init**（Fly/Apple/microsandbox 三家都是 `init=`）。**[已验证]**

---

## 3. 问题 2：socat 这条路为什么慢（可验证的分解）

### 3.1 一手硬数据（从真机 guest 镜像里 dump 出来实测，不是推算）

在 `/data/harness/images/rootfs-bootmarks.ext4` 上用 `debugfs` 取出文件，在宿主（192 核、`taskset -c 0,1`、页缓存热）测：

- `/usr/bin/socat` 是 **指向 `socat1` 的符号链接**；真身 `/usr/bin/socat1` = **348,024 B**（Alpine socat 1.8.0.0, 2023-11-16）。**[已验证]**
- `readelf -d` NEEDED：`libreadline.so.8`、`libssl.so.3`、`libcrypto.so.3`、`libc.musl-x86_64.so.1`。**[已验证]**
- 运行时会 mmap 的库体积合计 **约 6.9MB**：`libcrypto.so.3` 4,482,384 B、`libssl.so.3` 802,520 B、
  `ld-musl-x86_64.so.1` 649,832 B、`libreadline.so.8.2` 285,456 B、`libncursesw.so.6.4` 338,888 B（+ socat 自身 348KB）。**[已验证]**
- 重定位条目数（`readelf -r` 计数）：socat **3,484**、`libcrypto.so.3` **18,551**、`libssl.so.3` **3,333** → 合计 **≈25,368**。**[已验证]**
- 真实路径 strace（`./ld-musl-x86_64.so.1 --library-path . ./socat VSOCK-LISTEN:59777,fork EXEC:/bin/true`）：
  `execve` @17:51:35.667643 → `socket(AF_VSOCK, SOCK_STREAM, 0) = 5` @.672870 → `bind(…, svm_port=0xe981)` @.672936 → `listen(5,5) = 0` @.672975，
  即 **execve → listen 只有 5.33ms**；全程 104 条 syscall，只 open 了 `/dev/vsock` 与 `/etc/localtime`。**[已验证]**
- 同一路径 **没有** open `openssl.cnf` / `ossl-modules` / `/dev/urandom`，也 **没有** `getrandom`（grep 计数 0）；
  `socat -V` 全路径 `read()` 总字节 4,800（= 5 个库各读 960B ELF 头，其余靠 mmap 缺页）。**[已验证]**
- 对照 busybox：minor page faults 111、maxRSS 1536kB。**[已验证]**

### 3.2 为什么「340ms」从来就不是 socat 的测量值（本文的核心解释）

`firecracker-vsock-bridge.ts` 的握手机制有三个互相叠加的性质（都能在代码里直接看到，**[已验证]**）：

1. `connect()` 的 Promise **只在收到同 id `pong` 时才 resolve**（`:226-232`）。一次「尝试」= `CONNECT` → `OK` → `ping` → `pong`
   的完整往返，而 `pong` 要等 guest 侧 socat `accept` 并 **fork+exec 完 agent**。
2. 失败路径里**没有把「对端干净地关闭连接（FIN）」算作失败**：只有 `error` 事件会 `reject`（`:160`），
   `close` 事件只通知 `activeHandlers`（`:172`），而握手段 `activeHandlers` 是空的
   → 这次尝试既不立刻失败也不报错，而是**静静等满 `attemptTimeoutMs`**。
3. Firecracker 官方文档写明：*"If no one is listening, Firecracker will terminate the host connection."*
   —— 宿主连上 UDS 并写 `CONNECT 5000\n`，只要 guest 还没 `listen`，Firecracker 就主动关掉这条连接。**[官方文档]**
   https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md

三者拼起来，`connectWithRetry(intervalMs=100, attemptTimeoutMs=300)` 在 O6 那次测量的时间轴必然是：

```
t=0     尝试#1 发出 → Firecracker 立刻关掉 → 代码把它当"还在等"，一直等到 300ms
t=300   尝试#1 超时失败 → sleep(100)
t=400   尝试#2 发出 → 此时 guest 早已 listen → OK + ping + pong
t=404   vsock-connect-ok
```

**404 ≈ 300 + 100 + 4**，与台账 O6 的 `connect-ok 404ms` 完全吻合；而「socat 340ms」是
`404 − 内核 55 − init 10` 得到的残差。结论：**在 100/300 口径下，只要 guest 在 400ms 前的任意时刻就绪，读数都是 ~404ms**
——「socat 5ms 就绪」与「socat 300ms 就绪」在这个埋点下**不可分辨**。**[已验证]（代码）+ [推测]（对读数的解释）**

这条解释与台账 O8 的真机实验完全一致：O8 用 2KB/890KB 的静态 vsock 监听器替换 socat，同参数实测
**523~542ms vs 539ms（差 ~16ms）**，即换掉监听器在 O6 口径下**本来就测不出差别**。**[已验证]（台账 O8 实测）**

**顺带一个真实（但非主要）的缺陷**：因为 FIN 不算失败，每次冷启动在「guest 还没监听」的窗口里至少白等一个
`attemptTimeoutMs`（当前 300ms）；冷启动的**检测延迟**因此有 300~400ms 的粗粒度。它不改变 guest 侧真正就绪的时刻，
但会污染所有基于 `vsock-connect-ok` 的归因（O6 的「340ms」就是这么来的）。这也与桥上注释里
「旧实现一次 1000ms 白等」的历史一致。**[已验证]（代码推理）/ [推测]（FIN 而非 RST）**

### 3.3 那 socat 到底值多少？≈16ms（O8 实测）

| 解释 | 证据 | 结论 |
| --- | --- | --- |
| socat 启动（动态链接/重定位/缺页）占 340ms | O8：静态监听器 523~542ms vs socat 539ms；本文 §3.2：O6 口径下无法分辨 <400ms | **作废**，实测量级 ~16ms [已验证] |
| 96MB agent 加载占大头 | O8：900KB 静态应答器替换 `/agent/main` → `total` 442 → 208~228ms | **成立，~230~240ms** [已验证] |
| 等熵 / `getrandom` 阻塞 | socat 真实路径 0 次 `getrandom`；且 guest crng（~1.1s）晚于监听 | 已否证 [已验证] |
| 宿主 I/O / 页缓存 | 第二轮（宿主页缓存热）与第一轮同值 | 已否证 [已验证] |
| 预读 agent 进 page cache 有收益 | O8 实验 3：inittab 里 `cat /agent/main > /dev/null` 后 `total` 344/407/443（中位 407）vs 442 | **无效**（256MB guest 留不住 96MB）[已验证] |
| busybox init 固定 sleep 1s | busybox `init/init.c:749` 注释 *"Used to have `while (1) sleep(1)` here"*（已删）；`:1182-1193` 同一轮 `SYSINIT→WAIT→ONCE→RESPAWN\|ASKFIRST` | 已排除 [已验证] |
| 宿主探测循环量化 | §3.2 的代码链 + 404≈300+100+4 | **成立**（这是 O6 归因错误的机制）[已验证] |

### 3.4 现在还剩哪些可验证空间

已经量出来的：内核→init ~60ms、init 链 + socat 进监听 ~90ms（socat 本体 ~16ms）、**96MB agent ~240ms**、
其余 ~30ms（O8 口径；合计 539ms 是 O6 口径，O8 的若干次运行在 344~542ms 波动）。**[已验证]**

建议后续任何 A/B 都同时记录**每次尝试的开始/结束时间与失败原因**，否则掉回 §3.2 的量化陷阱：
在 100/300 口径下，任何 <400ms 的 guest 侧改进在冷启动绝对值上都看不见。
若想让生产口径也具备毫秒级可观测性，最省事的做法是串口 mark 驱动连接（见 §4.5 (e)）。

---


## 4. 问题 3：替代方案对比

### 4.1 总表（收益已按台账 O8 的真机 A/B 校正）

| # | 方案 | 预期冷启动收益 | 风险 / 成本 | 证据 |
| --- | --- | --- | --- | --- |
| (a) | 自写 ~2KB 静态 C vsock 监听器替换 socat（`socket(AF_VSOCK)`/`bind`/`listen`/`accept` + `fork` + `dup2` + `execl /agent/main`） | **仅 ~16ms**：O8 实测静态监听器 523~542ms vs socat 539ms | 低（需自持 SIGCHLD/reap、失败退出码语义） | [已验证] 台账 O8 |
| **(b)** | **agent 换成小体积静态二进制（去掉 96MB Bun 产物）** | **−230ms**：O8 实验 2，900KB 静态应答器替换 `/agent/main` 后 `total` 442ms → **208~228ms** | 中：要移植 `guest/agent/main.ts` 的 181 行 JSON-RPC；远程宿主只有 gcc，**C 是唯一现成工具链** | [已验证] 台账 O8 |
| (b2) | 让 agent 自己监听 `AF_VSOCK`（Bun FFI 调 socket/bind/listen/accept；或换更小运行时） | 去掉 socat 的收益 ≈ (a) 的 ~16ms 量级；**若同时把运行时换小，则并入 (b)** | Bun FFI 可行，但**仍是 96MB 进程**，不解决大头；需确认 guest 内核 CONFIG_VSOCKETS 已内建（4.14 默认 y） | [推测] |
| (c) | 保留 socat 但改静态/无 OpenSSL 构建（自编 musl 静态 socat；busybox 无 vsock 监听故不可替代） | ≤ (a)，即 ~16ms 上限 | 需 musl 工具链；远程无 musl-gcc | [已验证]（O8 的等价 A/B 说明收益上限）+ [推测] |
| (d) | `init=<agent>` 直接启动，跳过 busybox init | init 链实测 ≤10ms（O6）+ 结构收益（无 inittab、PID 1 即 agent）；**若与 (b) 合并，收益主要来自 (b)** | 低：agent 要自己 mount /proc /sys、挂 /dev/vdb、跑 mdev；内核已支持 `init=`（E2B/Apple 同样用法） | [已验证]（内核命令行可设 `init=`）+ [已验证]（O6 init 链耗时） |
| (e) | 串口 mark 驱动的就绪探测，替换 100ms 盲轮询 | 消除最坏 **~400ms 的检测延迟**（见 §3.2） | 低：宿主已在读 guest 串口（`src/sandbox/microvm/firecracker-sandbox-driver.ts:465`）；需定义「agent 已监听」的 mark | [已验证]（代码）+ [推测]（收益量级） |
| (f) | 其它：把 agent 放进 tmpfs/initramfs、缩小 guest RAM、内核内早期用户态 | O8 实验 3 已否证「预读进 page cache」（96MB 在 256MB guest 里留不住）；缩 RAM 是 (b) 的配套 | — | [已验证] 台账 O8 |

### 4.2 为什么 (b) 才是真身
1. O8 实验 1/2 是真机 A/B（同参数、同镜像、同快照开关）：**换监听器只差 ~16ms，换 agent 二进制差 ~230ms**。[已验证]
2. 业界 3 家能读到代码的实现，全部把「小体积静态单二进制」当成 guest 内的第一原则：
   microsandbox 的 `agentd`（`FROM scratch` 只拷一个静态 Rust 二进制、注释写明 *"Runs as PID 1 inside the microVM guest"*）、
   Fly.io 的 `init`（musl 静态，写进 64MB ext2 init 盘当 `/dev/vda`）、Apple 的 `vminitd`（Swift Static Linux SDK，`init=/sbin/vminitd`）；
   E2B 的 `envd` 用 `CGO_ENABLED=0` 静态 Go，并在注释里点明 *"must not need a dynamic loader"*。[已验证]
3. 机理：96MB 二进制在 2 vCPU / 256MB guest 里是**冷页缓存下的大量缺页 + 动态链接/初始化**，而我们无法靠预读规避（O8 实验 3）。[已验证]

### 4.3 (a)/(c) 的实测与代码级解释
- O8 已经做过这个实验：静态监听器（890KB、静态编译）替换 inittab 里的 socat，523~542ms vs 539ms → **没有收益**。[已验证]
- 为什么本来就该预期没收益：在 `connectWithRetry(20000, 100, 300)` 口径下，`vsock-connect-ok` 会被量化到 ~400ms（§3.2），
  而 O6 记的 socat 残差（340ms）正是从这个被量化的 404ms 里减出来的。把监听器从 socat（热缓存宿主实测 execve→listen 5.33ms，见 §3.1）
  换成自写静态监听器，改变量远小于量化步长 → 测不出差异。[已验证]（代码）+ [已验证]（O8 实测）
- 结论：**(a)/(c) 不应作为独立优化项**；但若 (b) 已经要把 agent 改成静态 C，那么顺手把监听器写进同一个二进制（省掉 socat 的 6.9MB 动态库与 ~25k 条重定位）是自然的镜像卫生收益。[推测]

### 4.4 (d) `init=<agent>` 的取舍
- 收益：去掉 busybox init 与其 inittab 链（O6 实测整条 sysinit ≤10ms），并且**少一个常驻进程**；PID 1 直接是 agent，符合 E2B/Apple/microsandbox 的做法。
- 代价：agent 必须自己完成原本 inittab 里的事（mount proc/sysfs、`mdev -s`、tmpfs、`mount /dev/vdb /workspace`），
  以及承担 PID 1 的职责（reap 子进程、失败即整机退出）。microsandbox 的 `agentd/lib/init.rs` 就是这么写的（*"PID 1 init: mount filesystems, apply tmpfs mounts, prepare runtime directories."*）。[已验证]
- 我们的场景里 (b) 已经要重写 agent，所以 **建议 (b)+(d) 一次做完**。[推测]

### 4.5 (e) 串口事件驱动的就绪探测
- 现状：宿主冷启动一次性 `connectWithRetry(20000, 100, 300)`（`src/sandbox/microvm/firecracker-sandbox-driver.ts:931`），
  靠 100ms 轮询撞运气；且握手阶段不把「对端关闭」当失败（§3.2），最坏情况白等一个完整 300ms。
- 方案：把「agent 已监听」写成一个 boot mark（我们已经有 `scripts/microvm/patch-guest-rootfs-bootmarks.sh` 和 `/dev/console` mark 机制），
  宿主 `onSerialOutput` 看到该 mark 后立刻连接；兜底仍保留重试循环。
- 预期：把「检测延迟」从最坏的 ~400ms 压到 ~0；对 (b) 之后的收益（~208ms 级）尤其重要——否则小改进会被量化吞掉。[推测]

---


## 5. 问题 4：哪些要换内核，哪些只改 rootfs/inittab/agent

| 方案 | 内核参数 | rootfs/inittab | agent 代码 | 换 vmlinux？ |
| --- | --- | --- | --- | --- |
| **(A2) 修宿主探测循环** | — | — | — | **不需要** |
| (a)/(a′) 静态监听器 | — | ✔（换二进制、改 inittab 一行） | — | **不需要** |
| (b2) agent 自监听（FFI） | — | ✔（删 socat 行） | ✔（FFI） | **不需要** |
| (c) 静态 socat | — | ✔ | — | **不需要** |
| (d) `init=<agent>` | ✔（加 `init=`，可保留 `console=`/`i8042.*`） | ✔（inittab 不再被使用） | ✔（自己做 mount + PID 1 职责） | **不需要** |
| (e) 串口 mark 驱动（§4.5） | — | ✔（多一行 mark） | — | **不需要** |
| (f2) 宿主预排队 bootstrap（microsandbox 做法，见 §2.5） | — | — | ✔（先读后答） | **不需要** |
| **(b) 缩小 agent（首选，§4.2）** | — | ✔ | ✔ | **不需要** |

原因：`AF_VSOCK`、`init=`、静态 ELF、`virtio-blk`、`devtmpfs` 在 4.14.174 上都已具备；
Firecracker 的 vsock 设备是 VMM 侧模型，与 guest 内核版本无关（官方文档只要求 guest 内核 `CONFIG_VIRTIO_VSOCKETS=y`，
以及宿主能用 `/dev/vsock` 自检）。**[官方文档]** https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md

---

## 6. 排序后的动作（含预期收益）

> 与台账 O8 的「下一步」一致；每条都标注证据强度与预期毫秒量级。

**A1（首选，预期 −230ms）把 guest agent 换成小体积静态二进制。**
- 依据：O8 实验 2（同参数 A/B，900KB 静态应答器替换 96MB Bun 产物 → `total` 442ms → 208~228ms）。[已验证]
- 预期：O6 口径冷启动 **539ms → ~310ms**（保守）；若同时做 A3 与 A2，可望到 **~210~250ms**。
- 实施要点：C 重写 `guest/agent/main.ts` 的 181 行（JSON-RPC `ping`/`exec`；base64 64KB 分片；1MiB 截断；`timeoutMs` 到点 SIGTERM→2s→SIGKILL）；`gcc -static -Os`（远程宿主有 gcc，无 go/rustc）。
- 风险：exec 语义与 PATH、并发 exec 的处理；需保留现有宿主侧协议（`{v:1,type,id}` 帧）。
- **进行中**：本仓库已出现 `guest/agent/agent.c`（453 行，2026-10-12 18:22 尚未提交），即本文 A1+(b2) 的实现——静态 C、自己监听 `AF_VSOCK`（默认 5000）、每连接 fork、协议与 `guest/agent/main.ts` 完全一致（`ping`/`pong`/`exec`/`exec_output`/`exec_result`），并提供 `--stdio` 便于非 Linux CI。**[已验证]（代码）**

**A2（同批，检测延迟）修正宿主握手循环三处。**
- (1) 握手阶段把 socket `close`/`end` 当成一次失败（现在是 `error` 才 reject；`src/sandbox/microvm/firecracker-vsock-bridge.ts:172`）。
- (2) 限制在飞尝试/重试去重，使 `intervalMs` 可以收紧——O8 实测 20/30 会在热恢复里开出 ~50 个连接、反复 fork 96MB agent，热恢复 97ms → **229~653ms 回归**。[已验证]
- (3) 保持单次 `attemptTimeoutMs` **大于 agent 加载时间**（O8 的教训）；agent 变小后可相应下调。
- 预期：修 (1) 后最坏检测延迟 400ms → ~100ms；叠加 A4(e) 串口 mark 可到 ~0。

**A3（与 A1 合并）`init=<agent>`。** 省掉 busybox init 与 inittab（init 链实测 ≤10ms）并去掉一个常驻进程；agent 自己 mount /proc /sys、`mdev -s`、tmpfs、`/dev/vdb`。业界 3/3 一手案例都这么做。[已验证]+[推测]

**A4（顺手，~16ms + 镜像卫生）去掉 socat。** O8 已实测「换监听器」只值 ~16ms，所以这不是性能项；收益是少 6.9MB 动态库（libcrypto 4.48MB 等）与 ~25k 条重定位、少一个 fork 服务。若 A1 已改用静态 C，把监听逻辑并进 agent 即可。[已验证]

**A5（配套，可选）缩小 guest RAM、把 agent 放在 tmpfs 而非回环块设备上。** 依据：O8 实验 3 证明「预读 agent 进 page cache」无效（256MB guest 留不住 96MB），所以只能靠「变小」（A1）而不是「预热」。[已验证]

---


## 7. 来源清单

- 一手真机台账（本文多处数据来源）：`docs/vm-startup-optimizations.zh-CN.md` 的 O6（i8042 参数 → 539ms）与 **O8**（同文档 :175-235，2026-10-12：静态 vsock 监听器 A/B 523~542 vs 539ms、900KB 静态应答器替换 96MB agent → 442 vs 208~228ms、预读无效、20/30 握手的冷启动假象与热恢复回归）[已验证]。

**一手源码（本次实际读过，[已验证]）**
- E2B：https://github.com/e2b-dev/infra
  - `packages/orchestrator/pkg/sandbox/fc/kernel_args.go`（`init`/`i8042.nokbd`/`i8042.noaux`/`random.trust_cpu=on`/`quiet loglevel=1`/`maxcpus`，以及保留参数校验）
  - `packages/orchestrator/pkg/template/build/core/rootfs/rootfs.go`（`BusyBoxInitPath = "usr/bin/init"`）
  - `packages/orchestrator/pkg/template/build/core/rootfs/files/{inittab.tpl,envd.service.tpl,envd.openrc.tpl,rcS.sh.tpl}`
  - `packages/envd/{Makefile,main.go,README.md}`（`CGO_ENABLED=0`、`defaultPort = 49983`）
- Fly.io：https://github.com/superfly/init-snapshot （Rust `init`，musl 静态，`/dev/vda` init 盘 + `/dev/vdb` rootfs + virtio-vsock）
- Apple：https://github.com/apple/containerization
  - `Sources/Containerization/Kernel+Commandline.swift`（`init=/sbin/vminitd`）、`README.md`、`vminitd/Makefile`（Swift Static Linux SDK）
- microsandbox：https://github.com/microsandbox/microsandbox
  - `Dockerfile.agentd`（rust:alpine → `FROM scratch`）、`crates/agentd/bin/main.rs`（PID 1）、
    `crates/agentd/lib/init.rs`（自己 mount）、`crates/agentd/lib/serial.rs`（virtio-serial、`/sys/class/virtio-ports`）
- Kata：https://github.com/kata-containers/kata-containers/blob/main/src/agent/kata-agent.service.in
- gVisor：https://github.com/google/gvisor/blob/master/pkg/urpc/urpc.go
- busybox：https://github.com/mirror/busybox/blob/master/init/init.c （`:163/:175/:594/:602/:607/:749/:1182-1193`）
- Firecracker vsock 设备与 `CONNECT/OK` 协议、以及「无人监听时宿主连接会被关闭」：
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md **[官方文档]**

**官方文档 [官方文档]**
- Modal 内存快照（gVisor runsc + CRIU）：https://modal.com/blog/mem-snapshots
- Blaxel（standby 恢复 <25ms）：https://docs.blaxel.ai/
- Daytona 架构：https://www.daytona.io/docs/en/architecture/

**第三方 [第三方]**
- CodeSandbox 内存快照压缩（8GiB→412MiB zstd、userfaultfd）：https://codesandbox.stream/blog/how-we-scale-our-microvm-infrastructure-using-low-latency-memory-decompression

---

## 附录 A：复现本次测量的命令

```bash
# 1) 从存量镜像里取出 socat 及其库（真机，只读）
sudo debugfs -R "dump /usr/bin/socat1 /tmp/gsa3/socat"     /data/harness/images/rootfs-bootmarks.ext4
sudo debugfs -R "dump /lib/ld-musl-x86_64.so.1  /tmp/gsa3/ld-musl-x86_64.so.1" <img>
# …（libcrypto.so.3 / libssl.so.3 / libreadline.so.8.2 / libncursesw.so.6.4 同理）
chmod 755 /tmp/gsa3/*

# 2) 真实路径的时间线（宿主，热页缓存，2 vCPU 绑定）
taskset -c 0,1 strace -f -tt -T -o tr.txt \
  ./ld-musl-x86_64.so.1 --library-path . ./socat VSOCK-LISTEN:59777,fork EXEC:/bin/true
# 关注 execve → socket(AF_VSOCK) → bind → listen 的绝对时间差

# 3) 重定位规模
readelf -r ./socat | wc -l ; readelf -r ./libcrypto.so.3 | wc -l ; readelf -r ./libssl.so.3 | wc -l
```

## 附录 B：待确认 / 反例清单（写作时已知的不确定性）

1. **「96MB agent 加载 ~240ms」与台账 O6 记的「agent 加载 ~75ms」互相矛盾。**
   本文以 O8 的 A/B 为准（同参数替换二进制、可重复，442 → 208~228ms），并标注两者口径不同：
   O6 的 75ms 是 `pong − vsock-connect-ok` 的差量，而 `connect-ok` 本身受重试量化影响（§3.2），
   在 96MB agent + 收紧后的循环下差值会失真。**待确认**：用串口 mark（A4e）重新标定 agent 就绪时刻。[推测]
2. **Firecracker 对「无人监听」的连接是发 FIN 还是 RST，我未直接验证。**
   官方文档只说 Firecracker 会关闭宿主连接、宿主须重试；若实际是 RST，则宿主 `error` 会立刻触发，
   §3.2 里「白等满 300ms」只在「先连上、后关闭」的边缘情形成立。**待确认**：在宿主侧记录每次尝试的
   `connect`/`close`/`error` 时间戳（一次冷启动日志即可分辨）。[推测]
3. **静态监听器的 O8 A/B 与本文 §3.2 的量化分析共同说明**：在 `(100, 300)` 口径下无法分辨 <400ms 的 guest 侧差异。
   任何后续 A/B 都应同时记录「每次尝试的开始/结束时间 + 串口 mark」，否则会把量化误差当成优化收益。[已验证]（代码）+ [推测]
4. **`init=<agent>` 的失败模式未在真机上试过**：PID 1 退出即内核 panic/重启，agent 崩溃会让 VM 直接死掉（现在 socat 崩了还有 respawn）。需要明确这是否可接受。[推测]
5. **Bun FFI 监听 AF_VSOCK 的可行性（(b2)）我只做了接口层面的判断**，没有实机验证 `socket(AF_VSOCK)` 在 Alpine guest 里对 Bun 的 FFI 是否可用；但即使可行也不解决 96MB 的体积问题，故优先级低。[推测]
6. **本次调研未覆盖**：guest 内核 `CONFIG_VSOCKETS_CORE` 是否为 y（我们只有 vmlinux，未取 config）；若为 m，则 `init=<agent>` 需先确认模块已加载。可用 `zcat /proc/config.gz`（若内核带 IKCONFIG）或从 vmlinux 的 `.config` 段确认。[推测]
