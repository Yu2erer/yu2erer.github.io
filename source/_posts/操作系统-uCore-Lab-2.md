---
title: 操作系统 uCore Lab 2
categories: 操作系统
date: 2018-11-19 14:24:20
keywords: 操作系统, ucore, lab 2
tags: [操作系统, uCore, Lab, 内存分配]
---
### x86 特权级 (Privilege Levels)

* RING 0(内核) 
* RING 1(服务) 
* RING 2(服务) 
* RING 3(应用程序)

当前操作系统 一般只用到了 RING 0 和 RING 3 比如 Linux
在访问数据段 页表 进入中断服务例程 (ISRs) CPU 会检查特权级

#### x86 特权级检查失败
会提示 General Protection Fault 一般保护错误

<!-- more -->
#### x86 特权级检查
RPL 请求特权级 DS ES GS FS 数据段

CPL 当前特权级 存在于 CS / SS 的低2位

![](/images/segmentregister.png)

DPL 段或者门的特权级

![](/images/segmentdescriptor.png)

访问门时 CPL <= DPL[门] && CPL >= DPL[段]
访问段时 MAX(CPL, RPL) <= DPL[段]

#### x86 通过中断切换特权级
首先在中断描述符表里 建立好 中断门 来实现中断切换特权级

![](/images/interruptgate.png)

##### RING 0 to RING 3
当 ring 0 内核态发生中断的时候 首先因为发生中断的时候还是在 ring 0 所以不会将 ss esp 压入堆栈中 只会压入 Eflags cs eip 和 中断错误码

因此 为了实现从 ring 0 到 ring 3 的特权级转换 将其 ss 改成特权级3的栈 cs 改为用户代码段 最后通过 IRET 将这些信息 POP 出栈 此时 运行环境就进入了用户态中了 

![](/images/ring0toring3.png)

##### RING 3 to RING 0
当 ring 3 用户态发生中断时 会将 ss esp 压入堆栈中 这是为了 跳出中断的时候 还能返回到这个用户态中 但是我们是为了实现 从 ring 3 到 ring 0 的特权级转换
因此 ss esp 是不需要的 将它们给去掉 同时将 cs 改为 内核态代码段 最后 还是 通过 IRET 将这些信息 POP 出栈 就回到了 ring 0 内核态中

![](/images/ring3toring0.png)

##### TSS 任务状态段 (Task State Segment)
TSS 的位置 可以从 全局描述符表 中的 任务状态描述符 (Task State Descriptor) 中找到

因为 IDT 中断描述符表 中的 中断门 有 代码段选择子 可以用它作为索引从 GDT 全局描述符表中 找到实际的代码段的内存地址 但是 ss 和 esp 是不存在于 中断门中的
它们 存在于 TSS 中. TR(Task Register) 寄存器会缓存 TSS 从而实现 任务的切换

![](/images/tss.png)

tss 在里面 只会保存 ring 0 ~ ring 2 的 ss 和 esp 之所以不保存 ring 3 的 ss 和 esp 是因为 CPU 默认只支持 从低特权级跳到高特权级 而 ring 3 是最低的特权级 不会有其他的特权级跳过去了 因此 不保存 ring 3 的 ss 和 esp

#### x86 内存管理单元 MMU
##### 段机制
首先通过段选择子作为索引 在 GDT 全局描述符表中找到 段描述符 若没启动页机制的话 那么现在就找到 线性地址 

![](/images/segment_based.png)

GDT 存在于内存当中 因为它所占空间比较大 但是由于内存比较慢 每次去访问 段表的时候 耗费比较大 因此 硬件会将 GDT 中的描述信息(Base Address, Limit...) 放在 CPU 来加快段的映射过程 
##### 页机制

1. 线性地址 的 高十位 + cr3 中的 PDE 页目标表的地址 找到 PTE 页表的 物理地址 
2. PTE 页表物理地址+ 线性地址中间 10位 找到 物理页基址 
3. 物理页基址 加上 线性地址的 低 12位 找到物理地址

![](/images/coarsepagetable.png)

