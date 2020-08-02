---
title: Lua 5.3 源码剖析(二) 字符串设计与实现原理
categories: Lua
date: 2020-07-28 13:14:20
keywords: Lua, 源码剖析, 虚拟机, 字符串, TString
tags: [Lua, 源码剖析, 虚拟机, 字符串, TString]
---

本篇主要讲 Lua 中的 字符串 是如何设计实现的, 为本系列第二篇.

## TString

Lua 中的字符串 的结构体名字为 TString 主要由以下内容构成.

```c
#define CommonHeader \
  GCObject* next; \
  lu_byte tt; \
  lu_byte marked

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

从中我们可以猜想, Lua 中的字符串主要分为两个部分, 其中一个 是 String Header, 用于记录字符串的长度, hash值, 和 GC回收的链表.

记录字符串的长度我们可以比较好理解, 提高效率, 不用每次都重新计算一次字符串长度, 但是 Hash值是用来做什么的呢?

<!-- more -->

## 字符串 Hash 的意义?

首先 Lua 是一种胶水语言, 依附于其他环境存活, 如果每创建一个字符串就开辟一次内存空间的话, 那对内存开销是非常高的, 其次 Lua 依赖 GC回收 来回收内存, GC回收的开销也是很高, 希望有一种方式可以减少创建字符串的内存空间, 因此很自然的想到, 当新的字符串与旧的字符串的值完全相同的时候, 我们就复用原先的字符串, 而不是重新进行创建.

那么 要想判断两个字符串是否完全相同, 一种可以是逐个字符比较, 但是这得与字符串的长度成线性, 时间开销不大合理, 只有将字符串提前Hash后 存储起来, 然后 直接判断 两个字符串的 Hash值是否相同, 就能快速的判断这两个字符串是否相同了, 而这种判断时间复杂度仅要O(1).

至此, 我们理解了 Lua 中的字符串为什么要进行Hash, 但我们还没理解 它是如何存储起来的.

### 字符串如何存储起来?

我们首先回忆一下 global_State 中的成员

```c
typedef struct stringtable {
  TString** hash; // 哈希表数组
  int nuse; // 存在哈希表数组里的短字符串个数 (Lua 5.2.0 不分长短)
  int size; // 哈希表数组的大小
} stringtable;

typedef struct global_State {
  // 字符串 部分 Begin
  stringtable strt; // 用于字符串的哈希表
  unsigned int seed; // 随机数 用于字符串 哈希
	// 字符串缓存, 用于存储C语言中经常转TString的字符串
  TString *strcache[STRCACHE_N][STRCACHE_M];
	// 字符串 End
 
} global_State;
```

可以看出 字符串 根据 global_State 的 seed 进行 Hash后, 会被放入 global_State 的 strt 中.

## 为什么字符串分长短?

在 Lua 5.3 版本中, Lua 中的 字符串 分为 长字符串 和 短字符串, 这一点可以从以下 Lua 源码中看出.

```c
#define LUA_TSTRING		4

