---
title: ptmalloc2 内存管理
categories: 内存分配
date: 2021-02-28 10:45:20
keywords: glibc, ptmalloc, 内存分配, malloc, free
tags: [glibc, 内存分配]
---

近期在压测服务器的过程中发现内存随着用户数增加而暴涨，用户数减少内存却没有释放回内核，一开始怀疑是内存泄漏，后面上了工具排查，最终定位到是 `glibc` 的内存管理并没有将内存释放给OS，为了解决这个问题，对 `ptmalloc2` 进行了剖析。

本篇中，不谈论  `brk` 和 `mmap` 系统调用的使用方法，默认环境为 `Linux-x86-64`，讨论的 `ptmalloc2` 的版本为 `glibc 2.17` 的版本。

## chunk

`ptmalloc2` 分配给用户的内存都以 chunk 来表示，可以理解为 chunk 为分配释放内存的载体。

![chunk](/images/chunk.png)

```c
#ifndef INTERNAL_SIZE_T
#define INTERNAL_SIZE_T size_t
#endif

/* The corresponding word size */
#define SIZE_SZ                (sizeof(INTERNAL_SIZE_T))

struct malloc_chunk {
  INTERNAL_SIZE_T      prev_size;  /* Size of previous chunk (if free).  */
  INTERNAL_SIZE_T      size;       /* Size in bytes, including overhead. */
// -----------------------------------------------------------------------
  struct malloc_chunk* fd;         /* double links -- used only if free. */
  struct malloc_chunk* bk;

  /* Only used for large blocks: pointer to next larger size.  */
  struct malloc_chunk* fd_nextsize; /* double links -- used only if free. */
  struct malloc_chunk* bk_nextsize;
};
```

chunk 由以上几部分组成， `INTERNAL_SIZE_T` 为 `size_t` 为了屏蔽平台之间的差异，这里只谈论64位平台，为8字节。

1. `prev_size` 代表着上一个 chunk 的大小，是否有效取决于 `size` 的属性位 `P`。
2. `size` 代表当前 chunk 的大小和属性，其中低3位为属性位 `[A|M|P]`。
3. 当这个 chunk 为空闲时，则会使用 `fd, bk` 将其加入链表中管理。
4. 同上， `fd_nextsize bk_nextsize` 只用在 `large bin` 中，表示 上/下一个大小的指针，加快链表遍历。

<!-- more -->

从上可以得出以下结论：

1. 当前一个 chunk 非空闲时， `prev_size` 无意义，可以被前一个 chunk 所利用。
2. `size` 的低3位为属性位，说明 `size` 一定是 8 的倍数，`A` 为是否为非主分配区，1是0否，`M` 为是否从 `mmap` 中获取， `P` 为前一个 chunk 是否被使用。
3. 分配区分两种，主分配区与非主分配区们。
4. 当 chunk 非空闲时，`fd bk，fd_nextsize bk_nextsize` 都无意义，因此返回给用户的可用内存应为 `size` 之后。

```c
/* size field is or'ed with PREV_INUSE when previous adjacent chunk in use */
#define PREV_INUSE 0x1
/* extract inuse bit of previous chunk */
#define prev_inuse(p)       ((p)->size & PREV_INUSE)
/* size field is or'ed with IS_MMAPPED if the chunk was obtained with mmap() */
#define IS_MMAPPED 0x2
/* check for mmap()'ed chunk */
#define chunk_is_mmapped(p) ((p)->size & IS_MMAPPED)

/* size field is or'ed with NON_MAIN_ARENA if the chunk was obtained
   from a non-main arena.  This is only set immediately before handing
   the chunk to the user, if necessary.  */
#define NON_MAIN_ARENA 0x4

/* check for chunk from non-main arena */
#define chunk_non_main_arena(p) ((p)->size & NON_MAIN_ARENA)

typedef struct malloc_chunk* mchunkptr;

#define chunk2mem(p)   ((void*)((char*)(p) + 2*SIZE_SZ))
#define mem2chunk(mem) ((mchunkptr)((char*)(mem) - 2*SIZE_SZ))

/* The smallest possible chunk */
#define MIN_CHUNK_SIZE        (offsetof(struct malloc_chunk, fd_nextsize))

#define MALLOC_ALIGN_MASK      (MALLOC_ALIGNMENT - 1)

#define MINSIZE  \
  (unsigned long)(((MIN_CHUNK_SIZE+MALLOC_ALIGN_MASK) & ~MALLOC_ALIGN_MASK))

#define request2size(req)                                         \
  (((req) + SIZE_SZ + MALLOC_ALIGN_MASK < MINSIZE)  ?             \
   MINSIZE :                                                      \
   ((req) + SIZE_SZ + MALLOC_ALIGN_MASK) & ~MALLOC_ALIGN_MASK)
```

`mem` 为用户真正可用的内存起始地址，可以看出 最小的 chunk 应该至少 `4*8 = 32字节`，因为 `fd_nextsize 和 bk_nextsize` 只有在 large chunk 才用的上。

`request2size` 将用户申请的内存大小转化为 需要分配的 chunk 大小，用户请求大小 `(req + prev_size + size) = req + 16B`，但是由于内存复用的关系，可以从下一个 chunk 中借用 `prev_size` 的空间（反正对于下一个 chunk 来说，前一个 chunk 已经被使用了，知道前一个 chunk 的大小也没有意义），因此应为 `req + prev_size + size - prev_size(next chunk) = req + 8B`，同时 `req + 8B` 不应小于 `MINSIZE` 所以二者取最大，为 `max(req + 8B, 32B)`。

## bin

`bin` 可以理解桶，存放着 `chunk` ，在 `ptmalloc` 的世界中存在四种 bin。

- fast bins
- unsorted bin
- small bins
- large bins

`fast bins` 是小内存块的缓存，当小内存块被回收时，会先放入 `fast bins`，当下次分配小内存时，就会优先从 `fast bins` 中找，节约时间。

`unsorted bin` 只有一个，回收的 `chunk` 若大于 `fast bins` 的阈值即 `global_max_fast`，则放入 `unsorted bin` 。

`small bins` 顾名思义，就是 `ptmalloc` 觉得小的 chunk，就放进去，呈等差数列的形式递增，每个 bin 的 chunk 均为同一大小，通过 `fd, bk` 链接 chunk 链表。

`large bins` 同上，不过每个 bin 中的 chunk 有大小排序，大的在前，小的在后，通过 `fd_nextsize, bk_nextsize` 快速找到上/下 一个大小节点。

```c
#define NBINS             128
```

`bins` 共有 `small bins` 有 62 个， `large bins` 有 63个， `unsorted bin` 为 1个，总共为 `62+63+1 = 126 个`，其中 bin[0] 和 bin[127] 不用，因此 bins 总数为 128 个。要注意 `fast bins` 并不放入同一数组。

### fast bins

`fast bins` 小内存块的缓存，大小小于 `DEFAULT_MXFAST` 的 chunk 分配与回收都会在 `fast bins` 中先查找，在64位上为 `128字节`，这个参数可以通过 `mallopt` 函数进行修改，最大值为 `160B`。一共有 `9` 个，`bin[0] 和 bin[1]` 没有用上，剩余 7 个 为 small bins 的小 7 个。

```c
#ifndef DEFAULT_MXFAST
#define DEFAULT_MXFAST     (64 * SIZE_SZ / 4)
#endif

typedef struct malloc_chunk* mfastbinptr;
#define fastbin(ar_ptr, idx) ((ar_ptr)->fastbinsY[idx])

/* offset 2 to use otherwise unindexable first 2 bins */
#define fastbin_index(sz) \
  ((((unsigned int)(sz)) >> (SIZE_SZ == 8 ? 4 : 3)) - 2)

/* The maximum fastbin request size we support */
#define MAX_FAST_SIZE     (80 * SIZE_SZ / 4)

#define NFASTBINS  (fastbin_index(request2size(MAX_FAST_SIZE))+1)

#define FASTBIN_CONSOLIDATION_THRESHOLD  (65536UL)
```

