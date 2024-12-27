---
title: Lua 5.3 设计实现(六) GC 垃圾回收
categories: Lua
date: 2020-12-11 20:20:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机, GC, 垃圾回收
tags: [Lua, Lua虚拟机]
---

虽然本系列主要讲的是 Lua 5.3 中的实现，不过在本篇中，想先聊聊 Lua 垃圾回收的历史。只有了解其历史，才知道为什么这么设计。

## Lua GC 历史

### Lua 5.0 之前

在 Lua 5.0 之前，Lua 因为没有 `userdata` ，垃圾回收的工作就很简单了，因为没有 `userdata` 也就没有了 `__gc` 元方法，也就不需要针对有特殊析构操作的对象进行特殊处理。

Lua 从早期到现在 `2020年` 推出的 最新版 Lua 5.4 都是采用的标记扫描算法，垃圾回收算法一般分为两类。

1. 标记扫描算法
2. 引用计数算法

引用计数的话，每个对象都要占用多一块内存，同时需要频繁的增减引用计数值，特别指的是在栈上的时候，Lua 解释器做的又非常简单，如果采用引用计数，还要对指令进行优化。

而早期 标记扫描 也是比较简单，首先它每次扫描且回收垃圾都是需要一次执行完的，其次它只有两种标记，用到或没用到，而且每次创建新对象都会跑一次GC。

显然，这种垃圾回收注定了没人敢用。。。我每创建一个对象，你都跑一次GC，这谁顶得住？

<!-- more -->

### Lua 5.0

到了 Lua 5.0，就采用了折中的办法，当内存分配超过了上次GC后的两倍，就跑一次全量GC。而且 这个版本里 支持了 `userdata` ，当一个 `userdata` 有 `__gc` 元方法时，需要对 `userdata` 作特殊处理，所谓的处理就是将其从所有对象的链表 也就是 `allgc` 拿出来，放到一个单独的链上 `finobj`，因为还要调用完 `__gc` 方法，再将其释放。（这一个操作是在对 `userdata` 设置 `metatable` 后进行的，因为一个 `userdata` 如果没有 `metatable` 必然没有这个 `__gc` 元方法，当然 table 也可以有 `__gc` 元方法）

依然是全量GC，没人敢用，只不过稍微好一些，只有内存分配超过上次GC的两倍，才进行GC。

### Lua 5.1

Lua 5.1 支持了渐进式垃圾回收，原理就是三色扫描，两种白分别表示不同回合的需要回收的对象的标记，灰色代表没扫描完，黑色代表一定别给我回收了！

但是这样也有问题，因为是渐进式扫描，如果一个 `table` 已经被扫描完了，这时再给他加一个对象，这个新对象默认为白色，到最后会被回收。

因此有两种方式，一种是 `barrier forward` 就是将白色改为灰色，另一种是 `barrier back` 就是将黑色的 table 改为灰色。

在 Lua 实现中，如果你对 一个扫描完的 table 进行修改操作，会默认将 table 改为 灰色，且加入到 `grayagain`，等到 `atomic` 的时候 再一次性扫过。因为 table 被改过一次，说明它还有可能再被改，为了避免其在 黑色 与 灰色里面 反复横跳，干脆直接丢 `grayagain` 链表上，等到时候一次性解决，也就是 atomic 阶段。

如果对象在栈上的话，则直接变为灰色，而不是将栈改为灰色，减少对栈的操作。

关键是 含有 `__gc` 元方法的对象，从 Lua 的角度，只有两类可以设置 元表，table 与 userdata，从 C 的角度，任何类型都可以有自己的元表。

如果给一个黑色对象设置一个元表，那么将元表置为灰色即可。

拥有`__gc` 元方法的对象，在设置的那一刻，会将该对象，从 `allgc` 链表上弄下来，将其加入到 `finobj` 链表上。

`atomic` 时刻，扫描一次 `finobj` 链表，将可回收对象转移到 `tobefnz` 链上，同时标记为灰色 不可回收，这是为了到最后阶段，先执行一次 `__gc` 然后将其重新链回到 `allgc` 走常规对象的 GC 流程。

因此，不要有过多含有 `__gc` 元方法的对象，毕竟都是在 `atomic` 阶段扫的，不可分割。

其次是弱表，弱表的话就是避免因为引用而无法被GC清理，它也是在 `atomic` 阶段进行扫描的，尽量减少 `__gc` 和 弱表，就能减少 GC 的时间消耗。

键值都弱放 `allweak` 链表，键弱放 `ephemeron` 链表，弱值放 `weak` 链表。

### Lua 5.2

在 Lua 5.2 中，推出了分代GC，不过又在 Lua 5.3 中将其删除，现又在 Lua 5.4 中加入。

### Lua 5.4

再次推出了 分代GC。所谓的 分代GC 指的是对象分为老年代和新生代。老年代指的是常驻对象，长时间不需要GC的对象，但是在 之前的版本中，大量的时间都是在扫描标记这些“老年代”，因此如果能够减少扫描标记老年代的话，GC性能就能达到提升。

