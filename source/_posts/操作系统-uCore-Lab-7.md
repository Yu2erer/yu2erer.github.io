---
title: 操作系统 uCore Lab 7
categories: 操作系统
date: 2018-12-25 11:32:20
keywords: 操作系统, ucore, lab 7, lab7, 信号量, 同步互斥, 管程, 哲学家就餐
tags: [操作系统, uCore, Lab, 信号量, 同步互斥, 管程, 哲学家就餐, 并发, 临界区]
---
### 练习0：填写已有实验
请把你做的实验代码填入本实验中代码中有“LAB1”/“LAB2”/“LAB3”/“LAB4”/“LAB5”/"LAB6"的注释相应部分。并确保编译通过。注意：为了能够正确执行lab7的测试应用程序，可能需对已完成的实验1/2/3/4/5/6的代码进行进一步改进。

```c
这次又是要修改 trap.c
vmm.c trap.c default_pmm.c pmm.c proc.c swap_fifo.c
trap.c:
static void trap_dispatch(struct trapframe *tf) {
    ++ticks;
    /* 注销掉下面这一句 因为这一句被包含在了 run_timer_list()
        run_timer_list() 在之前的基础上 加入了对 timer 的支持 */
    // sched_class_proc_tick(current);
    run_timer_list();
}
```

<!-- more -->

### 练习1: 理解内核级信号量的实现和基于内核级信号量的哲学家就餐问题
请在实验报告中给出内核级信号量的设计描述，并说其大致执行流流程。

```c
// 先是定义了一个信号量的数据结构
typedef struct {
    int value; // 计数值 用于 PV操作
    wait_queue_t wait_queue; // 进程等待队列
} semaphore_t;

// 用于等待队列 存放了当前等待的线程PCB 和 唤醒原因 和 等待队列 和 用于还原结构体的等待队列标志
typedef struct {
    struct proc_struct *proc;
    uint32_t wakeup_flags;
    wait_queue_t *wait_queue;
    list_entry_t wait_link;
} wait_t;

// 初始化信号量中的计数值和等待队列
void sem_init(semaphore_t *sem, int value) {
    sem->value = value;
    wait_queue_init(&(sem->wait_queue));
}

/*
    P操作 要关闭中断并保存 eflag 寄存器的值 避免共享变量被多个线程同时修改
    判断 计数值是否大于 0 若大于 0 说明此时没有其他线程访问临界区 则直接将计数值 减 1 并 返回
    若 计数值小于 0 则 已经有其他线程访问临界区了 就将当前线程放入等待队列中 并调用调度函数
    等到进程被唤醒 再将当前进程从等待队列中 取出并删去 最后判断等待的线程是因为什么原因被唤醒
*/
static __noinline uint32_t __down(semaphore_t *sem, uint32_t wait_state) {
    bool intr_flag;
    local_intr_save(intr_flag);
    if (sem->value > 0) {
        sem->value --;
        local_intr_restore(intr_flag);
        return 0;
    }
    wait_t __wait, *wait = &__wait;
    wait_current_set(&(sem->wait_queue), wait, wait_state);
    local_intr_restore(intr_flag);

    schedule();

    local_intr_save(intr_flag);
    wait_current_del(&(sem->wait_queue), wait);
    local_intr_restore(intr_flag);

    if (wait->wakeup_flags != wait_state) {
        return wait->wakeup_flags;
    }
    return 0;
}

/*
    V操作 也要关闭中断 并保存 eflag 寄存器的值 防止共享变量同时被多个线程访问或修改
    先判断等待队列是否为空 若为空 则将计数值 加 1 并返回
    若不为空 则说明还有线程在等待 此时取出等待队列的第一个线程 并将其 唤醒 唤醒的过程中 
    将其从等待队列中删除
*/
static __noinline void __up(semaphore_t *sem, uint32_t wait_state) {
    bool intr_flag;
    local_intr_save(intr_flag);
    {
        wait_t *wait;
        if ((wait = wait_queue_first(&(sem->wait_queue))) == NULL) {
            sem->value ++;
        }
        else {
            assert(wait->proc->wait_state == wait_state);
            wakeup_wait(&(sem->wait_queue), wait, wait_state, 1);
        }
    }
    local_intr_restore(intr_flag);
}
```

