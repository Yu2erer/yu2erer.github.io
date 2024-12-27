---
title: Linux网络编程 I/O多路复用
categories: Linux网络编程
date: 2020-08-23 13:14:20
keywords: Linux, 系统编程, 网络编程, I/O多路复用, epoll, select, poll
tags: [Linux, 系统编程, 网络编程, I/O多路复用, epoll, select, poll]
---
## 前言

本节主要是讲 网络编程中, 常用的I/O 多路复用. 全文大概分为以下几点.

1. 为什么需要I/O多路复用?
2. I/O多路复用的使用场景?
3. 为什么都是与非阻塞I/O进行搭配, 而不是与阻塞I/O进行搭配呢?
4. select 的 优缺点 及 内核实现
5. poll 的 优缺点 及 内核实现
6. epoll 的 优缺点 及 内核实现

<!-- more -->

## 为什么需要 I/O 多路复用?

首先 I/O 模型 最主要分为以下几种

- 阻塞I/O
- 非阻塞I/O
- I/O 复用
- 信号驱动I/O
- 异步I/O

在这里只谈 阻塞与非阻塞 I/O.

### 阻塞I/O

比如说 Socket send 一段数据给对端机器 如果TCP发送缓冲区不够大, 则会产生阻塞, 产生阻塞之后, 调度器会将CPU资源让给其他进程, 这样对于一个服务器进程来说实在是难以接受, 因此有没有什么办法, 让内核通知我们 缓冲区什么时候足够大了, 再通知我们, 我们这时候再去写入数据到TCP缓冲区呢?

这就引出了 I/O 多路复用, 它就是用来做这类事情, 只要你将描述符给到它们, 当可读或可写为你所关心的事件的时候, 它就会来通知你, 这时候去读就不会阻塞(注意不是一定, 原因会在下面)

### 非阻塞I/O

那非阻塞I/O send 的时候不就不会阻塞了吗? 为什么 非阻塞I/O 也要用 I/O多路复用呢? 其实原因很简单, 非阻塞I/O 你想你调用 send 的函数, 发送出去, 它是不阻塞的, 但是有可能TCP发送缓冲区不够大, 它虽然立即返回结果, 但有可能并没有发送成功, 这个时候你就要想, 我应该在什么时候再试试呢? 不知晓I/O多路复用的人 很可能写出以下 伪代码

```c
while (Socket::send(buf) != succ) {}
```

换句话说就是 不停地 while 循环 检测 TCP发送缓冲区是否足以成功发送了, 但是这种做法会引来一个新的问题 那就是, 服务端没办法做其他任何的事情, 它就一直在这傻傻的不停地问.

这时候 I/O多路复用再次出场了, 它通知你这时候可读或可写, 你再去读, 这样就不会一直处于 busy loop 中.

## I/O多路复用的使用场景?

其实从上面举的例子来看, 已经讲清楚了I/O多路复用的使用场景, 当你想要高效的知道一个文件描述符是否可读/可写的时候, 就可以采用I/O多路复用模型.

## 为什么都是与非阻塞I/O进行搭配, 而不是与阻塞I/O进行搭配呢?

在第一个问题中, 我分别描述了 I/O多路复用与非阻塞I/O和阻塞I/O的搭配使用, 但是有些基础的同学, 可能会想, 为什么我在网络上看到的都是说 I/O多路复用与非阻塞I/O进行搭配, 几乎没有说到和阻塞I/O进行搭配的?

首先假设 此时 阻塞I/O与I/O多路复用搭配使用, 内核通知到我们说 这个阻塞 I/O 可以读了, 我们就去读, 那这时候就有一个问题, 数据有多大, 我们要读多少次呢? 如果我们只读一次, 那效率又太低了, 如果我们读多次, 你怎么保证下一次读的时候, 一定不会阻塞呢? 要知道I/O多路复用只保证你当前读了一次不阻塞, 不代表读多次不阻塞, 如果阻塞了, I/O多路复用的机制就完全停住了, 因为程序一直阻塞在读中, 这就回退到了 阻塞I/O的版本.

还有一个问题就是说, 内核通知你去读, 但是有可能被其他线程读走了, 然后你并不知道, 再去读 阻塞了, 这就是惊群现象.

而与非阻塞I/O搭配, 没这么多烦恼, 反正我就一直读 读到返回 EWOULDBLOCK为止就是了, 反正不阻塞, 爱读多少读多少, 就算被别人拿走了, 我也不会阻塞.

可以看出 与非阻塞I/O进行搭配确实可以减轻我们不少的烦恼啊.

再举两个例子

accept() 阻塞版 与 I/O多路复用搭配, 内核通知我们可以 去建立一个连接, 但是如果服务器这时候很迟钝, 一直等到客户那边发送RST后才去连接, 这时候TCP会将客户的连接从队列中删除, 很明显 之后调用accept() 会发生阻塞.

connect() 阻塞版, 在调用之后 TCP完成三次握手前, 突然被中断了, 会直接返回 EINTR, 从中断服务例程回来之后, 是应该重新调用 connect() 吗? 显然是不行的 因为握手的过程还在继续, 只不过中途被中断了而已, 重新调用 connect() 如果对方已经接受连接, 则这一次connect会被拒绝, 返回 EADDRINUSE 错误, 只能通过 I/O多路复用, 等连接建立成功时, 再返回套接字可写条件.