至于新生代，则是刚创建出来的对象，很有可能需要进行清理，比如在栈上创建的对象，这样不只是GC效率有提升，还能保持内存占用的稳定（毕竟刚创建出来的对象，如果不用了就马上回收掉，而不是一直拖着）。

分代GC目前看来是挺好的，不过一旦与渐进式GC混用就很难受了，因为你没法复用 `barrier forward` 和 `barrier back` ，这里不指的是颜色/标记，而是指老年还是新生，试想渐进的时候，创建了个新对象，那么是应该把引用到新对象的老对象改为新生，还是把新对象改为老年代。这是一个问题，新对象改为老年，那老年就会有特别多，起不到回收的作用，老对象改为新生也是同理。

因此这个时候就需要第三种状态，类似于之前标记扫描法的第三种颜色，触碰过的对象，可以理解为触碰态，如果老对象指向了一个新的对象，则认为它处于触碰态，下次扫描把他一起扫了。

新生代和被触碰过的对象连续两次被扫描到，就说明它有可能经常被用到，就将其转为老年代。

分代GC 减少了老对象重复被扫描和标记的代价，提升了GC性能，但是总会有一个适合，会进行全量GC，只不过这个代价比较少，毕竟大部分对象都在新生代的时候就被回收了，如果项目要上 Lua 5.4，要特别小心这个全量GC的过程，最好主动的切换到步进模式，回收完一个周期后，再切回分代GC。

## 优化GC思路

从上面我们可以知道，所有的对象，都会在创建的时候挂上 `allgc` 链表，但是在游戏服务器中，我们有很多的对象，根本不需要GC，特别是配置表信息，（目前的几个项目都是重Lua的架构，所有配置都在 Lua 中进行读取。哪怕是 Lua 5.4 这些对象肯定会进入老年代，还是会被全量扫描标记到）。因此我们可以考虑给 table 加个函数，例如 `table.nogc()` ，把所有配置表的对象从 `allgc` 链拿下来，这样我们就能减少 `O(N)` 的时间。但是仅仅这样还是不够的，我们还要在扫描阶段提前返回，当扫描到我们标记过的 不需要 GC 的 table，则提前返回，减少扫描标记的时间。理论上，配置越多，越大，减少的GC时间越多

同理，我们还可以对一些全局函数进行这样的操作，旨在于减少需要扫描标记的对象个数。

如果不进行这样的优化，几乎每次重新开始GC，前面的一大段时间都是在标记扫描我们的不能垃圾回收的对象，非常浪费。

这个思路，我将会在之后进行尝试，最后再链接过去。

还有个思路，则是在 内存分配和释放上做手脚，简单来说就是你写个内存池，进行小内存分配。不过个人感觉，优化不大，基本上和 原生的 `malloc` 性能差不多，毕竟现代的内存分配器早就迭代了N个版本了。

在此之前，我们还是先来过一下 Lua 5.3 的GC的设计与实现吧。

## Lua 5.3 GC源码鉴赏

GC 的时机，主要由以下宏控制，可以看出默认是分步GC。

```c
#define luaC_condGC(L,pre,pos) \
	{ if (G(L)->GCdebt > 0) { pre; luaC_step(L); pos;}; \
	  condchangemem(L,pre,pos); }

/* more often than not, 'pre'/'pos' are empty */
#define luaC_checkGC(L)		luaC_condGC(L,(void)0,(void)0)
```

除此之外，还可以手动调用 `lua_gc` api。

分步GC 可以通过 `LUA_GCSETPAUSE` 控制执行GC 的时机，默认是新增内存为上一次的两倍 也就是 `200` 。

`LUA_GCSETSTEPMUL` 则是控制 GC 的速度，默认为 2，是新增内存速度的两倍，这个值不能低于 40，也就是 0.4，最小也是 40。

```c
static lu_mem singlestep (lua_State *L) {
  global_State *g = G(L);
  switch (g->gcstate) {
    case GCSpause: {
      g->GCmemtrav = g->strt.size * sizeof(GCObject*);
      restartcollection(g);
      g->gcstate = GCSpropagate;
      return g->GCmemtrav;
    }
    case GCSpropagate: {
      g->GCmemtrav = 0;
      lua_assert(g->gray);
      propagatemark(g);
       if (g->gray == NULL)  /* no more gray objects? */
        g->gcstate = GCSatomic;  /* finish propagate phase */
      return g->GCmemtrav;  /* memory traversed in this step */
    }
    case GCSatomic: {
      lu_mem work;
      propagateall(g);  /* make sure gray list is empty */
      work = atomic(L);  /* work is what was traversed by 'atomic' */
      entersweep(L);
      g->GCestimate = gettotalbytes(g);  /* first estimate */;
      return work;
    }
    case GCSswpallgc: {  /* sweep "regular" objects */
      return sweepstep(L, g, GCSswpfinobj, &g->finobj);// __gc
    }
    case GCSswpfinobj: {  /* sweep objects with finalizers */
      return sweepstep(L, g, GCSswptobefnz, &g->tobefnz);
    }
    case GCSswptobefnz: {  /* sweep objects to be finalized */
      return sweepstep(L, g, GCSswpend, NULL);
    }
    case GCSswpend: {  /* finish sweeps */
      makewhite(g, g->mainthread);  /* sweep main thread */
      checkSizes(L, g);
      g->gcstate = GCScallfin;
      return 0;
    }
    case GCScallfin: {  /* call remaining finalizers */
      if (g->tobefnz && g->gckind != KGC_EMERGENCY) {
        int n = runafewfinalizers(L);
        return (n * GCFINALIZECOST);
      }
      else {  /* emergency mode or no more finalizers */
        g->gcstate = GCSpause;  /* finish collection */
        return 0;
      }
    }
    default: lua_assert(0); return 0;
  }
}
```

