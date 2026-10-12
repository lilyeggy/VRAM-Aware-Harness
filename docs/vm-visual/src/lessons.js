import gsap from "gsap";
import { createTrack } from "./lib.js";

// ============================================================
// 第 1 章：CPU 的"权限等级"（特权级 / Ring）
// ============================================================
export function mountRings(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>CPU 有"权限等级"。内核运行在最高等级（x86 叫 <b>Ring 0</b>），能直接操作硬件；普通程序运行在 <b>Ring 3</b>，想碰硬件必须先请求内核。
      这样一个出错的程序，最多只能搞崩它自己，不会把整台机器带走。</p>
    </div>
    <div class="btns">
      <button class="bad-btn" data-s="direct">✗ 程序直接去读硬盘</button>
      <button class="primary" data-s="syscall">✓ 程序请求内核帮忙读硬盘</button>
      <button data-s="reset">重置</button>
    </div>
    <div class="stage-track" data-track></div>
    <div class="caption" data-cap>选一种做法，看 CPU 怎么处理。</div>`;
  const track = createTrack(
    root.querySelector("[data-track]"),
    [
      { label: "普通程序", sub: "Ring 3 · 只能提需求", color: "#ffb547" },
      { label: "CPU 门卫", sub: "检查当前权限等级", color: "#8b98a5" },
      { label: "内核", sub: "Ring 0 · 能碰硬件", color: "#5ac8fa" },
      { label: "硬盘", sub: "真实硬件", color: "#3ddc97" },
    ],
    root.querySelector("[data-cap]"),
  );
  root.querySelector('[data-s="direct"]').addEventListener("click", () => track.run([
    { to: 1, text: "程序执行读硬盘的指令。CPU 门卫检查：<b>当前在 Ring 3，不允许直接访问硬件</b>。", color: "#ff6b6b", dur: 0.9, hold: 1.4 },
    { to: 0, text: "CPU 拒绝执行，触发一个<b>异常（exception）</b>，控制权交给内核。程序被终止或报错。", color: "#ff6b6b", dur: 0.9, hold: 1.8, mark: "bad" },
  ]));
  root.querySelector('[data-s="syscall"]').addEventListener("click", () => track.run([
    { to: 1, text: "程序执行 <b>syscall</b> 指令：请求内核帮忙。CPU 门卫<b>放行入口</b>，把权限切到 Ring 0。", color: "#5ac8fa", dur: 0.9, hold: 1.4 },
    { to: 2, text: "内核（Ring 0）检查请求合法，然后去执行真正的硬件操作。", color: "#5ac8fa", dur: 0.9, hold: 1.2 },
    { to: 3, text: "内核访问硬盘，读出数据。", color: "#3ddc97", dur: 0.9, hold: 1.2 },
    { to: 0, text: "内核把结果返回给程序，权限切回 Ring 3。", color: "#ffb547", dur: 1.4, hold: 1.6 },
  ]));
  root.querySelector('[data-s="reset"]').addEventListener("click", () => track.reset());
}

// ============================================================
// 第 2 章：为什么虚拟化难？软件模拟 vs 硬件辅助
// ============================================================
export function mountWhyHard(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>虚拟机里的操作系统（客户机）以为自己是内核，也想用 Ring 0。可它实际上只是另一个普通程序，<b>必须被宿主机的 VMM 管住</b>。问题是：客户机执行的"敏感指令"（碰硬件、改页表、关中断）如何被截获？</p>
      <p>早期做法是纯软件：VMM 扫描并翻译客户机的代码，把危险指令替换掉。这很慢，而且 x86 有些指令在低权限下<b>不报错、只悄悄表现不同</b>，软件很难发现。</p>
    </div>
    <div class="cmp">
      <div class="cmp-col">
        <h4>纯软件方案（2005 年之前）</h4>
        <ol>
          <li>VMM 在运行前<b>翻译</b>客户机的代码块</li>
          <li>危险指令被替换成调用 VMM 的代码</li>
          <li>所有人都要绕一圈软件，开销大</li>
          <li>x86 的部分指令会<b>静默失败</b>，翻译器必须逐条兜底</li>
        </ol>
      </div>
      <div class="cmp-col hw">
        <h4>硬件辅助（Intel VT-x / AMD-V）</h4>
        <ol>
          <li>CPU 本身新增一个<b>"虚拟化模式"</b>，客户机代码直接在 CPU 上跑</li>
          <li>只有真正的<b>敏感事件</b>才会被 CPU 自动交给 VMM</li>
          <li>绝大多数普通计算完全不经过 VMM，接近原生速度</li>
          <li>这个"交接"就是下一章的 <b>VM entry / VM exit</b></li>
        </ol>
      </div>
    </div>
    <div class="callout">现在的 KVM、Firecracker 都依赖这种硬件能力。没有 VT-x/AMD-V，就没有现代的快速虚拟机。</div>`;
}

