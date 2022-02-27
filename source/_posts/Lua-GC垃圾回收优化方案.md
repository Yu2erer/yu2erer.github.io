---
title: Lua GC垃圾回收优化方案
categories: Lua
date: 2020-12-19 10:09:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机, GC, 垃圾回收
tags: [Lua, Lua虚拟机]
---

最近接手的一个游戏项目是重 `Lua` 的结构（网络模块在 C++，其余逻辑全在 Lua）。和许多用 Lua 的游戏项目一样，遇到了 Lua 的垃圾回收的性能问题，经常跑着跑着就会掉帧，因此花了一周的时间，给 Lua 虚拟机写了个模块，把 Lua 垃圾回收的速度提高了一个量级。

## 思路

这个思路其实在之前的一篇博客中也有提到，想要 垃圾回收快，无非就那么几种思路。

1. 使用内存池
2. 减少对象生成
3. 垃圾回收提速

### 使用内存池

第一种思路，我觉得不合理，因为现代的内存分配器早就有内存池的设计了，手写一个内存池的收益并不大。

### 减少对象生成

第二种思路，是比较合理的。因为我在项目的代码中发现很多处地方有动态生成 `Closure` 的情况。

```lua
function test()
  local fn = function()
    print("test")
  end
  fn()
  fn()
end
```

上面那个例子，每次调用到 `test` 函数的时候，都会动态根据 `fn` 的 函数原型，生成一个 `Closure` 

可能有人会问，Proto 不是有一个 cache 指向 `Closure` 吗？按道理这里 没有 `UpValue`（即代表UpValue 完全相同），应该会复用啊，但是很可惜，执行完这个函数以后，因为没有对象指向 `Closure` 用完再不久的将来又会被回收。

因此，少写这种代码就可以减少对象的生成。

## 垃圾回收提速

第三种思路，我的想法是，让垃圾回收所要遍历的对象大幅减少，就可以为垃圾回收提速了，由于我们是重 Lua 的框架，因此我们的所有配置都存在于 Lua 的 table中，而这一部分肯定是不需要被回收的，但是每次垃圾回收的时候，又会不停的扫描递归遍历，不合理。同时代码中的很多全局函数，也是根本不需要被回收的，也会被扫描到，于是就想到一个想法，给这些对象打上标记，让他们不被遍历不被清理，就可以大幅度的提速了。

原理简单，但是做起来确实挺难受的，要注意要手动关闭 `UpValue` 将其保留下来。