题外话, 如果建立连接的过程中被中断的话, 有以下几种做法

1. 你自己重启被中断的系统调用
2. 对信号设置 SA_RESTART 属性, 让被中断的系统调用自行恢复
3. 忽略信号

## select 的 优缺点 及 内核实现

最多只支持到 1024个描述符, 不够用

### select 使用方法

```c
int select(int maxfd, fd_set *readset, fd_set *writeset, fd_set *exceptset, const struct timeval *timeout);
```

- maxfd: 描述符数量
- readset: 读描述符集合
- writeset: 写描述符集合
- exceptset: 异常描述符集合
- timeout: 如果为NULL 表示一直等, 如果为0则不等立即返回, 如果非0则一直等到超时

每次调用 select 都要重新覆盖 那三个集合, 因为监听的事件会改变着三个集合中的位, 此外, 每次返回的时候 如果select 不为0, 说明有事件发生, 如果想知道是哪个描述符的事件, 就要通过遍历 三个集合的内容, 来找到那个描述符.

### select 优缺点

通过以上可知, 优点 实现简单.

缺点:

1. 只支持 1024 个文件描述符
2. 每次都要给内核重新传递三个集合, 用户态拷贝到内核态 开销大
3. 每次都要遍历三个集合, 才能知道是哪个文件描述符发送了事件, 而且因为是位图, 遍历还是用的线性遍历

### select 内核实现

就是一个简单的 bitmap

```c
#define FD_SETSIZE 1024 // 可以看出 select 最多支持 1024个描述符
#define NFDBITS (8 * sizeof(unsigned long))
#define __FDSET_LONGS (FD_SETSIZE/NFDBITS)

// 本质上就是一个 bitmap
typedef struct {
    unsigned long fds_bits[__FDSET_LONGS];
} fd_set;

// 按位设置
#define FD_SET(fd,fdsetp)	__FD_SET(fd,fdsetp)
#define FD_CLR(fd,fdsetp)	__FD_CLR(fd,fdsetp)
#define FD_ISSET(fd,fdsetp)	__FD_ISSET(fd,fdsetp)
#define FD_ZERO(fdsetp)		__FD_ZERO(fdsetp)

#define __FD_SET(fd, fdsetp) \
		(((fd_set *)(fdsetp))->fds_bits[(fd) >> 5] |= (1<<((fd) & 31)))
#define __FD_CLR(fd, fdsetp) \
		(((fd_set *)(fdsetp))->fds_bits[(fd) >> 5] &= ~(1<<((fd) & 31)))
#define __FD_ISSET(fd, fdsetp) \
		((((fd_set *)(fdsetp))->fds_bits[(fd) >> 5] & (1<<((fd) & 31))) != 0)
#define __FD_ZERO(fdsetp) \
		(memset (fdsetp, 0, sizeof (*(fd_set *)(fdsetp))))
```

SYSCALL_DEFINE5 ⇒ sys_select() 在这里

sys_select() 主要是对超时时间做处理, 从用户态copy到内核态, 然后将超时时间 转化为 纳秒

```c
SYSCALL_DEFINE5(select, int, n, fd_set __user *, inp, fd_set __user *, outp,
        fd_set __user *, exp, struct timeval __user *, tvp)
{
    struct timespec end_time, *to = NULL;
    struct timeval tv;
    int ret;

    if (tvp) {
        if (copy_from_user(&tv, tvp, sizeof(tv)))
            return -EFAULT;

        to = &end_time;
        if (poll_select_set_timeout(to,
                tv.tv_sec + (tv.tv_usec / USEC_PER_SEC),
                (tv.tv_usec % USEC_PER_SEC) * NSEC_PER_USEC))
            return -EINVAL;
    }
    
    ret = core_sys_select(n, inp, outp, exp, to);
    ret = poll_select_copy_remaining(&end_time, tvp, 1, ret);
    return ret;
}
```

接下来调用 core_sys_select()

创建一个 256位 的数组, 然后获取当前进程的文件描述符表, 主要是做判断 不能让 select 监控的最大 文件描述符超过 该进程的文件描述符的上限, 接下来开辟空间 要开6个bitmap, in, out, ex 和其余三个对应的结果集合, 最后将其清空, 然后从用户态中拷贝到新创建的集合中, 调用 do_select() 去做真正的操作.

