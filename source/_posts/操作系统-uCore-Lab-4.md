---
title: 操作系统 uCore Lab 4
categories: 操作系统
date: 2018-12-10 13:12:20
keywords: 操作系统, ucore, lab 4, 进程控制块, pcb
tags: [操作系统, uCore, Lab, 进程, 线程]
---
### 练习0：填写已有实验
本实验依赖实验1/2/3。请把你做的实验1/2/3的代码填入本实验中代码中有“LAB1”,“LAB2”,“LAB3”的注释相应部分。
```
vmm.c trap.c default_pmm.c pmm.c swap_fifo.c 这几个补上去就完事了
```

### 练习1：分配并初始化一个进程控制块
alloc_proc函数（位于kern/process/proc.c中）负责分配并返回一个新的struct proc_struct结构，用于存储新建立的内核线程的管理信息。ucore需要对这个结构进行最基本的初始化，你需要完成这个初始化过程。
> 【提示】在alloc_proc函数的实现中，需要初始化的proc_struct结构中的成员变量至少包括：state/pid/runs/kstack/need_resched/parent/mm/context/tf/cr3/flags/name。

<!-- more -->

```c
很简单 按照进程控制块的内容填写就行了
static struct proc_struct *alloc_proc(void) {
    struct proc_struct *proc = kmalloc(sizeof(struct proc_struct));
    if (proc != NULL) {
        proc->state = PROC_UNINIT; // 进程状态
        proc->pid = -1; // 进程ID
        proc->runs = 0; // 进程时间片
        proc->kstack = 0; // 进程所使用的内存栈地址
        proc->need_resched = NULL; // 进程是否能被调度
        proc->parent = NULL; // 父进程
        proc->mm = NULL; // 进程所用的虚拟内存
        memset(&(proc->context), 0, sizeof(struct context)); // 进程的上下文
        proc->tf = NULL; // 中断帧指针
        proc->cr3 = boot_cr3; // 页目录表地址 设为 内核页目录表基址
        proc->flags = 0; // 标志位
        memset(&(proc->name), 0, PROC_NAME_LEN); // 进程名
    }
    return proc;
}
```
请在实验报告中简要说明你的设计实现过程。请回答如下问题：
* 请说明proc_struct中struct context context和struct trapframe *tf成员变量含义和在本实验中的作用是啥？（提示通过看代码和编程调试可以判断出来）

```c
context 中 保存着各种寄存器的内容 这是为了保存进程上下文 为进程调度做准备
struct context {
    uint32_t eip;
    uint32_t esp;
    uint32_t ebx;
    uint32_t ecx;
    uint32_t edx;
    uint32_t esi;
    uint32_t edi;
    uint32_t ebp;
};
```
```c
trapframe 保存着 用于特权级转换的 栈 esp 寄存器

当进程发生特权级转换的时候 中断帧记录了进入中断时任务的上下文 当退出中断时 恢复环境
struct trapframe {
    struct pushregs {
        uint32_t reg_edi;
        uint32_t reg_esi;
        uint32_t reg_ebp;
        uint32_t reg_oesp;          /* Useless */
        uint32_t reg_ebx;
        uint32_t reg_edx;
        uint32_t reg_ecx;
        uint32_t reg_eax;
    };
    uint16_t tf_gs;
    uint16_t tf_padding0;
    uint16_t tf_fs;
    uint16_t tf_padding1;
    uint16_t tf_es;
    uint16_t tf_padding2;
    uint16_t tf_ds;
    uint16_t tf_padding3;
    uint32_t tf_trapno;
    /* below here defined by x86 hardware */
    uint32_t tf_err;
    uintptr_t tf_eip;
    uint16_t tf_cs;
    uint16_t tf_padding4;
    uint32_t tf_eflags;
    /* below here only when crossing rings, such as from user to kernel */
    uintptr_t tf_esp;
    uint16_t tf_ss;
    uint16_t tf_padding5;
} __attribute__((packed));
```

![pcb](/images/pcb.png)

### 练习2：为新创建的内核线程分配资源
创建一个内核线程需要分配和设置好很多资源。kernel_thread函数通过调用do_fork函数完成具体内核线程的创建工作。do_kernel函数会调用alloc_proc函数来分配并初始化一个进程控制块，但alloc_proc只是找到了一小块内存用以记录进程的必要信息，并没有实际分配这些资源。ucore一般通过do_fork实际创建新的内核线程。do_fork的作用是，创建当前内核线程的一个副本，它们的执行上下文、代码、数据都一样，但是存储位置不同。在这个过程中，需要给新内核线程分配资源，并且复制原进程的状态。你需要完成在kern/process/proc.c中的do_fork函数中的处理过程。它的大致执行步骤包括：
* 调用alloc_proc，首先获得一块用户信息块。
* 为进程分配一个内核栈。
* 复制原进程的内存管理信息到新进程（但内核线程不必做此事）
* 复制原进程上下文到新进程
* 将新进程添加到进程列表
* 唤醒新进程
* 返回新进程号

