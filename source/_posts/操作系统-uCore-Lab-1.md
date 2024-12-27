---
title: 操作系统 uCore Lab 1 含 Challenge
categories: 操作系统
date: 2018-11-04 22:12:20
keywords: 操作系统, ucore, lab 1, challenge
tags: [操作系统, uCore, Lab]
---
### 练习1：理解通过make生成执行文件的过程

1. 操作系统镜像文件ucore.img是如何一步一步生成的？

```MakeFile
$(UCOREIMG): $(kernel) $(bootblock)
	$(V)dd if=/dev/zero of=$@ count=10000
	$(V)dd if=$(bootblock) of=$@ conv=notrunc
	$(V)dd if=$(kernel) of=$@ seek=1 conv=notrunc
从 MakeFile 里面 可以看出 生成 ucore.img 首先需要生成 大小为 10000字节 的空间
然后 将 bootblock 和 kernel 依次写入到 那块空间之中
```
<!-- more -->
生成 Bootblock

```MakeFile
bootfiles = $(call listf_cc,boot)
$(foreach f,$(bootfiles),$(call cc_compile,$(f),$(CC),$(CFLAGS) -Os -nostdinc))
这里遍历 boot 目录下的所有文件 asm.h bootasm.S bootmain.c
bootblock = $(call totarget,bootblock)
生成目标文件 asm.o bootasm.o bootmain.o sign.o
$(bootblock): $(call toobj,$(bootfiles)) | $(call totarget,sign)
	@echo + ld $@
	$(V)$(LD) $(LDFLAGS) -N -e start -Ttext 0x7C00 $^ -o $(call toobj,bootblock)
	@$(OBJDUMP) -S $(call objfile,bootblock) > $(call asmfile,bootblock)
	@$(OBJDUMP) -t $(call objfile,bootblock) | $(SED) '1,/SYMBOL TABLE/d; s/ .* / /; /^$$/d' > $(call symfile,bootblock)
	@$(OBJCOPY) -S -O binary $(call objfile,bootblock) $(call outfile,bootblock)
	@$(call totarget,sign) $(call outfile,bootblock) $(bootblock)
将目标文件 链接起来 同时指定代码段开始地址 为 0x7c00
$(call create_target,bootblock)
```

![](/images/lab1_gcc.png)

![](/images/lab1_ld_bootblock.png)

生成 Kernel

```MakeFile
KOBJS	= $(call read_packet,kernel libs)

kernel = $(call totarget,kernel)

$(kernel): tools/kernel.ld

$(kernel): $(KOBJS)
	@echo + ld $@
	$(V)$(LD) $(LDFLAGS) -T tools/kernel.ld -o $@ $(KOBJS)
	@$(OBJDUMP) -S $@ > $(call asmfile,kernel)
	@$(OBJDUMP) -t $@ | $(SED) '1,/SYMBOL TABLE/d; s/ .* / /; /^$$/d' > $(call symfile,kernel)

$(call create_target,kernel)
将 kern 下面的所有文件 编译 生成 目标文件 再进行链接
```
![](/images/lab1_ld_kernel.png)

- -ggdb 生成可供gdb使用的调试信息 
- -m32 生成适用于32位环境的代码 
- -gstabs 生成stabs格式的调试信息 
- -nostdinc 不使用标准库 
- -fno-stack-protector 不生成用于检测缓冲区溢出的代码 
- -Os 为减小代码大小而进行优化 
- -I添加搜索头文件的路径 
- -fno-builtin 不进行builtin函数的优化
- -m 模拟为i386上的连接器 
- -N 设置代码段和数据段均可读写 
- -e 指定入口 
- -Ttext 指定代码段开始位置


2. 一个被系统认为是符合规范的硬盘主引导扇区的特征是什么？

```c
在 tools/sign.c 里面  有以下两句 说明 符合规范的硬盘主引导扇区特征是 最后两个字节 为 0x55 0xAA 同时 主引导扇区的大小应为 512 字节
    buf[510] = 0x55;
    buf[511] = 0xAA;
```