```c
int core_sys_select(int n, fd_set __user *inp, fd_set __user *outp,
                 fd_set __user *exp, struct timespec *end_time)
{
    fd_set_bits fds;
    void *bits;
    int ret, max_fds;
    unsigned int size;
    struct fdtable *fdt;

	  // SELECT_STACK_ALLOC 为 256
    long stack_fds[SELECT_STACK_ALLOC/sizeof(long)];

    rcu_read_lock();
		// 获取该进程的 文件描述符表
    fdt = files_fdtable(current->files);
    max_fds = fdt->max_fds;
    rcu_read_unlock();
		
		// select 可监控最大为 该进程的文件描述符的上限
    if (n > max_fds)
        n = max_fds;

    // 计算在位图中表示n需要多少字节, (32 + n - 1 / 32) * 4
    size = FDS_BYTES(n); 
    bits = stack_fds;

    // 6个 bitmap, in out ex, 和 三个对应的结果
    if (size > sizeof(stack_fds) / 6) {
        bits = kmalloc(6 * size, GFP_KERNEL);
    }
    fds.in      = bits;
    fds.out     = bits +   size;
    fds.ex      = bits + 2*size;
    fds.res_in  = bits + 3*size;
    fds.res_out = bits + 4*size;
    fds.res_ex  = bits + 5*size;

    // 把用户态的三个集合拷贝到内核态
    if ((ret = get_fd_set(n, inp, fds.in)) ||
            (ret = get_fd_set(n, outp, fds.out)) ||
            (ret = get_fd_set(n, exp, fds.ex)))
        goto out;
        
    // 清空结果集
    zero_fd_set(n, fds.res_in);
    zero_fd_set(n, fds.res_out);
    zero_fd_set(n, fds.res_ex);
		
		// 真正去做 select 的函数
    ret = do_select(n, &fds, end_time);

    if (ret < 0)
        goto out;
    if (!ret) {
        ret = -ERESTARTNOHAND;
        if (signal_pending(current))
            goto out;
        ret = 0;
    }
    // 将结果集 从内核态 拷贝到 用户态
    if (set_fd_set(n, inp, fds.res_in) ||
            set_fd_set(n, outp, fds.res_out) ||
            set_fd_set(n, exp, fds.res_ex))
        ret = -EFAULT;

out:
    if (bits != stack_fds)
        kfree(bits);
out_nofds:
    return ret;
}
```

do_select()

```c
int do_select(int n, fd_set_bits *fds, struct timespec *end_time)
{
    ktime_t expire, *to = NULL;
    struct poll_wqueues table;
    poll_table *wait;
    int retval, i, timed_out = 0;
    u64 slack = 0;

    rcu_read_lock();
    retval = max_select_fd(n, fds);
    rcu_read_unlock();
    n = retval;

    poll_initwait(&table);
    wait = &table.pt;
    if (end_time && !end_time->tv_sec && !end_time->tv_nsec) {
        wait->_qproc = NULL;
        timed_out = 1;
    }

    if (end_time && !timed_out)
        slack = select_estimate_accuracy(end_time);

    retval = 0;
    for (;;) {
        unsigned long *rinp, *routp, *rexp, *inp, *outp, *exp;
        bool can_busy_loop = false;

        inp = fds->in; outp = fds->out; exp = fds->ex;
        rinp = fds->res_in; routp = fds->res_out; rexp = fds->res_ex;

        for (i = 0; i < n; ++rinp, ++routp, ++rexp) {
            unsigned long in, out, ex, all_bits, bit = 1, mask, j;
            unsigned long res_in = 0, res_out = 0, res_ex = 0;

            in = *inp++; out = *outp++; ex = *exp++;
            all_bits = in | out | ex;
            
            if (all_bits == 0) {
                i += BITS_PER_LONG;
                continue;
            }

            for (j = 0; j < BITS_PER_LONG; ++j, ++i, bit <<= 1) {
                struct fd f;
                if (i >= n)
                    break;
                if (!(bit & all_bits))
                    continue;
                f = fdget(i);
                if (f.file) {
                    const struct file_operations *f_op;
                    f_op = f.file->f_op;
                    mask = DEFAULT_POLLMASK;
                    if (f_op->poll) {
                        wait_key_set(wait, in, out, bit, busy_flag);
												// 调用文件的 poll 操作
                        mask = (*f_op->poll)(f.file, wait); 
                    }
                    fdput(f);
                    // 写入结果
                    if ((mask & POLLIN_SET) && (in & bit)) {
                        res_in |= bit;
                        retval++;
                        wait->_qproc = NULL;
                    }
                    if ((mask & POLLOUT_SET) && (out & bit)) {
                        res_out |= bit;
                        retval++;
                        wait->_qproc = NULL;
                    }
                    if ((mask & POLLEX_SET) && (ex & bit)) {
                        res_ex |= bit;
                        retval++;
                        wait->_qproc = NULL;
                    }
                    // 当返回值不为零，则停止循环轮询
                    if (retval) {
                        can_busy_loop = false; 
                        busy_flag = 0;
                    } else if (busy_flag & mask)
                        can_busy_loop = true;
                }
            }
            if (res_in)
                *rinp = res_in;
            if (res_out)
                *routp = res_out;
            if (res_ex)
                *rexp = res_ex;
            cond_resched(); // 让出 CPU资源
        }
        wait->_qproc = NULL;
        // 文件描述符准备就绪 超时 有信号 则退出循环
        if (retval || timed_out || signal_pending(current))
            break;
        if (table.error) {
            retval = table.error;
            break;
        }

        if (can_busy_loop && !need_resched()) {
            if (!busy_end) {
                busy_end = busy_loop_end_time();
                continue;
            }
            if (!busy_loop_timeout(busy_end))
                continue;
        }
        busy_flag = 0;

        if (end_time && !to) {
            expire = timespec_to_ktime(*end_time);
            to = &expire;
        }

        if (!poll_schedule_timeout(&table, TASK_INTERRUPTIBLE,
                         to, slack))
            timed_out = 1;
    }

    poll_freewait(&table);
    return retval;
}
```

可以看到 do_select 主要遍历 集合, 通过集合中的文件描述符找到文件结构体, 然后调用 poll 函数, 最后将结果写入集合中, 比较蠢, 需要把集合中的全部扫一遍, 效率很低.

分三层遍历, 第一层死循环直到满足 超时, 文件描述符有监听事件发生, 中断, 第二层循环遍历文件描述符, 第三层遍历 集合中的每一个 bit.

