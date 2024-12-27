---
title: SkipList 原理及在游戏排行榜中的应用
categories: 游戏设计
date: 2020-09-12 15:05:20
keywords: Redis, SkipList, 游戏服务器, 排行榜
tags: [Redis, SkipList, 游戏服务器, 排行榜]
---

近期工作的内容主要是设计一个通用的游戏排行榜服务器, 通用的含义指的是同时为多个项目组提供一套通用的解决方案, 经过不断的调研, 最终写下此文.

本文将会讲述 排行榜的多种实现方式, 不过最终我选择了 SkipList 作为底层的数据结构, 因此会着重讲SkipList.

先来讲一下排行榜的主要功能.

## 排行榜主要功能

- 更新/删除/获取 一个 Key 在某个 排行榜 上的 排名, 及展示信息
- 获取 一个排行榜 任意区间(例如排名区间) 的展示信息

## 排行榜排序方案

游戏中的排行榜的排序方案无非就两种

- 实时排序, 即玩家数值变化的瞬间, 就完成了对它的排序
- 非实时排序, 亦可称之为定时排序, 玩家数据变动不立即排序, 而是直到策划所配的时间点到的时候才进行排序

这两种排序方案没有好坏之分, 主要是看策划他想要什么? ~~(或许他自己也不知道想要什么, 他都想试试看, 他只顾着他自己)~~

<!-- more -->

## 数据结构的抉择

首先, 因为我们要提供给多个项目组一套解决方案, 每个项目组需要的排序方案大概率是不同的, 因此 排除了定时排序, 如果一开始就往定时排序的思路上想, 到时候哪个项目组突然说要实时排序, 改动起来会非常痛苦, 而且定时排序实现起来比较简单, 直接到点快排就完事了.

那么 排除了 定时排序, 就只能朝着实时排序的思路上走.

业界一般采用两种数据结构进行实现

- RB Tree 红黑树
    - 优势:
        - 时间复杂度的常数相对 SkipList 低
        - 内存占用也相对较低
    - 不足:
        - 实现复杂
        - 不能方便的获取到某个区间的信息
- SkipList 跳表
    - 和 红黑树 相反

或许 堆也可以加进去, 取topK, 但是超出了k项, 就不知道排名.

SkipList 在 redis 的有序集合中也有用到, 这时候可能会有人问 为什么你不考虑直接用 redis 呢?

我考虑的点主要有以下几点

1. 引入 redis 会增加部署难度
2. 引入 redis 仅仅只用来做排序, 是不是太笨重了?
3. redis 的默认 SkipList 实现是从小到大, 而我们知道一般是分值越靠前的越经常访问, 如果从小到大 查找靠前的效率可能不如从大到小, 但是 redis 写死排序顺序了, 我不开心
4. 现在游戏服务器为了避免宕机的风险, 都会把服务器拆的特别细, 但是这就会带来一个问题, 本来一件事情能在一个地方集中处理完, 现在要多走几条链路才能做完, 效率会变低, 如果再加入一个 redis, 链路只会更长

不过, 我们实现的时候可以参考 redis 的 SkipList.

## 排行榜服务实现

首先 我们要抽象出 key 和 value 这两个概念, key 你可以理解为 playerID, 那之所以叫 key 是因为 有的排行榜它不是以角色为单位, 它也有可能是以宠物为单位, 此时的 key 就是 petID. value 就是分值, 不过这里不能简单地就一个分值, 试想一下, 如果分值相同了怎么办?

以下代码均为伪代码, 随手一写.

```cpp
struct Value {
    uint64_t score;
    // 加入操作时间这一概念, 如果分值相同, 先来排前
    int64_t operatorTime;
};

struct Data {
    uint64_t key;
    Value value;
};
```

Data 表示的就是 这个 key 用于排序的信息, 那么这时候有个问题 如果 这个 key 同时出现在 A, B 两个排行榜, 那么 key 就可能造成数据冗余, 占用内存, 这个时候 就要改造 Data 这一 结构.

```cpp
struct Data {
    uint64_t key;
    // Value value;
    // [leaderBoardID, value]
    Value unordered_map<uint32_t, Value> value;
};
```

这时候 如果一个 key 出现在多个排行榜 只需要在 这个 map 里 通过 排行榜ID 去找属于这个排行榜的分值就行了.

此时又出现了一个问题, player key 和 pet key 有可能相同 通过 key 来查找数据 显然是不合理的.

这时候就要引入一个 DataType 可以理解为 key 的类型, 它与 排行榜LeaderBoard 绑定在一起.