### 练习2：使用qemu执行并调试lab1中的软件
1. 从CPU加电后执行的第一条指令开始，单步跟踪BIOS的执行。
2. 在初始化位置0x7c00设置实地址断点,测试断点正常。
3. 从0x7c00开始跟踪代码运行,将单步跟踪反汇编得到的代码与bootasm.S和 bootblock.asm进行比较。
4. 自己找一个bootloader或内核中的代码位置，设置断点并进行测试。

在一个终端中先执行
```
qemu-system-i386 -S -s -d in_asm -D bin/q.log -monitor stdio -hda bin/ucore.img
```
后在另一个终端执行
```
i386-elf-gdb
file bin/kernel
target remote :1234
查看 CS:EIP 由于此时在实际模式下 CPU 在加电后执行的第一条指令的地址 为 0xf000:0xfff0 => 0xffff0
(gdb) x/i $cs
   0xf000:	add    %al,(%eax)
(gdb) x/i $eip
=> 0xfff0:	add    %al,(%eax)
再来看看这个地址的指令是什么
(gdb) x/2i 0xffff0
   0xffff0:	ljmp   $0x3630,$0xf000e05b
可以看到 第一条指令执行完以后 会跳转到 0xf000e05b 也就是说 BIOS 开始的地址是 0xfe05b

打上断点
b *0x7c00
(gdb) b *0x7c00
Breakpoint 1 at 0x7c00
(gdb) c
Continuing.

Breakpoint 1, 0x00007c00 in ?? ()
```

### 练习3：分析bootloader进入保护模式的过程
BIOS将通过读取硬盘主引导扇区到内存，并转跳到对应内存中的位置执行bootloader。请分析bootloader是如何完成从实模式进入保护模式的。

