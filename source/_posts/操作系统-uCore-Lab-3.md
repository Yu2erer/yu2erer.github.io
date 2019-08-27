---
title: 操作系统 uCore Lab 3 含 Challenge
categories: 操作系统
date: 2018-11-27 18:08:20
keywords: 操作系统, ucore, lab 3, challenge
tags: [操作系统, uCore, Lab, 内存分配, 虚拟存储]
---
### Lab 3 练习补充
在练习开始之前 先讲讲 两个数据结构
```c
struct mm_struct { // 描述一个进程的虚拟地址空间 每个进程的 pcb 中 会有一个指针指向本结构体
    list_entry_t mmap_list;        // 链接同一页目录表的虚拟内存空间 的 双向链表的 头节点 
    struct vma_struct *mmap_cache; // 当前正在使用的虚拟内存空间
    pde_t *pgdir;                  // mm_struct 所维护的页表地址(拿来找 PTE)
    int map_count;                 // 虚拟内存块的数目
    void *sm_priv;                 // 记录访问情况链表头地址(用于置换算法)
};
struct vma_struct { // 虚拟内存空间
    struct mm_struct *vm_mm; // 虚拟内存空间属于的进程
    uintptr_t vm_start; // 连续地址的虚拟内存空间的起始位置和结束位置
    uintptr_t vm_end;
    uint32_t vm_flags; // 虚拟内存空间的属性 (读/写/执行)
    list_entry_t list_link; // 双向链表 从小到大将虚拟内存空间链接起来
};
```
<!-- more -->
总而言之就是 mm_struct 描述了整个进程的虚拟地址空间 而 vma_struct 描述了 进程中的一小部分虚拟内存空间
![mm_vma](/images/mm_vma.png)
### 练习0：填写已有实验
本实验依赖实验1/2。请把你做的实验1/2的代码填入本实验中代码中有“LAB1”,“LAB2”的注释相应部分。
```
就下面三个 复制过去就好
pmm.c default_pmm.c trap.c
```

### 练习1：给未被映射的地址映射上物理页
完成do_pgfault（mm/vmm.c）函数，给未被映射的地址映射上物理页。设置访问权限 的时候需要参考页面所在 VMA 的权限，同时需要注意映射物理页时需要操作内存控制 结构所指定的页表，而不是内核的页表。注意：在LAB3 EXERCISE 1处填写代码。执行
```
make qemu
```
后，如果通过check_pgfault函数的测试后，会有“check_pgfault() succeeded!”的输出，表示练习1基本正确。

```c
do_pgfault()
 ptep = get_pte(mm->pgdir, addr, 1); // 根据引发缺页异常的地址 去找到 地址所对应的 PTE 如果找不到 则创建一页表
    if (*ptep == 0) { // PTE 所指向的 物理页表地址 若不存在 则分配一物理页并将逻辑地址和物理地址作映射 (就是让 PTE 指向 物理页帧)
        if (pgdir_alloc_page(mm->pgdir, addr, perm) == NULL) {
            goto failed;
        }
    } else { // 如果 PTE 存在 说明此时 P 位为 0 该页被换出到外存中 需要将其换入内存
        if(swap_init_ok) { // 是否可以换入页面
            struct Page *page = NULL;
            ret = swap_in(mm, addr, &page); // 根据 PTE 找到 换出那页所在的硬盘地址 并将其从外存中换入
            if (ret != 0) {
                cprintf("swap_in in do_pgfault failed\n");
                goto failed;
            }
            page_insert(mm->pgdir, page, addr, perm); // 建立虚拟地址和物理地址之间的对应关系(更新 PTE 因为 已经被换入到内存中了)
            swap_map_swappable(mm, addr, page, 0); // 使这一页可以置换
            page->pra_vaddr = addr; // 设置 这一页的虚拟地址
        }
```
* 请描述页目录项（Page Directory Entry）和页表项（Page Table Entry）中组成部分对ucore实现页替换算法的潜在用处。

```
其实很想说这道题之前不是问过了吗?...
```

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

![pagetable_entries](/images/pagetableentries.png)

* 如果ucore的缺页服务例程在执行过程中访问内存，出现了页访问异常，请问硬件要做哪些事情？

```
页访问异常 会将产生页访问异常的线性地址存入 cr2 寄存器中 并且给出 错误码 error_code 说明是页访问异常的具体原因
uCore OS 会将其 存入 struct trapframe 中 tf_err 等到中断服务例程 调用页访问异常处理函数(do_pgfault()) 时
再判断 具体原因 
若不在某个VMA的地址范围内 或 不满足正确的读写权限 则是非法访问
若在此范围 且 权限也正确 则 认为是 合法访问 只是没有建立虚实对应关系 应分配一页 并修改页表 完成 虚拟地址到 物理地址的映射 刷新 TLB 最后再 调用 iret 重新执行引发页访问异常的 那条指令
若是在外存中 则将其换入 内存 刷新 TLB 然后退出中断服务例程 重新执行引发页访问异常的 那条指令
```