```cpp
typedef uint32_t DataType;
vector<Data> DataArray;

struct LeaderBoard {
    uint32_t leaderBoardID;
    DataType dataType;
    // 真正去排序的 SkipList
    SkipList list;
};
score = DataArray[leaderBoard.dataType].value[leaderboard.leaderBoard.ID].score;
```

这样就能通过 排行榜 反查到其旗下的排行信息.

讲清楚了排行榜的设计, 接下来就是重头戏 SkipList 的实现, 这里我 拿出 Redis 的源码来讲解.

## SkipList 原理

其实你可以这么理解, 普通的链表 搜索一个东西 要遍历一次 时间复杂度为 O(n), 要想提高搜索速度, 就要尽可能跳过多的节点, 那么给它建多条索引链就行了.

```cpp
┌────────┐    .─.                .─.               .─.
│  Head  ├──▶(Min───────────────▶ 7 ──────────────▶99 )  Level 3
└────┬───┘    `─'                `┬'               `┬'
     │                            │                 │
┌────▼───┐    .─.    .─.         .▼.   .─.         .▼.
│  Head  ├──▶(Min──▶( 3 ────────▶ 7 ──▶30 ────────▶99 )  Level 2
└────┬───┘    `─'    `┬'         `┬'   `┬'         `┬'
     │                │           │     │           │