```x86asm
#include <asm.h>

# Start the CPU: switch to 32-bit protected mode, jump into C.
# The BIOS loads this code from the first sector of the hard disk into
# memory at physical address 0x7c00 and starts executing in real mode
# with %cs=0 %ip=7c00.

.set PROT_MODE_CSEG,        0x8                     # kernel code segment selector
.set PROT_MODE_DSEG,        0x10                    # kernel data segment selector
.set CR0_PE_ON,             0x1                     # protected mode enable flag

# start address should be 0:7c00, in real mode, the beginning address of the running bootloader
.globl start
start:
.code16                                             # Assemble for 16-bit mode
    cli                                             # Disable interrupts
    cld                                             # String operations increment

    # Set up the important data segment registers (DS, ES, SS).
    xorw %ax, %ax                                   # Segment number zero
    movw %ax, %ds                                   # -> Data Segment
    movw %ax, %es                                   # -> Extra Segment
    movw %ax, %ss                                   # -> Stack Segment

    # Enable A20:
    #  For backwards compatibility with the earliest PCs, physical
    #  address line 20 is tied low, so that addresses higher than
    #  1MB wrap around to zero by default. This code undoes this.
--------------------------------------------------------
A20 开启方法是 将 0x64 端口读入一个字节 到 al中 然后 testb 即做一个 and 运算 只不过不保存结果 判断一下 0x64端口的第二位是否为0 即 8042 键盘缓冲区是否为空 若不为空 则循环 直至为空
后 将 0xdl(写入数据到8042的p2端口) 写入到 0x64端口中

后面的也很类似
还是判断 0x64端口的第二位是不是为0 不是就循环
然后把 0xdf(11011111) 写入到 0x60 设置了 P2的 A20位 即第一位为 1 开启 A20地址线
--------------------------------------------------------
seta20.1:
    inb $0x64, %al                                  # Wait for not busy(8042 input buffer empty).
    testb $0x2, %al
    jnz seta20.1

    movb $0xd1, %al                                 # 0xd1 -> port 0x64
    outb %al, $0x64                                 # 0xd1 means: write data to 8042's P2 port

seta20.2:
    inb $0x64, %al                                  # Wait for not busy(8042 input buffer empty).
    testb $0x2, %al
    jnz seta20.2

    movb $0xdf, %al                                 # 0xdf -> port 0x60
    outb %al, $0x60                                 # 0xdf = 11011111, means set P2's A20 bit(the 1 bit) to 1

    # Switch from real to protected mode, using a bootstrap GDT
    # and segment translation that makes virtual addresses
    # identical to physical addresses, so that the
    # effective memory map does not change during the switch.
--------------------------------------------------------
加载 GDT 全局描述符表
打开 保护模式 需要将 cr0 控制寄存器的 第0位 PE位 置1
--------------------------------------------------------
    lgdt gdtdesc
    movl %cr0, %eax
    orl $CR0_PE_ON, %eax
    movl %eax, %cr0

    # Jump to next instruction, but in 32-bit code segment.
    # Switches processor into 32-bit mode.
--------------------------------------------------------
刷新流水线 进入 32位模式
将 PROT_MODE_CSEG = 0x8 此时 指向的是 GDT 中的第一个段描述符 加载到 CS 后 protcseg 加载到 IP
--------------------------------------------------------
    ljmp $PROT_MODE_CSEG, $protcseg

.code32                                             # Assemble for 32-bit mode
protcseg:
    # Set up the protected-mode data segment registers
    movw $PROT_MODE_DSEG, %ax                       # Our data segment selector
    movw %ax, %ds                                   # -> DS: Data Segment
    movw %ax, %es                                   # -> ES: Extra Segment
    movw %ax, %fs                                   # -> FS
    movw %ax, %gs                                   # -> GS
    movw %ax, %ss                                   # -> SS: Stack Segment

    # Set up the stack pointer and call into C. The stack region is from 0--start(0x7c00)
    movl $0x0, %ebp
    movl $start, %esp
    call bootmain

    # If bootmain returns (it shouldn't), loop.
spin:
    jmp spin
--------------------------------------------------------
GDT 构建一个代码段描述符 和 一个数据段描述符 使用的平坦模型
--------------------------------------------------------
# Bootstrap GDT
.p2align 2                                          # force 4 byte alignment
gdt:
第0个描述符项不可用
    SEG_NULLASM                                     # null seg
    SEG_ASM(STA_X|STA_R, 0x0, 0xffffffff)           # code seg for bootloader and kernel
    SEG_ASM(STA_W, 0x0, 0xffffffff)                 # data seg for bootloader and kernel

gdtdesc:
    .word 0x17                                      # sizeof(gdt) - 1
    .long gdt                                       # address gdt
```

* 为何开启A20，以及如何开启A20

```
实模式下内存访问采取的 段基址:段内偏移地址 的形式 段基址要左移4位再加上段内偏移地址来访问 实模式下寄存器都是16位的 如果段基址和段内便宜地址都为16位的最大值 0xFFFF:0xFFFF 即 0x10FFEF 当实模式下的地址总线为20位 最大寻址空间为 2的20次方= 1M 的内存 超出了 1M的内存 若不打开 A20地址线 CPU将采用 8086/8088 的地址回绕
```

* 如何初始化GDT表

```
先提前创建好 GDT 里面的 代码段选择子 数据段选择子 然后 通过 调用 lgdt 将 GDT的界限和内存起始地址存入 GDTR 寄存器中
```

* 如何使能和进入保护模式

```
将 cr0 控制寄存器的 第0位 PE位 置1
同时 使用长跳转 刷新流水线 进入 32位模式
```

### 练习4：分析bootloader加载ELF格式的OS的过程
通过阅读bootmain.c，了解bootloader如何加载ELF文件。通过分析源代码和通过qemu来运行并调试bootloader&OS，