- 当有描述符发生所要监控的事件, 则会将其存下来, 返回到用户态
- 如果没有发生所要监控的事件, 如果已超时, 或者有待处理的信号, 也会回到用户态
- 即没有监控的事件, 又没有超时 或者 没有待处理的信号, 则会让出CPU, 等待被唤醒, 唤醒后再次进入循环

`mask = (*f_op->poll)(f.file, wait); `

对于 socket 来说 应该是 sock_poll 会将当前进程 放入等待队列中(但并不是去睡眠), 等到这个 f_op 可读或可写时, 就会唤醒当前进程, 如果一直没人唤醒的话, 就会自己去睡眠, 并设置超时时间, 时间到了之后, 就会重新唤醒去重新遍历 fd.

## poll 的 优缺点 及 内核实现

```c
struct pollfd {
    int    fd;       /* file descriptor */ // 如果 < 0 则不监听
    short  events;   /* events to look for */
    short  revents;  /* events returned */
 };

// 用于填写 events
// 可读事件
#define POLLIN     0x0001    /* any readable data available */
#define POLLPRI    0x0002    /* OOB/Urgent readable data */
#define POLLRDNORM 0x0040    /* non-OOB/URG data available */
#define POLLRDBAND 0x0080    /* OOB/Urgent readable data */

// 可写事件
#define POLLOUT    0x0004    /* file descriptor is writeable */
#define POLLWRNORM POLLOUT   /* no write type differentiation */
#define POLLWRBAND 0x0100    /* OOB/Urgent data can be written */

// 异常事件 这些异常事件并不需要自己显式的传入, 内核源码中会自动帮我们 | 上去
#define POLLERR    0x0008    /* 一些错误发送 */
#define POLLHUP    0x0010    /* 描述符挂起*/
#define POLLNVAL   0x0020    /* 请求的事件无效*/
```

### poll 使用方法

```c
int poll(struct pollfd *fds, unsigned long nfds, int timeout);
```

- fds: 监听事件数组
- nfds: fds有多大(突破了select 1024的限制)
- timeout: 超时事件 < 0 则一直等待, 0立即返回, >0 到时再返回

### poll 优缺点

优点自然是 解决了 select 1024个文件描述符的限制

缺点和 select 一样

1. 每次都要从用户态拷贝 pollfd数组到 内核态
2. 寻找发生事件的描述符也是 和 select 一样 进行遍历, 线性扫描.

### poll 内核实现

sys_poll()

可以看到 poll 的系统调用 和 select 类似 都是先设置好超时时间

然后调用 do_sys_poll()

```c
SYSCALL_DEFINE3(poll, struct pollfd __user *, ufds, unsigned int, nfds,
        int, timeout_msecs)
{
    struct timespec end_time, *to = NULL;
    int ret;
		// 老样子 如果有超时时间 先设置超时
    if (timeout_msecs >= 0) {
        to = &end_time;
        poll_select_set_timeout(to, timeout_msecs / MSEC_PER_SEC,
            NSEC_PER_MSEC * (timeout_msecs % MSEC_PER_SEC));
    }

    ret = do_sys_poll(ufds, nfds, to);

    if (ret == -EINTR) {
        struct restart_block *restart_block;

        restart_block = &current->restart_block;
        restart_block->fn = do_restart_poll;
        restart_block->poll.ufds = ufds;
        restart_block->poll.nfds = nfds;

        if (timeout_msecs >= 0) {
            restart_block->poll.tv_sec = end_time.tv_sec;
            restart_block->poll.tv_nsec = end_time.tv_nsec;
            restart_block->poll.has_timeout = 1;
        } else
            restart_block->poll.has_timeout = 0;

        ret = -ERESTART_RESTARTBLOCK;
    }
    return ret;
}
```

do_sys_poll()

```c
int do_sys_poll(struct pollfd __user *ufds, unsigned int nfds,
        struct timespec *end_time)
{
    struct poll_wqueues table;
    int err = -EFAULT, fdcount, len, size;

    // 创建大小为256bit 的数组
    long stack_pps[POLL_STACK_ALLOC/sizeof(long)];
    struct poll_list *const head = (struct poll_list *)stack_pps;
    struct poll_list *walk = head;
    unsigned long todo = nfds;

		// 上限默认为1024 (ulimit -n)
    if (nfds > rlimit(RLIMIT_NOFILE))
        return -EINVAL;

    len = min_t(unsigned int, nfds, N_STACK_PPS);

		// 这个循环 负责将用户态的数据拷贝到内核态
		// 可见 select 和 poll的 性能开销大多用在了 内核和用户态的相互拷贝上
    for (;;) {
        walk->next = NULL;
        walk->len = len;
        if (!len)
            break;

        if (copy_from_user(walk->entries, ufds + nfds-todo,
                    sizeof(struct pollfd) * walk->len))
            goto out_fds;

        todo -= walk->len;
        if (!todo)
            break;

        len = min(todo, POLLFD_PER_PAGE);
        size = sizeof(struct poll_list) + sizeof(struct pollfd) * len;
        walk = walk->next = kmalloc(size, GFP_KERNEL);
    }

		// 真正去做 do_poll()
    poll_initwait(&table);
    fdcount = do_poll(nfds, head, &table, end_time);
    poll_freewait(&table);
		
		// 将结果拷贝回用户态
    for (walk = head; walk; walk = walk->next) {
        struct pollfd *fds = walk->entries;
        int j;
        for (j = 0; j < walk->len; j++, ufds++)
            if (__put_user(fds[j].revents, &ufds->revents))
                goto out_fds;
      }

    err = fdcount;
out_fds:
    walk = head->next;
    while (walk) {
        struct poll_list *pos = walk;
        walk = walk->next;
        kfree(pos);
    }

    return err;
}
```