目前已经开源，[LuaJIT-5.3.6](https://github.com/Yu2erer/LuaJIT-5.3.6)源码。

<!-- more -->

## 如何使用呢？

说的那么好，那如何使用呢？

目前提供了四个接口。

```lua
nogc("open", Table) -- 这一整个 Table 都不被扫描不被清理
nogc("close", Table) -- 相当于 open 的反方法
nogc("len") -- 当前不被 垃圾回收管理的对象个数
nogc("count") -- 当前不被 垃圾回收管理的对象的总内存大小 单位为k
```

Table 中的元素支持，字符串，整数，浮点数，布尔值，表，Lua 闭包。

不支持 当 Table 是弱表的情况。

需要注意的是，当一个 Table 被打上标记之后，就不能够再修改其内部的数据，因为有可能会创建出一个新的对象，但是又不会被 Lua 的垃圾回收扫描到，导致这个对象被回收，发生段错误。

### 接入 Lua

首先需要引入我写的两个文件， `YGC.c, YGC.h` 。

然后跟着我的步伐修改以下几个文件。

### lbaselib.c

添加头文件，然后导出  `nogc` 函数给 Lua 使用。

```c
#include "YGC.h"

static const luaL_Reg base_funcs[] = {
  ....
  {"nogc", nogc},
  {NULL, NULL}
};

```

### lvm.c

添加头文件，在 `pushclosure` 函数这里， `if (!isblack(p))`  改为以下的代码。

这是因为，当我们标记的 Table 中含有的闭包，被执行到的时候，会动态的生成 `Closure` ，但是这个 `Closure` 是没办法被标记到的，因为是动态生成的，因此不应该指过去。

```c
#include "YGC.h"

if (!isblack(p) && !Y_isnogc(p) && !Y_isnogc(ncl))
  p->cache = ncl;
}

```

### lstate.h

在 `global_State` 记录两个辅助的值，其中一个是 nogc 的对象内存大小，另一个是 不参与GC的链表，都是为了方便调试用的。

```c
typedef struct global_State {
  ....
  lu_mem Y_GCmemnogc; /* memory size of nogc linked list */
  GCObject *Y_nogc;  /* list of objects not to be traversed or collected */
  ....
}
```

### lstate.c

初始化上面的对象

```c
LUA_API lua_State *lua_newstate (lua_Alloc f, void *ud) {
  ....
  g->Y_GCmemnogc = 0;
  g->Y_nogc = NULL;
  ....
}
```

### lgc.c

这是最后一个文件了，依然是添加头文件。然后将以下代码进行对比替换。

```c
#include "YGC.h"
```

提前返回对象，减少垃圾回收耗时。

将 以下代码 进行替换，简单的来说就是将不需要GC的对象，移出 `allgc` 链表。

```c
static GCObject **sweeplist (lua_State *L, GCObject **p, lu_mem count) {
  global_State *g = G(L);
  int ow = otherwhite(g);
  int white = luaC_white(g);  /* current white */
  while (*p != NULL && count-- > 0) {
    GCObject *curr = *p;
    int marked = curr->marked;
    if (isdeadm(ow, marked)) {  /* is 'curr' dead? */
      *p = curr->next;  /* remove 'curr' from list */
      freeobj(L, curr);  /* erase 'curr' */
    }
    else {  /* change mark to 'white' */
      curr->marked = cast_byte((marked & maskcolors) | white);
      p = &curr->next;  /* go to next element */
    }
  }
  return (*p == NULL) ? NULL : p;
}
```

替换为以下这段。

```c
static GCObject **sweeplist (lua_State *L, GCObject **p, lu_mem count) {
  global_State *g = G(L);
  int ow = otherwhite(g);
  int white = luaC_white(g);  /* current white */
  while (*p != NULL && count-- > 0) {
    GCObject *curr = *p;
    if (g->gcstate == GCSswpallgc && Y_isnogc(curr)) {
      *p = curr->next;
      curr->next = g->Y_nogc;
      g->Y_nogc = curr;
      continue;
    }
    int marked = curr->marked;
    if (isdeadm(ow, marked)) {  /* is 'curr' dead? */
      *p = curr->next;  /* remove 'curr' from list */
      freeobj(L, curr);  /* erase 'curr' */
    }
    else {  /* change mark to 'white' */
      curr->marked = cast_byte((marked & maskcolors) | white);
      p = &curr->next;  /* go to next element */
    }
  }
  return (*p == NULL) ? NULL : p;
}
```

propagatemark 的修改主要是为了提前返回，不要遍历不需要GC的对象。

```c
static void propagatemark (global_State *g) {
  lu_mem size;
  GCObject *o = g->gray;
  lua_assert(isgray(o));
  gray2black(o);
  switch (o->tt) {
    case LUA_TTABLE: {
      Table *h = gco2t(o);
      g->gray = h->gclist;  /* remove from 'gray' list */
      size = traversetable(g, h);
      break;
    }
    case LUA_TLCL: {
      LClosure *cl = gco2lcl(o);
      g->gray = cl->gclist;  /* remove from 'gray' list */
      size = traverseLclosure(g, cl);
      break;
    }
    case LUA_TCCL: {
      CClosure *cl = gco2ccl(o);
      g->gray = cl->gclist;  /* remove from 'gray' list */
      size = traverseCclosure(g, cl);
      break;
    }
    case LUA_TTHREAD: {
      lua_State *th = gco2th(o);
      g->gray = th->gclist;  /* remove from 'gray' list */
      linkgclist(th, g->grayagain);  /* insert into 'grayagain' list */
      black2gray(o);
      size = traversethread(g, th);
      break;
    }
    case LUA_TPROTO: {
      Proto *p = gco2p(o);
      g->gray = p->gclist;  /* remove from 'gray' list */
      size = traverseproto(g, p);
      break;
    }
    default: lua_assert(0); return;
  }
  g->GCmemtrav += size;
}
```

替换为。

```c
static void propagatemark (global_State *g) {
  lu_mem size;
  GCObject *o = g->gray;
  lua_assert(isgray(o));
  gray2black(o);
  switch (o->tt) {
    case LUA_TTABLE: {
      Table *h = gco2t(o);
      g->gray = h->gclist;  /* remove from 'gray' list */
      size = (Y_isnogc(o) ? 0 : traversetable(g, h));
      break;
    }
    case LUA_TLCL: {
      LClosure *cl = gco2lcl(o);
      g->gray = cl->gclist;  /* remove from 'gray' list */
      size = (Y_isnogc(cl) ? 0 : traverseLclosure(g, cl));
      break;
    }
    case LUA_TCCL: {
      CClosure *cl = gco2ccl(o);
      g->gray = cl->gclist;  /* remove from 'gray' list */
      size = traverseCclosure(g, cl);
      break;
    }
    case LUA_TTHREAD: {
      lua_State *th = gco2th(o);
      g->gray = th->gclist;  /* remove from 'gray' list */
      linkgclist(th, g->grayagain);  /* insert into 'grayagain' list */
      black2gray(o);
      size = traversethread(g, th);
      break;
    }
    case LUA_TPROTO: {
      Proto *p = gco2p(o);
      g->gray = p->gclist;  /* remove from 'gray' list */
      size = (Y_isnogc(p) ? 0 : traverseproto(g, p));
      break;
    }
    default: lua_assert(0); return;
  }
  g->GCmemtrav += size;
}
```

至此完结，享受提速后的快感吧。