```c
#define SECTSIZE        512
#define ELFHDR          ((struct elfhdr *)0x10000)      // scratch space

/* waitdisk - wait for disk ready */
检查 0x1F7 端口 的 第7位为0则硬盘不忙
static void waitdisk(void) {
    while ((inb(0x1F7) & 0xC0) != 0x40)
        /* do nothing */;
}

/* readsect - read a single sector at @secno into @dst */
static void readsect(void *dst, uint32_t secno) {
    // wait for disk to be ready
    waitdisk();
--------------------------------------------------------
0x1F2 写入扇区数
0x1F3 LBA 0~7
0x1F4 LBA 8~15
0x1F5 LBA 16~23
0x1F6 LBA 7~4位为1110 表示LBA模式 24~27 
0x1F7 0x20 读命令
一次从 0x1F0 读入 2个字 4个字节 读入512字节 需要 128次
--------------------------------------------------------
    outb(0x1F2, 1);                         // count = 1
    outb(0x1F3, secno & 0xFF);
    outb(0x1F4, (secno >> 8) & 0xFF);
    outb(0x1F5, (secno >> 16) & 0xFF);
    outb(0x1F6, ((secno >> 24) & 0xF) | 0xE0);
    outb(0x1F7, 0x20);                      // cmd 0x20 - read sectors

    // wait for disk to be ready
    waitdisk();

    // read a sector
    insl(0x1F0, dst, SECTSIZE / 4);
}

/* *
 * readseg - read @count bytes at @offset from kernel into virtual address @va,
 * might copy more than asked.
 * */
 包装一下 可以读取任意长度的内容 
static void readseg(uintptr_t va, uint32_t count, uint32_t offset) {
    uintptr_t end_va = va + count;

    // round down to sector boundary
    va -= offset % SECTSIZE;

    // translate from bytes to sectors; kernel starts at sector 1
    uint32_t secno = (offset / SECTSIZE) + 1;

    // If this is too slow, we could read lots of sectors at a time.
    // We'd write more to memory than asked, but it doesn't matter --
    // we load in increasing order.
    for (; va < end_va; va += SECTSIZE, secno ++) {
        readsect((void *)va, secno);
    }
}

/* bootmain - the entry of bootloader */
void bootmain(void) {
    // read the 1st page off disk
这里读入了 512 * 8 个字节 ELF头
    readseg((uintptr_t)ELFHDR, SECTSIZE * 8, 0);

    // is this a valid ELF?
根据读进来的文件的头部 魔数 判断是否为合法 ELF文件
    if (ELFHDR->e_magic != ELF_MAGIC) {
        goto bad;
    }

    struct proghdr *ph, *eph;

    // load each program segment (ignores ph flags)
读取每个代码段 到指定的地方
    ph = (struct proghdr *)((uintptr_t)ELFHDR + ELFHDR->e_phoff);
    eph = ph + ELFHDR->e_phnum;
    for (; ph < eph; ph ++) {
        readseg(ph->p_va & 0xFFFFFF, ph->p_memsz, ph->p_offset);
    }

    // call the entry point from the ELF header
    // note: does not return
进入内核
    ((void (*)(void))(ELFHDR->e_entry & 0xFFFFFF))();

bad:
真实硬件中 并不会有设备连接到 0x8A00 端口 故相当于啥也没做
    outw(0x8A00, 0x8A00);
    outw(0x8A00, 0x8E00);

    /* do nothing */
    while (1);
}
```

* bootloader如何读取硬盘扇区的？
* bootloader是如何加载ELF格式的OS？
首先 bootloader 调用 bootmain 函数 然后读取第一个扇区的内容 到 0x10000 地址处 读取硬盘扇区的过程 
0x1F2 写入扇区数
0x1F3 LBA 0~7
0x1F4 LBA 8~15
0x1F5 LBA 16~23
0x1F6 LBA 7~4位为1110 表示LBA模式 24~27 
0x1F7 0x20 读命令
一次从 0x1F0 读入 2个字 4个字节 读入512字节 需要 128次
然后 判断 他的魔数是否为 ELF文件 若不是 则走向死循环 若是 则读 ELF 文件的程序段 到 该段的起始虚拟地址中去

### 练习5：实现函数调用堆栈跟踪函数
我们需要在lab1中完成kdebug.c中函数print_stackframe的实现，可以通过函数print_stackframe来跟踪函数调用堆栈中记录的返回地址。在如果能够正确实现此函数，可在lab1中执行 “make qemu”后，在qemu模拟器中得到类似如下的输出