do_poll()

```c
static int do_poll(unsigned int nfds,  struct poll_list *list,
           struct poll_wqueues *wait, struct timespec *end_time)
{
    poll_table* pt = &wait->pt;
    ktime_t expire, *to = NULL;
    int timed_out = 0, count = 0;
    u64 slack = 0;
    unsigned int busy_flag = net_busy_loop_on() ? POLL_BUSY_LOOP : 0;
    unsigned long busy_end = 0;

    if (end_time && !end_time->tv_sec && !end_time->tv_nsec) {
        pt->_qproc = NULL;
        timed_out = 1;
    }

    if (end_time && !timed_out)
        slack = select_estimate_accuracy(end_time);

    for (;;) {
        struct poll_list *walk;
        bool can_busy_loop = false;

        for (walk = list; walk != NULL; walk = walk->next) {
            struct pollfd * pfd, * pfd_end;

            pfd = walk->entries;
            pfd_end = pfd + walk->len;
            for (; pfd != pfd_end; pfd++) {
                if (do_pollfd(pfd, pt, &can_busy_loop,
                          busy_flag)) {
                    count++;
                    pt->_qproc = NULL;
                    busy_flag = 0;
                    can_busy_loop = false; 
                }
            }
        }

        pt->_qproc = NULL;
        if (!count) {
            count = wait->error;
            if (signal_pending(current))
                count = -EINTR;
        }
        if (count || timed_out)
            break;

        if (can_busy_loop && !need_resched()) {
            if (!busy_end) {
                busy_end = busy_loop_end_time();
                continue;
            }
            if (!busy_loop_timeout(busy_end))
                continue;
        }
        busy_flag = 0;

        if (end_time && !to) {
            expire = timespec_to_ktime(*end_time);
            to = &expire;
        }
        if (!poll_schedule_timeout(wait, TASK_INTERRUPTIBLE, to, slack))
            timed_out = 1;
    }
    return count;
}
// 又是通过 fd 找到 file 然后调用 file 的 poll 接口 将当前进程放入睡眠队列, 如果可读/可写
// 就唤醒当前进程, 要注意 这里放入睡眠队列不是说立刻进入睡眠
static inline unsigned int do_pollfd(struct pollfd *pollfd, 
                     poll_table *pwait,
                     bool *can_busy_poll,
                     unsigned int busy_flag)
{
    unsigned int mask;
    int fd;

    mask = 0;
    fd = pollfd->fd;
    if (fd >= 0) {
        struct fd f = fdget(fd);
        mask = POLLNVAL;
        if (f.file) {
            mask = DEFAULT_POLLMASK;
            if (f.file->f_op->poll) {
                pwait->_key = pollfd->events|POLLERR|POLLHUP;
                pwait->_key |= busy_flag;
                mask = f.file->f_op->poll(f.file, pwait);
                if (mask & busy_flag)
                    *can_busy_poll = true;
            }
            mask &= pollfd->events | POLLERR | POLLHUP;
            fdput(f);
        }
    }
    pollfd->revents = mask;

    return mask;
}

```

和 select 类似 来个无限循环, 然后 遍历 用户传进来的数组, 对数组中的文件描述符 进行 poll操作, 一样会将当前进程放入等待队列, 当文件描述符所代表的"文件"可读或者可写就会唤醒等待队列的进程, 最后将其放入 revents, 拷贝回用户态. 如果一直没有 文件可读或者可写, 就和select一样, 开个定时器, 让自己睡过去, 直到超时.

离开无限循环的条件 1. 有新事件 2. 超时, 3. 有信号发生, 发生中断

## epoll 的 优缺点 及 内核实现

```c
typedef union epoll_data {
     void        *ptr;
     int          fd;
     uint32_t     u32;
     uint64_t     u64;
 } epoll_data_t;

 struct epoll_event {
     uint32_t     events;      /* Epoll events */
     epoll_data_t data;        /* User data variable */
 };
```

这里的 events 和 poll的 一样, 此外 epoll_data 中一般只用 fd.

### epoll 使用方法

```c
int epoll_create(int size);
// size 在 Linux 2.6.8 之后没用了, 但是还是要填写一个 大于 0 的数值
int epoll_create1(int flags);
// 创建 epollfd 可增加 额外选项
```

```c
int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event);
```

- epfd 就是 epoll_create 的返回值
- op 就是 operator 操作
    - EPOLL_CTL_ADD: 向 epoll 注册文件描述符的事件
    - EPOLL_CTL_DEL: 向 epoll 删除文件描述符的事件
    - EPOLL_CTL_MOD: 修改文件描述符的事件
- fd 监听的文件描述符
- event 监听事件类型 和 用户自定义信息(大部分时候只放 fd)

```c
int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout);
```

- events: 数组 返回需要处理的I/O事件
- maxevents: 可以返回的最大事件值
- timeout -1 不超时, 0 立即返回

### 条件触发(水平触发) 与 边缘触发

通过设置 event | EPOLLET 设置为 边缘触发, 默认为水平触发.