/* Variant tags for strings */
#define LUA_TSHRSTR	(LUA_TSTRING | (0 << 4))  /* short strings */
#define LUA_TLNGSTR	(LUA_TSTRING | (1 << 4))  /* long strings */
```

早在 Lua 5.2.0 的时候, Lua 中的字符串 其实并不区分 长短, 而是统一用字符串来表示, 但是这带来了一个问题, 那就是 Hash Dos 攻击.

首先我们知道, Lua 中的字符串会进行 Hash, 然后将其放入 strt 中, 如果发生了冲突, 就会用最简单的开链法, 将相同Hash值的字符串串起来.

那么会有一个问题 当冲突的字符串越来越多的时候, 查询相同字符串的效率会越来越差, 不过没关系, 当字符串的数量 > strt的大小, 会分配一个原strt两倍大小的哈希表, 同时 将原有重新进行 Hash, 放入新的哈希表中. 同理, 当字符串的数量 < strt的大小 / 4的时候, strt 就会缩小为 原先的一半.

```c
// GC回收中调用, 进行缩小 strt的大小
static void checkSizes(lua_State* L, global_State* g) {
  if (g->gckind != KGC_EMERGENCY) {
    l_mem olddebt = g->GCdebt;
    if (g->strt.nuse < g->strt.size / 4) // strt 比 字符串数量大4倍 那就缩小strt一半
      luaS_resize(L, g->strt.size / 2);
    g->GCestimate += g->GCdebt - olddebt
  }
// 如果字符串数量大过 strt 大小
// 则进行扩容
// 同时 将原有字符串 重新 Hash 添加到 新 strt
// 如果没有大过
// 先把 Hash范围缩小到[0, newsize-1]
// 开辟一个新 strt 大小为 newsize
// 将其复制过去
void luaS_resize(lua_State* L, int newsize) {
  int i;
  stringtable* tb = &G(L)->strt; // global string table
  if (newsize > tb->size) { /* grow table if needed */
    luaM_reallocvector(L, tb->hash, tb->size, newsize, TString*);
    for (i = tb->size; i < newsize; i++)
      // open hash table, tb->hash is the pointer for linked list
      tb->hash[i] = NULL;
  }
  for (i = 0; i < tb->size; i++) { /* rehash */
    TString* p = tb->hash[i];
    tb->hash[i] = NULL;
    while (p) { /* for each node in the list */
      TString* hnext = p->u.hnext; /* save next */
      unsigned int h = lmod(p->hash, newsize); /* new position */
      p->u.hnext = tb->hash[h]; /* chain it */
      tb->hash[h] = p;
      p = hnext;
    }
  }
  if (newsize < tb->size) { /* shrink table if needed */
    lua_assert(tb->hash[newsize] == NULL && tb->hash[tb->size - 1] == NULL);
    luaM_reallocvector(L, tb->hash, tb->size, newsize, TString*);
  }
  tb->size = newsize;
}
```

通过以上可以看到, Lua 在字符串冲突的时候, 会进行扩容Hash表, 同时进行 Re-Hash, 或者是 Hash表过大, 则也会 Re-Hash, 同时复制到一个小的 Hash 表中.

可是, 讲了这么多 还是没讲为什么会有长字符串和短字符串?

我们来假设一种情况, 当成千上万个不同的字符串有相同的哈希值得时候, 那么 会在 strt 哈希表的桶中不断开链, 最后变为 O(n), 当每创建一个新的字符串, 就会和所有Hash值相同的字符串逐一比对字符, 最终因为比较字符串耗尽CPU性能.

但是我们说过了, 当字符串的数量 大于 哈希表的大小就会进行扩容, 应该不会有这种情况发生啊? 那么我们来看看 Lua 5.2.0 中创建字符串的代码.

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

1. 这个版本 不区分 短字符串和长字符串, 统统都是字符串
2. 会对字符串进行哈希, 不过当字符串太长的时候, 不会对整个字符串进行哈希 而是有一个步进值 且该步进值是写死的, 任何人都能通过阅读源码得知 哈希规则, 构造相同哈希值得字符串
3. 当哈希值相同的时候, 遍历链表 逐一比对字符串内容是否相同 非常耗时.

正是因为 第二点, 任何人都可以通过 阅读源码 知道 字符串哈希规则, 从而精心构造出大量相同 哈希值的字符串, 利用创建字符串的过程, 来达到攻击服务器的目的.

因此, 新版本中, 就开始区分长短字符串, 同时 对哈希的规则随机化, 即每次运行虚拟机, 哈希的seed都会不同, 来达到攻击者无法构造出相同Hash值, 不同字符串内容的字符串.

到了这里, 我们已经将 Lua 字符串原理讲的差不多了, 现在就是 来分析一下 Lua 虚拟机运作的流程.

## Lua 字符串

### 初始化流程

- lua_newstate 创建虚拟机
    - g->seed = makeseed(L); 生成随机数种子
    - g->strt.size = g->strt.nuse = 0;
    - g->strt.hash = NULL;
    - 以保护模式 执行 f_luaopen() 函数
        - 此处的保护模式 其实就是 用C语言实现的一个异常捕获机制, 可查阅 GC回收篇
        - 调用 luaS_init() 初始化 Lua 字符串

```c
#define MINSTRTABSIZE 128
#define MEMERRMSG "not enough memory"

void luaS_init(lua_State* L) {
  global_State* g = G(L);
  int i, j;
	// 初始化 strt 大小 为 128
	// 这个函数上面已经讲过了
  luaS_resize(L, MINSTRTABSIZE);
	// 同时 内存不够的错误信息为 "not enough memory"
  g->memerrmsg = luaS_newliteral(L, MEMERRMSG);
	// 因为总要用到 希望它永远不被 回收
  luaC_fix(L, obj2gco(g->memerrmsg));
  // 又是因为总要在Lua中作为字符串用到 因此 在C语言层面先将其缓存起来
  // 就不用每次都将 char* 转化为 TString 了
  for (i = 0; i < STRCACHE_N; i++)
    for (j = 0; j < STRCACHE_M; j++)
      g->strcache[i][j] = g->memerrmsg;
}

static void f_luaopen(lua_State* L, void* ud) {
	/* *** */
  luaS_init(L); // 初始化 Lua 字符串
	/* *** */
}

LUA_API lua_State* lua_newstate(lua_Alloc f, void* ud) {
	lua_State* L;
  global_State* g;
	/* *** */
	g->seed = makeseed(L); // 生成随机数种子
	g->strt.size = g->strt.nuse = 0;
  g->strt.hash = NULL;
	/* *** */
if (luaD_rawrunprotected(L, f_luaopen, NULL) != LUA_OK) {
    /* memory allocation error: free partial state */
    close_state(L);
    L = NULL;
  }
  return L;
}
```

随机数种子生成规律非常有趣 它根据以下几点进行随机生成

1. 根据 lua_State 的地址
2. 根据 虚拟机的 运行时间
3. 根据 luaO_nilobject 常量的地址
4. 根据 lua_newstate 函数的地址

能想象出 Lua 作者在写出这段代码的时候 得意的笑着说 这下你总该猜不到 Lua Hash的规则了吧hhhh.

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

最后调用了 luaS_hash() 来创建 Hash Seed, 对, 这个函数又用来Hash字符串, 同时又用来创建Hash Seed.

```c
#define LUAI_HASHLIMIT 5

unsigned int luaS_hash(const char* str, size_t l, unsigned int seed) {
  unsigned int h = seed ^ cast(unsigned int, l); // ^ means Bitwise XOR
  // 如果字符串长度 < 2^5 则都会进行 Hash, 否则 会跳过部分字符 提高效率
  size_t step = (l >> LUAI_HASHLIMIT) + 1;
  for (; l >= step; l -= step)
    h ^= ((h << 5) + (h >> 2) + cast_byte(str[l - 1]));
  return h;
}
```

### 使用流程

- lua_pushstring() 从 C语言层面传入字符串到 Lua
- luaS_new() 看看是不是有缓存 有缓存则直接返回, 没有就进入到创建新字符串流程
- luaS_newlstr() 创建新字符串
    - 如果字符串长度 ≤ 40 则为短字符串 进入 internshrstr() 创建短字符串
    - 如果字符串长度 > 40 则进入 luaS_createlngstrobj() 创建长字符串
- 最后无论长短 都会进入 createstrobj() 创建字符串对象

```c
#define LUAI_MAXSHORTLEN 40

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

TString* luaS_new(lua_State* L, const char* str) {
	// 通过 str地址来查找在strcache中的位置
	// 加入 strcache 的意义就是说 当C语言的字符串频繁要转化为Lua的TString 时
  // 效率提高
  // 题外话: 在一次完整的GC的时候的atomic阶段 会调用 luaS_clearcache(g) 
/*
说是说清理 其实只不过是先判断是不是可回收的, 对 白色就代表可回收, 然后将字符串的值
修改为 特定的错误信息 并不做真正的删除
void luaS_clearcache(global_State* g) {
  int i, j;
  for (i = 0; i < STRCACHE_N; i++)
    for (j = 0; j < STRCACHE_M; j++) {
      if (iswhite(g->strcache[i][j]))
        g->strcache[i][j] = g->memerrmsg;
    }
}
*/
  unsigned int i = point2uint(str) % STRCACHE_N;
  int j;
  TString** p = G(L)->strcache[i];
  for (j = 0; j < STRCACHE_M; j++) {
    if (strcmp(str, getstr(p[j])) == 0) /* hit? */
      return p[j]; /* that is it */
  }
  /* normal route */
  for (j = STRCACHE_M - 1; j > 0; j--)
    p[j] = p[j - 1]; /* move out last element */
  /* new element is first in the list */
  p[0] = luaS_newlstr(L, str, strlen(str));
  return p[0];
}

LUA_API const char* lua_pushstring(lua_State* L, const char* s) {
  if (s == NULL)
    setnilvalue(L->top);
  else {
    TString* ts;
    ts = luaS_new(L, s);
    setsvalue2s(L, L->top, ts);
    s = getstr(ts); /* internal copy's address */
  }
  api_incr_top(L);
  luaC_checkGC(L);
  return s;
}
```

#### 短字符串执行函数 internshrstr()

```c
#define isdead(g, v) isdeadm(otherwhite(g), (v)->marked)

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
      // 就看看是否将被回收 很简单(只要看是不是下一轮要被回收的那种状态 即 另一种白色)
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

#### 长字符串执行函数 luaS_createlngstrobj()

```c
// 比较简单 单枪直入 直接调用 createstrobj()
TString* luaS_createlngstrobj(lua_State* L, size_t l) {
  TString* ts = createstrobj(L, l, LUA_TLNGSTR, G(L)->seed);
  // 注意 长字符串 不会将相同 Hash值的字符串链起来!
  // 甚至 它都没有进行 Hash!!!
  ts->u.lnglen = l;
  return ts;
}
```

### 字符串对象创建 createstrobj()

```c
static TString* createstrobj(lua_State* L, size_t l, int tag, unsigned int h) {
  TString* ts;
  GCObject* o;
  size_t totalsize; /* total size of TString object */
  totalsize = sizelstring(l);
  o = luaC_newobj(L, tag, totalsize);
  ts = gco2ts(o);
  ts->hash = h;
  ts->extra = 0; // if long string, means doesn't have a hash value
                 // if short string, means this string not a reserved key word
  getstr(ts)[l] = '\0'; // 方便C语言使用
  return ts;
}
```

总之 短字符串 即 长度 ≤ 40 的字符串 才会进行 Hash 然后加入链表中, 而长字符串不会进行 Hash !!!

而且从上面我们可以看出, 当我们修改 Lua 中的字符串的时候, 并不是直接在原字符串上做修改的(这样让其他指向这个字符串的不就很难办了?), 而是直接开一个新的字符串.

## 总结

本篇中, 讲解了 Lua 的 TString 是怎么一个组织形式, 结构是怎么样的, 长短字符串出现的历史原因, 还讲述虚拟机中的运作流程, 通过公开的 API 传入的字符串, 是怎么一步步到 Lua 中的.