┌────▼───┐    .─.    .▼.   .─.   .▼.   .▼.   .─.   .▼.
│  Head  ├──▶(Min──▶( 3 ──▶ 9 ──▶ 7 ──▶30 ──▶90 ──▶99 )  Level 1
└────────┘    `─'    `─'   `─'   `─'   `─'   `─'   `─'
```

从最上面的索引链表开始搜 30 的排名 可以像下面这样搜索

```cpp
┌────────┐    .─.                .─.               .─.
│  Head  ├──▶(Min──────3────────▶ 7 ──────────────▶99 )  Level 3
└────┬───┘    `─'                `┬'               `┬'
	 │                            │                 │
┌────▼───┐    .─.    .─.         .▼.   .─.         .▼.
│  Head  ├──▶(Min──▶( 3 ────────▶ 7  1▶30 ────────▶99 )  Level 2
└────┬───┘    `─'    `┬'         `┬'   `┬'         `┬'
     │                │           │     │           │
┌────▼───┐    .─.    .▼.   .─.   .▼.   .▼.   .─.   .▼.
│  Head  ├──▶(Min──▶( 3 ──▶ 9 ──▶ 7 ──▶30 ──▶90 ──▶99 )  Level 1
└────────┘    `─'    `─'   `─'   `─'   `─'   `─'   `─'
```

min 后面 要跨越 span = 3 才能到 7,  7要跨越 span = 1 才能到 30, 因此 30 从小到大为第四名.

至此, 我们知道 skiplist 本质就是多个索引 快速查找, 同时维护了一个 span值, 来快速得到 排名

### Redis 中 SkipList 的实现

首先是要确定, 我们提升一个节点到索引链的概率, 和 要建多少条索引链, redis 中 最大层级为32层, 每次提升节点的概率为 0.25.

```c
#define ZSKIPLIST_MAXLEVEL 32
#define ZSKIPLIST_P 0.25
int zslRandomLevel(void) {
    int level = 1;

    while ((random()&0xFFFF) < (ZSKIPLIST_P * 0xFFFF))
        level += 1;

    return (level<ZSKIPLIST_MAXLEVEL) ? level : ZSKIPLIST_MAXLEVEL;
}
```

通过这个随机算法, 可以粗略的计算

- 层数为 1, 概率为 1 - p
- 层数为 2, 概率为 (1 - p)*p
- 层数为 3, 概率为 (1 - p)*p*p

平均层数为 (1-p)+ (1-p)*p + (1-p)*p*p + ... = 1 / 1 - p

如果按照 redis 的提升概率 0.25 来算, 那么空间上膨胀 (4 / 3) 即 1.33倍.

下面来看 SkipList 的定义.

```c
typedef struct zskiplistNode {
    // 一个对象, 当分值相同时, 它决定了先后顺序, 可以忽视
    robj *obj;
    // 分值
    double score;
    // 回退指针, 其实基本用不上
    struct zskiplistNode *backward;
    // 每一层
    struct zskiplistLevel {

        // 前进指针
        struct zskiplistNode *forward;

        // 距离后一个节点要走几步, 用来算 排名
        unsigned int span;

    } level[];

} zskiplistNode;

typedef struct zskiplist {
    // 头和尾节点
    struct zskiplistNode *header, *tail;
    // 表中节点的数量, 不然它从小到大排序, 你怎么找最大的?
    unsigned long length;
    // 最大层数 不超过 32层
    int level;

} zskiplist;
```

### Insert 插入操作

主要是从最高层, 依次向下找 新来的值应该插入到哪, 然后 保存到 update 这个数组中, 这样就不用每找一层就改一层.

```c
zskiplistNode *zslInsert(zskiplist *zsl, double score, robj *obj) {
    zskiplistNode *update[32], *x;
    unsigned int rank[32];
    int i, level;

    x = zsl->header;
    for (i = zsl->level-1; i >= 0; i--) {

        // 最顶层的起始 rank值当然是 0
        rank[i] = i == (zsl->level-1) ? 0 : rank[i+1];


        // 从小到大排
        while (x->level[i].forward &&
            (x->level[i].forward->score < score ||
                (x->level[i].forward->score == score &&
                compareStringObjects(x->level[i].forward->obj,obj) < 0))) {

            // 跨度就是 排名
            rank[i] += x->level[i].span;

            x = x->level[i].forward;
        }
        update[i] = x;
    }

    level = zslRandomLevel();

    // 初始化未使用层级
    if (level > zsl->level) {
        for (i = zsl->level; i < level; i++) {
            rank[i] = 0;
            update[i] = zsl->header;
            update[i]->level[i].span = zsl->length;
        }
        zsl->level = level;
    }

    x = zslCreateNode(level,score,obj);

    // 把 update 记录的位置, 拿来做修正
    for (i = 0; i < level; i++) {

        // 简单的链表插入操作, 你只需要记住, update[i]->x->update[i].forward
        x->level[i].forward = update[i]->level[i].forward;
        update[i]->level[i].forward = x;

        // rank[0] 是最底层链表的 x 的前一个节点
        // rank[i] 是第i层链表 距离 x 的前一个节点
        // 相当于修复一下 第i层链表距离x的前一个节点的span值
        x->level[i].span = update[i]->level[i].span - (rank[0] - rank[i]);
        update[i]->level[i].span = (rank[0] - rank[i]) + 1;
    }

    for (i = level; i < zsl->level; i++) {
        update[i]->level[i].span++;
    }

    x->backward = (update[0] == zsl->header) ? NULL : update[0];
    if (x->level[0].forward)
        x->level[0].forward->backward = x;
    else
        zsl->tail = x;

    zsl->length++;

    return x;
}
```

### GetRank 获取排名

一样从最上层开始找... 然后累计 span 值

```c
unsigned long zslGetRank(zskiplist *zsl, double score, robj *o) {
    zskiplistNode *x;
    unsigned long rank = 0;
    int i;

    x = zsl->header;
    for (i = zsl->level-1; i >= 0; i--) {

        while (x->level[i].forward &&
            (x->level[i].forward->score < score ||
                (x->level[i].forward->score == score &&
                compareStringObjects(x->level[i].forward->obj,o) <= 0))) {

            rank += x->level[i].span;

            x = x->level[i].forward;
        }

        if (x->obj && equalStringObjects(x->obj,o)) {
            return rank;
        }
    }

    return 0;
}
```

### GetElementByRank 根据排名找对象

用 traversed 统计意境走过的步长, 这个思路还是比较清奇的...

```c
zskiplistNode* zslGetElementByRank(zskiplist *zsl, unsigned long rank) {
    zskiplistNode *x;
    unsigned long traversed = 0;
    int i;

    x = zsl->header;
    for (i = zsl->level-1; i >= 0; i--) {

        while (x->level[i].forward && (traversed + x->level[i].span) <= rank)
        {
            traversed += x->level[i].span;
            x = x->level[i].forward;
        }

        if (traversed == rank) {
            return x;
        }

    }

    // 没找到目标节点
    return NULL;
}
```

至此, Redis 中的 SkipList 已经基本了解完了.

## 排行榜的另类做法

其实如果你知道 玩家的分值的区间, 例如皇室战争的皇冠杯数大致的范围你是知道的, 那你其实可以这么来做

```cpp
vector<vector<uint32_t>> array;
array[皇冠数].push_back(👑的key);
这样要取出其排名, 只需要累加前面的 数组就可以了..

假设 分值为 1 - 5 
[5] [4] [3] [2] [1]
k1  k4  k2  k5  k7
k3      k6

那你要得到 k2 的排名, 你只需要 累加 [5] + [4] 的大小就能算出来
```