用一句话来解释就是 条件触发的话 只要缓冲区有东西 就一直 从 epoll_wait 中提醒, 而边缘触发 只有在第一次 满足条件的时候才触发, 因此 边缘触发的效率比水平触发高, 不过 边缘触发的代码就不是很好写了.

题外话: select 和 poll 都是水平触发的模式.

### epoll 内核实现

#### sys_epoll_create()

epoll_create 会创建 匿名文件 和 文件描述符 同时将其绑定起来, 而且会将 该匿名文件 存入 eventpoll 结构体当中, 方便通过 epollfd 来找到 eventpoll 实例.

```c
SYSCALL_DEFINE1(epoll_create, int, size)
{
    if (size <= 0)
        return -EINVAL;
    return sys_epoll_create1(0);
}
```

```c
SYSCALL_DEFINE1(epoll_create1, int, flags)
{
    int error, fd;
    struct eventpoll *ep = NULL;
    struct file *file;

    // 创建 eventpoll
    error = ep_alloc(&ep);

		// 找没用过的 fd
    fd = get_unused_fd_flags(O_RDWR | (flags & O_CLOEXEC));
	  // 创建 匿名文件 实例, 会将 eventpoll 存入 file 中的 private_data
		// 方便快速定位 到 eventpoll 对象
    file = anon_inode_getfile("[eventpoll]", &eventpoll_fops, ep,
                 O_RDWR | (flags & O_CLOEXEC));

    ep->file = file;
		// 将 fd 和 epoll 实例关联
    fd_install(fd, file);
    return fd;

out_free_fd:
    put_unused_fd(fd);
out_free_ep:
    ep_free(ep);
    return error;
}
```

```c
static int ep_alloc(struct eventpoll **pep)
{
    int error;
    struct user_struct *user;
    struct eventpoll *ep;
    user = get_current_user();
    error = -ENOMEM;
    ep = kzalloc(sizeof(*ep), GFP_KERNEL);

    spin_lock_init(&ep->lock);
    mutex_init(&ep->mtx);
    init_waitqueue_head(&ep->wq); // 执行 epoll_wait 而等待的进程队列
    init_waitqueue_head(&ep->poll_wait); // eventloop 文件等待队列(epoll本身就是个文件)
    INIT_LIST_HEAD(&ep->rdllist);
    ep->rbr = RB_ROOT;
    ep->ovflist = EP_UNACTIVE_PTR;
    ep->user = user;
    *pep = ep;
    return 0;

free_uid:
    free_uid(user);
    return error;
}
```

```c
/*
 * This structure is stored inside the "private_data" member of the file
 * structure and represents the main data structure for the eventpoll
 * interface.
 */
struct eventpoll {
    /* Protect the access to this structure */
    spinlock_t lock;
    struct mutex mtx;

    /* Wait queue used by sys_epoll_wait() */
    //这个队列里存放的是执行epoll_wait从而等待的进程队列
    wait_queue_head_t wq;

    /* Wait queue used by file->poll() */
		// eventloop 文件等待队列(epoll本身就是个文件)
    wait_queue_head_t poll_wait;

    /* List of ready file descriptors */
    // 这里存放的是事件就绪的fd列表 链表的每个元素是下面的epitem
    struct list_head rdllist;

    /* RB tree root used to store monitored fd structs */
    // 红黑树 用来查找 fd
    struct rb_root_cached rbr;

    /*
     * This is a single linked list that chains all the "struct epitem" that
     * happened while transferring ready events to userspace w/out
     * holding ->lock.
     */
    struct epitem *ovflist;

    /* wakeup_source used when ep_scan_ready_list is running */
    struct wakeup_source *ws;

    /* The user that created the eventpoll descriptor */
		// 描述 创建 epoll 的用户
    struct user_struct *user;

    // epoll 实例文件
    struct file *file;

    /* used to optimize loop detection check */
    int visited;
    struct list_head visited_list_link;
};
```

```c
// 其实就是 红黑树的 一个节点
struct epitem {
    union {
        struct rb_node rbn; // RB树节点将此结构链接到eventpoll RB树
        struct rcu_head rcu; // 用于释放epitem
    };
		// 将这个eptiem连接到 eventpoll的 rdllist 的 list指针
    struct list_head rdllink;
    struct epitem *next;
		// epoll 监听的fd
    struct epoll_filefd ffd;

		// 一个文件被多个epoll实例监听时的监听数目
    int nwait;

    struct list_head pwqlist;
    struct eventpoll *ep;  // epitem 所属的 eventpoll
    struct list_head fllink; // 链接到file条目列表的列表头
    struct wakeup_source __rcu *ws; // 设置EPOLLWAKEUP时使用的wakeup_source
    struct epoll_event event; // 监控的事件和文件描述符
};

struct epoll_event {
    __u32 events;
    __u64 data;
} EPOLL_PACKED;

struct epoll_filefd {
    struct file *file;
    int fd;
} __packed;
```

#### sys_epoll_ctl()

先是根据 epollfd 来找到 匿名文件, 即 epoll 实例, 接着获取真正的 文件(fd传进来的), 然后取出 epoll,

接着 在红黑树中 找这个 fd.