`FASTBIN_CONSOLIDATION_THRESHOLD` 表示当回收的 `chunk` 与相邻的 `chunk` 合并后大于该值 `64k`，则合并 `fast bins` 中所有的 `chunk` 放回到 `unsorted bin`

### unsorted bin

`unsorted bin` 只有一个， `fast bins` 合并后的 `chunk` 会先放到这里，从名字可以看出这里面的 `chunk` 没有排序。如果从这里面分配不到合适的 `chunk` 就会将其放到正确的 `small bins` 或者 `large bins` 中。

```c
#define unsorted_chunks(M)          (bin_at(M, 1))
```

### small bins

`small bins` 在64位平台上，共有62个bin，最小的 `chunk` 为 `32字节`，等差数列的公差为 `16B` (SMALLBIN_WIDTH)，最大为 `1008B` 。

```c
#define NSMALLBINS         64
#define SMALLBIN_WIDTH    MALLOC_ALIGNMENT
#define SMALLBIN_CORRECTION (MALLOC_ALIGNMENT > 2 * SIZE_SZ)

#define in_smallbin_range(sz)  \
  ((unsigned long)(sz) < (unsigned long)MIN_LARGE_SIZE)

#define smallbin_index(sz) \
  ((SMALLBIN_WIDTH == 16 ? (((unsigned)(sz)) >> 4) : (((unsigned)(sz)) >> 3)) \
   + SMALLBIN_CORRECTION)
```

将数值带进 `smallbin_index` 会发现最小的 `chunk` 是在 `bin[2]` 上，这是因为为了编程的方便， `small bins` 从2开始，可以形成 `chunk size = 2 * size_t * index` 的等差数列，`bin[1]` 则用来存 `unsorted bin` 而 `bin[0]` 为空。

每个 `bin` 中的 `chunk` 大小相同，通过双向链表链接起来。

### large bins

`large bins` 则接在 `small bins` 之后，`MIN_LARGE_SIZE` 可以看到最小的 `large chunk` 为 `1024B` 。共有63个。

```c
#define MIN_LARGE_SIZE    ((NSMALLBINS - SMALLBIN_CORRECTION) * SMALLBIN_WIDTH)

#define largebin_index_32(sz)                                                \
(((((unsigned long)(sz)) >>  6) <= 38)?  56 + (((unsigned long)(sz)) >>  6): \
 ((((unsigned long)(sz)) >>  9) <= 20)?  91 + (((unsigned long)(sz)) >>  9): \
 ((((unsigned long)(sz)) >> 12) <= 10)? 110 + (((unsigned long)(sz)) >> 12): \
 ((((unsigned long)(sz)) >> 15) <=  4)? 119 + (((unsigned long)(sz)) >> 15): \
 ((((unsigned long)(sz)) >> 18) <=  2)? 124 + (((unsigned long)(sz)) >> 18): \
					126)

#define largebin_index_32_big(sz)                                            \
(((((unsigned long)(sz)) >>  6) <= 45)?  49 + (((unsigned long)(sz)) >>  6): \
 ((((unsigned long)(sz)) >>  9) <= 20)?  91 + (((unsigned long)(sz)) >>  9): \
 ((((unsigned long)(sz)) >> 12) <= 10)? 110 + (((unsigned long)(sz)) >> 12): \
 ((((unsigned long)(sz)) >> 15) <=  4)? 119 + (((unsigned long)(sz)) >> 15): \
 ((((unsigned long)(sz)) >> 18) <=  2)? 124 + (((unsigned long)(sz)) >> 18): \
                                        126)
#define largebin_index_64(sz)                                                \
(((((unsigned long)(sz)) >>  6) <= 48)?  48 + (((unsigned long)(sz)) >>  6): \
 ((((unsigned long)(sz)) >>  9) <= 20)?  91 + (((unsigned long)(sz)) >>  9): \
 ((((unsigned long)(sz)) >> 12) <= 10)? 110 + (((unsigned long)(sz)) >> 12): \
 ((((unsigned long)(sz)) >> 15) <=  4)? 119 + (((unsigned long)(sz)) >> 15): \
 ((((unsigned long)(sz)) >> 18) <=  2)? 124 + (((unsigned long)(sz)) >> 18): \
					126)

#define largebin_index(sz) \
  (SIZE_SZ == 8 ? largebin_index_64 (sz)                                     \
   : MALLOC_ALIGNMENT == 16 ? largebin_index_32_big (sz)                     \
   : largebin_index_32 (sz))

#define bin_index(sz) \
 ((in_smallbin_range(sz)) ? smallbin_index(sz) : largebin_index(sz))
```

`large bins` 中的每个 `bin` 里的 `chunk` 大小为一个区间，从大到小排序，通过双向链表链接，同时为了加快遍历的过程，通过 `fd_nextsize, bk_nextsize` 将前后不同大小的对象链接起来。

```c
typedef struct malloc_chunk* mbinptr;

/* addressing -- note that bin_at(0) does not exist */
#define bin_at(m, i) \
  (mbinptr) (((char *) &((m)->bins[((i) - 1) * 2]))			      \
	     - offsetof (struct malloc_chunk, fd))

/* analog of ++bin */
#define next_bin(b)  ((mbinptr)((char*)(b) + (sizeof(mchunkptr)<<1)))

/* Reminders about list directionality within bins */
#define first(b)     ((b)->fd)
#define last(b)      ((b)->bk)

/* Take a chunk off a bin list */
#define unlink(P, BK, FD) {                                            \
  FD = P->fd;                                                          \
  BK = P->bk;                                                          \
  if (__builtin_expect (FD->bk != P || BK->fd != P, 0))                \
    malloc_printerr (check_action, "corrupted double-linked list", P); \
  else {                                                               \
    FD->bk = BK;                                                       \
    BK->fd = FD;                                                       \
    if (!in_smallbin_range (P->size)				       \
	&& __builtin_expect (P->fd_nextsize != NULL, 0)) {	       \
      assert (P->fd_nextsize->bk_nextsize == P);		       \
      assert (P->bk_nextsize->fd_nextsize == P);		       \
      if (FD->fd_nextsize == NULL) {				       \
	if (P->fd_nextsize == P)				       \
	  FD->fd_nextsize = FD->bk_nextsize = FD;		       \
	else {							       \
	  FD->fd_nextsize = P->fd_nextsize;			       \
	  FD->bk_nextsize = P->bk_nextsize;			       \
	  P->fd_nextsize->bk_nextsize = FD;			       \
	  P->bk_nextsize->fd_nextsize = FD;			       \
	}							       \
      }	else {							       \
	P->fd_nextsize->bk_nextsize = P->bk_nextsize;		       \
	P->bk_nextsize->fd_nextsize = P->fd_nextsize;		       \
      }								       \
    }								       \
  }                                                                    \
}
```

一些辅助宏，可能会好奇为什么有那么多个 对 `malloc_chunk*` 的 `typedef struct`，其实就是 `ptmalloc` 把内存从不同的角度看待的意思，类似 C++ 的 `union` 。

## malloc_par

`malloc_par` 可以理解为一个全局的参数。

```c
struct malloc_par {
  /* Tunable parameters */
  unsigned long    trim_threshold;
  INTERNAL_SIZE_T  top_pad;
  INTERNAL_SIZE_T  mmap_threshold;
#ifdef PER_THREAD
  INTERNAL_SIZE_T  arena_test;
  INTERNAL_SIZE_T  arena_max;
#endif

  /* Memory map support */
  int              n_mmaps;
  int              n_mmaps_max;
  int              max_n_mmaps;
  /* the mmap_threshold is dynamic, until the user sets
     it manually, at which point we need to disable any
     dynamic behavior. */
  int              no_dyn_threshold;

  /* Statistics */
  INTERNAL_SIZE_T  mmapped_mem;
  /*INTERNAL_SIZE_T  sbrked_mem;*/
  /*INTERNAL_SIZE_T  max_sbrked_mem;*/
  INTERNAL_SIZE_T  max_mmapped_mem;
  INTERNAL_SIZE_T  max_total_mem; /* only kept for NO_THREADS */

  /* First address handed out by MORECORE/sbrk.  */
  char*            sbrk_base;
};
```

