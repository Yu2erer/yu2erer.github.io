---
title: C++ 内存管理 之 实现内存池
categories: C++
date: 2019-11-4 17:51:20
keywords: C++, 内存管理, 内存池
tags: [C++, 内存管理, 内存池]
---

## 为什么要实现内存池?

一方面 是为了减少 调用 `malloc()` 的次数(尽管 `malloc()` 不慢) 调多了 会产生(外碎片)

另一方面 是因为 每次用 `malloc()` 分配到的内存 是要交税的 就是上一节中讲的 `cookie` 里面记录着 这一块内存的大小信息(内碎片)

## 内存管理之一

最简陋的版本 简单的来说就是 一次获取 一大块内存 然后串成链表 每次要就返回其中一块

多用了一个指针 成员变量也就4个字节 一个指针多占用了 8 个字节

<!-- more -->

```c++
class Screen {
public:
	Screen(int x) : i(x) { };
	void *operator new(size_t size) {
		Screen *p;
		if (!freeStore) {
			size_t chunk = screenChunk * size;
            // reinterpret_cast 将两个毫不相关的类型进行转换
			freeStore = p = reinterpret_cast<Screen*> (new char[chunk]);
			while (p != &freeStore[screenChunk - 1]) {
				p->next = p + 1;
				p ++;
			}
			p->next = nullptr;
		}
		p = freeStore;
		freeStore = freeStore->next;
		return p;
	}
	void operator delete(void* p, size_t) {
		(static_cast<Screen*> (p))->next = freeStore;
		freeStore = static_cast<Screen*> (p);
	}
private:
	// 多用了一个指针 成员变量也就4个字节 一个指针多占用了 8 个字节
	Screen *next;
	static Screen *freeStore;
	static const int screenChunk;
private:
	int i;
};
Screen *Screen::freeStore = nullptr;
const int Screen::screenChunk = 24;
```

## 内存管理之二

上一个版本 最大的缺陷就是说 多占用了个指针 这对于只有 一个 int 的类来说 有点浪费

使用 `union` 将类 的 成员变量和链表指针包起来 节约内存

```c++
class Airplane {
private:
	// 9个字节 对齐后 16个字节
	struct AirplaneRep {
		unsigned long miles;
		char type;	
	};
private:
	union { // 采用 union 将数据成员和链表指针占用空间节约起来
		Airplane *next;  // 链表
		AirplaneRep rep; // 相当于使用中的 obj
	};
public:
	void *operator new(size_t size) {
		// 如果发生了继承就会进入这个分支
		if (size != sizeof(Airplane)) {
			return ::operator new(size);
		}
		Airplane *p = head;
		if (p) {
			head = p->next;
		} else {
			Airplane *newBlock = static_cast<Airplane*> (::operator new(BLOCK_SIZE * sizeof(Airplane)));
			for (int i = 1; i < BLOCK_SIZE - 1; i ++) {
				newBlock[i].next = &newBlock[i + 1];
			}
			newBlock[BLOCK_SIZE - 1].next = nullptr;
			p = newBlock;
			head = &newBlock[1];
		}
		return p;
	}
	void operator delete(void *p, size_t size) {
		if(p == nullptr) {
			return;
		}
		if (size != sizeof(Airplane)) {
			::operator delete(p);
			return;
		}
		Airplane *rp = static_cast<Airplane*> (p);
		rp->next = head;
		head = rp;
	}
private:
	static const int BLOCK_SIZE;
	static Airplane *head;
};
Airplane *Airplane::head = nullptr;
const int Airplane::BLOCK_SIZE = 512;
```

## static allocator

前面两个 必须要为不同的 `classes` 重写一个几乎相同的 `member operator new 和 member operator delete`

因此这个版本 将其抽取出来 放到一个 `class` 中

```c++
class allocator {
private:
	struct obj {
		struct obj *next;	
	};
public:
	void *allocate(size_t size) {
		obj *p;
		if (!freeStore) {
			size_t chunk = CHUNK * size;
			freeStore = p = (obj*)malloc(chunk);
			for (int i = 0; i < CHUNK - 1; i ++) {
				p->next = (obj*)((char*)p + size);
				p = p->next;
			}
			p->next = nullptr;
		}
		p = freeStore;
		freeStore = freeStore->next;
		return p;
	}
	void deallocate(void *p, size_t) {
		((obj*)p)->next = freeStore;
		freeStore = (obj*)p;
	}
public:
	obj *freeStore = nullptr;
	// 标准库中为 20
	const int CHUNK = 5;
};
```