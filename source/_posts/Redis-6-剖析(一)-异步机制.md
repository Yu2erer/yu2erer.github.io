---
title: Redis 6 剖析(一) 异步机制
categories: Redis
date: 2021-03-26 23:46:20
keywords: Redis, ThreadIO
tags: [Redis]
---

一直觉得关系型数据库非常难用，在使用之前要先定好表的结构，中途修改存储结构，改动就会非常繁杂，特别是 `外键` 这玩意离开了学校就再也没见过。好在在 `游戏领域` 中，用的最多的都是 `NoSQL` 。

熟悉我风格的人，可以看出这个系列的标题，不再是 `源码剖析`，而是只有 `剖析` 两字，主要是考虑到 `Redis 6.0` 的代码量已经挺大了，同时网络中又有大量关于 `Redis` 数据结构的源码剖析，没必要再炒冷饭了。

出于以上的原因，我将 `Redis` 分为几个部分进行剖析和讨论。

1. 异步机制
2. 主从同步
3. 集群
4. 数据结构

本篇主要是来剖析 `Redis` 为了避免 `阻塞` ，是如何运用 `多进程` 与 `多线程`，这两种异步机制的。

## 阻塞点

`Redis` 一般有以下几种阻塞的点。

从网络交互来看有

- 网络 I/O (多线程)
- 客户端交互 (部分删除用多线程 `BIO`)
- 传输 RDB 快照 (多进程)

从磁盘交互又分

- 关闭文件 (多线程 `BIO`)
- 记录 AOF 日志 (多线程 `BIO`)
- AOF 日志重写 (多进程)
- RDB 快照生成 (多进程)

<!-- more -->


## 网络 I/O (多线程)

`Redis` 在早期的版本中 采用的是 `单线程 + I/O 多路复用` 的模型，而在最新的 `6.0` ，采用了 `Thread I/O` ，默认不会开启，开启需要在配置中加入以下两行。

```
io-threads-do-reads true // 开启多线程读和解析执行
io-threads 2 // 开启多少个线程，至少要大于 1
```

`Redis` 在初始化的时候，会调用 `initThreadedIO` 。

![Redis6-ThreadIO-Init](/images/Redis6-ThreadIO-Init.png)

### initThreadedIO

根据配置，创建 `server.io_threads_num` 个子线程，如果只是 一个，则选择直接返回，将 网络I/O的处理放到主线程（相当于使用单线程I/O）。

通过为每个线程创建一个 `mutex` 来达到 临时开启暂停子线程的功能，之所以需要这样，主要是 子线程都是一个死循环，采用 `自旋锁` 的形式去获取任务链表，如果一直没有任务，CPU占用也会达到 `100%`。 

```c
/* Initialize the data structures needed for threaded I/O. */
void initThreadedIO(void) {
    server.io_threads_active = 0; /* We start with threads not active. */

    /* Don't spawn any thread if the user selected a single thread:
     * we'll handle I/O directly from the main thread. */
    if (server.io_threads_num == 1) return;

    if (server.io_threads_num > IO_THREADS_MAX_NUM) {
        serverLog(LL_WARNING,"Fatal: too many I/O threads configured. "
                             "The maximum number is %d.", IO_THREADS_MAX_NUM);
        exit(1);
    }

    /* Spawn and initialize the I/O threads. */
    for (int i = 0; i < server.io_threads_num; i++) {
        /* Things we do for all the threads including the main thread. */
        io_threads_list[i] = listCreate();
        if (i == 0) continue; /* Thread 0 is the main thread. */

        /* Things we do only for the additional threads. */
        pthread_t tid;
        pthread_mutex_init(&io_threads_mutex[i],NULL);
        setIOPendingCount(i, 0);
        pthread_mutex_lock(&io_threads_mutex[i]); /* Thread will be stopped. */
        if (pthread_create(&tid,NULL,IOThreadMain,(void*)(long)i) != 0) {
            serverLog(LL_WARNING,"Fatal: Can't initialize IO thread.");
            exit(1);
        }
        io_threads[i] = tid;
    }
}
```

### IOThreadMain

通过 `atomic` 实现自旋锁的形式，去获取任务列表，再根据写任务或读任务去执行。其中在一开始的时候通过 `lock(mutex)` 的形式，给主线程暂停子线程的机会。