其中较为重要的参数有：

- trim_threshold，mmap 的收缩阈值 默认128KB
- mmap_threshold，mmap 分配阈值 默认128KB
- n_mmaps_max，mmap 分配内存块的最大数
- no_dyn_threshold，是否关闭动态调整分配阈值 默认开启

以上任一项的修改，都会关闭 动态调整分配阈值，之所以有这个机制，是为了减少 `mmap` 的次数，因为 `mmap` 的效率远远低于 `brk`。更多细节建议阅读 [mallopt(3) — Linux manual page](https://man7.org/linux/man-pages/man3/mallopt.3.html)。

但是使用 `mmap` 分配的内存有一个好处，当释放的时候可以直接还回给内核，而且当虚拟内存空间有洞时，只能用 `mmap` 进行分配，在本次服务器压测的过程中，通过修改以下配置达到释放内存的目的，但是强烈不建议使用， `mmap` 分配的内存以页为单位，哪怕你申请 `1B`，都会变成向内核申请一块页大小的内存块，仅适合用于排查内存不释放究竟位于 `ptmalloc2` 的哪个地方。

```c
#include <malloc.h>

mallopt(M_MMAP_THRESHOLD, 0);
mallopt(M_MMAP_MAX, 1e9);
```

## malloc_state

前面提到过，申请出来的 `chunk` 可能来自三个地方。

1. mmap 直接申请
2. 主分配区分配
3. 非主分配区分配

`malloc_state` 就是用来管理分配区的。非主分配区的出现主要是为了缓解多线程的场景下，减少锁争用的情况，一般情况是一个线程对应一个非主分配区，尽管是这样还是会进行加锁，因此性能不佳，分配区达到CPU核心数时，则会停止创建非主分配区，转而进行复用，复用也很简单，轮询判断是否可以加锁。

```c
#define FASTCHUNKS_BIT        (1U)

#define have_fastchunks(M)     (((M)->flags &  FASTCHUNKS_BIT) == 0)
#define clear_fastchunks(M)    catomic_or (&(M)->flags, FASTCHUNKS_BIT)
#define set_fastchunks(M)      catomic_and (&(M)->flags, ~FASTCHUNKS_BIT)

#define NONCONTIGUOUS_BIT     (2U)

#define contiguous(M)          (((M)->flags &  NONCONTIGUOUS_BIT) == 0)
#define noncontiguous(M)       (((M)->flags &  NONCONTIGUOUS_BIT) != 0)
#define set_noncontiguous(M)   ((M)->flags |=  NONCONTIGUOUS_BIT)
#define set_contiguous(M)      ((M)->flags &= ~NONCONTIGUOUS_BIT)

struct malloc_state {
  /* Serialize access.  */
  mutex_t mutex;

  /* Flags (formerly in max_fast).  */
  int flags;

  /* Fastbins */
  mfastbinptr      fastbinsY[NFASTBINS];

  /* Base of the topmost chunk -- not otherwise kept in a bin */
  mchunkptr        top;

  /* The remainder from the most recent split of a small request */
  mchunkptr        last_remainder;

  /* Normal bins packed as described above */
  mchunkptr        bins[NBINS * 2 - 2];

  /* Bitmap of bins */
  unsigned int     binmap[BINMAPSIZE];

  /* Linked list */
  struct malloc_state *next;

#ifdef PER_THREAD
  /* Linked list for free arenas.  */
  struct malloc_state *next_free;
#endif

  /* Memory allocated from the system in this arena.  */
  INTERNAL_SIZE_T system_mem;
  INTERNAL_SIZE_T max_system_mem;
};
```

- mutex，为了支持多线程
- flags，bit0 表示是否有 fast bin chunk，bit1 表示是否能返回连续的虚拟地址空间，显然只有主分配区才能做到，因为在未达到 mmap阈值 时，只有主分配区是用 `brk` 进行分配，而非主分配区都是采用 `mmap` 。但也有一种情况，主分配区用 `mmap` ，静态链接 `glibc` 的时候，就会禁用 `brk` ，我想是担心出现洞。
- fastbinY，就是存储 fast bins 的数组，NFASTBINS 为 10。
- top，top chunk 前面一系列的 bin 分配不到内存，就从 top chunk 里拿，释放回内核也是从 top chunk 开始释放，即从高地址开始释放 类似于 stack。
- last_remainder，分配区若上次分配 small chunk 且还有剩余，则存入这个指针。
- bins，即 unsorted bin + small bins + large bins = 1 + 62 + 63 = 125，bin[0] 和 bin[127] 没有用，但是 bins 的大小为 254，这主要是为了节约内存，可以理解为它只是用数组来申请内存，然后将其转化为双向链表的结构体。
- binmap，标识 bit 指向的 bin 是否有空闲 chunk。
- next，链接分配区。
- system_mem，当前分配区已分配内存大小，可通过 `malloc_stats(3)` 进行查看。

![largebin](/images/largebin.png)

## 内存分配

本节先通过文字描述一遍内存分配流程，再进行代码分析。malloc glibc 内部名字为 `__libc_malloc`

1. ptmalloc 是否没有初始化或者有钩子函数，调用指定函数(如果使用 其他malloc，就在此处返回了)。
2. 查找合适的分配区，加锁,，调用 `_int_malloc` 在分配区中分配内存，如果分配失败，则解锁分配区并换一个分配区，如果分配区的数量少于CPU核心数，则默认是新建一个非主分配区，并调用 `mmap` 分配一块大内存并设置好 top chunk。
3. 进入 `_int_malloc` 逻辑。
4. chunk_size  ≤ `128B`，是则在 fast bins 中查找并返回，否则下一步。
5. 若 chunk_size < `1008B` 则在 small bins 进行分配，优先用 `last_remainder`，从尾节点先分配，头结点还回，使每一个 `chunk` 都有机会被用上，成功则返回，否则下一步。
6. 若到这一步要么是 还没找到合适的内存，或者是 chunk_size 是一个 大的请求，则先遍历 fast bins，将相邻的 chunk 进行合并，放入到 unsorted bin 中，从 unstorted bin 中进行查找，一边找一边将其放入正确的 bins 中，同时在 binmap中进行标记。如果找到则返回给用户，若 `unsorted bin` 只有一个 chunk，且 该 chunk 为 last remainder chunk，且我们需要的是一个 small bin chunk，则将其切分，剩余部分依然不动，此步骤最多尝试 `MAX_ITERS（10000）`次，防止因为 unsored bin 的 chunk 过多而影响分配效率。
7. 最后还是找不到，那就在 `large bins` 中按照最佳匹配的原则，从更大的 bins 中进行查找，查找方式是通过遍历 `binmap`，找一个合适的 `chunk`，并将其切分，成功则返回，否则下一步。
8. 只好从 `top chunk` 进行切分了（回收的时候也是从 `top chunk` 进行切分，埋下了长周期的内存无法回收导致内存暴涨的伏笔），不成功下一步。
9. 又开始打 `fast bins` 的注意了，主要是 `fast bins` 回收的时候没有加锁，而是采用 `lock-free` 方式(Compareand-Swap)回收，因此有可能里面已经有 chunk 了，这时候又开始合并，放入 unsorted bin，但是却是从 small bins 或从 large bins 中再去查找，这主要是因为，在第 5,6 步的时候，如果在 small bins 中找不到合适的 chunk，就合并 fast bins 到 unsorted bin，然后放回到指定的 small bins 和 large bins 中，但是并没有再去扫描一下相应的 bins，这里相当于再补上一刀。
10. 山穷水尽了，调用 `sysmalloc` 向内核申请内存了，先看看是否超过 mmap 分配的阈值，若没超过，主分配区采用 `brk` 扩充 top chunk 大小(若静态链接 `brk` 会被禁用，此时采用 `mmap` ），非主分配区则默认用 `mmap` 进行扩充，超过就更不用讲了，直接 `mmap` 分配给用户，释放也是直接释放即可。
11. 分配成功。解锁分配区并返回。

```c
#define arena_get(ptr, size) do { \
  arena_lookup(ptr); \
  arena_lock(ptr, size); \
} while(0)

#define arena_lookup(ptr) do { \
  void *vptr = NULL; \
  ptr = (mstate)tsd_getspecific(arena_key, vptr); \
} while(0)

#ifdef PER_THREAD
# define arena_lock(ptr, size) do { \
  if(ptr) \
    (void)mutex_lock(&ptr->mutex); \
  else \
    ptr = arena_get2(ptr, (size), NULL); \
} while(0)
#else
# define arena_lock(ptr, size) do { \
  if(ptr && !mutex_trylock(&ptr->mutex)) { \
    THREAD_STAT(++(ptr->stat_lock_direct)); \
  } else \
    ptr = arena_get2(ptr, (size), NULL); \
} while(0)
#endif

static mstate
internal_function
arena_get2(mstate a_tsd, size_t size, mstate avoid_arena)
{
  mstate a;

#ifdef PER_THREAD
  static size_t narenas_limit;

  a = get_free_list ();
  if (a == NULL)
    {
      /* Nothing immediately available, so generate a new arena.  */
      if (narenas_limit == 0)
	{
	  if (mp_.arena_max != 0)
	    narenas_limit = mp_.arena_max;
	  else if (narenas > mp_.arena_test)
	    {
	      int n  = __get_nprocs ();

	      if (n >= 1)
		narenas_limit = NARENAS_FROM_NCORES (n);
	      else
		/* We have no information about the system.  Assume two
		   cores.  */
		narenas_limit = NARENAS_FROM_NCORES (2);
	    }
	}
    repeat:;
      size_t n = narenas;
      /* NB: the following depends on the fact that (size_t)0 - 1 is a
	 very large number and that the underflow is OK.  If arena_max
	 is set the value of arena_test is irrelevant.  If arena_test
	 is set but narenas is not yet larger or equal to arena_test
	 narenas_limit is 0.  There is no possibility for narenas to
	 be too big for the test to always fail since there is not
	 enough address space to create that many arenas.  */
      if (__builtin_expect (n <= narenas_limit - 1, 0))
	{
	  if (catomic_compare_and_exchange_bool_acq (&narenas, n + 1, n))
	    goto repeat;
	  a = _int_new_arena (size);
	  if (__builtin_expect (a == NULL, 0))
	    catomic_decrement (&narenas);
	}
      else
	a = reused_arena (avoid_arena);
    }
#else
  if(!a_tsd)
    a = a_tsd = &main_arena;
  else {
    a = a_tsd->next;
    if(!a) {
      /* This can only happen while initializing the new arena. */
      (void)mutex_lock(&main_arena.mutex);
      THREAD_STAT(++(main_arena.stat_lock_wait));
      return &main_arena;
    }
  }

  /* Check the global, circularly linked list for available arenas. */
  bool retried = false;
 repeat:
  do {
    if(!mutex_trylock(&a->mutex)) {
      if (retried)
	(void)mutex_unlock(&list_lock);
      THREAD_STAT(++(a->stat_lock_loop));
      tsd_setspecific(arena_key, (void *)a);
      return a;
    }
    a = a->next;
  } while(a != a_tsd);

  /* If not even the list_lock can be obtained, try again.  This can
     happen during `atfork', or for example on systems where thread
     creation makes it temporarily impossible to obtain _any_
     locks. */
  if(!retried && mutex_trylock(&list_lock)) {
    /* We will block to not run in a busy loop.  */
    (void)mutex_lock(&list_lock);

    /* Since we blocked there might be an arena available now.  */
    retried = true;
    a = a_tsd;
    goto repeat;
  }

  /* Nothing immediately available, so generate a new arena.  */
  a = _int_new_arena(size);
  (void)mutex_unlock(&list_lock);
#endif

  return a;
}
```

可以看出 分配区是绑定在线程的，但并不代表每个线程独占一个分配区，因此都要加锁，导致性能无论在单线程还是多线程上都不佳。同时 分配区的数量取决于 CPU核心数，若获取不到则默认为 8。

```c
void*
__libc_malloc(size_t bytes)
{
  mstate ar_ptr;
  void *victim;

  __malloc_ptr_t (*hook) (size_t, const __malloc_ptr_t)
    = force_reg (__malloc_hook);
  if (__builtin_expect (hook != NULL, 0))
    return (*hook)(bytes, RETURN_ADDRESS (0));

  arena_lookup(ar_ptr);

  arena_lock(ar_ptr, bytes);
  if(!ar_ptr)
    return 0;
  victim = _int_malloc(ar_ptr, bytes);
  if(!victim) {
    ar_ptr = arena_get_retry(ar_ptr, bytes);
    if (__builtin_expect(ar_ptr != NULL, 1)) {
      victim = _int_malloc(ar_ptr, bytes);
      (void)mutex_unlock(&ar_ptr->mutex);
    }
  } else
    (void)mutex_unlock(&ar_ptr->mutex);
  assert(!victim || chunk_is_mmapped(mem2chunk(victim)) ||
	 ar_ptr == arena_for_chunk(mem2chunk(victim)));
  return victim;
}
```

### _int_malloc

`_int_malloc` 可以说是 `ptmalloc2` 中最重要的函数之一，它可以说是 `ptmalloc2` 内存分配策略的实现。

```c
static void*
_int_malloc(mstate av, size_t bytes)
{
  INTERNAL_SIZE_T nb;               /* normalized request size */
  unsigned int    idx;              /* associated bin index */
  mbinptr         bin;              /* associated bin */

  mchunkptr       victim;           /* inspected/selected chunk */
  INTERNAL_SIZE_T size;             /* its size */
  int             victim_index;     /* its bin index */

  mchunkptr       remainder;        /* remainder from a split */
  unsigned long   remainder_size;   /* its size */

  unsigned int    block;            /* bit map traverser */
  unsigned int    bit;              /* bit map traverser */
  unsigned int    map;              /* current word of binmap */

  mchunkptr       fwd;              /* misc temp for linking */
  mchunkptr       bck;              /* misc temp for linking */

  const char *errstr = NULL;

  /*
    Convert request size to internal form by adding SIZE_SZ bytes
    overhead plus possibly more to obtain necessary alignment and/or
    to obtain a size of at least MINSIZE, the smallest allocatable
    size. Also, checked_request2size traps (returning 0) request sizes
    that are so large that they wrap around zero when padded and
    aligned.
  */

  checked_request2size(bytes, nb);

  /*
    If the size qualifies as a fastbin, first check corresponding bin.
    This code is safe to execute even if av is not yet initialized, so we
    can try it without checking, which saves some time on this fast path.
  */

  if ((unsigned long)(nb) <= (unsigned long)(get_max_fast ())) {
    idx = fastbin_index(nb);
    mfastbinptr* fb = &fastbin (av, idx);
    mchunkptr pp = *fb;
    do
      {
	victim = pp;
	if (victim == NULL)
	  break;
      }
    while ((pp = catomic_compare_and_exchange_val_acq (fb, victim->fd, victim))
	   != victim);
    if (victim != 0) {
      if (__builtin_expect (fastbin_index (chunksize (victim)) != idx, 0))
	{
	  errstr = "malloc(): memory corruption (fast)";
	errout:
	  malloc_printerr (check_action, errstr, chunk2mem (victim));
	  return NULL;
	}
      check_remalloced_chunk(av, victim, nb);
      void *p = chunk2mem(victim);
      if (__builtin_expect (perturb_byte, 0))
	alloc_perturb (p, bytes);
      return p;
    }
  }
```

以上为内存分配的第 4 步 `fast bins`，这里采用了 CAS 操作，换句话说 回收 `fast bins` 不需要加锁。

```c
if (in_smallbin_range(nb)) {
    idx = smallbin_index(nb);
    bin = bin_at(av,idx);

    if ( (victim = last(bin)) != bin) {
      if (victim == 0) /* initialization check */
	malloc_consolidate(av);
      else {
	bck = victim->bk;
	if (__builtin_expect (bck->fd != victim, 0))
	  {
	    errstr = "malloc(): smallbin double linked list corrupted";
	    goto errout;
	  }
	set_inuse_bit_at_offset(victim, nb);
	bin->bk = bck;
	bck->fd = bin;

	if (av != &main_arena)
	  victim->size |= NON_MAIN_ARENA;
	check_malloced_chunk(av, victim, nb);
	void *p = chunk2mem(victim);
	if (__builtin_expect (perturb_byte, 0))
	  alloc_perturb (p, bytes);
	return p;
      }
    }
  }
```

内存分配第五步 `small bins` 至此结束。

```c
else {
    idx = largebin_index(nb);
    if (have_fastchunks(av))
      malloc_consolidate(av);
  }

  /*
    Process recently freed or remaindered chunks, taking one only if
    it is exact fit, or, if this a small request, the chunk is remainder from
    the most recent non-exact fit.  Place other traversed chunks in
    bins.  Note that this step is the only place in any routine where
    chunks are placed in bins.

    The outer loop here is needed because we might not realize until
    near the end of malloc that we should have consolidated, so must
    do so and retry. This happens at most once, and only when we would
    otherwise need to expand memory to service a "small" request.
  */

  for(;;) {

    int iters = 0;
    while ( (victim = unsorted_chunks(av)->bk) != unsorted_chunks(av)) {
      bck = victim->bk;
      if (__builtin_expect (victim->size <= 2 * SIZE_SZ, 0)
	  || __builtin_expect (victim->size > av->system_mem, 0))
	malloc_printerr (check_action, "malloc(): memory corruption",
			 chunk2mem (victim));
      size = chunksize(victim);

      /*
	 If a small request, try to use last remainder if it is the
	 only chunk in unsorted bin.  This helps promote locality for
	 runs of consecutive small requests. This is the only
	 exception to best-fit, and applies only when there is
	 no exact fit for a small chunk.
      */

      if (in_smallbin_range(nb) &&
	  bck == unsorted_chunks(av) &&
	  victim == av->last_remainder &&
	  (unsigned long)(size) > (unsigned long)(nb + MINSIZE)) {

	/* split and reattach remainder */
	remainder_size = size - nb;
	remainder = chunk_at_offset(victim, nb);
	unsorted_chunks(av)->bk = unsorted_chunks(av)->fd = remainder;
	av->last_remainder = remainder;
	remainder->bk = remainder->fd = unsorted_chunks(av);
	if (!in_smallbin_range(remainder_size))
	  {
	    remainder->fd_nextsize = NULL;
	    remainder->bk_nextsize = NULL;
	  }

	set_head(victim, nb | PREV_INUSE |
		 (av != &main_arena ? NON_MAIN_ARENA : 0));
	set_head(remainder, remainder_size | PREV_INUSE);
	set_foot(remainder, remainder_size);

	check_malloced_chunk(av, victim, nb);
	void *p = chunk2mem(victim);
	if (__builtin_expect (perturb_byte, 0))
	  alloc_perturb (p, bytes);
	return p;
      }

      /* remove from unsorted list */
      unsorted_chunks(av)->bk = bck;
      bck->fd = unsorted_chunks(av);

      /* Take now instead of binning if exact fit */

      if (size == nb) {
	set_inuse_bit_at_offset(victim, size);
	if (av != &main_arena)
	  victim->size |= NON_MAIN_ARENA;
	check_malloced_chunk(av, victim, nb);
	void *p = chunk2mem(victim);
	if (__builtin_expect (perturb_byte, 0))
	  alloc_perturb (p, bytes);
	return p;
      }

      /* place chunk in bin */

      if (in_smallbin_range(size)) {
	victim_index = smallbin_index(size);
	bck = bin_at(av, victim_index);
	fwd = bck->fd;
      }
      else {
	victim_index = largebin_index(size);
	bck = bin_at(av, victim_index);
	fwd = bck->fd;

	/* maintain large bins in sorted order */
	if (fwd != bck) {
	  /* Or with inuse bit to speed comparisons */
	  size |= PREV_INUSE;
	  /* if smaller than smallest, bypass loop below */
	  assert((bck->bk->size & NON_MAIN_ARENA) == 0);
	  if ((unsigned long)(size) < (unsigned long)(bck->bk->size)) {
	    fwd = bck;
	    bck = bck->bk;

	    victim->fd_nextsize = fwd->fd;
	    victim->bk_nextsize = fwd->fd->bk_nextsize;
	    fwd->fd->bk_nextsize = victim->bk_nextsize->fd_nextsize = victim;
	  }
	  else {
	    assert((fwd->size & NON_MAIN_ARENA) == 0);
	    while ((unsigned long) size < fwd->size)
	      {
		fwd = fwd->fd_nextsize;
		assert((fwd->size & NON_MAIN_ARENA) == 0);
	      }

	    if ((unsigned long) size == (unsigned long) fwd->size)
	      /* Always insert in the second position.  */
	      fwd = fwd->fd;
	    else
	      {
		victim->fd_nextsize = fwd;
		victim->bk_nextsize = fwd->bk_nextsize;
		fwd->bk_nextsize = victim;
		victim->bk_nextsize->fd_nextsize = victim;
	      }
	    bck = fwd->bk;
	  }
	} else
	  victim->fd_nextsize = victim->bk_nextsize = victim;
      }

      mark_bin(av, victim_index);
      victim->bk = bck;
      victim->fd = fwd;
      fwd->bk = victim;
      bck->fd = victim;

#define MAX_ITERS	10000
      if (++iters >= MAX_ITERS)
	break;
    }
```

第六步至此结束，到这要么是 `small bins` 不满足 或者 本身请求就是一个 大请求，因此先整合 `fast bins` 的 chunk，将其放入 `unsorted bin` 中，一边又从 `unsorted bin` 中查找，顺便放入正确的 bins 中，如果碰巧就找到了 那就返回就完事了，同时还会设置 `binmap`，方便之后搜索。

```c
/*
      If a large request, scan through the chunks of current bin in
      sorted order to find smallest that fits.  Use the skip list for this.
    */

    if (!in_smallbin_range(nb)) {
      bin = bin_at(av, idx);

      /* skip scan if empty or largest chunk is too small */
      if ((victim = first(bin)) != bin &&
	  (unsigned long)(victim->size) >= (unsigned long)(nb)) {

	victim = victim->bk_nextsize;
	while (((unsigned long)(size = chunksize(victim)) <
		(unsigned long)(nb)))
	  victim = victim->bk_nextsize;

	/* Avoid removing the first entry for a size so that the skip
	   list does not have to be rerouted.  */
	if (victim != last(bin) && victim->size == victim->fd->size)
	  victim = victim->fd;

	remainder_size = size - nb;
	unlink(victim, bck, fwd);

	/* Exhaust */
	if (remainder_size < MINSIZE)  {
	  set_inuse_bit_at_offset(victim, size);
	  if (av != &main_arena)
	    victim->size |= NON_MAIN_ARENA;
	}
	/* Split */
	else {
	  remainder = chunk_at_offset(victim, nb);
	  /* We cannot assume the unsorted list is empty and therefore
	     have to perform a complete insert here.  */
	  bck = unsorted_chunks(av);
	  fwd = bck->fd;
	  if (__builtin_expect (fwd->bk != bck, 0))
	    {
	      errstr = "malloc(): corrupted unsorted chunks";
	      goto errout;
	    }
	  remainder->bk = bck;
	  remainder->fd = fwd;
	  bck->fd = remainder;
	  fwd->bk = remainder;
	  if (!in_smallbin_range(remainder_size))
	    {
	      remainder->fd_nextsize = NULL;
	      remainder->bk_nextsize = NULL;
	    }
	  set_head(victim, nb | PREV_INUSE |
		   (av != &main_arena ? NON_MAIN_ARENA : 0));
	  set_head(remainder, remainder_size | PREV_INUSE);
	  set_foot(remainder, remainder_size);
	}
	check_malloced_chunk(av, victim, nb);
	void *p = chunk2mem(victim);
	if (__builtin_expect (perturb_byte, 0))
	  alloc_perturb (p, bytes);
	return p;
      }
    }

    /*
      Search for a chunk by scanning bins, starting with next largest
      bin. This search is strictly by best-fit; i.e., the smallest
      (with ties going to approximately the least recently used) chunk
      that fits is selected.

      The bitmap avoids needing to check that most blocks are nonempty.
      The particular case of skipping all bins during warm-up phases
      when no chunks have been returned yet is faster than it might look.
    */

    ++idx;
    bin = bin_at(av,idx);
    block = idx2block(idx);
    map = av->binmap[block];
    bit = idx2bit(idx);

    for (;;) {

      /* Skip rest of block if there are no more set bits in this block.  */
      if (bit > map || bit == 0) {
	do {
	  if (++block >= BINMAPSIZE)  /* out of bins */
	    goto use_top;
	} while ( (map = av->binmap[block]) == 0);

	bin = bin_at(av, (block << BINMAPSHIFT));
	bit = 1;
      }

      /* Advance to bin with set bit. There must be one. */
      while ((bit & map) == 0) {
	bin = next_bin(bin);
	bit <<= 1;
	assert(bit != 0);
      }

      /* Inspect the bin. It is likely to be non-empty */
      victim = last(bin);

      /*  If a false alarm (empty bin), clear the bit. */
      if (victim == bin) {
	av->binmap[block] = map &= ~bit; /* Write through */
	bin = next_bin(bin);
	bit <<= 1;
      }

      else {
	size = chunksize(victim);

	/*  We know the first chunk in this bin is big enough to use. */
	assert((unsigned long)(size) >= (unsigned long)(nb));

	remainder_size = size - nb;

	/* unlink */
	unlink(victim, bck, fwd);

	/* Exhaust */
	if (remainder_size < MINSIZE) {
	  set_inuse_bit_at_offset(victim, size);
	  if (av != &main_arena)
	    victim->size |= NON_MAIN_ARENA;
	}

	/* Split */
	else {
	  remainder = chunk_at_offset(victim, nb);

	  /* We cannot assume the unsorted list is empty and therefore
	     have to perform a complete insert here.  */
	  bck = unsorted_chunks(av);
	  fwd = bck->fd;
	  if (__builtin_expect (fwd->bk != bck, 0))
	    {
	      errstr = "malloc(): corrupted unsorted chunks 2";
	      goto errout;
	    }
	  remainder->bk = bck;
	  remainder->fd = fwd;
	  bck->fd = remainder;
	  fwd->bk = remainder;

	  /* advertise as last remainder */
	  if (in_smallbin_range(nb))
	    av->last_remainder = remainder;
	  if (!in_smallbin_range(remainder_size))
	    {
	      remainder->fd_nextsize = NULL;
	      remainder->bk_nextsize = NULL;
	    }
	  set_head(victim, nb | PREV_INUSE |
		   (av != &main_arena ? NON_MAIN_ARENA : 0));
	  set_head(remainder, remainder_size | PREV_INUSE);
	  set_foot(remainder, remainder_size);
	}
	check_malloced_chunk(av, victim, nb);
	void *p = chunk2mem(victim);
	if (__builtin_expect (perturb_byte, 0))
	  alloc_perturb (p, bytes);
	return p;
      }
    }
```

第七步主要是从更大的 `bins` 中进行查找，然后进行切分，如果切分后剩余的内存太小则一起送给用户，还有很多的话，则将其插入到 `unsorted bin` ，分配的是小内存则还会将其剩余部分保存到 `last_remainder` 供下次优先分配。

```c
use_top:
    /*
      If large enough, split off the chunk bordering the end of memory
      (held in av->top). Note that this is in accord with the best-fit
      search rule.  In effect, av->top is treated as larger (and thus
      less well fitting) than any other available chunk since it can
      be extended to be as large as necessary (up to system
      limitations).

      We require that av->top always exists (i.e., has size >=
      MINSIZE) after initialization, so if it would otherwise be
      exhausted by current request, it is replenished. (The main
      reason for ensuring it exists is that we may need MINSIZE space
      to put in fenceposts in sysmalloc.)
    */

    victim = av->top;
    size = chunksize(victim);

    if ((unsigned long)(size) >= (unsigned long)(nb + MINSIZE)) {
      remainder_size = size - nb;
      remainder = chunk_at_offset(victim, nb);
      av->top = remainder;
      set_head(victim, nb | PREV_INUSE |
	       (av != &main_arena ? NON_MAIN_ARENA : 0));
      set_head(remainder, remainder_size | PREV_INUSE);

      check_malloced_chunk(av, victim, nb);
      void *p = chunk2mem(victim);
      if (__builtin_expect (perturb_byte, 0))
	alloc_perturb (p, bytes);
      return p;
    }
```

第八步，从 `top chunk` 中进行切分，回收也是从 `top chunk` 从高往低释放回给内核，因此如果后分配的没有释放，会导致先分配的已释放都没办法还回给内核。

```c
/* When we are using atomic ops to free fast chunks we can get
       here for all block sizes.  */
    else if (have_fastchunks(av)) {
      malloc_consolidate(av);
      /* restore original bin index */
      if (in_smallbin_range(nb))
	idx = smallbin_index(nb);
      else
	idx = largebin_index(nb);
    }
```

第九步，`fast bins`，因为 `fast bins` 的回收是不需要锁的，有可能回收了。

```c
/*
       Otherwise, relay to handle system-dependent cases
    */
    else {
      void *p = sysmalloc(nb, av);
      if (p != NULL && __builtin_expect (perturb_byte, 0))
	alloc_perturb (p, bytes);
      return p;
    }
  }
}
```

第十步，一滴也没有了，通过 `sysmalloc` 从内核申请内存。

### sysmalloc

主分配区用 `brk` 申请一块内存进行内存分配，若是静态链接 `glibc` 则只能用 `mmap` 防止有洞。非主分配区则只能用 `mmap` 。还会先看看所需内存是否大于 `mmap` 的阈值，大过就直接采用 `mmap` 返回。但是 `mmap` 的效率不高，在内核中属于串行运作，因此 `ptmalloc2` 会动态调整这个阈值（默认为 `128KB`，最大可达 `32MB`）换句话说你要想百分百用 `mmap` 申请内存，那请你申请大于 `32MB` 的内存。

```c
static void* sysmalloc(INTERNAL_SIZE_T nb, mstate av)
{
  mchunkptr       old_top;        /* incoming value of av->top */
  INTERNAL_SIZE_T old_size;       /* its size */
  char*           old_end;        /* its end address */

  long            size;           /* arg to first MORECORE or mmap call */
  char*           brk;            /* return value from MORECORE */

  long            correction;     /* arg to 2nd MORECORE call */
  char*           snd_brk;        /* 2nd return val */

  INTERNAL_SIZE_T front_misalign; /* unusable bytes at front of new space */
  INTERNAL_SIZE_T end_misalign;   /* partial page left at end of new space */
  char*           aligned_brk;    /* aligned offset into brk */

  mchunkptr       p;              /* the allocated/returned chunk */
  mchunkptr       remainder;      /* remainder from allocation */
  unsigned long   remainder_size; /* its size */

  unsigned long   sum;            /* for updating stats */

  size_t          pagemask  = GLRO(dl_pagesize) - 1;
  bool            tried_mmap = false;

  /*
    If have mmap, and the request size meets the mmap threshold, and
    the system supports mmap, and there are few enough currently
    allocated mmapped regions, try to directly map this request
    rather than expanding top.
  */

  if ((unsigned long)(nb) >= (unsigned long)(mp_.mmap_threshold) &&
      (mp_.n_mmaps < mp_.n_mmaps_max)) {

    char* mm;             /* return value from mmap call*/

  try_mmap:
    /*
      Round up size to nearest page.  For mmapped chunks, the overhead
      is one SIZE_SZ unit larger than for normal chunks, because there
      is no following chunk whose prev_size field could be used.

      See the front_misalign handling below, for glibc there is no
      need for further alignments unless we have have high alignment.
    */
    if (MALLOC_ALIGNMENT == 2 * SIZE_SZ)
      size = (nb + SIZE_SZ + pagemask) & ~pagemask;
    else
      size = (nb + SIZE_SZ + MALLOC_ALIGN_MASK + pagemask) & ~pagemask;
    tried_mmap = true;

    /* Don't try if size wraps around 0 */
    if ((unsigned long)(size) > (unsigned long)(nb)) {

      mm = (char*)(MMAP(0, size, PROT_READ|PROT_WRITE, 0));

      if (mm != MAP_FAILED) {

	/*
	  The offset to the start of the mmapped region is stored
	  in the prev_size field of the chunk. This allows us to adjust
	  returned start address to meet alignment requirements here
	  and in memalign(), and still be able to compute proper
	  address argument for later munmap in free() and realloc().
	*/

	if (MALLOC_ALIGNMENT == 2 * SIZE_SZ)
	  {
	    /* For glibc, chunk2mem increases the address by 2*SIZE_SZ and
	       MALLOC_ALIGN_MASK is 2*SIZE_SZ-1.  Each mmap'ed area is page
	       aligned and therefore definitely MALLOC_ALIGN_MASK-aligned.  */
	    assert (((INTERNAL_SIZE_T)chunk2mem(mm) & MALLOC_ALIGN_MASK) == 0);
	    front_misalign = 0;
	  }
	else
	  front_misalign = (INTERNAL_SIZE_T)chunk2mem(mm) & MALLOC_ALIGN_MASK;
	if (front_misalign > 0) {
	  correction = MALLOC_ALIGNMENT - front_misalign;
	  p = (mchunkptr)(mm + correction);
	  p->prev_size = correction;
	  set_head(p, (size - correction) |IS_MMAPPED);
	}
	else
	  {
	    p = (mchunkptr)mm;
	    set_head(p, size|IS_MMAPPED);
	  }

	/* update statistics */

	if (++mp_.n_mmaps > mp_.max_n_mmaps)
	  mp_.max_n_mmaps = mp_.n_mmaps;

	sum = mp_.mmapped_mem += size;
	if (sum > (unsigned long)(mp_.max_mmapped_mem))
	  mp_.max_mmapped_mem = sum;

	check_chunk(av, p);

	return chunk2mem(p);
      }
    }
  }

  /* Record incoming configuration of top */

  old_top  = av->top;
  old_size = chunksize(old_top);
  old_end  = (char*)(chunk_at_offset(old_top, old_size));

  brk = snd_brk = (char*)(MORECORE_FAILURE);

  /*
     If not the first time through, we require old_size to be
     at least MINSIZE and to have prev_inuse set.
  */

  assert((old_top == initial_top(av) && old_size == 0) ||
	 ((unsigned long) (old_size) >= MINSIZE &&
	  prev_inuse(old_top) &&
	  ((unsigned long)old_end & pagemask) == 0));

  /* Precondition: not enough current space to satisfy nb request */
  assert((unsigned long)(old_size) < (unsigned long)(nb + MINSIZE));

  if (av != &main_arena) {

    heap_info *old_heap, *heap;
    size_t old_heap_size;

    /* First try to extend the current heap. */
    old_heap = heap_for_ptr(old_top);
    old_heap_size = old_heap->size;
    if ((long) (MINSIZE + nb - old_size) > 0
	&& grow_heap(old_heap, MINSIZE + nb - old_size) == 0) {
      av->system_mem += old_heap->size - old_heap_size;
      arena_mem += old_heap->size - old_heap_size;
      set_head(old_top, (((char *)old_heap + old_heap->size) - (char *)old_top)
	       | PREV_INUSE);
    }
    else if ((heap = new_heap(nb + (MINSIZE + sizeof(*heap)), mp_.top_pad))) {
      /* Use a newly allocated heap.  */
      heap->ar_ptr = av;
      heap->prev = old_heap;
      av->system_mem += heap->size;
      arena_mem += heap->size;
      /* Set up the new top.  */
      top(av) = chunk_at_offset(heap, sizeof(*heap));
      set_head(top(av), (heap->size - sizeof(*heap)) | PREV_INUSE);

      /* Setup fencepost and free the old top chunk with a multiple of
	 MALLOC_ALIGNMENT in size. */
      /* The fencepost takes at least MINSIZE bytes, because it might
	 become the top chunk again later.  Note that a footer is set
	 up, too, although the chunk is marked in use. */
      old_size = (old_size - MINSIZE) & ~MALLOC_ALIGN_MASK;
      set_head(chunk_at_offset(old_top, old_size + 2*SIZE_SZ), 0|PREV_INUSE);
      if (old_size >= MINSIZE) {
	set_head(chunk_at_offset(old_top, old_size), (2*SIZE_SZ)|PREV_INUSE);
	set_foot(chunk_at_offset(old_top, old_size), (2*SIZE_SZ));
	set_head(old_top, old_size|PREV_INUSE|NON_MAIN_ARENA);
	_int_free(av, old_top, 1);
      } else {
	set_head(old_top, (old_size + 2*SIZE_SZ)|PREV_INUSE);
	set_foot(old_top, (old_size + 2*SIZE_SZ));
      }
    }
    else if (!tried_mmap)
      /* We can at least try to use to mmap memory.  */
      goto try_mmap;

  } else { /* av == main_arena */

  /* Request enough space for nb + pad + overhead */

  size = nb + mp_.top_pad + MINSIZE;

  /*
    If contiguous, we can subtract out existing space that we hope to
    combine with new space. We add it back later only if
    we don't actually get contiguous space.
  */

  if (contiguous(av))
    size -= old_size;

  /*
    Round to a multiple of page size.
    If MORECORE is not contiguous, this ensures that we only call it
    with whole-page arguments.  And if MORECORE is contiguous and
    this is not first time through, this preserves page-alignment of
    previous calls. Otherwise, we correct to page-align below.
  */

  size = (size + pagemask) & ~pagemask;

  /*
    Don't try to call MORECORE if argument is so big as to appear
    negative. Note that since mmap takes size_t arg, it may succeed
    below even if we cannot call MORECORE.
  */

  if (size > 0)
    brk = (char*)(MORECORE(size));

  if (brk != (char*)(MORECORE_FAILURE)) {
    /* Call the `morecore' hook if necessary.  */
    void (*hook) (void) = force_reg (__after_morecore_hook);
    if (__builtin_expect (hook != NULL, 0))
      (*hook) ();
  } else {
  /*
    If have mmap, try using it as a backup when MORECORE fails or
    cannot be used. This is worth doing on systems that have "holes" in
    address space, so sbrk cannot extend to give contiguous space, but
    space is available elsewhere.  Note that we ignore mmap max count
    and threshold limits, since the space will not be used as a
    segregated mmap region.
  */

    /* Cannot merge with old top, so add its size back in */
    if (contiguous(av))
      size = (size + old_size + pagemask) & ~pagemask;

    /* If we are relying on mmap as backup, then use larger units */
    if ((unsigned long)(size) < (unsigned long)(MMAP_AS_MORECORE_SIZE))
      size = MMAP_AS_MORECORE_SIZE;

    /* Don't try if size wraps around 0 */
    if ((unsigned long)(size) > (unsigned long)(nb)) {

      char *mbrk = (char*)(MMAP(0, size, PROT_READ|PROT_WRITE, 0));

      if (mbrk != MAP_FAILED) {

	/* We do not need, and cannot use, another sbrk call to find end */
	brk = mbrk;
	snd_brk = brk + size;

	/*
	   Record that we no longer have a contiguous sbrk region.
	   After the first time mmap is used as backup, we do not
	   ever rely on contiguous space since this could incorrectly
	   bridge regions.
	*/
	set_noncontiguous(av);
      }
    }
  }
```

## 内存释放

依然是文字先总结一遍流程。

1. 先检查是否有钩子函数，有则调用并返回。
2. 如果是 `mmap` 分配的 chunk，则用 `munmap` 将其释放，如果释放的 `chunk` 大小大于 `mmap` 分配的阈值，且未关闭动态调整阈值开关，则调整一下 `mmap` 的阈值为当前 `chunk` 大小。
3. 调用 `_int_free` 释放内存。
4. 若 `chunk_size` < `128B` ，且 chunk 不与 `top chunk` 相邻则放入 `fast bins` 中，这里不会加锁，而是用的 `CAS`，返回。
5. 加锁分配区，前一个 chunk 若空闲，则合并。
6. 后一个 chunk 若为 `top chunk` ，则将其合并到 `top chunk` 中，若不是也合并，将其放到 `unosrted bin`。
7. 如果合并的 `chunk` 大于 `64KB`，则开始整合 `fast bins` 到 `unsorted bin` ，若 `top chunk` 的大小 大过 收缩阈值了，默认为 `128K` ，则收缩堆，也就是还给内核。
8. 也就是说 释放内存回内核 需要两个条件， `chunk_size` > `64KB`，且 `top chunk` 大于收缩阈值，则释放。

### __libc_free

```c
void
__libc_free(void* mem)
{
  mstate ar_ptr;
  mchunkptr p;                          /* chunk corresponding to mem */

  void (*hook) (__malloc_ptr_t, const __malloc_ptr_t)
    = force_reg (__free_hook);
  if (__builtin_expect (hook != NULL, 0)) {
    (*hook)(mem, RETURN_ADDRESS (0));
    return;
  }

  if (mem == 0)                              /* free(0) has no effect */
    return;

  p = mem2chunk(mem);

  if (chunk_is_mmapped(p))                       /* release mmapped memory. */
  {
    /* see if the dynamic brk/mmap threshold needs adjusting */
    if (!mp_.no_dyn_threshold
	&& p->size > mp_.mmap_threshold
	&& p->size <= DEFAULT_MMAP_THRESHOLD_MAX)
      {
	mp_.mmap_threshold = chunksize (p);
	mp_.trim_threshold = 2 * mp_.mmap_threshold;
      }
    munmap_chunk(p);
    return;
  }

  ar_ptr = arena_for_chunk(p);
  _int_free(ar_ptr, p, 0);
}
```

### _int_free

只放出最重要的一段，收缩堆的条件。

```c
if ((unsigned long)(size) >= FASTBIN_CONSOLIDATION_THRESHOLD) {
      if (have_fastchunks(av))
	malloc_consolidate(av);

      if (av == &main_arena) {
#ifndef MORECORE_CANNOT_TRIM
	if ((unsigned long)(chunksize(av->top)) >=
	    (unsigned long)(mp_.trim_threshold))
	  systrim(mp_.top_pad, av);
#endif
      } else {
	/* Always try heap_trim(), even if the top chunk is not
	   large, because the corresponding heap might go away.  */
	heap_info *heap = heap_for_ptr(top(av));

	assert(heap->ar_ptr == av);
	heap_trim(heap, mp_.top_pad);
      }
    }
```

## 其他细节

由于 `ptmalloc` 用了 `mutex` ，如果一个多线程的进程执行 `fork` 会将执行 `fork` 的线程进行拷贝，其他线程会突然消失，这个时候子进程的 `mutex` 处于不安全的状态，只能直接重新初始化。关于这一点可以查看 `ptmalloc_unlock_all2` 这个函数。

```c
thread_atfork(ptmalloc_lock_all, ptmalloc_unlock_all, ptmalloc_unlock_all2);
```

扩展堆和收缩堆还有释放堆的几个操作补充一下。

```c
/* Grow a heap.  size is automatically rounded up to a
   multiple of the page size. */

static int
grow_heap(heap_info *h, long diff)
{
  size_t page_mask = GLRO(dl_pagesize) - 1;
  long new_size;

  diff = (diff + page_mask) & ~page_mask;
  new_size = (long)h->size + diff;
  if((unsigned long) new_size > (unsigned long) HEAP_MAX_SIZE)
    return -1;
  if((unsigned long) new_size > h->mprotect_size) {
    if (__mprotect((char *)h + h->mprotect_size,
		   (unsigned long) new_size - h->mprotect_size,
		   PROT_READ|PROT_WRITE) != 0)
      return -2;
    h->mprotect_size = new_size;
  }

  h->size = new_size;
  return 0;
}

/* Shrink a heap.  */

static int
shrink_heap(heap_info *h, long diff)
{
  long new_size;

  new_size = (long)h->size - diff;
  if(new_size < (long)sizeof(*h))
    return -1;
  /* Try to re-map the extra heap space freshly to save memory, and make it
     inaccessible.  See malloc-sysdep.h to know when this is true.  */
  if (__builtin_expect (check_may_shrink_heap (), 0))
    {
      if((char *)MMAP((char *)h + new_size, diff, PROT_NONE,
		      MAP_FIXED) == (char *) MAP_FAILED)
	return -2;
      h->mprotect_size = new_size;
    }
  else
    __madvise ((char *)h + new_size, diff, MADV_DONTNEED);
  /*fprintf(stderr, "shrink %p %08lx\n", h, new_size);*/

  h->size = new_size;
  return 0;
}

/* Delete a heap. */

#define delete_heap(heap) \
  do {								\
    if ((char *)(heap) + HEAP_MAX_SIZE == aligned_heap_area)	\
      aligned_heap_area = NULL;					\
    __munmap((char*)(heap), HEAP_MAX_SIZE);			\
  } while (0)
```

## 结语

通过了解 `ptmalloc2` 分配释放内存的策略，可以知道，它比较适合短生命周期的内存分配，若是长生命周期的内存，则会不断抬高 `top chunk` ，导致无法将内存释放回内核，引起内存暴涨。而游戏服务器中，玩家的内存数据很有可能要等一个小时以上才释放，生命周期比较长，因此最好的做法还是自己写一个基于 `mmap` 的内存池（打脸了 在[Lua GC垃圾回收优化方案](https://yuerer.com/Lua-GC%E5%9E%83%E5%9C%BE%E5%9B%9E%E6%94%B6%E4%BC%98%E5%8C%96%E6%96%B9%E6%A1%88/)中我还提到，认为内存池没有必要），之所以特意强调是基于 `mmap` 主要是 `brk` 它类似于栈，会将堆顶抬高，如果堆顶内存没释放，会导致堆顶以下的内存都不能还回内核，又会导致内存暴涨。