1. GCSpause （一步完成）
    - 标记起点（主线程，注册表，G的元表，上一次 GC 剩的 tobefnz （需要执行 `__gc` 元方法，执行后再放回 `allgc` 走常规回收流程）。
2. GCSpropagate （多步完成）
    - 扫描灰色链表，逐步将灰色对象转为黑色对象。
3. GCSatomic （一步完成）
    - 原子操作，主要是扫描 `grayagain` `finobj` 链表，还有弱键，弱值，弱表，将 `finobj` 可回收的对象转移到 `tobefnz` 链表。
    - 进入清理阶段，将白色改为另一种白色。
4. GCSswpallgc （多步完成）
    - 清理常规对象
5. GCSswpfinobj （多步完成）
    - 清理 `finobj` 对象，这一个我一开始没反应过来，因为 `finobj` 链表中的对象难道不是在 `atomic` 阶段就已经将可回收的都转移到 `tobefnz` 链表吗？怎么还要进行清理 `finobj` 呢？
    - 我能想到的原因是 作者调用 `sweepstep` 的原因只是为了将其标记为另一种白色而已。
6. GCSswptobefnz （多步完成）
    - 清理 `tobefnz` 对象，也可以和上面那样理解。
7. GCSswpend （一步完成）
    - 清理完成，进入 `GCScallfin`
8. GCScallfin （多步完成）
    - 调用 `tobefnz` 的 `__gc` 函数，后将其转移到 `allgc` 链表，走常规对象回收流程。

还有一条 `fixedgc` 链表，存储的都是不会被GC的对象，目前都是短字符串，但是它还是有可能会被扫描到，浪费了一定的时间，不过因为比较少，所以其实也还好。

## Upvalue 如何 GC？

首先 `Upvalue` 受不受扫描标记控制，这个问题是有条件的，当 `Upvalue` 指向的对象处于栈上时，栈上的对象会被栈引用到，因此会被标记，但是 不会通过 闭包去扫描到 `Upvalue`。

一旦 `Upvalue` 被关闭（就是返回的时候，离开了作用域），就会将其拷贝到 闭包内部的 `UpVal`中，这个时候就不受到扫描标记的管控了，而是被引用计数所管理。

```c
void luaF_close (lua_State *L, StkId level) {
  UpVal *uv;
  while (L->openupval != NULL && (uv = L->openupval)->v >= level) {
    lua_assert(upisopen(uv));
    L->openupval = uv->u.open.next;  /* remove from 'open' list */
    if (uv->refcount == 0)  /* no references? */
      luaM_free(L, uv);  /* free upvalue */
    else {
      setobj(L, &uv->u.value, uv->v);  /* move value to upvalue slot */
      uv->v = &uv->u.value;  /* now current value lives here */
      luaC_upvalbarrier(L, uv);
    }
  }
}
```

而只有 `Closure` 被回收的时候，才会将 `UpValue` 的引用计数减少，因此被关闭的 `UpValue` 是否被回收依赖于其寄生的 `Closure` 。

```c
static void freeLclosure (lua_State *L, LClosure *cl) {
  int i;
  for (i = 0; i < cl->nupvalues; i++) {
    UpVal *uv = cl->upvals[i];
    if (uv)
      luaC_upvdeccount(L, uv);
  }
  luaM_freemem(L, cl, sizeLclosure(cl->nupvalues));
}
```

这就说明 `Closure` 在初始化的时候，要把 `UpValue` 被关掉的时候的藏身的内存也给提前分配好，这点可以在以下代码可以看到。

```c
struct UpVal {
  TValue *v;  /* points to stack or to its own value */
  lu_mem refcount;  /* reference counter */
  union {
    struct {  /* (when open) */
      UpVal *next;  /* linked list */
      int touched;  /* mark to avoid cycles with dead threads */
    } open;
    TValue value;  /* the value (when closed) */
  } u;
};

LClosure *luaF_newLclosure (lua_State *L, int n) {
  GCObject *o = luaC_newobj(L, LUA_TLCL, sizeLclosure(n));
  LClosure *c = gco2lcl(o);
  c->p = NULL;
  c->nupvalues = cast_byte(n);
  while (n--) c->upvals[n] = NULL;
  return c;
}
```