页目录表项和页表项的高20位为物理页表地址/物理页地址 之所以只用到 20 位 是因为页是以 4K 为单位 地址都是 4K的倍数 后面12位都为 0 所以 可以将多余的 12 位用作属性位

* AVL CPU 不理会这个属性 可以不管 (有可能在32位系统使用大过 4G内存的时候 用到这几位) 
* G Global 全局位 表示是否将虚拟地址与物理地址的转换结果缓存到 TLB 中
* D Dirty 脏页位 当 CPU 对这个页进行写操作时 会置 1
* PAT Page Attribute Table 页属性表位 置 0
* A Accessed 访问位 若为 1 则 说明 CPU 访问过了 CPU 会定时清 0 记录被置 1 的频率 当内存不足时 会将 使用频率较低的页面换出到外存 同时将 P位 置 0 下次访问 该页时 会引起 Pagefault 异常 中断处理程序再将此页换上
* PCD Page-level Cache Disable 页级高速缓存位 置 0 即可 读的时候 高速缓存是否有效 若有效则直接从高速缓存中读出 若无效的话 则必须实实在在的从 I/O 端口去读数据
* PWT Page-level Write-Through 页级通写位 控制是先写到高速缓存里再慢慢回写到内存里 还是 直接慢慢写到内存里
* US User/Superviosr 普通用户/超级用户位
* RW Read/Write 读写位
* P Present 存在位 (虚拟页式存储的关键位 若为 0 则发起缺页异常)

![](/images/pagetableentries.png)

##### 如何开启页机制

1. 准备好页目录表和页表
2. 页目录表物理地址 写入 cr3 寄存器
3. cr0 最高位 PG位 置 1

##### 段机制和页机制都能作为映射机制 应该如何选择?
选择页机制有助于硬件机制对其进行有效的处理

使用段机制的安全保护手段 来保护系统的安全 但是弱化了 段机制的映射 使用页机制的映射

段机制和页机制结合成段页式的存储管理 从而 既能便于程序的共享和保护 又能高效率利用存储空间

#### 线性地址 虚拟地址 逻辑地址 物理地址 有效地址 区别

* 保护模式 段基址+段偏移 = 线性地址 若不开分页 == 物理地址
* 实模式/保护模式 段偏移 = 有效地址 也称 逻辑地址
* 开启分页后 线性地址 == 虚拟地址

## Ucore Lab 2

### 练习0: 填写已有实验
本实验依赖实验1。请把你做的实验1的代码填入本实验中代码中有“LAB1”的注释相应部分。提示：可采用diff和patch工具进行半自动的合并（merge），也可用一些图形化的比较/merge工具来手动合并，比如meld，eclipse中的diff/merge工具，understand中的diff/merge工具等。

```
其实 就 kdebug.c init.c(Lab 1 Challenge 可以不管) trap.c 这三个文件自己复制粘贴下完事
```

### 补充说明
#### int 0x15 0xE820 物理内存探测
首先 Lab 2 我们知道是要实现连续物理内存的分配 那么就要知道 我们的物理内存有多少
Linux 采用 实模式下 int 0x15 中断来探测 物理内存的大小 它 和 ucore 不同的是 Linux 通过三种不同的方法来获取 物理内存大小 分别是
(E820h E801h 88h) 功能依次减弱 当一种方法不能使用时 则采用更弱的一种方法去获取 而 ucore 直接采用最强大的 E820h 方法 来获取物理内存

