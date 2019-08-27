---
title: 操作系统 uCore Lab 6
categories: 操作系统
date: 2018-12-22 10:12:20
keywords: 操作系统, ucore, lab 6, 调度, Stride, Round Robin, MLFQ, RR
tags: [操作系统, uCore, Lab, 调度]
---
### 练习0：填写已有实验
请把你做的实验2/3/4/5的代码填入本实验中代码中有“LAB1”/“LAB2”/“LAB3”/“LAB4”“LAB5”的注释相应部分。并确保编译通过。注意：为了能够正确执行lab6的测试应用程序，可能需对已完成的实验1/2/3/4/5的代码进行进一步改进。

```c
复制以下文件 其中 proc.c 和 trap.c 需要进行修正
vmm.c trap.c default_pmm.c pmm.c proc.c swap_fifo.c
proc.c:
static struct proc_struct *alloc_proc(void) {
    // 添加如下几行 初始化进程所属就绪队列 初始化就绪队列指针 初始化时间片
    proc->rq = NULL;
    list_init(&(proc->run_link));
    proc->time_slice = 0;
}
trap.c:
static void trap_dispatch(struct trapframe *tf) {
    // 在时钟中断下 添加以下几行 并去掉之前设置 进程需要调度标记
    // 这个标记现在已经被 调度程序所使用了 不再需要自己控制
    ++ticks;
    sched_class_proc_tick(current);
    // current->need_resched = 1;
}
```

<!-- more -->

### 练习1: 使用 Round Robin 调度算法
完成练习0后，建议大家比较一下（可用kdiff3等文件比较软件）个人完成的lab5和练习0完成后的刚修改的lab6之间的区别，分析了解lab6采用RR调度算法后的执行过程。执行make grade，大部分测试用例应该通过。但执行priority.c应该过不去。

请在实验报告中完成：
* 请理解并分析sched_calss中各个函数指针的用法，并接合Round Robin 调度算法描述ucore的调度执行过程

```c
// 初始化算法所需要的数据结构
static void RR_init(struct run_queue *rq) {
    list_init(&(rq->run_list));
    rq->proc_num = 0;
}
/* 进程入队 将进程加入就绪队列(不同的就绪队列的时间片不同 也就是说有不同优先级的就绪队列)
 在 RR调度中 
 当进程时间片为0 或 应某种情况被阻塞 则将其加入到就绪队列 并将其 时间片进行重置 */
static void RR_enqueue(struct run_queue *rq, struct proc_struct *proc) {
    assert(list_empty(&(proc->run_link)));
    list_add_before(&(rq->run_list), &(proc->run_link));
    if (proc->time_slice == 0 || proc->time_slice > rq->max_time_slice) {
        proc->time_slice = rq->max_time_slice;
    }
    proc->rq = rq;
    rq->proc_num ++;
}
// 进程出队 将进程从就绪队列中删去
static void RR_dequeue(struct run_queue *rq, struct proc_struct *proc) {
    assert(!list_empty(&(proc->run_link)) && proc->rq == rq);
    list_del_init(&(proc->run_link));
    rq->proc_num --;
}
/* 挑选出下一个进程 占用处理机去运行
   在 RR调度中 直接按照就绪队列的顺序轮询
    */
static struct proc_struct * RR_pick_next(struct run_queue *rq) {
    list_entry_t *le = list_next(&(rq->run_list));
    if (le != &(rq->run_list)) {
        return le2proc(le, run_link);
    }
    return NULL;
}
// 时钟中断时 调用此函数 在 RR调度中 每次调用都会减少当前进程时间片
static void RR_proc_tick(struct run_queue *rq, struct proc_struct *proc) {
    if (proc->time_slice > 0) {
        proc->time_slice --;
    }
    if (proc->time_slice == 0) {
        proc->need_resched = 1;
    }
}
```

Round Robin 调度执行过程
```
设置当前进程剩余时间片
每次时钟中断 都将当前进程剩余时间片 -1
直到 剩余时间片 为 0 当前进程的 need_resched 被置1 意为 需要被调度
中断服务例程 一发现当前进程需要被调度 就 调用 schedule() 将它调度
会将当前进程 放入就绪队列中 并将其时间片设为当前队列的最大时间片
接着调用 pick_next() 选择下一个需要换上处理机的进程 若选择成功 就让其 出就绪队列
若查找不到 则 内核线程 idle() 顶上 该进程会死循环 查找可被调度的进程
最后调用 proc_run() 进行进程切换
```

* 请在实验报告中简要说明如何设计实现"多级反馈队列调度算法"，给出概要设计，鼓励给出详细设计

```
Multilevel Feedback queues(MLFQ) 的思想
1. 时间片大小随优先级级别增加而增加
2. 进程在当前时间片没有完成 则降到下一优先级

init
初始化算法维护的数据结构

enqueue
若该进程的时间片为0 则不改变其优先级 并将其放入相应优先级的对垒
若该进程时间片不为0 说明 它不需要那么多的时间片 将其优先级降低一级 并将其放入相应优先级的队列中
最后设置它的时间片为其队列的最大时间片

dequeue
从相应优先级的队列中删去该进程

pick_next
使用某种调度算法 选择下一个要执行的进程的优先级 并从相应优先级的就绪队列中选出下一个换上处理机的进程

proc_tick
时钟中断所使用 每次时钟中断 减少当前进程的时间片 若为0 则 将进程标记为需要调度
```