```c
void print_stackframe(void) {
    uint32_t ebp = read_ebp(), eip = read_eip();
    int i, j;
    for (i = 0; ebp != 0 && i < STACKFRAME_DEPTH; i++) {
        cprintf("ebp:0x%08x eip:0x%08x args:", ebp, eip);
        uint32_t *args = (uint32_t*)ebp + 2;
        for (j = 0; j < 4; j ++ ) {
            cprintf("0x%08x ", args[j]);
        }
        cprintf("\n");
        print_debuginfo(eip - 1);
        eip = ((uint32_t*)ebp)[1];
取得 调用本函数的函数的返回地址
        ebp = ((uint32_t*)ebp)[0];
取得 调用本函数的 之前的 ebp 地址
    }
}
最后一行输出的 ebp为 0x00007bf8 但是 bootloader 起始地址是 0x7c00 说明 压入了 两个东西 其中一个是 返回地址 另一个是 ebp 最后将 esp 赋给 ebp
```

![](/images/stack.png)
esp 栈顶指针 
ebp 栈底指针 
eip 寄存器存放的CPU下一条指令的地址
首先读取 ebp 和 eip 的值 然后 在ebp的地址上 + 2 就是第一个参数的位置

### 练习6：完善中断初始化和处理
请完成编码工作和回答如下问题：
1. 中断描述符表（也可简称为保护模式下的中断向量表）中一个表项占多少字节？其中哪几位代表中断处理代码的入口？

![](/images/trapgate.png)
```c
/* Gate descriptors for interrupts and traps */
struct gatedesc {
    unsigned gd_off_15_0 : 16;        // low 16 bits of offset in segment
    unsigned gd_ss : 16;            // segment selector
    unsigned gd_args : 5;            // # args, 0 for interrupt/trap gates
    unsigned gd_rsv1 : 3;            // reserved(should be zero I guess)
    unsigned gd_type : 4;            // type(STS_{TG,IG32,TG32})
    unsigned gd_s : 1;                // must be 0 (system)
    unsigned gd_dpl : 2;            // descriptor(meaning new) privilege level
    unsigned gd_p : 1;                // Present
    unsigned gd_off_31_16 : 16;        // high bits of offset in segment
};
8 个字节  0~15 + 48~63 组成段偏移 + 16~31 组成段描述符选择子 通过段描述符选择子 和 段偏移 找到 中断程序的入口
```

2. 请编程完善kern/trap/trap.c中对中断向量表进行初始化的函数idt_init。在idt_init函数中，依次对所有中断入口进行初始化。使用mmu.h中的SETGATE宏，填充idt数组内容。每个中断的入口由tools/vectors.c生成，使用trap.c中声明的vectors数组即可。

```c
extern uintptr_t __vectors[];
void idt_init(void) {
    int i;
    for (i = 0; i < sizeof(idt) / sizeof(struct gatedesc); i++) {
        SETGATE(idt[i], 0, GD_KTEXT, __vectors[i], DPL_KERNEL);
    }
	用于系统调用 专门给用户使用的
	SETGATE(idt[T_SWITCH_TOK], 0, GD_KTEXT, __vectors[T_SWITCH_TOK], DPL_USER);
	将 中断向量表加载到 ldtr 寄存器中
    lidt(&idt_pd);
}
```

3. 请编程完善trap.c中的中断处理函数trap，在对时钟中断进行处理的部分填写trap函数中处理时钟中断的部分，使操作系统每遇到100次时钟中断后，调用print_ticks子程序，向屏幕上打印一行文字”100 ticks”。

```c
kern/trap/trap.c 138:
    switch (tf->tf_trapno) {
    case IRQ_OFFSET + IRQ_TIMER:
        if (++ticks % TICK_NUM == 0) {
            print_ticks();
        }
        break;
```

![](/images/lab1.png)

### 扩展练习 
#### 扩展练习 Challenge 1
扩展proj4,增加syscall功能，即增加一用户态函数（可执行一特定系统调用：获得时钟计数值），当内核初始完毕后，可从内核态返回到用户态的函数，而用户态的函数又通过系统调用得到内核态的服务。需写出详细的设计和分析报告。完成出色的可获得适当加分。