下面是通过中断将物理内存信息 存放到 0x8000 的代码实现
```c
struct e820map {
    int nr_map;
    struct {
        long long addr;
        long long size;
        long type;
    } map[E820MAX];
};
probe_memory:
//对0x8000处的32位单元清零,即给位于0x8000处的
//struct e820map的成员变量nr_map清零
                  movl $0, 0x8000
                  xorl %ebx, %ebx
//表示设置调用INT 15h BIOS中断后，BIOS返回的映射地址描述符的起始地址
                  movw $0x8004, %di
start_probe:
                  movl $0xE820, %eax // INT 15的中断调用参数
//设置地址范围描述符的大小为20字节，其大小等于struct e820map的成员变量map的大小
                  movl $20, %ecx
//设置edx为534D4150h (即4个ASCII字符“SMAP”)，这是一个约定
                  movl $SMAP, %edx
//调用int 0x15中断，要求BIOS返回一个用地址范围描述符表示的内存段信息
                  int $0x15
//如果eflags的CF位为0，则表示还有内存段需要探测
                  jnc cont
//探测有问题，结束探测
                  movw $12345, 0x8000 // 12345 这个数是给 ucore 检测错误用的
                  jmp finish_probe
cont:
//设置下一个BIOS返回的映射地址描述符的起始地址
                  addw $20, %di
//递增struct e820map的成员变量nr_map
                  incl 0x8000
//如果INT0x15返回的ebx为零，表示探测结束，否则继续探测
                  cmpl $0, %ebx
                  jnz start_probe
finish_probe:
```

#### 系统执行中的地址映射四阶段

第一阶段 bootloader 阶段 也就是此时 kernel 还没有载入 从bootloader的start函数（在boot/bootasm.S中）到执行ucore kernel的kern_\entry函数之前 和 Lab 1一样 

`virt addr = linear addr = phy addr`

第二阶段 从kern_\entry函数开始，到执行enable_page函数（在kern/mm/pmm.c中）之前再次更新了段映射，还没有启动页映射机制 而 Lab 2 通过 ld 工具将 ucore 起始内核虚拟地址设置为了 0xC0100000 但其实际 物理内存地址仍是 0x100000(换句话说就是 我链接的 ucore的内核虚拟地址 是假设开了分页后的特意算好的地址 但是我进入内核的时候 还没有开好分页 所以只能从段机制上做文章 也就是让段的起始地址 从 -0xc0000000开始) 为了使ucore正确运行 映射关系应为

`virt addr - 0xC0000000 = linear addr = phy addr`

第三阶段 从enable_page函数开始，到执行gdt_init函数（在kern/mm/pmm.c中）之前，启动了页映射机制 然而之前第二阶段的段机制还没有修改
此时的映射关系为

`virt addr = linear addr + 0xC0000000 = phy addr + 2 * 0xC0000000`

这肯定是错的 我们想要的 映射 应该是

`virt addr = linear addr + 0xC0000000 = phy addr + 0xC0000000`

ucore 采用一个小技巧 就是建立临时的页映射 线性地址 0xC0000000~0xC0400000(4MB) 映射到物理地址 0x00000000~0x00400000(4MB) 按照我们想要的映射关系映射 4MB 之外的内存地址 依然保留错误的映射关系 但也足够了 因为 ucore 的内核大小也就 3MB

第四阶段 可喜可贺 从gdt_init函数开始 此时重设了 GDT 的段起始地址 又改回了 0 然后再将第三阶段的临时 映射关系给取消了 终于得到了想要的 映射关系

`virt addr = linear addr = phy addr + 0xC0000000`

### 练习1: 实现 first-fit 连续物理内存分配算法
在实现first fit 内存分配算法的回收函数时，要考虑地址连续的空闲块之间的合并操作。提示:在建立空闲页块链表时，需要按照空闲页块起始地址来排序，形成一个有序的链表。可能会修改default_pmm.c中的default_init，default_init_memmap，default_alloc_pages， default_free_pages等相关函数。请仔细查看和理解default_pmm.c中的注释。