// ============================================================
// 第 3 章：硬件辅助的核心——VMX 模式、VM entry/exit、VMCS
// ============================================================
export function mountVmxExit(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>CPU 多了两种状态：<b>根模式（root）</b>，宿主 VMM 运行在这里；<b>非根模式（non-root）</b>，客户机运行在这里。
      客户机在非根模式里几乎全速运行。遇到"必须让宿主处理"的事件，CPU 会自动切换回根模式，这叫 <b>VM exit</b>；处理完再切回客户机，叫 <b>VM entry</b>。</p>
    </div>
    <div class="btns">
      <button data-s="compute">客户机做普通计算</button>
      <button data-s="io" class="primary">客户机往串口写一个字节</button>
      <button data-s="reset">清空</button>
    </div>
    <div class="ribbon-wrap">
      <div class="ribbon-label"><span class="lg g">■ 客户机（non-root）</span><span class="lg a">■ 宿主 VMM（root）</span><span class="lg r">■ 切换事件</span></div>
      <div class="ribbon" data-ribbon></div>
    </div>
    <div class="vmcs-wrap">
      <div class="vmcs">
        <h4>VMCS（虚拟机控制结构）</h4>
        <p class="muted">CPU 为每个虚拟 CPU 保存一份"客户机快照"，切换时用它保存/恢复寄存器。</p>
        <pre data-vmcs>客户机状态：（尚未运行）</pre>
      </div>
      <div class="caption" data-cap>点按钮，观察 CPU 在两种模式之间怎么切换。</div>
    </div>`;

  const ribbon = root.querySelector("[data-ribbon]");
  const cap = root.querySelector("[data-cap]");
  const vmcs = root.querySelector("[data-vmcs]");

  function seg(kind, text, width) {
    const d = document.createElement("div");
    d.className = `seg ${kind}`;
    d.style.flex = `${width} 0 0`;
    d.innerHTML = text;
    ribbon.appendChild(d);
    gsap.fromTo(d, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4 });
    return d;
  }
  function reset() {
    ribbon.innerHTML = "";
    cap.innerHTML = "点按钮，观察 CPU 在两种模式之间怎么切换。";
    vmcs.textContent = "客户机状态：（尚未运行）";
  }
  const saved = `RIP = 0x00ffa3 （下一条要执行的指令地址）
RSP = 0x7ffd10 （栈顶）
CR3 = 0x1f2000 （客户机页表根）
RAX = 0x000041 （寄存器内容）`;

  root.querySelector('[data-s="compute"]').addEventListener("click", () => {
    const d = seg("g", "普通计算…", 3);
    cap.innerHTML = "客户机在 non-root 模式直接执行普通指令。<b>宿主完全不知道</b>，没有任何切换，速度接近原生。";
    vmcs.textContent = "客户机状态：运行中（无需保存，VMM 不介入）";
    return d;
  });

  root.querySelector('[data-s="io"]').addEventListener("click", () => {
    if (ribbon.children.length > 12) reset();
    const tl = gsap.timeline();
    tl.add(() => { seg("g", "客户机代码", 2); cap.innerHTML = "客户机执行 <code>out 0x3f8, 'h'</code>：往串口端口写字节。这是<b>敏感操作</b>，CPU 不能让它直接生效。"; });
    tl.add(() => { seg("r", "VM exit", 1); cap.innerHTML = "<b>VM exit</b>：CPU 自动把客户机寄存器存进 VMCS，切换到宿主（root 模式）。"; vmcs.textContent = "已保存到 VMCS：\n" + saved; });
    tl.add(() => { seg("a", "宿主 KVM + Firecracker 模拟串口", 3); cap.innerHTML = "宿主看到退出原因是<b>端口 I/O</b>，于是由用户态的 Firecracker 模拟一个串口，把字节 'h' 写到它的输出。"; }, "+=0.9");
    tl.add(() => { seg("r", "VM entry", 1); cap.innerHTML = "<b>VM entry</b>：宿主处理完毕，CPU 从 VMCS 恢复客户机寄存器，切回非根模式继续执行。"; vmcs.textContent = "已从 VMCS 恢复，客户机继续运行。"; }, "+=0.9");
    tl.add(() => { seg("g", "客户机代码继续", 2); cap.innerHTML = "客户机以为刚才那条 <code>out</code> 正常完成了。它<b>看不出</b>中间被宿主接管过。"; }, "+=0.7");
  });
  root.querySelector('[data-s="reset"]').addEventListener("click", reset);
}

// ============================================================
// 第 4 章：内存——两级地址翻译
// ============================================================
export function mountMemory(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>程序访问内存时，地址要经过两次翻译。第一次是操作系统的<b>页表</b>（把程序的「虚拟地址」换成「物理地址」）。
      虚拟机里多了一层：客户机以为的"物理地址"其实还要再翻译一次，才是宿主机上真实的内存位置。这第二次翻译由 CPU 的 <b>EPT</b>（扩展页表）完成。</p>
    </div>
    <div class="addr-row">
      <div class="addr" data-a="va"><small>程序看到的</small><b>虚拟地址</b><code>0x7f3a1000</code></div>
      <div class="arrow-l"><span>① 客户机页表<br><i>客户机内核维护</i></span></div>
      <div class="addr" data-a="gpa"><small>客户机以为的</small><b>客户机物理地址</b><code>0x0001a000</code></div>
      <div class="arrow-l"><span>② EPT 页表<br><i>宿主 KVM 维护</i></span></div>
      <div class="addr" data-a="hpa"><small>真实位置</small><b>宿主物理地址</b><code>0x3c08a000</code></div>
    </div>
    <div class="pt-wrap">
      <div class="pt"><h5>客户机页表（4 级）</h5><div class="levels" data-g></div></div>
      <div class="pt"><h5>EPT 页表（4 级）</h5><div class="levels" data-e></div></div>
    </div>
    <div class="btns"><button class="primary" data-s="walk">访问一个地址，看两次翻译</button><button data-s="reset">重置</button></div>
    <div class="caption" data-cap>点按钮，逐级查表。</div>
    <div class="callout">这也解释了项目里的 <code>mem.snap</code>：<b>一台 VM 的内存，本质上就是宿主进程里的一大块普通内存</b>。把它整块写进文件，就是快照。</div>`;

  const levels = ["PML4", "PDPT", "PD", "PT"];
  const g = root.querySelector("[data-g]");
  const e = root.querySelector("[data-e]");
  const cap = root.querySelector("[data-cap]");
  [g, e].forEach((box) => levels.forEach((l) => {
    const p = document.createElement("div");
    p.className = "lvl";
    p.textContent = l;
    box.appendChild(p);
  }));
  const addr = (k) => root.querySelector(`[data-a="${k}"]`);
  const reset = () => {
    root.querySelectorAll(".lvl").forEach((el) => el.classList.remove("on"));
    root.querySelectorAll(".addr").forEach((el) => el.classList.remove("on"));
    cap.innerHTML = "点按钮，逐级查表。";
  };
  root.querySelector('[data-s="reset"]').addEventListener("click", reset);
  root.querySelector('[data-s="walk"]').addEventListener("click", () => {
    reset();
    const tl = gsap.timeline();
    addr("va").classList.add("on");
    levels.forEach((_, i) => tl.call(() => {
      g.children[i].classList.add("on");
      cap.innerHTML = `① 客户机页表第 ${i + 1} 级：用地址的一段索引，找到下一级页表的位置（<b>${levels[i]}</b>）。`;
    }, null, `+=${i === 0 ? 0.2 : 0.8}`));
    tl.call(() => { addr("gpa").classList.add("on"); cap.innerHTML = "得到<b>客户机物理地址</b>。但这还不是真实内存！客户机看到的只是它自己的「物理」世界。"; }, null, "+=1");
    levels.forEach((_, i) => tl.call(() => {
      e.children[i].classList.add("on");
      cap.innerHTML = `② EPT 第 ${i + 1} 级：宿主 KVM 维护的表，把「客户机物理地址」翻译成「宿主物理地址」（<b>${levels[i]}</b>）。`;
    }, null, `+=${i === 0 ? 0.8 : 0.8}`));
    tl.call(() => { addr("hpa").classList.add("on"); cap.innerHTML = "命中宿主机真实内存。两次翻译完成，读写生效。<b>客户机无法访问不属于它的内存</b>，因为 EPT 里根本没有那些映射。"; }, null, "+=1");
  });
}

