---
title: Skynet 时间轮剖析
categories: Skynet
date: 2023-08-26 08:20:20
keywords: Lua, Skynet, TimingWheel, Timer
tags: [Skynet, Lua, TimingWheel, Timer]
---
## 前言

定时器的实现通常使用有序数据结构来实现，一般通过红黑树、跳表、最小堆、时间轮来实现。

其中又以最小堆最容易实现，红黑树最难实现。

Skynet 选择时间轮的原因估计是多线程，时间轮的插入平均复杂度比其他几个都要低，非常适用于多线程场景。

本篇就简单剖析一下 Skynet 实现的 TimingWheel。以下代码为方便阅读有删减。

## 时间轮

首先实现上是采用数组 + 链表的形式进行实现。

先定义了一个链表，存放了过期时间，从 `*tail` 可以看出，此结构为尾插法，毕竟后插入的定时器后执行，很合理。

```c
struct timer_node {
	struct timer_node *next;
	uint32_t expire;
};

struct link_list {
	struct timer_node head;
	struct timer_node *tail;
};
```

<!-- more -->

时间轮数据结构中含有一把自旋锁，时间轮在框架中会被多线程访问，又由于插入的时候冲突的粒度比较小，所以用自旋锁而不是互斥锁。

```c
#define TIME_NEAR_SHIFT 12
#define TIME_NEAR (1 << TIME_NEAR_SHIFT)
#define TIME_LEVEL_SHIFT 5
#define TIME_LEVEL (1 << TIME_LEVEL_SHIFT)
#define TIME_NEAR_MASK (TIME_NEAR-1)
#define TIME_LEVEL_MASK (TIME_LEVEL-1)

struct timer {
	struct link_list near[TIME_NEAR];
	struct link_list t[4][TIME_LEVEL];
	struct spinlock lock;
	uint32_t time;
	uint64_t current;
	uint64_t current_point;
};
```

从中可以看出，Skynet 的时间轮有5个层级，其中会执行的那层 为 `near` 数组，其他的4层均不会被执行到。

之所以要分为5层，是为了节约内存，不然你完全可以定义一个巨大的数组，每个槽位表示每秒要执行的任务。

其中第一层大小为 `1 << 12` 即 `4096`，2-5层为 `1<<5` 即 `32` 。

可以看出定时器最大值为 12 + (4 * 5) = 32 位。

每当遍历完整个 `near` 数组后，则从下面几层中取出一个槽位，将其填充到 `near` 数组继续模拟计时。

大致了解数据结构之后，再来看初始化逻辑。

### 定时器初始化

```c
void
skynet_timer_init(void) {
	TI = timer_create_timer();
	uint32_t current = 0;
	TI->current = current;
	TI->current_point = gettime();
}
```

均为简单的初始化链表。

```c
static struct timer *
timer_create_timer() {
	struct timer *r=(struct timer *)skynet_malloc(sizeof(struct timer));
	memset(r,0,sizeof(*r));

	int i,j;

	for (i=0;i<TIME_NEAR;i++) {
		link_clear(&r->near[i]);
	}

	for (i=0;i<4;i++) {
		for (j=0;j<TIME_LEVEL;j++) {
			link_clear(&r->t[i][j]);
		}
	}

	SPIN_INIT(r)

	r->current = 0;

	return r;
}
```

其中 `gettime` 使用了 `clock_gettime` 而且还是单调时间，避免系统时间被修改。 `clock_gettime` 的时间精度为纳秒，此函数进行换算后，最后精度为毫秒，而且还是10毫秒，此时我们可以猜测时间轮的精度为10ms。

```c
static uint64_t
gettime() {
	uint64_t t;
	struct timespec ti;
	clock_gettime(CLOCK_MONOTONIC, &ti);
	t = (uint64_t)ti.tv_sec * 1000;
	t += ti.tv_nsec / 1000000;
	return t;
}
```

### 定时器更新

定时器更新由定时器线程去执行，每隔 100 微秒(也就是 0.1毫秒) 触发一次定时器更新，之所以外面调用是 0.1 毫秒，而时间轮精度为10 毫秒，是为了留足时间给定时器回调函数执行，否则某些函数执行时间过长，可能会导致定时器越来越晚触发。

```c
static void *
thread_timer(void *p) {
	for (;;) {
		skynet_updatetime();
		usleep(100);
	}
}
```

`skynet_updatetime` 还考虑到时间倒流的问题，虽然我认为是不会触发，因为 `clock_gettime` 取的是 `CLOCK_MONOTONIC` 的时间，即系统启动后至今的时间，不会倒流。

之所以此处 要判断  `(cp != TI->current_point)` 是因为 `update` 的间隔为 0.1 毫秒，而时间轮精度为10 毫秒，可能 `update` 执行的时候 还没到定时的最小精度，最终触发 `timer_update` 。

