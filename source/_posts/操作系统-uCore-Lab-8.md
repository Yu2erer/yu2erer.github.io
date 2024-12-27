---
title: 操作系统 uCore Lab 8
categories: 操作系统
date: 2019-01-14 14:58:20
keywords: 操作系统, ucore, lab 8, lab8, 文件系统
tags: [操作系统, uCore, Lab, 文件系统]
---
### 练习0：填写已有实验
请把你做的实验代码填入本实验中代码中有“LAB1”/“LAB2”/“LAB3”/“LAB4”/“LAB5”/“LAB6” /“LAB7”的注释相应部分。并确保编译通过。注意：为了能够正确执行lab8的测试应用程序，可能需对已完成的实验1/2/3/4/5/6/7的代码进行进一步改进。

```c
vmm.c default_pmm.c pmm.c proc.c swap_fifo.c trap.c check_sync.c
proc.c: 
static struct proc_struct *alloc_proc(void) {
    // 初始化 PCB 下的 fs(进程相关的文件信息)
    proc->filesp = NULL;
}
int do_fork(uint32_t clone_flags, uintptr_t stack, struct trapframe *tf) {
    // 使用 copy_files()函数复制父进程的fs到子进程中
    if (copy_files(clone_flags, proc) != 0) {
        goto bad_fork_cleanup_kstack;
    }
}
```

<!-- more -->

### 练习1: 完成读文件操作的实现
首先了解打开文件的处理流程，然后参考本实验后续的文件读写操作的过程分析，编写在sfs_inode.c中sfs_io_nolock读文件中数据的实现代码。


这里唯一没想到的就是 alen 因为 后面 *alenp 要返回真实的长度 我实现的里面没注意到这一点
```c
static int sfs_io_nolock(struct sfs_fs *sfs, struct sfs_inode *sin, void *buf, off_t offset, size_t *alenp, bool write) {
    // 先判断第一块的情况 如果没对齐 就从偏移的地方读取
    if ((blkoff = offset % SFS_BLKSIZE) != 0)  {
        // 判断 endpos 和 offset 是否在同一块中
        // 若为同一块 则 size 为 endpos - offset
        // 若不为同一块 则 size 为 SFS_BLKSIZE - blkoff(偏移) 为 第一块要读的大小
        size = (nblks != 0) ? (SFS_BLKSIZE - blkoff) : (endpos - offset);
        if ((ret = sfs_bmap_load_nolock(sfs, sin, blkno, &ino)) != 0) {
            goto out;
        }
        if ((ret = sfs_buf_op(sfs, buf, size, ino, blkoff)) != 0) {
            goto out;
        }
        alen += size;
        if (nblks == 0) {
            goto out;
        }
        buf += size, blkno++; nblks--;
    }

    // 中间对齐的情况
    size = SFS_BLKSIZE;
    while (nblks != 0) {
        if ((ret = sfs_bmap_load_nolock(sfs, sin, blkno, &ino)) != 0) {
            goto out;
        }
        if ((ret = sfs_block_op(sfs, buf, ino, 1)) != 0) {
            goto out;
        }
        alen += size, buf += size, blkno++, nblks--;
    }

    // 末尾最后一块没对齐的情况
    if ((size = endpos % SFS_BLKSIZE) != 0) {
        if ((ret = sfs_bmap_load_nolock(sfs, sin, blkno, &ino)) != 0) {
            goto out;
        }
        if ((ret = sfs_buf_op(sfs, buf, size, ino, 0)) != 0) {
            goto out;
        }
        alen += size;
    }
}
```

### 练习2: 完成基于文件系统的执行程序机制的实现
改写proc.c中的load_icode函数和其他相关函数，实现基于文件系统的执行程序机制。执行：make qemu。如果能看看到sh用户程序的执行界面，则基本成功了。如果在sh用户界面上可以执行”ls”,”hello”等其他放置在sfs文件系统中的其他执行程序，则可以认为本实验基本成功。

可以在 Lab 7 的基础上进行修改 读elf文件变成了从磁盘上读 而不是直接在内存中读
此外 参数在栈中的布局

```
| High Address |
----------------
|   Argument   |
|      n       |
----------------
|     ...      |
----------------
|   Argument   |
|      1       |
----------------
|    padding   |
----------------
|   null ptr   |
----------------
|  Ptr Arg n   |
----------------
|     ...      |
----------------
|  Ptr  Arg 1  |
----------------
|  Arg  Count  | <-- user esp
----------------
| Low  Address |
```