```c
#define IO_THREADS_MAX_NUM 128
#define IO_THREADS_OP_READ 0
#define IO_THREADS_OP_WRITE 1

pthread_t io_threads[IO_THREADS_MAX_NUM];
pthread_mutex_t io_threads_mutex[IO_THREADS_MAX_NUM];
redisAtomic unsigned long io_threads_pending[IO_THREADS_MAX_NUM];
int io_threads_op;      /* IO_THREADS_OP_WRITE or IO_THREADS_OP_READ. */

list *io_threads_list[IO_THREADS_MAX_NUM];

static inline unsigned long getIOPendingCount(int i) {
    unsigned long count = 0;
    atomicGetWithSync(io_threads_pending[i], count);
    return count;
}

static inline void setIOPendingCount(int i, unsigned long count) {
    atomicSetWithSync(io_threads_pending[i], count);
}

void *IOThreadMain(void *myid) {
    /* The ID is the thread number (from 0 to server.iothreads_num-1), and is
     * used by the thread to just manipulate a single sub-array of clients. */
    long id = (unsigned long)myid;
    char thdname[16];

    snprintf(thdname, sizeof(thdname), "io_thd_%ld", id);
    redis_set_thread_title(thdname);
    redisSetCpuAffinity(server.server_cpulist);
    makeThreadKillable();

    while(1) {
        /* Wait for start */
        for (int j = 0; j < 1000000; j++) {
            if (getIOPendingCount(id) != 0) break;
        }

        /* Give the main thread a chance to stop this thread. */
        if (getIOPendingCount(id) == 0) {
            pthread_mutex_lock(&io_threads_mutex[id]);
            pthread_mutex_unlock(&io_threads_mutex[id]);
            continue;
        }

        serverAssert(getIOPendingCount(id) != 0);

        /* Process: note that the main thread will never touch our list
         * before we drop the pending count to 0. */
        listIter li;
        listNode *ln;
        listRewind(io_threads_list[id],&li);
        while((ln = listNext(&li))) {
            client *c = listNodeValue(ln);
            if (io_threads_op == IO_THREADS_OP_WRITE) {
                writeToClient(c,0);
            } else if (io_threads_op == IO_THREADS_OP_READ) {
                readQueryFromClient(c->conn);
            } else {
                serverPanic("io_threads_op value is unknown");
            }
        }
        listEmpty(io_threads_list[id]);
        setIOPendingCount(id, 0);
    }
}
```

### Threaded I/O 读写流程

1. `beforeSleep` 会先遍历所有待读的客户端，采用 `Round-Robin` 将其分配到各个线程。
2. 通过原子操作设置任务数量，交给 `I/O线程` 操作，自旋等到操作完成，再回到主线程执行命令，并加入到 `clients_pending_write` 。
3. 遍历所有待写的客户端，再次用相同的策略分配到各个线程。
4. 通过原子操作设置任务数量，再次交给 `I/O线程` 操作，自旋等待完成。
5. 如果还没写完，则设置 `Write Handler` 到 `epoll` ，之后未完成的写任务交给主线程去写。

![Redis6-ThreadIO](/images/Redis6-ThreadIO.png)

### handleClientsWithPendingReadsUsingThreads

读操作，先检查 `I/O 线程` 是否关闭，从 `clients_pending_read` 中取出并进行分配到子线程， 访问 `io_threads_list` 不需要加锁， `io_threads_list[i]` 只会有主线程和 i子线程访问，而主线程与子线程之间又通过一个原子变量进行同步，之间通过自旋的形式解决了数据竞争的问题，在等待任务完成的同时，主线程也承担一部分的读操作。最后加入到 `clients_pending_write` 链表。