请在实验报告中给出给用户态进程/线程提供信号量机制的设计方案，并比较说明给内核级提供信号量机制的异同。

```
可以将内核级信号量 包装成系统调用 供用户进程使用 但不能直接使用信号量结构体的指针作为参数
不能持有或访问内核的指针 可以在每个进程的PCB里维护一个信号量指针数组 供用户态进程及其进程下的多线程使用
不同的地方在于 需要通过系统调用进入 内核态 进行操作
```

### 练习2: 完成内核级条件变量和基于内核级条件变量的哲学家就餐问题
首先掌握管程机制，然后基于信号量实现完成条件变量实现，然后用管程机制实现哲学家就餐问题的解决方案（基于条件变量）。

请在实验报告中给出内核级条件变量的设计描述，并说其大致执行流流程。

首先可以确定 这里实现的是 Hoare管程 因为 等待条件变量的进程的优先级更高
```c
// 管程数据结构
typedef struct monitor{
    semaphore_t mutex; // 二值信号量 用来互斥访问管程
    semaphore_t next; // 用于 条件同步 用于发出signal操作的进程等条件为真之前进入睡眠
    int next_count; // 记录睡在 signal 操作的进程数
    condvar_t *cv; // 条件变量
} monitor_t;

// 条件变量数据结构
typedef struct condvar{
    semaphore_t sem; // 用于条件同步 用于发出wait操作的进程等待条件为真之前进入睡眠
    int count; // 记录睡在 wait 操作的进程数(等待条件变量成真)
    monitor_t * owner; // 所属管程
} condvar_t;

// 初始化管程
void monitor_init (monitor_t * mtp, size_t num_cv) {
    int i;
    assert(num_cv>0);
    mtp->next_count = 0; // 睡在signal进程数 初始化为0
    mtp->cv = NULL;
    sem_init(&(mtp->mutex), 1); // 二值信号量 保护管程 使进程访问管程操作为互斥的
    sem_init(&(mtp->next), 0); // 条件同步信号量
    mtp->cv =(condvar_t *) kmalloc(sizeof(condvar_t)*num_cv); // 获取一块内核空间 放置条件变量
    assert(mtp->cv!=NULL);
    for(i=0; i<num_cv; i++){
        mtp->cv[i].count=0;
        sem_init(&(mtp->cv[i].sem),0);
        mtp->cv[i].owner=mtp;
    }
}

// 管程wait操作
/*
先将 因为条件不成立而睡眠的进程计数加1
分支1. 当 管程的 next_count 大于 0 说明 有进程睡在了 signal 操作上 我们将其唤醒
分支2. 当 管程的 next_count 小于 0 说明 当前没有进程睡在 signal操作数 只需要释放互斥体
然后 再将 自身阻塞 等待 条件变量的条件为真 被唤醒后 将条件不成立而睡眠的进程计数减1 因为现在成立了
*/
void cond_wait (condvar_t *cvp) {
    cprintf("cond_wait begin:  cvp %x, cvp->count %d, cvp->owner->next_count %d\n", cvp, cvp->count, cvp->owner->next_count);

    cvp->count++;
    if (cvp->owner->next_count > 0) {
        up(&(cvp->owner->next));
    } else {
        up(&(cvp->owner->mutex));
    }

    down(&(cvp->sem)); // 阻塞自己 等待条件成真
    cvp->count--;

    cprintf("cond_wait end:  cvp %x, cvp->count %d, cvp->owner->next_count %d\n", cvp, cvp->count, cvp->owner->next_count);
}

// 管程signal操作
/*
分支1. 因为条件不成立而睡眠的进程计数小于等于0 时 说明 没有进程需要唤醒 则直接返回
分支2. 因为条件不成立而睡眠的进程计数大于0 说明有进程需要唤醒 就将其唤醒
同时设置 条件变量所属管程的 next_count 加1 以用来告诉 wait操作 有进程睡在了 signal操作上
然后自己将自己阻塞 等待条件同步 被唤醒 被唤醒后 睡在 signal 操作上的进程应该减少 故 next_count 应减 1
*/
void cond_signal (condvar_t *cvp) {
    cprintf("cond_signal begin: cvp %x, cvp->count %d, cvp->owner->next_count %d\n", cvp, cvp->count, cvp->owner->next_count);  

    if (cvp->count > 0) { // 若存在因为当前条件变量而等待的进程的话
        up(&(cvp->sem));
        cvp->owner->next_count++; // 所属管程的 next 计数 加 1 表示当前进程会被等待者堵塞
        down(&(cvp->owner->next)); // 阻塞自己 等待条件同步
        cvp->owner->next_count--;
    }
    cprintf("cond_signal end: cvp %x, cvp->count %d, cvp->owner->next_count %d\n", cvp, cvp->count, cvp->owner->next_count);
}
```