### 练习2：补充完成基于FIFO的页面替换算法
完成vmm.c中的do_pgfault函数，并且在实现FIFO算法的swap_fifo.c中完成map_swappable和swap_out_victim函数。通过对swap的测试。注意：在LAB3 EXERCISE 2处填写代码。执行
```
make qemu
```
后，如果通过check_swap函数的测试后，会有“check_swap() succeeded!”的输出，表示练习2基本正确。
请在实验报告中简要说明你的设计实现过程。
```c
此时完成的是 FIFO 置换算法 因此 每次换出的都应该是 最先进来的 页
static int _fifo_map_swappable(struct mm_struct *mm, uintptr_t addr, struct Page *page, int swap_in) {
    list_entry_t *head=(list_entry_t*) mm->sm_priv;
    list_entry_t *entry=&(page->pra_page_link);
 
    assert(entry != NULL && head != NULL);

    list_add(head, entry); // 就是将这一页加入到链表头中(最近访问过的放前面) 使其可以被置换算法使用到
    return 0;
}
static int _fifo_swap_out_victim(struct mm_struct *mm, struct Page ** ptr_page, int in_tick) {
    list_entry_t *head=(list_entry_t*) mm->sm_priv;
    assert(head != NULL);
    assert(in_tick==0);

    list_entry_t *le = head->prev; // 换出最先进来的页 (因为每次访问一个页 都是插入到头节点的后面 因此 头节点的前面就是最先访问的页)
    struct Page* page = le2page(le, pra_page_link); // 和之前一样 通过 le 这个链表节点的地址 减去 pra_page_link 在 Page 结构体中的 Offset 得到 Page 的地址
    list_del(le); // 删掉这个节点
    *ptr_page = page; // 将这一页地址存到 ptr_page 中 给 调用本函数的函数使用
    return 0;
}
```
请在实验报告中回答如下问题：
* 如果要在ucore上实现"extended clock页替换算法"请给你的设计方案，现有的swap_manager框架是否足以支持在ucore中实现此算法？如果是，请给你的设计方案。如果不是，请给出你的新的扩展和基此扩展的设计方案。并需要回答如下问题
    * 需要被换出的页的特征是什么？
    * 在ucore中如何判断具有这样特征的页？
    * 何时进行换入和换出操作？

```
当然能够支持
首选 页表项的 Dirty Bit 为 0 的页 且 Access Bit 为 0 的页 其次是 访问了但没修改的页 最次是 访问了修改了的页
!(*ptep & PTE_A) && !(*ptep & PTE_D)  没被访问过 也没被修改过
(*ptep & PTE_A) && !(*ptep & PTE_D) 被访问过 但没被修改过
!(*ptep & PTE_A) && (*ptep & PTE_D) 没被访问过 但被修改过
换入是在缺页异常的时候 换出是在物理页帧满的时候
```

至此 这两道题就完成了 比之前的 Lab 要简单多了 这次只花了 一天半时间 下面是 Challenge 花了我一个小时(跑出去饭堂吃饭 哈哈哈哈哈 0.0)

### 扩展练习 Challenge 1：实现识别dirty bit的 extended clock页替换算法
```c
swap_fifo.c
struct swap_manager swap_manager_fifo = {
     .name            = "fifo swap manager",
     .init            = &_fifo_init,
     .init_mm         = &_fifo_init_mm,
     .tick_event      = &_fifo_tick_event,
     .map_swappable   = &_fifo_map_swappable,
     .set_unswappable = &_fifo_set_unswappable,
    //  .swap_out_victim = &_fifo_swap_out_victim,
     .swap_out_victim = &_extended_clock_swap_out_victim, // 将 选择换出的页的函数改掉
     .check_swap      = &_fifo_check_swap,
};
static int _extended_clock_swap_out_victim(struct mm_struct *mm, struct Page ** ptr_page, int in_tick) {
    list_entry_t *head = (list_entry_t*)mm->sm_priv;
    assert(head != NULL);
    assert(in_tick == 0);
    list_entry_t *le = head->prev;
    assert(head != le);

    int i; // 循环三次 寻找合适的置换页
    for (i = 0; i < 2; i++) {
        /* 第一次循环 寻找 没被访问过的 且 没被修改过的 同时将被访问过的页的 访问位 清 0
            第二次循环 依然是寻找 没被访问过的 且 没被修改过的 因为到了此次循环 访问位都被清 0 了 不存在被访问过的
            只需要找没被修改过的即可 同时将被修改过的页 修改位 清 0
            第三次循环 还是找 没被访问过 且 没被修改过的 此时 第一次循环 已经将所有访问位 清 0 了
             第二次循环 也已经将所有修改位清 0 了 故 在第三次循环 一定有 没被访问过 也没被修改过的 页
        */
        while (le != head) {
            struct Page *page = le2page(le, pra_page_link);            
            pte_t *ptep = get_pte(mm->pgdir, page->pra_vaddr, 0);

            if (!(*ptep & PTE_A) && !(*ptep & PTE_D)) { // 没被访问过 也没被修改过 
                list_del(le);
                *ptr_page = page;
                return 0;
            }
            if (i == 0) {
                *ptep &= 0xFFFFFFDF;
            } else if (i == 1) {
                *ptep &= 0xFFFFFFBF;
            }
            le = le->prev;
        }
        le = le->prev;
    }
}
```

最后放上 运行结果
![lab3_finish](/images/lab3_finish.png)