```c
int handleClientsWithPendingReadsUsingThreads(void) {
    if (!server.io_threads_active || !server.io_threads_do_reads) return 0;
    int processed = listLength(server.clients_pending_read);
    if (processed == 0) return 0;

    /* Distribute the clients across N different lists. */
    listIter li;
    listNode *ln;
    listRewind(server.clients_pending_read,&li);
    int item_id = 0;
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);
        int target_id = item_id % server.io_threads_num;
        listAddNodeTail(io_threads_list[target_id],c);
        item_id++;
    }

    /* Give the start condition to the waiting threads, by setting the
     * start condition atomic var. */
    io_threads_op = IO_THREADS_OP_READ;
    for (int j = 1; j < server.io_threads_num; j++) {
        int count = listLength(io_threads_list[j]);
        setIOPendingCount(j, count);
    }

    /* Also use the main thread to process a slice of clients. */
    listRewind(io_threads_list[0],&li);
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);
        readQueryFromClient(c->conn);
    }
    listEmpty(io_threads_list[0]);

    /* Wait for all the other threads to end their work. */
    while(1) {
        unsigned long pending = 0;
        for (int j = 1; j < server.io_threads_num; j++)
            pending += getIOPendingCount(j);
        if (pending == 0) break;
    }

    /* Run the list of clients again to process the new buffers. */
    while(listLength(server.clients_pending_read)) {
        ln = listFirst(server.clients_pending_read);
        client *c = listNodeValue(ln);
        c->flags &= ~CLIENT_PENDING_READ;
        listDelNode(server.clients_pending_read,ln);

        if (processPendingCommandsAndResetClient(c) == C_ERR) {
            /* If the client is no longer valid, we avoid
             * processing the client later. So we just go
             * to the next. */
            continue;
        }

        processInputBuffer(c);

        /* We may have pending replies if a thread readQueryFromClient() produced
         * replies and did not install a write handler (it can't).
         */
        if (!(c->flags & CLIENT_PENDING_WRITE) && clientHasPendingReplies(c))
            clientInstallWriteHandler(c);
    }

    /* Update processed count on server */
    server.stat_io_reads_processed += processed;

    return processed;
}
```

### handleClientsWithPendingWritesUsingThreads

写操作，检查一下 `I/O线程` 是否开启，当任务量少的时候，会通过 `lock(mutex)` 临时阻塞子线程，因为子线程是一个死循环，就算没有任务也会占满 `CPU` 。如果没有写完，则会设置写回调，注册到 `epoll` 中，下次由主线程去写。

```c
int stopThreadedIOIfNeeded(void) {
    int pending = listLength(server.clients_pending_write);

    /* Return ASAP if IO threads are disabled (single threaded mode). */
    if (server.io_threads_num == 1) return 1;

    if (pending < (server.io_threads_num*2)) {
        if (server.io_threads_active) stopThreadedIO();
        return 1;
    } else {
        return 0;
    }
}

int handleClientsWithPendingWritesUsingThreads(void) {
    int processed = listLength(server.clients_pending_write);
    if (processed == 0) return 0; /* Return ASAP if there are no clients. */

    /* If I/O threads are disabled or we have few clients to serve, don't
     * use I/O threads, but the boring synchronous code. */
    if (server.io_threads_num == 1 || stopThreadedIOIfNeeded()) {
        return handleClientsWithPendingWrites();
    }

    /* Start threads if needed. */
    if (!server.io_threads_active) startThreadedIO();

    /* Distribute the clients across N different lists. */
    listIter li;
    listNode *ln;
    listRewind(server.clients_pending_write,&li);
    int item_id = 0;
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);
        c->flags &= ~CLIENT_PENDING_WRITE;

        /* Remove clients from the list of pending writes since
         * they are going to be closed ASAP. */
        if (c->flags & CLIENT_CLOSE_ASAP) {
            listDelNode(server.clients_pending_write, ln);
            continue;
        }

        int target_id = item_id % server.io_threads_num;
        listAddNodeTail(io_threads_list[target_id],c);
        item_id++;
    }

    /* Give the start condition to the waiting threads, by setting the
     * start condition atomic var. */
    io_threads_op = IO_THREADS_OP_WRITE;
    for (int j = 1; j < server.io_threads_num; j++) {
        int count = listLength(io_threads_list[j]);
        setIOPendingCount(j, count);
    }

    /* Also use the main thread to process a slice of clients. */
    listRewind(io_threads_list[0],&li);
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);
        writeToClient(c,0);
    }
    listEmpty(io_threads_list[0]);

    /* Wait for all the other threads to end their work. */
    while(1) {
        unsigned long pending = 0;
        for (int j = 1; j < server.io_threads_num; j++)
            pending += getIOPendingCount(j);
        if (pending == 0) break;
    }

    /* Run the list of clients again to install the write handler where
     * needed. */
    listRewind(server.clients_pending_write,&li);
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);

        /* Install the write handler if there are pending writes in some
         * of the clients. */
        if (clientHasPendingReplies(c) &&
                connSetWriteHandler(c->conn, sendReplyToClient) == AE_ERR)
        {
            freeClientAsync(c);
        }
    }
    listEmpty(server.clients_pending_write);

    /* Update processed count on server */
    server.stat_io_writes_processed += processed;

    return processed;
}
```

