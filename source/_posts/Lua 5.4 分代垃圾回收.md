---
title: Lua 5.4 分代垃圾回收
categories: Lua
date: 2024-08-25 14:54:20
keywords: Lua, Lua5.4, LuaGC, GC, GenGC
tags: [Lua, Lua虚拟机]
---

近期在改 Lua 5.4 的垃圾回收，虽然之前也写过分代垃圾回收的原理，但这次改完之后对其更有感悟，就简单记录一下Lua 5.4 的分代垃圾回收的实现原理。 
## 简介
分代垃圾回收认为对象分为年轻代和老年代，其中年轻代对象很快就会被释放(比如临时对象)，而老年代对象存在的时间比较长，不容易被释放，因此也就不需要经常去扫描老年代，只需要经常去扫描年轻代，等到年轻代垃圾回收的时候实在收不回对象，再进行一次全量垃圾回收。
## 原理
Lua 的 age 总共占用 3 Bit，刚创建出来的对象为 `G_NEW` ，当它活过一轮垃圾回收后，提升为 `G_SURVIVAL` ，若再活过一轮垃圾回收，则彻底进入 `G_OLD` 老年代，不在年轻代中扫描它。

```c
#define G_NEW		0	/* created in current cycle */
#define G_SURVIVAL	1	/* created in previous cycle */
#define G_OLD0		2	/* marked old by frw. barrier in this cycle */
#define G_OLD1		3	/* first full cycle as old */
#define G_OLD		4	/* really old object (not to be visited) */
#define G_TOUCHED1	5	/* old object touched this cycle */
#define G_TOUCHED2	6	/* old object touched in previous cycle */
#define AGEBITS		7  /* all age bits (111) */
```

这里面的 `G_OLD0` 是用于 Barrier forward，假设你创建了一个新对象，它本该是 `G_NEW` 但因为它被老年代对象引用，所以必须要强行将它改为老年代，否则会发生跨代引用，该新对象直接被清理掉。

同理 `G_TOUCHED1` 则是用于 Barrier back，假设你创建了一个新对象，然后放置在一个老年代的 table中，此时为了不频繁触发该 table 的 barrier，则将其修改为 `G_TOUCHED1` ，同时将其放置在 `grayagain` 链表中，这是因为老年代table是不会在年轻代的垃圾回收中被扫描到，但此时老年代又确实引用了年轻代对象，所以要将它放在一条特殊链表中，使其能在年轻代中被扫描到。

<!-- more -->

对 `G_TOUCHED2` 的理解就更为简单，前面我们知道新对象需要两轮年轻代垃圾回收才会进入老年代，为了不出现跨代引用，我们的老年代table也需要两轮年轻代的垃圾回收才能彻底放心的移出 `grayagain` 链表，因此 `G_TOUCHED1` -> `G_TOUCHED2` -> `G_OLD` 也是两轮垃圾回收。

而 `G_OLD1` 也是为了拖延 `G_OLD0` 真正变成 `G_OLD` 的时间，新对象就因为被老年代对象引用，它就直接变老年代是不合理的，需要让它也经历两轮年轻代垃圾回收再提升为真正的 `G_OLD`。


## 实现
若能理解以上的 barrier，则可进入学习实现阶段。

假设当前 Lua VM 处于渐进GC模式，此时切入分代GC，只需要将未完成的GC完成，同时将所有已存在对象置为 `OLD`。

```c
static lu_mem entergen (lua_State *L, global_State *g) {
  lu_mem numobjs;
  luaC_runtilstate(L, bitmask(GCSpause));  /* prepare to start a new cycle */
  luaC_runtilstate(L, bitmask(GCSpropagate));  /* start new cycle */
  numobjs = atomic(L);  /* propagates all and then do the atomic stuff */
  atomic2gen(L, g);
  setminordebt(g);  /* set debt assuming next cycle will be minor */
  return numobjs;
}
```

对 `allgc` 链表设置游标，认为所有对象都是旧的。
```c
static void atomic2gen (lua_State *L, global_State *g) {
  cleargraylists(g);
  /* sweep all elements making them old */
  g->gcstate = GCSswpallgc;
  sweep2old(L, &g->allgc);
  /* everything alive now is old */
  g->reallyold = g->old1 = g->survival = g->allgc;
  g->firstold1 = NULL;  /* there are no OLD1 objects anywhere */

  /* repeat for 'finobj' lists */
  sweep2old(L, &g->finobj);
  g->finobjrold = g->finobjold1 = g->finobjsur = g->finobj;

  sweep2old(L, &g->tobefnz);

  g->gckind = KGC_GEN;
  g->lastatomic = 0;
  g->GCestimate = gettotalbytes(g);  /* base for memory control */
  finishgencycle(L, g);
}
```

后续年轻代垃圾回收遍历 `allgc` 链表时，只需要遍历到指定位置(也就是之前设置的游标处)就可以结束本轮垃圾回收，大幅提高垃圾回收的速度。

```c
static GCObject **sweepgen (lua_State *L, global_State *g, GCObject **p,
                            GCObject *limit, GCObject **pfirstold1) {
  static const lu_byte nextage[] = {
    G_SURVIVAL,  /* from G_NEW */
    G_OLD1,      /* from G_SURVIVAL */
    G_OLD1,      /* from G_OLD0 */
    G_OLD,       /* from G_OLD1 */
    G_OLD,       /* from G_OLD (do not change) */
    G_TOUCHED1,  /* from G_TOUCHED1 (do not change) */
    G_TOUCHED2   /* from G_TOUCHED2 (do not change) */
  };
  int white = luaC_white(g);
  GCObject *curr;
  while ((curr = *p) != limit) {
    if (iswhite(curr)) {  /* is 'curr' dead? */
      lua_assert(!isold(curr) && isdead(g, curr));
      *p = curr->next;  /* remove 'curr' from list */
      freeobj(L, curr);  /* erase 'curr' */
    }
    else {  /* correct mark and age */
      if (getage(curr) == G_NEW) {  /* new objects go back to white */
        int marked = curr->marked & ~maskgcbits;  /* erase GC bits */
        curr->marked = cast_byte(marked | G_SURVIVAL | white);
      }
      else {  /* all other objects will be old, and so keep their color */
        setage(curr, nextage[getage(curr)]);
        if (getage(curr) == G_OLD1 && *pfirstold1 == NULL)
          *pfirstold1 = curr;  /* first OLD1 object in the list */
      }
      p = &curr->next;  /* go to next element */
    }
  }
  return p;
}
```