```c
struct Page {
    // 页帧的 引用计数
    int ref;
    // 页帧的状态 Reserve 表示是否被内核保留 另一个是 表示是否 可分配
    uint32_t flags;
    // 记录连续空闲页块的数量 只在第一块进行设置
    unsigned int property;
    // 用于将所有的页帧串在一个双向链表中 这个地方很有趣 直接将 Page 这个结构体加入链表中会有点浪费空间 因此在 Page 中设置一个链表的结点 将其结点加入到链表中 还原的方法是将 链表中的 page_link 的地址 减去它所在的结构体中的偏移 就得到了 Page 的起始地址
    list_entry_t page_link;
};

// 初始化空闲页块链表
static void default_init(void) {
    list_init(&free_list);
    nr_free = 0; // 空闲页块一开始是0个
}
// 初始化n个空闲页块
static void default_init_memmap(struct Page *base, size_t n) {
    assert(n > 0);
    struct Page *p = base;
    for (; p != base + n; p ++) {
        assert(PageReserved(p)); // 看看这个页是不是被内核保留的
        p->flags = p->property = 0;
        set_page_ref(p, 0);
    }
    base->property = n; // 头一个空闲页块 要设置数量
    SetPageProperty(base);
    nr_free += n;
    // 初始化玩每个空闲页后 将其要插入到链表每次都插入到节点前面 因为是按地址排序
    list_add_before(&free_list, &(base->page_link));
}
// 分配n个页块
static struct Page * default_alloc_pages(size_t n) {
    assert(n > 0);
    if (n > nr_free) {
        return NULL;
    }
    struct Page *page = NULL;
    list_entry_t *le = &free_list;
    // 查找 n 个或以上 空闲页块 若找到 则判断是否大过 n 则将其拆分 并将拆分后的剩下的空闲页块加回到链表中
    while ((le = list_next(le)) != &free_list) {
        // 此处 le2page 就是将 le 的地址 - page_link 在 Page 的偏移 从而找到 Page 的地址
        struct Page *p = le2page(le, page_link);
        if (p->property >= n) {
            page = p;
            break;
        }
    }
    if (page != NULL) {
        if (page->property > n) {
            struct Page *p = page + n;
            p->property = page->property - n;
            SetPageProperty(p);
            // 将多出来的插入到 被分配掉的页块 后面
            list_add(&(page->page_link), &(p->page_link));
        }
        // 最后在空闲页链表中删除掉原来的空闲页
        list_del(&(page->page_link));
        nr_free -= n;
        ClearPageProperty(page);
    }
    return page;
}
// 释放掉 n 个 页块
static void default_free_pages(struct Page *base, size_t n) {
    assert(n > 0);
    struct Page *p = base;
    for (; p != base + n; p ++) {
        assert(!PageReserved(p) && !PageProperty(p));
        p->flags = 0;
        set_page_ref(p, 0);
    }
    base->property = n;
    SetPageProperty(base);
    list_entry_t *le = list_next(&free_list);
    // 合并到合适的页块中
    while (le != &free_list) {
        p = le2page(le, page_link);
        le = list_next(le);
        if (base + base->property == p) {
            base->property += p->property;
            ClearPageProperty(p);
            list_del(&(p->page_link));
        }
        else if (p + p->property == base) {
            p->property += base->property;
            ClearPageProperty(base);
            base = p;
            list_del(&(p->page_link));
        }
    }
    nr_free += n;
    le = list_next(&free_list);
    // 将合并好的合适的页块添加回空闲页块链表
    while (le != &free_list) {
        p = le2page(le, page_link);
        if (base + base->property <= p) {
            break;
        }
        le = list_next(le);
    }
    list_add_before(le, &(base->page_link));
}
```

请在实验报告中简要说明你的设计实现过程。请回答如下问题：
* 你的first fit算法是否有进一步的改进空间

```
可以像 Buddy System 用树来管理空闲页块 搜索的时间复杂度 为 O(logn)
```

### 练习2：实现寻找虚拟地址对应的页表项
通过设置页表和对应的页表项，可建立虚拟内存地址和物理内存地址的对应关系。其中的get_pte函数是设置页表项环节中的一个重要步骤。此函数找到一个虚地址对应的二级页表项的内核虚地址，如果此二级页表项不存在，则分配一个包含此项的二级页表。本练习需要补全get_pte函数 in kern/mm/pmm.c，实现其功能。请仔细查看和理解get_pte函数中的注释。get_pte函数的调用关系图如下所示：

![](/images/lab2_ex.2.png)

这道题和下面一道题比较简单
原理就是 给我一个虚拟地址 然后我根据这个虚拟地址 的 高 10 位 找到 页目录表 中的 PDE项 前20位是页表项 (二级页表)的线性地址 后 12位 为属性 然后 判断一下 PDE 是否存在(就是判断 P位) 不存在 则 获取一个物理页 然后将这个物理页的线性地址写入到 PDE 中 最后返回 PTE 项
换句话说 就是 根据 给的 虚拟地址 构造一个 PTE 项 跟着注释来很容易就解决了