可以看出， `Redis` 的多线程模型并不是那么优雅，主线程完全没必要去等待所有线程的读或写操作，同时 `I/O线程` 又很暴力，直接一个死循环，吃光CPU，实现起来不够好，不过这也确实解决了单线程下 `Redis` 因为 `read` ， `write` 系统调用导致的性能开销（用户缓冲区和内核缓冲区拷贝所带来的）。

在网络中，见到不少人批判 `Redis` 使用自旋锁是一种开倒车的行为，但我不这么认为，使用 `mutex` 或者 `spinlock` 要根据实际情况来，当锁的粒度非常小的时候， `spinlock` 能够省去不必要的上下文切换的开销。

## BIO (三个多线程)

`BIO` 是 `Redis` 的后台线程，主要接收以下三种任务，每个任务都会开一个单独的线程。

```c
/* Background job opcodes */
#define BIO_CLOSE_FILE    0 /* Deferred close(2) syscall. */
#define BIO_AOF_FSYNC     1 /* Deferred AOF fsync. */
#define BIO_LAZY_FREE     2 /* Deferred objects freeing. */
#define BIO_NUM_OPS       3
```

1. 关闭文件描述符。
2. AOF 同步内核缓冲区的数据到文件(fsync)。
3. 惰性释放，将部分内存的释放放到另一个线程。

### bioInit

初始化三个后台线程的互斥量和条件变量。

```c
static pthread_t bio_threads[BIO_NUM_OPS];
static pthread_mutex_t bio_mutex[BIO_NUM_OPS];
static pthread_cond_t bio_newjob_cond[BIO_NUM_OPS];
static pthread_cond_t bio_step_cond[BIO_NUM_OPS];
static list *bio_jobs[BIO_NUM_OPS];
static unsigned long long bio_pending[BIO_NUM_OPS];
#define REDIS_THREAD_STACK_SIZE (1024*1024*4)

void bioInit(void) {
    pthread_attr_t attr;
    pthread_t thread;
    size_t stacksize;
    int j;

    /* Initialization of state vars and objects */
    for (j = 0; j < BIO_NUM_OPS; j++) {
        pthread_mutex_init(&bio_mutex[j],NULL);
        pthread_cond_init(&bio_newjob_cond[j],NULL);
        pthread_cond_init(&bio_step_cond[j],NULL);
        bio_jobs[j] = listCreate();
        bio_pending[j] = 0;
    }

    /* Set the stack size as by default it may be small in some system */
    pthread_attr_init(&attr);
    pthread_attr_getstacksize(&attr,&stacksize);
    if (!stacksize) stacksize = 1; /* The world is full of Solaris Fixes */
    while (stacksize < REDIS_THREAD_STACK_SIZE) stacksize *= 2;
    pthread_attr_setstacksize(&attr, stacksize);

    /* Ready to spawn our threads. We use the single argument the thread
     * function accepts in order to pass the job ID the thread is
     * responsible of. */
    for (j = 0; j < BIO_NUM_OPS; j++) {
        void *arg = (void*)(unsigned long) j;
        if (pthread_create(&thread,&attr,bioProcessBackgroundJobs,arg) != 0) {
            serverLog(LL_WARNING,"Fatal: Can't initialize Background Jobs.");
            exit(1);
        }
        bio_threads[j] = thread;
    }
}
```

### bioProcessBackgroundJobs

设置线程名字，阻塞 `SIGALRM` 信号，然后不断获取任务，根据任务类型进行操作。

