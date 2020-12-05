---
title: Lua 5.3 设计实现(三) 长短字符串
categories: Lua
date: 2020-10-28 13:12:20
keywords: Lua, Lua解释器, Lua5.3 Lua虚拟机, lua字符串
tags: [Lua, Lua虚拟机, lua字符串]
---

上一篇主要是讲了 `Table` 和 `MetaMethod` 的一些设计实现，谈论到了 Lua 会对 元方法的字符串名字作缓存，同时提到了 Lua 字符串分为长短字符串。这一篇主要是谈论一下 Lua 的长短字符串是怎么设计的？为什么要分长短这两种类型？

## TString 结构

可以看到字符串内部会记录哈希值，每个字符串被创建出来就不能被改写，因此为了节约内存，Lua会复用相同的字符串，但是逐字节比较太慢了，因此会预处理将字符串hash，存入字符串的 `hash` 字段中。

字符串的实际内容会追加到 `TString` 的后面。

```c
typedef struct TString {
  CommonHeader;  // GC 回收
  // 短字符串时 0为需要被GC接管, 1为不被GC回收
  // 长字符串时 0为未hash, 1为已hash
  lu_byte extra;
  lu_byte shrlen; // 短字符串长度, 如果是长字符串则无意义
  unsigned int hash; // 字符串哈希值
  union {
    size_t lnglen; // 长字符串长度 如果为短字符串则无效
    struct TString* hnext; // 短字符串的时候 与相同哈希值的字符串串起的链表
  } u;
} TString;
```

短字符串全局只有一份，Lua解释器会将其存到 `stringtable` 这个结构中。字符串 `hash` 会根据 `global_State` 的 `seed` 进行哈希。

<!-- more -->

```c
typedef struct stringtable {
  TString** hash; // 哈希表数组
  int nuse; // 存在哈希表数组里的短字符串个数
  int size; // 哈希表数组的大小
} stringtable;

typedef struct global_State {
	....
  stringtable strt; // 用于字符串的哈希表
  unsigned int seed; // 随机数 用于字符串 哈希
	// 字符串缓存, 用于存储C语言中经常转TString的字符串
  TString *strcache[STRCACHE_N][STRCACHE_M];
	....
 
} global_State;
```

## 为什么字符串要分长短？

`LUAI_MAXSHORTLE` 作为分界来区分长短字符串，默认为40字节

```c
#define LUAI_MAXSHORTLEN	40

#define LUA_TSTRING		4

/* Variant tags for strings */
#define LUA_TSHRSTR	(LUA_TSTRING | (0 << 4))  /* short strings */
#define LUA_TLNGSTR	(LUA_TSTRING | (1 << 4))  /* long strings */
```

其实在 Lua 5.3 之前，字符串并不分长短，之所以现在要分主要是因为 `Hash Dos` 攻击。

Lua 中的字符串会进行 Hash，然后将其放入 strt 中，如果发生了冲突，就会用最简单的开链法，将相同Hash值的字符串串起来。

Lua 5.2.0 中 创建字符串的规则比较简单，凡是阅读过源码的，都能大量构造出相同哈希值的字符串，导致 Lua解释器不得不根据链表上的字符串逐一比对字符，最终会因为比较字符串耗尽 `CPU` 资源。因此 Lua 5.2.1 之后才会采用 global_State 的 seed 去随机构造哈希。

```c
TString *luaS_newlstr (lua_State *L, const char *str, size_t l) {
   GCObject *o; 
   unsigned int h = cast(unsigned int, l);  /* seed */
   size_t step = (l>>5)+1;  /* if string is too long, don't hash all its chars */
   size_t l1; 
   for (l1=l; l1>=step; l1-=step)  /* compute hash */
     h = h ^ ((h<<5)+(h>>2)+cast(unsigned char, str[l1-1]));
   for (o = G(L)->strt.hash[lmod(h, G(L)->strt.size)];
        o != NULL;
        o = gch(o)->next) {
     TString *ts = rawgco2ts(o);
     if (h == ts->tsv.hash &&
         ts->tsv.len == l &&
         (memcmp(str, getstr(ts), l * sizeof(char)) == 0)) {
       if (isdead(G(L), o))  /* string is dead (but was not collected yet)? */
         changewhite(o);  /* resurrect it */
       return ts; 
     }   
   }
   return newlstr(L, str, l, h);  /* not found; create a new string */
 }
```

Lua 5.3.6 随机生成随机数种子。

```c
#define luai_makeseed() cast(unsigned int, time(NULL))
// create the seed
static unsigned int makeseed(lua_State* L) {
  char buff[4 * sizeof(size_t)];
  unsigned int h = luai_makeseed();
  int p = 0;
  addbuff(buff, p, L); /* heap variable */
  addbuff(buff, p, &h); /* local variable */
  addbuff(buff, p, luaO_nilobject); /* global variable */
  addbuff(buff, p, &lua_newstate); /* public function */
  return luaS_hash(buff, p, h);
}
```

随机数种子生成规律非常有趣 它根据以下几点进行随机生成