### 练习2: 实现 Stride Scheduling 调度算法
首先需要换掉RR调度器的实现，即用default_sched_stride_c覆盖default_sched.c。然后根据此文件和后续文档对Stride度器的相关描述，完成Stride调度算法的实现。

请在实验报告中简要说明你的设计实现过程。

```c
proc.c:
static struct proc_struct *alloc_proc(void) {
    proc->rq = NULL;
    list_init(&(proc->run_link));
    proc->time_slice = 0;
    // 在 实验0 的基础上 再加下面三行 这是初始化 Stride 调度算法 所使用的
    // 斜堆实现的 Priority Queue
    proc->lab6_run_pool.parent = proc->lab6_run_pool.left = proc->lab6_run_pool.right = NULL;
    // 优先级 (和步进成反比)
    proc->lab6_priority = 0;
    // 步进值
    proc->lab6_stride = 0;
}
```

这里只实现了用 Priority Queue 作为 stride 调度算法所使用的数据结构
用 list 也是可以的 只不过查找 删除的时候 会随着进程数目的增加而呈现出线性关系
```c
// 就是 32位系统下 int 的最大值 2147483647
#define BIG_STRIDE (((uint32_t)-1) / 2)

static void stride_init(struct run_queue *rq) {
    list_init(&rq->run_list);
    rq->lab6_run_pool = NULL;
    rq->proc_num = 0;
}

static void stride_enqueue(struct run_queue *rq, struct proc_struct *proc) {
    rq->lab6_run_pool = skew_heap_insert(rq->lab6_run_pool, &(proc->lab6_run_pool), proc_stride_comp_f);
    if (proc->lab6_priority == 0) {
        proc->lab6_priority = 1;
    }
    if (proc->time_slice == 0 || proc->time_slice > rq->max_time_slice) {
       proc->time_slice = rq->max_time_slice;
    }
    proc->rq = rq;
    ++rq->proc_num;
}   


static void stride_dequeue(struct run_queue *rq, struct proc_struct *proc) {
    rq->lab6_run_pool = skew_heap_remove(rq->lab6_run_pool, &(proc->lab6_run_pool), proc_stride_comp_f);
    --rq->proc_num;
}

static struct proc_struct * stride_pick_next(struct run_queue *rq) {
    if (rq->lab6_run_pool == NULL) {
        return NULL;
    }
    // 斜堆的顶就是 stride 值最小的进程
    struct proc_struct *p = le2proc(rq->lab6_run_pool, lab6_run_pool);
    // 提前增加 stride 的值 因为在之后调度别的进程之前 一定会执行这么多
    p->lab6_stride += BIG_STRIDE / p->lab6_priority;
    return p;
}

static void stride_proc_tick(struct run_queue *rq, struct proc_struct *proc) {
    if (proc->time_slice == 0) {
        proc->need_resched = 1;
    } else {
        --proc->time_slice;
    }
}
```

#### BIG_STRIDE 的值是怎么来的?
Stride 调度算法 的思路是 每次找 stride步进值最小的进程

每个进程 每次执行完以后 都要在 stride步进 += pass步长
其中 步长 是和 优先级成反比的 因此 步长可以反映出进程的优先级

但是随着每次调度 步长不断增加 有可能会有溢出的风险

因此 需要设置一个步长的最大值 使得他们哪怕溢出 还是能够进行比较

在 uCore 中 BIG_STRIDE 的值是采用 无符号32位整数表示 而 stride 也是无符号32位整数
也就是说 最大值只能为 `(2^32 - 1)`

如果一个 进程的 stride 已经为 `(2^32 -1)` 时 那么再加上 pass步长 一定会溢出 然后又从0开始算
这样 整个调度算法的比较 就没有意义了

这说明 我们必须得约定一个 最大的步长 使得两个进程的步进值哪怕其中一个溢出 或者都溢出 还能够进行比较

首先 因为 步长 和 优先级成反比 可以得到下面一条
`pass = BIG_STRIDE / priority <= BIG_STRIDE`

进而得到
`pass_max <= BIG_STRIDE`

最大步长 - 最小步长 一定小于等于步长
`max_stride - min_stride <= pass_max`

所以得出
`max_stride - min_stride <= BIG_STRIDE`

前面说了 uCore 中 BIG_STRIDE 用的 无符号32位整数 最大值只能为 `(2^32 - 1)`
而 又因为是无符号的 因此 最小 只能为 0 而且我们需要把32位无符号整数进行比较 需要保证任意两个进程stride的差值在32位有符号数能够表示的范围之内 故 BIG_STRIDE 为 `(2^32 - 1) / 2`

最后还是实验结果

![lab6_finish](/images/lab6_finish.png)