```c
struct bio_job {
    time_t time; /* Time at which the job was created. */
    /* Job specific arguments.*/
    int fd; /* Fd for file based background jobs */
    lazy_free_fn *free_fn; /* Function that will free the provided arguments */
    void *free_args[]; /* List of arguments to be passed to the free function */
};

void *bioProcessBackgroundJobs(void *arg) {
    struct bio_job *job;
    unsigned long type = (unsigned long) arg;
    sigset_t sigset;

    /* Check that the type is within the right interval. */
    if (type >= BIO_NUM_OPS) {
        serverLog(LL_WARNING,
            "Warning: bio thread started with wrong type %lu",type);
        return NULL;
    }

    switch (type) {
    case BIO_CLOSE_FILE:
        redis_set_thread_title("bio_close_file");
        break;
    case BIO_AOF_FSYNC:
        redis_set_thread_title("bio_aof_fsync");
        break;
    case BIO_LAZY_FREE:
        redis_set_thread_title("bio_lazy_free");
        break;
    }

    redisSetCpuAffinity(server.bio_cpulist);

    makeThreadKillable();

    pthread_mutex_lock(&bio_mutex[type]);
    /* Block SIGALRM so we are sure that only the main thread will
     * receive the watchdog signal. */
    sigemptyset(&sigset);
    sigaddset(&sigset, SIGALRM);
    if (pthread_sigmask(SIG_BLOCK, &sigset, NULL))
        serverLog(LL_WARNING,
            "Warning: can't mask SIGALRM in bio.c thread: %s", strerror(errno));

    while(1) {
        listNode *ln;

        /* The loop always starts with the lock hold. */
        if (listLength(bio_jobs[type]) == 0) {
            pthread_cond_wait(&bio_newjob_cond[type],&bio_mutex[type]);
            continue;
        }
        /* Pop the job from the queue. */
        ln = listFirst(bio_jobs[type]);
        job = ln->value;
        /* It is now possible to unlock the background system as we know have
         * a stand alone job structure to process.*/
        pthread_mutex_unlock(&bio_mutex[type]);

        /* Process the job accordingly to its type. */
        if (type == BIO_CLOSE_FILE) {
            close(job->fd);
        } else if (type == BIO_AOF_FSYNC) {
            redis_fsync(job->fd);
        } else if (type == BIO_LAZY_FREE) {
            job->free_fn(job->free_args);
        } else {
            serverPanic("Wrong job type in bioProcessBackgroundJobs().");
        }
        zfree(job);

        /* Lock again before reiterating the loop, if there are no longer
         * jobs to process we'll block again in pthread_cond_wait(). */
        pthread_mutex_lock(&bio_mutex[type]);
        listDelNode(bio_jobs[type],ln);
        bio_pending[type]--;

        /* Unblock threads blocked on bioWaitStepOfType() if any. */
        pthread_cond_broadcast(&bio_step_cond[type]);
    }
}
```

### 关闭文件描述符

关闭文件描述符，有可能会删除掉文件，引起阻塞。因为 `Redis` 实现的时候会通过 `rename` 覆盖掉原有文件，将文件描述符的关闭交给 `bio` 子线程避免阻塞。

### 客户端交互 (惰性删除)

客户端操作，无非就是对数据结构进行增删改查，大部分的操作都是 `O(1)`，需要注意的是对集合的查询和聚合操作，同时删除一个 `BigKey` 也会带来性能开销，即使 `Redis` 用的 `jemalloc` 已经性能够好了。因此 `Redis` 选择开子线程的方式，去另一个线程释放内存。

这里有几个条件必须满足。

1. 该对象没有其他人共享了。
2. 这个对象之后一定访问不到。(hash表中为 value 的情况)

这样做也就不需要加锁了。（Lua 好适合这种情况）

```c
void freeObjAsync(robj *key, robj *obj) {
    size_t free_effort = lazyfreeGetFreeEffort(key,obj);
    if (free_effort > LAZYFREE_THRESHOLD && obj->refcount == 1) {
        atomicIncr(lazyfree_objects,1);
        bioCreateLazyFreeJob(lazyfreeFreeObject,1,obj);
    } else {
        decrRefCount(obj);
    }
}
```

因此删除东西最好用 `unlink` ，当其为 BigKey 时，就会放入 `bio` 进行释放。同理 `flushdb` 也可以异步清除。

### AOF 日志

每当执行一条命令后，若开启了 `AOF日志` 则将其记录到 `AOF 缓冲区` （写后日志）。

```c
propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
```

### propagate

AOF日志若开启，则调用 `feedAppendOnlyFile` 将其写入到 `server.aof_buf` 中。

```c
void propagate(struct redisCommand *cmd, int dbid, robj **argv, int argc,
               int flags)
{
    if (!server.replication_allowed)
        return;

    /* Propagate a MULTI request once we encounter the first command which
     * is a write command.
     * This way we'll deliver the MULTI/..../EXEC block as a whole and
     * both the AOF and the replication link will have the same consistency
     * and atomicity guarantees. */
    if (server.in_exec && !server.propagate_in_transaction)
        execCommandPropagateMulti(dbid);

    /* This needs to be unreachable since the dataset should be fixed during 
     * client pause, otherwise data may be lossed during a failover. */
    serverAssert(!(areClientsPaused() && !server.client_pause_in_transaction));

    if (server.aof_state != AOF_OFF && flags & PROPAGATE_AOF)
        feedAppendOnlyFile(cmd,dbid,argv,argc);
    if (flags & PROPAGATE_REPL)
        replicationFeedSlaves(server.slaves,dbid,argv,argc);
}
```