```c
SYSCALL_DEFINE4(epoll_ctl, int, epfd, int, op, int, fd,
        struct epoll_event __user *, event)
{
    int error;
    int full_check = 0;
    struct fd f, tf;
    struct eventpoll *ep;
    struct epitem *epi;
    struct epoll_event epds;
    struct eventpoll *tep = NULL;

    error = -EFAULT;

    if (ep_op_has_event(op) &&
        copy_from_user(&epds, event, sizeof(struct epoll_event)))

    f = fdget(epfd);
    tf = fdget(fd);

    if (!tf.file->f_op->poll)
        goto error_tgt_fput;

    if (ep_op_has_event(op))
        ep_take_care_of_epollwakeup(&epds);

    ep = f.file->private_data; // 取出epoll_create过程创建的eventpoll

    mutex_lock_nested(&ep->mtx, 0);

    epi = ep_find(ep, tf.file, fd); // 红黑树中 找 该 fd
    switch (op) {
    case EPOLL_CTL_ADD:
        if (!epi) {
						// 快看, 这里会自动 把 POLLERR 和 POLLHUP 带上 因此不需要显式传入
            epds.events |= POLLERR | POLLHUP;
            error = ep_insert(ep, &epds, tf.file, fd, full_check);
        }
        if (full_check)
            clear_tfile_check_list();
        break;
    case EPOLL_CTL_DEL:
        if (epi)
            error = ep_remove(ep, epi);
        break;
    case EPOLL_CTL_MOD:
        if (epi) {
            epds.events |= POLLERR | POLLHUP;
            error = ep_modify(ep, epi, &epds);
        }
        break;
    }
    mutex_unlock(&ep->mtx);
    fdput(tf);
    fdput(f);
    return error;
}
```

epi = ep_find(ep, tf.file, fd);

红黑树的 排序规则 采用 文件地址排序, 如果相同 就按照文件描述符进行排序

```c
struct epoll_filefd {
  struct file *file; // pointer to the target file struct corresponding to the fd
  int fd; // target file descriptor number
} __packed;

/* Compare RB tree keys */
static inline int ep_cmp_ffd(struct epoll_filefd *p1,
                            struct epoll_filefd *p2)
{
  return (p1->file > p2->file ? +1:
       (p1->file < p2->file ? -1 : p1->fd - p2->fd));
}
```

ep_insert()

```c
static int ep_insert(struct eventpoll *ep, struct epoll_event *event,
             struct file *tfile, int fd, int full_check)
{
    int error, revents, pwake = 0;
    unsigned long flags;
    long user_watches;
    struct epitem *epi;
    struct ep_pqueue epq;

		// 判断 当前监控的文件值 是否超过了 /proc/sys/fs/epoll/max_user_watches 的预设最大值
    user_watches = atomic_long_read(&ep->user->epoll_watches);
    if (unlikely(user_watches >= max_user_watches))
        return -ENOSPC;
    if (!(epi = kmem_cache_alloc(epi_cache, GFP_KERNEL)))
        return -ENOMEM;

    // 初始化
    INIT_LIST_HEAD(&epi->rdllink);
    INIT_LIST_HEAD(&epi->fllink);
    INIT_LIST_HEAD(&epi->pwqlist);
    epi->ep = ep;
    ep_set_ffd(&epi->ffd, tfile, fd); // 将tfile和fd都赋值给ffd
    epi->event = *event;
    epi->nwait = 0;
    epi->next = EP_UNACTIVE_PTR;
    if (epi->event.events & EPOLLWAKEUP) {
        error = ep_create_wakeup_source(epi);
    } else {
        RCU_INIT_POINTER(epi->ws, NULL);
    }

    epq.epi = epi;
    // 设置轮询的回调函数
    init_poll_funcptr(&epq.pt, ep_ptable_queue_proc);
		// ep_ptable_queue_proc -> 会去设置回调函数 ep_poll_callback
		// 当有事件发生的时候 就会调用这个函数

    // 执行poll方法
    revents = ep_item_poll(epi, &epq.pt);

    spin_lock(&tfile->f_lock);
    list_add_tail_rcu(&epi->fllink, &tfile->f_ep_links);
    spin_unlock(&tfile->f_lock);

		// 将创建的epi添加到RB树
    ep_rbtree_insert(ep, epi); 

    spin_lock_irqsave(&ep->lock, flags);
    // 监听事件就绪 并且 epi的就绪队列有数据
    if ((revents & event->events) && !ep_is_linked(&epi->rdllink)) {
        list_add_tail(&epi->rdllink, &ep->rdllist);
        ep_pm_stay_awake(epi);

        // 唤醒调用epoll_wait的进程
        if (waitqueue_active(&ep->wq))
            wake_up_locked(&ep->wq);
        if (waitqueue_active(&ep->poll_wait))
            pwake++;
    }

    spin_unlock_irqrestore(&ep->lock, flags);
    atomic_long_inc(&ep->user->epoll_watches);

    if (pwake)
        ep_poll_safewake(&ep->poll_wait); // 唤醒等待eventpoll文件就绪的进程
    return 0;
}
```

ep_poll_callback()