```c
kern/init/init.c
static void lab1_switch_to_user(void) {
--------------------------------------------------------
	"sub $0x8, %%esp \n" 
	让 SS 和 ESP 这两个寄存器 有机会 POP 出时 更新 SS 和 ESP
	因为 从内核态进入中断 它的特权级没有改变 是不会 push 进 SS 和 ESP的 但是我们又需要通过 POP SS 和 ESP 去修改它们
	进入 T_SWITCH_TOU(120) 中断
	将原来的栈顶指针还给esp栈底指针
--------------------------------------------------------
	asm volatile (
	    "sub $0x8, %%esp \n"
	    "int %0 \n"
	    "movl %%ebp, %%esp"
	    : 
	    : "i"(T_SWITCH_TOU)
	);
}

static void lab1_switch_to_kernel(void) {
--------------------------------------------------------
	进入 T_SWITCH_TOK(121) 中断
	将原来的栈顶指针还给esp栈底指针
--------------------------------------------------------
	asm volatile (
	    "int %0 \n"
	    "movl %%ebp, %%esp \n"
	    : 
	    : "i"(T_SWITCH_TOK)
	);
}
```

```c
kern/trap/trap.c :
static void trap_dispatch(struct trapframe *tf)
通过"改造"一个中断 来进入我们想进入的用户态或者内核态
    case T_SWITCH_TOU:
        if (tf->tf_cs != USER_CS) {
            switchk2u = *tf;
            switchk2u.tf_cs = USER_CS;
            switchk2u.tf_ds = switchk2u.tf_es = switchk2u.tf_ss = USER_DS;
            switchk2u.tf_eflags |= FL_IOPL_MASK; // IOPL 改为 0
            switchk2u.tf_esp = (uint32_t)tf + sizeof(struct trapframe) - 8; // tf->esp的位置
            // iret 回到用户栈
            *((uint32_t *)tf - 1) = (uint32_t)&switchk2u;
        }
		break;
    case T_SWITCH_TOK:
        if (tf->tf_cs != KERNEL_CS) {
            tf->tf_cs = KERNEL_CS;
            tf->tf_ds = tf->tf_es = KERNEL_DS;
            tf->tf_eflags &= ~FL_IOPL_MASK;
            switchu2k = (struct trapframe *)(tf->tf_esp - (sizeof(struct trapframe) - 8));
            memmove(switchu2k, tf, sizeof(struct trapframe) - 8);
            *((uint32_t *)tf - 1) = (uint32_t)switchu2k;
        }
        break;
```

根据这张图 可以看出 内核态和用户态的转换 首先是留下 SS 和 ESP 的位置 然后 调用中断 改中断栈里面的内容 最后退出中断的时候 跳到内核态中 最后将 ebp 赋给 esp 修复 esp 的位置
![](/images/pcb.png)

#### 扩展练习 Challenge 2
用键盘实现用户模式内核模式切换。具体目标是：“键盘输入3时切换到用户模式，键盘输入0时切换到内核模式”。 基本思路是借鉴软中断(syscall功能)的代码，并且把trap.c中软中断处理的设置语句拿过来。

```c
kern/trap/trap.c
static void switch_to_user() {
	asm volatile (
	    "sub $0x8, %%esp \n"
	    "int %0 \n"
	    "movl %%ebp, %%esp"
	    : 
	    : "i"(T_SWITCH_TOU)
	);
}
static void switch_to_kernel() {
	asm volatile (
	    "int %0 \n"
	    "movl %%ebp, %%esp \n"
	    : 
	    : "i"(T_SWITCH_TOK)
	);
}

    case IRQ_OFFSET + IRQ_KBD:
        c = cons_getc();
        if (c == '3') {
            switch_to_user();
            print_trapframe(tf);
        } else if (c == '0') {
            switch_to_kernel();
            print_trapframe(tf);
        }
        cprintf("kbd [%03d] %c\n", c, c);
        break;
```

按键的中断在 IRQ_KBD 处