### feedAppendOnlyFile

先检查目前所用的 db， `Redis` 默认有 `REDIS_DEFAULT_DBNUM` 16个db。后将有相对时间过期的指令转换为绝对时间。如果有 `AOF` 子进程在重写日志，则还会将其写入`server.aof_rewrite_buf_blocks` 链表中，同时通过管道传输到子进程。就算子进程宕机了，主进程的 `AOF日志` 也还是完整的。

```c
void feedAppendOnlyFile(struct redisCommand *cmd, int dictid, robj **argv, int argc) {
    sds buf = sdsempty();
    /* The DB this command was targeting is not the same as the last command
     * we appended. To issue a SELECT command is needed. */
    if (dictid != server.aof_selected_db) {
        char seldb[64];

        snprintf(seldb,sizeof(seldb),"%d",dictid);
        buf = sdscatprintf(buf,"*2\r\n$6\r\nSELECT\r\n$%lu\r\n%s\r\n",
            (unsigned long)strlen(seldb),seldb);
        server.aof_selected_db = dictid;
    }

    if (cmd->proc == expireCommand || cmd->proc == pexpireCommand ||
        cmd->proc == expireatCommand) {
        /* Translate EXPIRE/PEXPIRE/EXPIREAT into PEXPIREAT */
        buf = catAppendOnlyExpireAtCommand(buf,cmd,argv[1],argv[2]);
    } else if (cmd->proc == setCommand && argc > 3) {
        robj *pxarg = NULL;
        /* When SET is used with EX/PX argument setGenericCommand propagates them with PX millisecond argument.
         * So since the command arguments are re-written there, we can rely here on the index of PX being 3. */
        if (!strcasecmp(argv[3]->ptr, "px")) {
            pxarg = argv[4];
        }
        /* For AOF we convert SET key value relative time in milliseconds to SET key value absolute time in
         * millisecond. Whenever the condition is true it implies that original SET has been transformed
         * to SET PX with millisecond time argument so we do not need to worry about unit here.*/
        if (pxarg) {
            robj *millisecond = getDecodedObject(pxarg);
            long long when = strtoll(millisecond->ptr,NULL,10);
            when += mstime();

            decrRefCount(millisecond);

            robj *newargs[5];
            newargs[0] = argv[0];
            newargs[1] = argv[1];
            newargs[2] = argv[2];
            newargs[3] = shared.pxat;
            newargs[4] = createStringObjectFromLongLong(when);
            buf = catAppendOnlyGenericCommand(buf,5,newargs);
            decrRefCount(newargs[4]);
        } else {
            buf = catAppendOnlyGenericCommand(buf,argc,argv);
        }
    } else {
        /* All the other commands don't need translation or need the
         * same translation already operated in the command vector
         * for the replication itself. */
        buf = catAppendOnlyGenericCommand(buf,argc,argv);
    }

    /* Append to the AOF buffer. This will be flushed on disk just before
     * of re-entering the event loop, so before the client will get a
     * positive reply about the operation performed. */
    if (server.aof_state == AOF_ON)
        server.aof_buf = sdscatlen(server.aof_buf,buf,sdslen(buf));

    /* If a background append only file rewriting is in progress we want to
     * accumulate the differences between the child DB and the current one
     * in a buffer, so that when the child process will do its work we
     * can append the differences to the new append only file. */
    if (server.child_type == CHILD_TYPE_AOF)
        aofRewriteBufferAppend((unsigned char*)buf,sdslen(buf));

    sdsfree(buf);
}
```

### flushAppendOnlyFile

AOF日志同步到硬盘的策略有三种，第一种不同步，由内核自己决定Flush时机，另一种每次都同步，但是 `fsync` 是会阻塞的，因此还有第三种每秒同步，通过 `BIO` 子线程，每秒去同步 `fsync` 一次，其实说是 `fsync` 也不准确，在 `Linux` 下用的是 `fdatasync` 省去了写文件的元数据开销。

```c
void bioCreateFsyncJob(int fd) {
    struct bio_job *job = zmalloc(sizeof(*job));
    job->fd = fd;

    bioSubmitJob(BIO_AOF_FSYNC, job);
}

void aof_background_fsync(int fd) {
    bioCreateFsyncJob(fd);
}
```

## AOF日志重写 (多进程)

前面提到的 AOF追加日志 是利用了子线程去执行 `fsync` ，而这里则是用子进程去重写 AOF日志。重写日志主要是根据数据库现状重新创建一份新的 AOF日志，如果在主线程上操作，会导致很长时间不能处理客户端的请求。

