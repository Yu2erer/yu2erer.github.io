---
title: C++ 内存管理 之 内存池实现
categories: C++
date: 2019-11-8 11:48:20
keywords: C++, 内存管理, 内存池
tags: [C++, 内存管理, 内存池]
---

## 为什么要实现内存池?

一方面 是为了减少 调用 `malloc()` 的次数(尽管 `malloc()` 不慢) 但是调多了 会产生(外碎片)

另一方面 是因为 每次用 `malloc()` 分配到的内存 是要交税的 就是上一节中讲的 `cookie` 里面记录着 这一块内存的大小信息(内碎片) 特别是在频繁申请小内存的时候尤为明显

## 最终 pool_allocator 版本

具体代码可见 [Memory_Pool](https://github.com/Yu2erer/Memory_Pool)

原理可见 [C++ 内存管理 之 STL内存分配实现原理](https://yuerer.com/C++%E5%86%85%E5%AD%98%E7%AE%A1%E7%90%86-%E4%B9%8B-STL%E5%86%85%E5%AD%98%E5%88%86%E9%85%8D%E5%AE%9E%E7%8E%B0%E5%8E%9F%E7%90%86/)

<!-- more -->

```c++
//
// Created by Yuerer on 2019/11/7.
//

#ifndef YY_ALLOCATOR_H
#define YY_ALLOCATOR_H

namespace YY {

    static const int ALIGN = 8;
    static const int MAX_BYTES = 128;
    static const int FREE_LIST_NUMS = MAX_BYTES / ALIGN; // 16

    class Alloc {
    public:
        static void *allocate(size_t n) {
            obj **my_free_list;
            obj *result;
            if (n > (size_t)MAX_BYTES) {
                return ::operator new(n);
            }
            my_free_list = free_list + FREE_LIST_INDEX(n);
            result = *my_free_list;
            if (result == nullptr) {
                void *r = refill(ROUND_UP(n));
                return r;
            }
            *my_free_list = result->next;
            return result;
        }
        static void deallocate(void *p, size_t n) {
            obj *q = (obj *)p;
            obj **my_free_list;
            if (n > (size_t)MAX_BYTES) {
                return ::operator delete(p);
            }
            my_free_list = free_list + FREE_LIST_INDEX(n);
            q->next = *my_free_list;
            *my_free_list = q;
        }
    private:
        // 单向链表
        union obj {
            union obj *next;
        };
    private:
        // 内存池
        static char *start_free;
        static char *end_free;
        static size_t heap_size;
    private:
        static obj *free_list[FREE_LIST_NUMS];
        static void *refill(size_t n);
        static char *chunk_alloc(size_t n, int &blocks);
    private:
        // 从 1 起步
        static size_t FREE_LIST_INDEX(size_t bytes) {
            return ((bytes + ALIGN - 1) / (ALIGN - 1));
        }
        static size_t ROUND_UP(size_t bytes) {
            return ((bytes + ALIGN - 1) & ~(ALIGN - 1));
        }
    };
    Alloc::obj *Alloc::free_list[FREE_LIST_NUMS] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    char *Alloc::start_free = nullptr;
    char *Alloc::end_free = nullptr;
    size_t Alloc::heap_size = 0;

    void *Alloc::refill(size_t n) {
        int blocks = 20;
        char *chunk = chunk_alloc(n, blocks);

        obj **my_free_list;
        obj *result;
        obj *next_obj, *current_obj;
        if (blocks == 1) {
            return chunk;
        }
        my_free_list = free_list + FREE_LIST_INDEX(n);
        result = (obj*)chunk;
        *my_free_list = next_obj = (obj*)(chunk + n);
        for (int i = 1; ; ++ i) {
            current_obj = next_obj;
            next_obj = (obj*)((char*)next_obj + n);
            if (blocks - 1 == i) {
                current_obj->next = nullptr;
                break;
            } else {
                current_obj->next = next_obj;
            }
        }
        return result;
    }

    char *Alloc::chunk_alloc(size_t n, int &blocks) {
        size_t bytes_left = end_free - start_free;
        size_t total_bytes = n * blocks;
        char *result;
        if (bytes_left >= total_bytes) {
            result = start_free;
            start_free += total_bytes;
            return result;
        } else if (bytes_left >= n) {
            blocks = bytes_left / n;
            total_bytes = n * blocks;
            result = start_free;
            start_free += total_bytes;
            return result;
        } else {
            size_t bytes_to_get = 2 * total_bytes + ROUND_UP(heap_size >> 4);
            if (bytes_left > 0) {
                obj **my_free_list = free_list + FREE_LIST_INDEX(bytes_left);
                ((obj*)start_free)->next = *my_free_list;
                *my_free_list = (obj*)start_free;
            }
            start_free = (char*)malloc(bytes_to_get);
            if (start_free == nullptr) {
                obj **my_free_list;
                obj *p;
                for (int i = n + ALIGN; i <= MAX_BYTES; i += ALIGN) {
                    my_free_list = free_list + FREE_LIST_INDEX(i);
                    p = *my_free_list;
                    if (p != nullptr) {
                        *my_free_list = p->next;
                        start_free = (char *) p;
                        end_free = (char *) p + i;
                        return chunk_alloc(n, blocks);
                    }
                }
                end_free = nullptr;
                start_free = (char*)::operator new(bytes_to_get);
            }
            heap_size += bytes_to_get;
            end_free = start_free + bytes_to_get;
            return chunk_alloc(n, blocks);
        }
    }
}

#endif //YY_ALLOCATOR_H
```

## 内存管理迭代之一

最简陋的版本 简单的来说就是 一次获取 一大块内存 然后串成链表 每次要就返回其中一块

多用了一个指针 成员变量也就4个字节 一个指针多占用了 8 个字节

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

## 内存管理迭代之二

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

## 内存管理迭代之三

静态版本

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