```c
跟着注释做就是了
先是创建一个进程控制块 然后设置进程控制块
要特别注意的是 设置 进程/线程 的 PID 调用的 get_pid() 方法 和 添加进程/线程到链表中时 要将中断暂时关闭
避免执行的中途被再次中断
int do_fork(uint32_t clone_flags, uintptr_t stack, struct trapframe *tf) {
    if ((proc = alloc_proc()) == NULL) {
        goto fork_out;
    }
    proc->parent = current;
    if (setup_kstack(proc) != 0) {
        goto bad_fork_cleanup_proc;
    }
    if (copy_mm(clone_flags, proc) != 0) {
        goto bad_fork_cleanup_kstack;
    }
    copy_thread(proc, stack, tf);
    bool intr_flag;
    local_intr_save(intr_flag);
    {
        proc->pid = get_pid();
        hash_proc(proc);
        nr_process++;
        list_add(&proc_list, &(proc->list_link));
    }
    local_intr_restore(intr_flag);

    wakeup_proc(proc);
    ret = proc->pid;
}
```

请在实验报告中简要说明你的设计实现过程。请回答如下问题：
* 请说明ucore是否做到给每个新fork的线程一个唯一的id？请说明你的分析和理由。

```
可以保证 每个fork的线程 唯一ID
调用的 get_pid() 函数 每次都从 进程控制块链表中 找到合适的ID
```

### 练习3：阅读代码，理解 proc_run 函数和它调用的函数如何完成进程切换的
请在实验报告中简要说明你对proc_run函数的分析。并回答如下问题：

```c
当前进程/线程 切换到 proc 这个进程/线程
void proc_run(struct proc_struct *proc) {
    if (proc != current) {
        bool intr_flag;
        struct proc_struct *prev = current, *next = proc;
        local_intr_save(intr_flag); // 关闭中断
        {
            current = proc; // 将当前进程换为 要切换到的进程
            // 设置任务状态段tss中的特权级0下的 esp0 指针为 next 内核线程 的内核栈的栈顶
            load_esp0(next->kstack + KSTACKSIZE);
            lcr3(next->cr3); // 重新加载 cr3 寄存器(页目录表基址) 进行进程间的页表切换
            switch_to(&(prev->context), &(next->context)); // 调用 switch_to 进行上下文的保存与切换
        }
        local_intr_restore(intr_flag);
    }
}
```

* 在本实验的执行过程中，创建且运行了几个内核线程？

```
两个内核线程 一个为 idle_proc 为 第 0 个内核线程 完成内核中的初始化 然后调度执行其他进程或线程
另一个为 init_proc 本次实验的内核线程 只用来打印字符串
```

* 语句local_intr_save(intr_flag);....local_intr_restore(intr_flag);在这里有何作用?请说明理由

```
关闭中断 避免进程切换的中途 再被中断(其他进程再进行调度)
```

最后还是附上执行结果 可以去🍚了 好冷 这周怕是 2018年 广东最冷的一周了
![lab4_finish](/images/lab4_finish.png)

#### 讲讲 switch_to 切换进程
吃完饭回来了 顺便讲讲这个 switch_to 的汇编
```x86asm
struct context {
    uint32_t eip;
    uint32_t ebx;
    uint32_t ecx;
    uint32_t edx;
    uint32_t esi;
    uint32_t edi;
    uint32_t ebp;
};
switch_to 的作用是 保存当前进程的上下文 并且 恢复被调度上处理机的进程的上下文
.text
.globl switch_to
switch_to:                      # switch_to(from, to)

    调用 switch_to 后栈的情况  |     To    esp + 8 |
                             |   From   esp + 4  |
                             |  Ret Addr <- esp  |
    movl 4(%esp), %eax       此处要取的是 From 因此为 esp + 4
    popl 0(%eax)  pop 掉返回地址 存到 From 的 eip 中 From 的 context eip为栈底 故而 context 的 eip 当返回地址
    movl %esp, 4(%eax)         这之后都只是将寄存器的内容 移到 context 相应的地址而已
    movl %ebx, 8(%eax)
    movl %ecx, 12(%eax)
    movl %edx, 16(%eax)
    movl %esi, 20(%eax)
    movl %edi, 24(%eax)
    movl %ebp, 28(%eax)

    此时的 栈的情况                                     |    To  esp + 4   |
    因为在上面已经将 返回地址 pop掉了 因此这里没有返回地址了  |   From <- esp    |
    movl 4(%esp), %eax          此处要取 To 的地址 因为 返回地址之前已经被 pop掉了 所以此时为 esp + 4
  
    movl 28(%eax), %ebp         这之后也没啥好说的 都是将 context 移到寄存器 恢复环境
    movl 24(%eax), %edi
    movl 20(%eax), %esi
    movl 16(%eax), %edx
    movl 12(%eax), %ecx
    movl 8(%eax), %ebx
    movl 4(%eax), %esp

    pushl 0(%eax)      eip 作返回地址 因为原先的 返回地址已经被pop掉了

    ret
```