AOF日志重写要么是由客户端发起 `BGREWRITEAOF`，要么是 `serverCron` 周期性判断是否触发了 `AOF重写` 。

当前没有其他子进程做事情，比如说 RDB快照，AOF重写，或者 loaded module。

同时默认要求大于 `64*1024*1024` 并且对比上一次重写后的文件大小是否增长了 `100%` 。

```c
/* Trigger an AOF rewrite if needed. */
if (server.aof_state == AOF_ON &&
	!hasActiveChildProcess() &&
	server.aof_rewrite_perc &&
	server.aof_current_size > server.aof_rewrite_min_size)
{
	long long base = server.aof_rewrite_base_size ?
		server.aof_rewrite_base_size : 1;
	long long growth = (server.aof_current_size*100/base) - 100;
	if (growth >= server.aof_rewrite_perc) {
		serverLog(LL_NOTICE,"Starting automatic rewriting of AOF on %lld%% growth",growth);
		rewriteAppendOnlyFileBackground();
	}
}
```

### rewriteAppendOnlyFileBackground

`fork` 一个子进程，同时父进程在有子进程的时候， `dict` 不扩容，这主要是因为 `fork` 采用的 `copy on write` ，尽量不去改动进程的内存，避免物理页复制引起内存暴涨，同时一定不要开启 `huge page` ，原因同上。

最后子进程将数据库信息重写，并从父进程的管道中获取新的数据。

```c
int rewriteAppendOnlyFileBackground(void) {
    pid_t childpid;

    if (hasActiveChildProcess()) return C_ERR;
    if (aofCreatePipes() != C_OK) return C_ERR;
    if ((childpid = redisFork(CHILD_TYPE_AOF)) == 0) {
        char tmpfile[256];

        /* Child */
        redisSetProcTitle("redis-aof-rewrite");
        redisSetCpuAffinity(server.aof_rewrite_cpulist);
        snprintf(tmpfile,256,"temp-rewriteaof-bg-%d.aof", (int) getpid());
        if (rewriteAppendOnlyFile(tmpfile) == C_OK) {
            sendChildCowInfo(CHILD_INFO_TYPE_AOF_COW_SIZE, "AOF rewrite");
            exitFromChild(0);
        } else {
            exitFromChild(1);
        }
    } else {
        /* Parent */
        if (childpid == -1) {
            serverLog(LL_WARNING,
                "Can't rewrite append only file in background: fork: %s",
                strerror(errno));
            aofClosePipes();
            return C_ERR;
        }
        serverLog(LL_NOTICE,
            "Background append only file rewriting started by pid %ld",(long) childpid);
        server.aof_rewrite_scheduled = 0;
        server.aof_rewrite_time_start = time(NULL);

        /* We set appendseldb to -1 in order to force the next call to the
         * feedAppendOnlyFile() to issue a SELECT command, so the differences
         * accumulated by the parent into server.aof_rewrite_buf will start
         * with a SELECT statement and it will be safe to merge. */
        server.aof_selected_db = -1;
        replicationScriptCacheFlush();
        return C_OK;
    }
    return C_OK; /* unreached */
}
```

子进程完成之后，父进程会在 `checkChildrenDone` 接受它的返回值。

### checkChildrenDone

`rename` AOF日志文件名，将原文件的文件描述符交给 `bio` 进行 `close` 避免阻塞。

可以从 `ModuleForkDoneHandler` 推论 `Module` 也预留了 `fork` 接口去多进程完成一些模块的自定义任务。