```c
static int load_icode(int fd, int argc, char **kargv) {
    if (current->mm != NULL) {
        panic("load_icode: current->mm must be empty.\n");
    }
    int ret = -E_NO_MEM;

    struct mm_struct *mm;
    if ((mm = mm_create()) == NULL) {
        goto bad_mm;
    }
    if (setup_pgdir(mm) != 0) {
        goto bad_pgdir_cleanup_mm;
    }
    struct Page *page;
    struct elfhdr __elf, *elf = &__elf;
    if ((ret = load_icode_read(fd, elf, sizeof(struct elfhdr), 0)) != 0) {
        goto bad_elf_cleanup_pgdir;
    }
    if (elf->e_magic != ELF_MAGIC) {
        ret = -E_INVAL_ELF;
        goto bad_elf_cleanup_pgdir;
    }
    struct proghdr __ph, *ph = &__ph;

    uint32_t i;
    uint32_t vm_flags, perm;

    for (i = 0; i < elf->e_phnum; ++i) {
        if ((ret = load_icode_read(fd, ph, sizeof(struct proghdr), elf->e_phoff + sizeof(struct proghdr) * i)) != 0) {
            goto bad_elf_cleanup_pgdir;
        }
        if (ph->p_type != ELF_PT_LOAD) {
            continue ;
        }
        if (ph->p_filesz > ph->p_memsz) {
            ret = -E_INVAL_ELF;
            goto bad_cleanup_mmap;
        }
        if (ph->p_filesz == 0) {
            continue ;
        }
        vm_flags = 0, perm = PTE_U;
        if (ph->p_flags & ELF_PF_X) vm_flags |= VM_EXEC;
        if (ph->p_flags & ELF_PF_W) vm_flags |= VM_WRITE;
        if (ph->p_flags & ELF_PF_R) vm_flags |= VM_READ;
        if (vm_flags & VM_WRITE) perm |= PTE_W;
        if ((ret = mm_map(mm, ph->p_va, ph->p_memsz, vm_flags, NULL)) != 0) {
            goto bad_cleanup_mmap;
        }
        off_t offset = ph->p_offset;
        size_t off, size;
        uintptr_t start = ph->p_va, end, la = ROUNDDOWN(start, PGSIZE);

        ret = -E_NO_MEM;

        end = ph->p_va + ph->p_filesz;

        while (start < end) {
            if ((page = pgdir_alloc_page(mm->pgdir, la, perm)) == NULL) {
                goto bad_cleanup_mmap;
            }
            off = start - la, size = PGSIZE - off, la += PGSIZE;
            if (end < la) {
                size -= la - end;
            }

            if ((ret = load_icode_read(fd, page2kva(page) + off, size, offset)) != 0) {
                goto bad_cleanup_mmap;
            }
            start += size, offset += size;
        }

        end = ph->p_va + ph->p_memsz;
        if (start < la) {
            if (start == end) {
                continue ;
            }
            off = start + PGSIZE - la, size = PGSIZE - off;
            if (end < la) {
                size -= la - end;
            }
            memset(page2kva(page) + off, 0, size);
            start += size;
            assert((end < la && start == end) || (end >= la && start == la));
        }
        while (start < end) {
            if ((page = pgdir_alloc_page(mm->pgdir, la, perm)) == NULL) {
                goto bad_cleanup_mmap;
            }
            off = start - la, size = PGSIZE - off, la += PGSIZE;
            if (end < la) {
                size -= la - end;
            }
            memset(page2kva(page) + off, 0, size);
            start += size;
        }
    
    }
    vm_flags = VM_READ | VM_WRITE | VM_STACK;
    if ((ret = mm_map(mm, USTACKTOP - USTACKSIZE, USTACKSIZE, vm_flags, NULL)) != 0) {
        goto bad_cleanup_mmap;
    }
    assert(pgdir_alloc_page(mm->pgdir, USTACKTOP-PGSIZE , PTE_USER) != NULL);
    assert(pgdir_alloc_page(mm->pgdir, USTACKTOP-2*PGSIZE , PTE_USER) != NULL);
    assert(pgdir_alloc_page(mm->pgdir, USTACKTOP-3*PGSIZE , PTE_USER) != NULL);
    assert(pgdir_alloc_page(mm->pgdir, USTACKTOP-4*PGSIZE , PTE_USER) != NULL);
    mm_count_inc(mm);
    current->mm = mm;
    current->cr3 = PADDR(mm->pgdir);
    lcr3(PADDR(mm->pgdir));

    // 先算出所有参数加起来的长度
    uint32_t total_len = 0;
    for (i = 0; i < argc; ++i) {
        total_len += strnlen(kargv[i], EXEC_MAX_ARG_LEN) + 1;
    }
    
    // 用户栈顶 减去所有参数加起来的长度 再 4字节对齐 找到 真正存放字符串参数的栈的位置
    char *arg_str = (USTACKTOP - total_len) & 0xfffffffc;
    // 放字符串参数的栈的位置的下面 是存放指向字符串参数的指针
    int32_t *arg_ptr = (int32_t *)arg_str - argc;
    // 指向字符串参数的指针下面 是参数的个数
    int32_t *stacktop = arg_ptr - 1;
    *stacktop = argc;
    for (i = 0; i < argc; ++i) {
        uint32_t arg_len = strnlen(kargv[i], EXEC_MAX_ARG_LEN);
        strncpy(arg_str, kargv[i], arg_len);
        *arg_ptr = arg_str;
        arg_str += arg_len + 1;
        ++arg_ptr;
    }

    struct trapframe *tf = current->tf;
    memset(tf, 0, sizeof(struct trapframe));

    tf->tf_cs = USER_CS;
    tf->tf_ds = tf->tf_es = tf->tf_ss = USER_DS;
    tf->tf_esp = stacktop;
    tf->tf_eip = elf->e_entry;
    tf->tf_eflags |= FL_IF;
    ret = 0;
out:
    return ret;
bad_cleanup_mmap:
    exit_mmap(mm);
bad_elf_cleanup_pgdir:
    put_pgdir(mm);
bad_pgdir_cleanup_mm:
    mm_destroy(mm);
bad_mm:
    goto out;
}
```

# 祝贺我通过自己的努力，完成了uCore OS lab1 - lab8！
三个月从0到1 断断续续的做 机房做 宿舍做 回家做 终于完成了! 继续努力!

整个实验的[代码](https://github.com/Yu2erer/ucore_os_lab)

![Lab8_finish](/images/Lab8_finish.png)