// ============================================================
// 第 5 章：设备——模拟设备 与 virtio
// ============================================================
export function mountDevices(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>虚拟机要和外界交换数据（串口输出、读写磁盘），就得有"虚拟设备"。两种做法：</p>
      <ul>
        <li><b>完全模拟</b>：假装是一块真实的硬件（如 8250 串口、IDE 磁盘）。客户机驱动一个寄存器，就触发一次 VM exit，开销大。</li>
        <li><b>virtio（半虚拟化）</b>：约定一种标准的"共享队列"（virtqueue）放在客户机内存里。客户机把请求放进队列，只需一次通知，宿主批量处理。</li>
      </ul>
    </div>
    <div class="btns">
      <button data-s="serial">A. 串口输出（完全模拟）</button>
      <button class="primary" data-s="blk">B. 读写磁盘（virtio-blk）</button>
    </div>
    <div class="stage-track" data-track></div>
    <div class="caption" data-cap>选一个场景看数据怎么流动。</div>`;
  const track = createTrack(
    root.querySelector("[data-track]"),
    [
      { label: "客户机驱动", sub: "guest 内核", color: "#3ddc97" },
      { label: "KVM / VM exit", sub: "宿主内核", color: "#ffb547" },
      { label: "Firecracker", sub: "用户态模拟设备", color: "#b28dff" },
      { label: "宿主文件", sub: "ext4 镜像 / 终端", color: "#5ac8fa" },
    ],
    root.querySelector("[data-cap]"),
  );
  root.querySelector('[data-s="serial"]').addEventListener("click", () => track.run([
    { to: 0, text: "客户机驱动执行 <code>out 0x3f8</code>，往串口寄存器写字节 'h'。", color: "#3ddc97", dur: 0.5, hold: 1.2 },
    { to: 1, text: "端口访问是敏感操作 → <b>VM exit</b>，控制权交给宿主。", color: "#ffb547", dur: 0.8, hold: 1.2 },
    { to: 2, text: "Firecracker 模拟的串口收到 'h'。它<b>没有真的串口</b>，只是个用户态程序。", color: "#b28dff", dur: 0.8, hold: 1.4 },
    { to: 3, text: "Firecracker 把字节写到自己的标准输出，宿主终端或日志里就出现了 h。", color: "#5ac8fa", dur: 0.8, hold: 1.6 },
  ]));
  root.querySelector('[data-s="blk"]').addEventListener("click", () => track.run([
    { to: 0, text: "驱动把「读第 N 扇区」的请求写进 <b>virtqueue</b>（共享队列，就在客户机内存里）。<b>这一步不退出</b>，很便宜。", color: "#3ddc97", dur: 0.5, hold: 1.8 },
    { to: 1, text: "驱动写一下「通知寄存器」（queue notify）→ <b>一次</b> VM exit。", color: "#ffb547", dur: 0.8, hold: 1.2 },
    { to: 2, text: "Firecracker 从共享队列取出请求，知道要读哪个扇区。", color: "#b28dff", dur: 0.8, hold: 1.4 },
    { to: 3, text: "Firecracker 去宿主文件（如 workspace.ext4）里读出这些字节。", color: "#5ac8fa", dur: 0.8, hold: 1.4 },
    { to: 2, text: "Firecracker 把数据<b>直接写回客户机内存</b>，然后给客户机发中断。", color: "#b28dff", dur: 0.8, hold: 1.4 },
    { to: 0, text: "客户机驱动收到中断，读到数据。整个过程只有一次退出，所以比完全模拟快得多。", color: "#3ddc97", dur: 0.9, hold: 1.8 },
  ]));
}

// ============================================================
// 第 6 章：KVM 与 VMM——谁负责什么
// ============================================================
export function mountKvm(root) {
  root.innerHTML = `
    <div class="lesson-intro">
      <p>虚拟机的运行靠三层配合。每一层只做一件事：</p>
    </div>
    <div class="layers3">
      <button class="layer3 l-user" data-layer="fc"><small>用户态（普通进程）</small><b>Firecracker（VMM 虚拟机监视器）</b><span>负责「造假硬件」：串口、virtio 磁盘、vsock，以及 HTTP API。它是宿主上的一个普通进程。</span></button>
      <button class="layer3 l-kernel" data-layer="kvm"><small>Linux 内核</small><b>KVM（内核模块）</b><span>暴露 <code>/dev/kvm</code>。负责调用 CPU 的虚拟化指令，把客户机跑起来，并在 VM exit 时把控制权交给 Firecracker。</span></button>
      <button class="layer3 l-hw" data-layer="hw"><small>硬件</small><b>CPU（VT-x / AMD-V）+ 内存</b><span>真正执行客户机指令的地方。VM entry / exit 由 CPU 硬件完成。</span></button>
    </div>
    <div class="layer-note" data-note>点击上面任意一层，看它的职责。</div>
    <h3 class="sub">Firecracker 的核心循环（简化示意）</h3>
    <div class="code-wrap">
      <pre class="code" data-code></pre>
    </div>
    <div class="btns"><button class="primary" data-s="run">▶ 看它运行一圈</button></div>
    <div class="caption" data-cap>循环的每一轮：让客户机跑 → 遇到退出 → 宿主处理 → 再跑。</div>`;

  const notes = {
    fc: "Firecracker 是 VMM。它<b>不发明</b>虚拟化能力，只是调用 KVM 提供的接口，然后扮演「主板」：决定有哪些设备、怎么模拟它们。它还提供 HTTP API（就是项目里 <code>putSocket</code> 发的那些 PUT 请求）。",
    kvm: "KVM 是 Linux 内核的一部分。它把 CPU 的虚拟化能力变成文件接口 <code>/dev/kvm</code>，用 <code>ioctl</code> 系统调用让进程创建虚拟机、创建虚拟 CPU、把内存交给客户机、然后运行。",
    hw: "CPU 硬件决定了「哪些指令直接执行、哪些要交给宿主」。KVM 和 Firecracker 只是在这个硬件机制上搭的软件。",
  };
  root.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => {
    root.querySelector("[data-note]").innerHTML = notes[b.dataset.layer];
    root.querySelectorAll("[data-layer]").forEach((x) => x.classList.toggle("on", x === b));
  }));

  const code = [
    "// 1. 创建虚拟机与虚拟 CPU（KVM 提供，通过 /dev/kvm）",
    "vm_fd   = ioctl(kvm_fd, KVM_CREATE_VM, 0);",
    "vcpu_fd = ioctl(vm_fd,  KVM_CREATE_VCPU, 0);",
    "",
    "// 2. 把一块宿主内存交给客户机当内存（客户机物理地址 → 宿主内存）",
    "ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &guest_ram);",
    "",
    "// 3. 循环：让客户机跑，遇到需要宿主处理的事件就返回",
    "while (1) {",
    "    ioctl(vcpu_fd, KVM_RUN, 0);         // 进入客户机（VM entry）",
    "    switch (run->exit_reason) {          // 客户机退出（VM exit）",
    "    case KVM_EXIT_IO:   emulate_serial_or_port(run); break;   // 端口 I/O",
    "    case KVM_EXIT_MMIO: emulate_virtio_notify(run);  break;   // 设备寄存器",
    "    case KVM_EXIT_HLT:  wait_for_interrupt();        break;   // 客户机空闲",
    "    }",
    "}",
  ];
  const codeEl = root.querySelector("[data-code]");
  codeEl.innerHTML = code.map((l, i) => `<span class="cl" data-l="${i}">${l.replace(/</g, "&lt;") || " "}</span>`).join("\n");
  const cap = root.querySelector("[data-cap]");
  root.querySelector('[data-s="run"]').addEventListener("click", () => {
    const tl = gsap.timeline();
    const hi = (i) => tl.call(() => {
      codeEl.querySelectorAll(".cl").forEach((el) => el.classList.remove("on"));
      codeEl.querySelector(`[data-l="${i}"]`).classList.add("on");
    });
    const cap1 = (t) => tl.call(() => { cap.innerHTML = t; });
    cap1("第一步：宿主创建虚拟机和虚拟 CPU（对应项目里 Firecracker 启动后收到的配置）。");
    hi(1); hi(2);
    cap1("第二步：把宿主上的一块内存交给客户机，这块内存就是客户机的全部 RAM。");
    hi(5);
    cap1("第三步：<b>KVM_RUN</b>：CPU 进入客户机执行（VM entry）。客户机一直跑，直到遇到需要宿主处理的事件。");
    hi(8); hi(9);
    cap1("遇到<b>端口 I/O</b>（如串口）：CPU 退出（VM exit），宿主 Firecracker 模拟设备后，循环回到 KVM_RUN，继续跑客户机。");
    hi(11);
    hi(12);
    cap1("遇到<b>设备寄存器访问</b>（如 virtio 通知）：同样退出、处理、再继续。这就是一台虚拟机「活着」的全部秘密：<b>不断地跑、不断地被接管</b>。");
    tl.call(() => codeEl.querySelectorAll(".cl").forEach((el) => el.classList.remove("on")));
  });
}