```c
void checkChildrenDone(void) {
    int statloc;
    pid_t pid;

    if ((pid = wait3(&statloc,WNOHANG,NULL)) != 0) {
        int exitcode = WEXITSTATUS(statloc);
        int bysignal = 0;

        if (WIFSIGNALED(statloc)) bysignal = WTERMSIG(statloc);

        /* sigKillChildHandler catches the signal and calls exit(), but we
         * must make sure not to flag lastbgsave_status, etc incorrectly.
         * We could directly terminate the child process via SIGUSR1
         * without handling it, but in this case Valgrind will log an
         * annoying error. */
        if (exitcode == SERVER_CHILD_NOERROR_RETVAL) {
            bysignal = SIGUSR1;
            exitcode = 1;
        }

        if (pid == -1) {
            serverLog(LL_WARNING,"wait3() returned an error: %s. "
                "child_type: %s, child_pid = %d",
                strerror(errno),
                strChildType(server.child_type),
                (int) server.child_pid);
        } else if (pid == server.child_pid) {
            if (server.child_type == CHILD_TYPE_RDB) {
                backgroundSaveDoneHandler(exitcode, bysignal);
            } else if (server.child_type == CHILD_TYPE_AOF) {
                backgroundRewriteDoneHandler(exitcode, bysignal);
            } else if (server.child_type == CHILD_TYPE_MODULE) {
                ModuleForkDoneHandler(exitcode, bysignal);
            } else {
                serverPanic("Unknown child type %d for child pid %d", server.child_type, server.child_pid);
                exit(1);
            }
            if (!bysignal && exitcode == 0) receiveChildInfo();
            resetChildState();
        } else {
            if (!ldbRemoveChild(pid)) {
                serverLog(LL_WARNING,
                          "Warning, detected child with unmatched pid: %ld",
                          (long) pid);
            }
        }

        /* start any pending forks immediately. */
        replicationStartPendingFork();
    }
}
```

## RDB 快照 (多进程)

当使用 `bgsaveCommand` 命令时，类似 `AOF重写` ，也是通过 `fork` 子进程去完成，避免加锁或是减少内存拷贝。当然其也支持自动触发。

```c
/* If there is not a background saving/rewrite in progress check if
* we have to save/rewrite now. */
for (j = 0; j < server.saveparamslen; j++) {
	struct saveparam *sp = server.saveparams+j;

	/* Save if we reached the given amount of changes,
	* the given amount of seconds, and if the latest bgsave was
	* successful or if, in case of an error, at least
	* CONFIG_BGSAVE_RETRY_DELAY seconds already elapsed. */
	if (server.dirty >= sp->changes &&
		server.unixtime-server.lastsave > sp->seconds &&
		(server.unixtime-server.lastbgsave_try >
		CONFIG_BGSAVE_RETRY_DELAY ||
		server.lastbgsave_status == C_OK))
	{
		serverLog(LL_NOTICE,"%d changes in %d seconds. Saving...",
			sp->changes, (int)sp->seconds);
		rdbSaveInfo rsi, *rsiptr;
		rsiptr = rdbPopulateSaveInfo(&rsi);
		rdbSaveBackground(server.rdb_filename,rsiptr);
		break;
	}
}
```

多个检查点，查看是否触发存盘。

```c
int rdbSaveBackground(char *filename, rdbSaveInfo *rsi) {
    pid_t childpid;

    if (hasActiveChildProcess()) return C_ERR;

    server.dirty_before_bgsave = server.dirty;
    server.lastbgsave_try = time(NULL);

    if ((childpid = redisFork(CHILD_TYPE_RDB)) == 0) {
        int retval;

        /* Child */
        redisSetProcTitle("redis-rdb-bgsave");
        redisSetCpuAffinity(server.bgsave_cpulist);
        retval = rdbSave(filename,rsi);
        if (retval == C_OK) {
            sendChildCowInfo(CHILD_INFO_TYPE_RDB_COW_SIZE, "RDB");
        }
        exitFromChild((retval == C_OK) ? 0 : 1);
    } else {
        /* Parent */
        if (childpid == -1) {
            server.lastbgsave_status = C_ERR;
            serverLog(LL_WARNING,"Can't save in background: fork: %s",
                strerror(errno));
            return C_ERR;
        }
        serverLog(LL_NOTICE,"Background saving started by pid %ld",(long) childpid);
        server.rdb_save_time_start = time(NULL);
        server.rdb_child_type = RDB_CHILD_TYPE_DISK;
        return C_OK;
    }
    return C_OK; /* unreached */
}
```

至于 `RDB快照` 传送，也是采用子进程生成，父进程发送，若采用无盘传输，则子进程直接序列化后通过管道发给父进程，父进程再发给从服务器，下一篇会比较详细讨论，这里就不细说了。

## 总结

`Redis` 除了命令执行是单线程，其他的网络和耗时操作尽可能都转化为 多进程或多线程，简化了开发，这一点在游戏服务器上是非常值得借鉴的。

此外， `Redis` 通过子线程释放内存，这一点我认为可以将其引用到 `Lua` 的垃圾回收中，缩短 `stop the world` 的时间，找个时间，写个多线程垃圾回收的版本，看看其效果。[LuaJIT-5.3.6](https://github.com/Yu2erer/LuaJIT-5.3.6)(更新时间 2021年07月04日，已实现 Lua 多线程垃圾回收版本)