```c
pte_t *get_pte(pde_t *pgdir, uintptr_t la, bool create) {
    pde_t *pdep = &pgdir[PDX(la)]; // 找到 PDE 这里的 pgdir 可以看做是 页目录表的基址
    if (!(*pdep & PTE_P)) {         // 看看 PDE 指向的页表 是否存在
        struct Page* page = alloc_page(); // 不存在就申请一页物理页
        /* 这里说多几句 通过 default_alloc_pages() 分配的页 的地址 并不是真正的页分配的地址
            实际上只是 Page 这个结构体所在的地址而已 故而需要 通过使用 page2pa() 将 Page 这个结构体
            的地址 转换成真正的物理页地址的线性地址 然后需要注意的是 无论是 * 或是 memset 都是对虚拟地址进行操作的
            所以需要将 真正的物理页地址再转换成 内核虚拟地址
            */
        if (!create || page == NULL) {
            return NULL;
        }
        set_page_ref(page, 1);
        uintptr_t pa = page2pa(page);
        memset(KADDR(pa), 0, PGSIZE); // 将这一页清空 此时将 线性地址转换为内核虚拟地址
        *pdep = pa | PTE_U | PTE_W | PTE_P; // 设置 PDE 权限
    }
    return &((pte_t *)KADDR(PDE_ADDR(*pdep)))[PTX(la)];
}
```

请在实验报告中简要说明你的设计实现过程。请回答如下问题：
* 请描述页目录项（Page Directory Entry）和页表项（Page Table Entry）中每个组成部分的含义以及对ucore而言的潜在用处。

```
PDE 和 PTE 的组成部分含义在上面
```

* 如果ucore执行过程中访问内存，出现了页访问异常，请问硬件要做哪些事情？

```
进行换页操作 首先 CPU 将产生页访问异常的线性地址 放到 cr2 寄存器中 
然后就是和普通的中断一样 保护现场 将寄存器的值压入栈中 
然后压入 error_code 中断服务例程将外存的数据换到内存中来 
最后 退出中断 回到进入中断前的状态
```

### 练习3：释放某虚地址所在的页并取消对应二级页表项的映射
当释放一个包含某虚地址的物理内存页时，需要让对应此物理内存页的管理数据结构Page做相关的清除处理，使得此物理内存页成为空闲；另外还需把表示虚地址与物理地址对应关系的二级页表项清除。请仔细查看和理解page_remove_pte函数中的注释。为此，需要补全在 kern/mm/pmm.c中的page_remove_pte函数。page_remove_pte函数的调用关系图如下所示：

![](/images/lab2_ex.3.png)

```c
static inline void page_remove_pte(pde_t *pgdir, uintptr_t la, pte_t *ptep) {
    if ((*ptep & PTE_P)) {
        struct Page *page = pte2page(*ptep);
        if (page_ref_dec(page) == 0) { // 若引用计数减一后为0 则释放该物理页
            free_page(page);
        }
        *ptep = 0; // 清空 PTE
        tlb_invalidate(pgdir, la); // 刷新 tlb
    }
}
```

最后测试一下是不是都通过了

![lab2_finish](/images/lab2_finish.png)

请在实验报告中简要说明你的设计实现过程。请回答如下问题：
* 数据结构Page的全局变量（其实是一个数组）的每一项与页表中的页目录项和页表项有无对应关系？如果有，其对应关系是啥？
* 如果希望虚拟地址与物理地址相等，则需要如何修改lab2，完成此事？ 鼓励通过编程来具体完成这个问题

```
有 比如 PG_reserved 这个表示的这个页是否被内核保留 与 页表项的 PTE_U 这个参数有关系
```

```c
kern/mm/memlayout.h
#define KERNBASE 0x0 改成0x0 完事
修改虚拟地址基址 减去一个 0xC0000000 就等于物理地址了
```

Challenge 以后看看有没有时间做吧 这个 Lab 2 还是在机房里面阅读的...