```c
int
skynet_updatetime(void) {
	int count = 0;
	uint64_t cp = gettime();
	if(cp < TI->current_point) {
		skynet_error(NULL, "ERROR: time diff error: change from %lld to %lld", cp, TI->current_point);
		TI->current_point = cp;
	} else if (cp != TI->current_point) {
		uint32_t diff = (uint32_t)(cp - TI->current_point);
		TI->current_point = cp;
		TI->current += diff;
		int i;
		for (i=0;i<diff;i++) {
			count += timer_update(TI);
		}
	}
	return count;
}
```

### 时间轮执行

先加自旋锁，然后进行执行 timeout 为 0 的回调，否则后面进行 转移 2-4 层的时间轮，将 `near` 层时间轮覆盖后，就再也执行不到了。

```c
static int
timer_update(struct timer *T) {
	int count = 0;

	SPIN_LOCK(T);

	// try to dispatch timeout 0 (rare condition)
	count += timer_execute(T);

	// shift time first, and then dispatch timer message
	timer_shift(T);

	count += timer_execute(T);

	SPIN_UNLOCK(T);
	return count;
}
```

执行逻辑很简单，用当前 time(为tick) % 4096 找到需要执行的槽位的链表，在代码中为了提升性能用了位运算 & 实现。这里还能注意到小细节，执行回调函数链表时不需要加锁。

```c
static inline int
timer_execute(struct timer *T) {
	int count = 0;
	int idx = T->time & TIME_NEAR_MASK;

	while (T->near[idx].head.next) {
		struct timer_node *current = link_clear(&T->near[idx]);
		SPIN_UNLOCK(T);
		// dispatch_list don't need lock T
		count += dispatch_list(current);
		SPIN_LOCK(T);
	}
	return count;
}
```

### 时间轮 Shift 操作

该函数由于用了大量位运算，所以看起来会比较难看，可以先从 while 的条件开始看，先是用当前 tick 也就是 ct % 4096，如果为 0，则说明 `near` 层的槽位已经全部走完 此时走完了 4096 * 10 毫秒，大约是40.96秒。接下来就是要找到正确的层次，然后从层次中找到正确的槽位，将其填充到 `near` 数组，即 ct / 4096 % 32，若为 0，则说明不在当前层次，还能再 除以一个 32。总之将位运算代码 & 翻译为 取余，>> 翻译为 除法，此函数的逻辑便不言自明。

同时 T→time 会一直递增，最后溢出回到0，uint32 的最大值为 **`4294967295`** 溢出为 0，则说明正确的值为 **`4294967296`** 那么 用该值 / 4096 / 32 / 32 / 32 / 32 发现 为 1，这就说明我们此时需要将 第四层的第0个槽位挪到 `near` 数组。 非常简单。

```c
static void
timer_shift(struct timer *T) {
	int mask = TIME_NEAR;
	uint32_t ct = ++T->time;
	if (ct == 0) {
		move_list(T, 3, 0);
	} else {
		uint32_t time = ct >> TIME_NEAR_SHIFT;
		int i=0;

		while ((ct & (mask-1))==0) {
			int idx=time & TIME_LEVEL_MASK;
			if (idx!=0) {
				move_list(T, i, idx);
				break;
			}
			mask <<= TIME_LEVEL_SHIFT;
			time >>= TIME_LEVEL_SHIFT;
			++i;
		}
	}
}
```

### 时间轮添加

`timer_add` 告诉了我们定时器传进来的参数 `time` 并不是要计时的值，而是多少个 `tick` ，比如 `time` 传入 10 时，则以为这 10个 `tick` 也就是 10 * 10 毫秒后到时。 `expire` 表示的就是多少个 `tick` 后到时。

```c
static void
timer_add(struct timer *T,void *arg,size_t sz,int time) {
	struct timer_node *node = (struct timer_node *)skynet_malloc(sizeof(*node)+sz);
	memcpy(node+1,arg,sz);

	SPIN_LOCK(T);

		node->expire=time+T->time;
		add_node(T,node);

	SPIN_UNLOCK(T);
}
```

又是一大坨位运算，就是判断 `expire` 应该插入到哪一层，如果将其改写，则需要大量的 if 判断。

```c
static void
add_node(struct timer *T,struct timer_node *node) {
	uint32_t time=node->expire;
	uint32_t current_time=T->time;

	if ((time|TIME_NEAR_MASK)==(current_time|TIME_NEAR_MASK)) {
		link(&T->near[time&TIME_NEAR_MASK],node);
	} else {
		int i;
		uint32_t mask=TIME_NEAR << TIME_LEVEL_SHIFT;
		for (i=0;i<3;i++) {
			if ((time|(mask-1))==(current_time|(mask-1))) {
				break;
			}
			mask <<= TIME_LEVEL_SHIFT;
		}
		link(&T->t[i][((time>>(TIME_NEAR_SHIFT + i*TIME_LEVEL_SHIFT)) & TIME_LEVEL_MASK)],node);
	}
}
```