1. 根据 lua_State 的地址
2. 根据 虚拟机的 运行时间
3. 根据 luaO_nilobject 常量的地址
4. 根据 lua_newstate 函数的地址

最后调用了 `luaS_hash()` 来创建 hash seed，这个函数即用来hash字符串，同时又用来创建 hash seed。

```c
#define LUAI_HASHLIMIT 5

unsigned int luaS_hash(const char* str, size_t l, unsigned int seed) {
  unsigned int h = seed ^ cast(unsigned int, l); // ^ means Bitwise XOR
  // 如果字符串长度 < 2^5 则都会进行 hash, 否则 会跳过部分字符 提高效率
  size_t step = (l >> LUAI_HASHLIMIT) + 1;
  for (; l >= step; l -= step)
    h ^= ((h << 5) + (h >> 2) + cast_byte(str[l - 1]));
  return h;
}
```

可以看到 `luaS_hash` 对字符串 hash 的时候，如果字符串过长，就会跳过部分字符来提高性能。

当冲突的字符串越来越多的时候，查询相同字符串的效率会越来越差，不过没关系，当字符串的数量 > strt的大小，会分配一个原strt两倍大小的哈希表。同时 将原有重新进行 Hash，放入新的哈希表中。同理，当字符串的数量 < strt的大小 / 4 的时候，strt 就会缩小为 原先的一半。

```c
static void checkSizes(lua_State* L, global_State* g) {
  if (g->gckind != KGC_EMERGENCY) {
    l_mem olddebt = g->GCdebt;
    if (g->strt.nuse < g->strt.size / 4) // strt 比 字符串数量大4倍 那就缩小strt一半
      luaS_resize(L, g->strt.size / 2);
    g->GCestimate += g->GCdebt - olddebt
  }
}
```

## 创建字符串

```c
TString* luaS_newlstr(lua_State* L, const char* str, size_t l) {
	// 短字符串流程 l <= 40
  if (l <= LUAI_MAXSHORTLEN)
    return internshrstr(L, str, l);
  else {
    TString* ts;
    if (l >= (MAX_SIZE - sizeof(TString)) / sizeof(char))
      luaM_toobig(L);
		// 长字符串流程 l > 40
    ts = luaS_createlngstrobj(L, l);
    memcpy(getstr(ts), str, l * sizeof(char));
    return ts;
  }
}
```

### 创建短字符串

短字符串会直接进行 `hash` 若冲突则用开链法链起来。

```c
static TString* internshrstr(lua_State* L, const char* str, size_t l) {
  TString* ts;
  global_State* g = G(L);
  unsigned int h = luaS_hash(str, l, g->seed);
  // g->strt.size always is 2^n, such as 128
  // lmod get the lowest n bit from h
  // list is a sub array from g->strt.hash
  // 通过将字符串Hash 来strt Hash表中找对应的桶
  TString** list = &g->strt.hash[lmod(h, g->strt.size)];
  for (ts = *list; ts != NULL; ts = ts->u.hnext) {
    if (l == ts->shrlen && (memcmp(str, getstr(ts), l * sizeof(char)) == 0)) {
      // 如果找到完全相同的字符串(Hash值相同, 字符串字符完全相同)
      // 就看看是否将被回收 未来再讲
      if (isdead(g, ts))
        changewhite(ts); // 将其留下 复用
      return ts;
    }
  }
	// 如果 Hash 后的字符串 >= strt Hash表的大小 则进行 两倍扩容
  if (g->strt.nuse >= g->strt.size && g->strt.size <= MAX_INT / 2) {
    luaS_resize(L, g->strt.size * 2);
    // 扩容后 当然要重新找 当前新创建的字符串 所对应的 新位置啦
    list = &g->strt.hash[lmod(h, g->strt.size)];
  }
  // 真正创建 字符串对象的函数 无论长短最后都用这个
  ts = createstrobj(L, l, LUA_TSHRSTR, h);
  memcpy(getstr(ts), str, l * sizeof(char));
  ts->shrlen = cast_byte(l);
  // 短字符串 会将 相同 Hash 值的字符串链起来
  ts->u.hnext = *list;
  *list = ts;
  g->strt.nuse++;
  return ts;
}
```

### 创建长字符串

没有立即进行 `hash` 而是留到之后，再进行 `hash`。

```c
TString* luaS_createlngstrobj(lua_State* L, size_t l) {
  TString* ts = createstrobj(L, l, LUA_TLNGSTR, G(L)->seed);
  // 没有进行 Hash!!!
  ts->u.lnglen = l;
  return ts;
}
```

在源码中，我只找到一处 对长字符串进行 `hash` ，就是在上一篇的 `table` 中，当要对 字符串key 进行 `hash` 的时候才 `hash` （它都需要哈希了才哈希，是否可以看作 Lua 并不想对长字符串进行哈希呢？）

```c
static Node *mainposition (const Table *t, const TValue *key) {
  switch (ttype(key)) {
		....
    case LUA_TLNGSTR:
      return hashpow2(t, luaS_hashlongstr(tsvalue(key)));
		....
  }
}
```