```c
static int ep_poll_callback(wait_queue_t *wait, unsigned mode, int sync, void *key)
{
    int pwake = 0;
    unsigned long flags;

    struct epitem *epi = ep_item_from_wait(wait);
    struct eventpoll *ep = epi->ep;

    spin_lock_irqsave(&ep->lock, flags);

    if (unlikely(ep->ovflist != EP_UNACTIVE_PTR)) {
        if (epi->next == EP_UNACTIVE_PTR) {
            epi->next = ep->ovflist;
            ep->ovflist = epi;
            if (epi->ws) {
                __pm_stay_awake(ep->ws);
            }
        }
        goto out_unlock;
    }

    // 事件发生 但不在已完成队列 就放进去
    if (!ep_is_linked(&epi->rdllink)) {
        // 将epi就绪事件 插入到ep就绪队列
        list_add_tail(&epi->rdllink, &ep->rdllist);
        ep_pm_stay_awake_rcu(epi);
    }

    // 唤醒 eventpoll上的等待进程
    if (waitqueue_active(&ep->wq))
				// 当队列不为空，则唤醒进程
        wake_up_locked(&ep->wq);
    if (waitqueue_active(&ep->poll_wait))
        pwake++;

out_unlock:
    spin_unlock_irqrestore(&ep->lock, flags);
    if (pwake)
        ep_poll_safewake(&ep->poll_wait);

    if ((unsigned long)key & POLLFREE) {
        list_del_init(&wait->task_list);
        smp_store_release(&ep_pwq_from_wait(wait)->whead, NULL);
    }
    return 1;
}

```

#### sys_epoll_wait()

```c
SYSCALL_DEFINE4(epoll_wait, int, epfd, struct epoll_event __user *, events,
        int, maxevents, int, timeout)
{
    int error;
    struct fd f;
    struct eventpoll *ep;

    if (maxevents <= 0 || maxevents > EP_MAX_EVENTS)
        return -EINVAL;

    if (!access_ok(VERIFY_WRITE, events, maxevents * sizeof(struct epoll_event)))
        return -EFAULT;

    f = fdget(epfd);  // 获取 epollfd 对应的文件
    ep = f.file->private_data;

    ****error = ep_poll(ep, events, maxevents, timeout);

error_fput:
    fdput(f);
    return error;
}
```

```c
static int ep_poll(struct eventpoll *ep, struct epoll_event __user *events,
           int maxevents, long timeout)
{
    int res = 0, eavail, timed_out = 0;
    unsigned long flags;
    long slack = 0;
    wait_queue_t wait;
    ktime_t expires, *to = NULL;

    if (timeout > 0) {
        struct timespec end_time = ep_set_mstimeout(timeout);
        slack = select_estimate_accuracy(&end_time);
        to = &expires;
        *to = timespec_to_ktime(end_time);
    } else if (timeout == 0) {
        // timeout 等于0为非阻塞 直接跳过去
        timed_out = 1;
        spin_lock_irqsave(&ep->lock, flags);
        goto check_events;
    }

fetch_events:
    spin_lock_irqsave(&ep->lock, flags);

    if (!ep_events_available(ep)) {
        // 没有事件就绪则进入睡眠状态，当事件就绪后可通过ep_poll_callback()来唤醒
        // 将当前进程放入wait等待队列
        init_waitqueue_entry(&wait, current);
        // 将当前进程加入eventpoll等待队列，等待文件就绪、超时或中断信号
        __add_wait_queue_exclusive(&ep->wq, &wait);

        for (;;) {
            set_current_state(TASK_INTERRUPTIBLE);
						// 有就绪事件 或者 超时 或者有信号 则退出循环
            if (ep_events_available(ep) || timed_out)
                break;
            if (signal_pending(current)) {
                res = -EINTR;
                break;
            }

            spin_unlock_irqrestore(&ep->lock, flags);
            // 让出 CPU 进入睡眠
            if (!freezable_schedule_hrtimeout_range(to, slack,
                                HRTIMER_MODE_ABS))
                timed_out = 1;

            spin_lock_irqsave(&ep->lock, flags);
        }
				// 被唤醒 将当前进程从等待队列中删除
        __remove_wait_queue(&ep->wq, &wait);
				// 设置当前进程状态
        set_current_state(TASK_RUNNING);
    }
check_events:
    eavail = ep_events_available(ep);
    spin_unlock_irqrestore(&ep->lock, flags);

    // 将就绪事件传到 用户态
    if (!res && eavail &&
        !(res = ep_send_events(ep, events, maxevents)) && !timed_out)
        goto fetch_events;

    return res;
}
```

ep_send_events() 还会在里面再次检测是否真的就绪, 因为很有可能在窗口时间(就是处理的过程中) 被用户处理掉.

### LT 与 ET 是怎么实现的?

其实很简单, 如果是 LT 的话, 每次 处理完 都将 epoll_item 重新加入 eventpoll 就绪队列中, 这样就能再次被重新处理.

## 总结

经过以上洗礼, 我们可以得出结论, epoll 效率比 select 或者 poll 高的原因是, 因为, 它内部采用了红黑树 来存储 事件, 这样就不需要每次都从 用户态拷贝到内核态 节约了一层的性能开销.

此外, 红黑树能用来快速搜索 fd, fd 又直接关联 eventpoll 对象, 可以直接将 fd加入到 eventpoll的就绪队列中, 不用像 select 或者 poll 一样, 发生了事件, 傻傻的去遍历 到底是哪个 fd 发生了事件.

同时, 返回给用户的事件的方式又有很大改善, select 和 poll 一股脑全反回去, 你还要自己进行遍历, 筛选掉很多没用的事件, 而 epoll 则不同, 它直接给你发生了事件的, 没发生事件的不给你, 省的你去遍历, 以上三层, 奠定了 epoll 在 I/O多路复用中的地位.