![lab7_monitor](/images/lab7_monitor.png)

```c
check_sync.c:
// 测试编号为i的哲学家是否能获得刀叉 如果能获得 则将状态改为正在吃 并且 尝试唤醒 因为wait操作睡眠的进程
// cond_signal 还会阻塞自己 等被唤醒的进程唤醒自己
void phi_test_condvar (i) { 
    if(state_condvar[i]==HUNGRY&&state_condvar[LEFT]!=EATING
            &&state_condvar[RIGHT]!=EATING) {
        cprintf("phi_test_condvar: state_condvar[%d] will eating\n",i);
        state_condvar[i] = EATING ;
        cprintf("phi_test_condvar: signal self_cv[%d] \n",i);
        cond_signal(&mtp->cv[i]) ;
    }
}
// 拿刀叉
void phi_take_forks_condvar(int i) {
    down(&(mtp->mutex));    // P操作进入临界区
    state_condvar[i] = HUNGRY; // 饥饿状态 准备进食
    phi_test_condvar(i); // 测试当前是否能获得刀叉 
    while (state_condvar[i] != EATING) {
        cond_wait(&mtp->cv[i]); // 若不能拿 则阻塞自己 等其它进程唤醒
    }
    if(mtp->next_count>0)
        up(&(mtp->next));
    else
        up(&(mtp->mutex));
}

// 放刀叉
void phi_put_forks_condvar(int i) {
    down(&(mtp->mutex)); // P操作进入临界区
    state_condvar[i] = THINKING; // 思考状态
    phi_test_condvar(LEFT); // 试试左右两边能否获得刀叉
    phi_test_condvar(RIGHT);
    if(mtp->next_count>0) // 有哲学家睡在 signal操作 则将其唤醒
        up(&(mtp->next));
    else
        up(&(mtp->mutex)); // 离开临界区
}
```

```
哲学家->试试拿刀叉->能拿->signal 唤醒被wait阻塞的进程->阻塞自己
                  |             |                  A
                  |             V                  |
                  ->不能拿->wait阻塞自己             |
                                                   |
哲学家->放刀叉->让左右两边试试拿刀叉->有哲学家睡在signal 唤醒他
```

请在实验报告中给出给用户态进程/线程提供条件变量机制的设计方案，并比较说明给内核级提供条件变量机制的异同。

```
依然是通过提供系统调用
```


请在实验报告中回答：能否不用基于信号量机制来完成条件变量？如果不能，请给出理由，如果能，请给出设计说明和具体实现。

```
可以 可以用 自旋锁
```

实验完成结果
![lab7_finish](/images/lab7_finish.png)