---
title: LeetCode 161 周赛
categories: LeetCode
date: 2019-11-3 13:08:20
keywords: LeetCode, 周赛
tags: [LeetCode, 周赛]
---
## [5247. 交换字符使得字符串相同](https://leetcode-cn.com/contest/weekly-contest-161/problems/minimum-swaps-to-make-strings-equal/)

规律题... 烦

```c++
class Solution {
public:
    int minimumSwap(string s1, string s2) {
        int n = s1.size();
        int nx = 0, ny = 0;
        for (int i = 0; i < n ; i++) {
            if (s1[i] != s2[i]) {
                if (s1[i] == 'x') {
                    nx ++;
                } else if (s1[i] == 'y') {
                    ny ++;
                }
            }
        }
        // 要么都偶 要么都奇 才能配上
        if ((nx % 2) == (ny % 2)) {
            // 一对 x-y 只需要变一次就可以了
            // 一对 y-x 同理
            // 如果匹配完所有对了 以后 只剩下奇数 就要把奇数 * 2
            return nx / 2 + ny / 2 + (nx % 2) * 2;
        }
        // 匹配不上
        return -1;
    }
};
```

<!-- more -->

## [5248. 统计「优美子数组」](https://leetcode-cn.com/contest/weekly-contest-161/problems/count-number-of-nice-subarrays/)

这一题搞了半天... 是要连续子数组 我把所有子集都求出来了...

先讲双指针 直观解法 不过会超时

```c++
class Solution {
public:
    int sum(const vector<int> &nums, int l, int r) {
        int res = 0;
        for (int i = l; i <= r; i ++) {
            if ((nums[i] % 2) != 0) {
                res ++;
            }
        }
        return res;
    }
    int numberOfSubarrays(vector<int>& nums, int k) {
        int n = nums.size();
        if (n < 1) { 
            return n;
        }
        int l = 0, r = -1;
        int res = 0;
        while (l < n) {
            if (r + 1 < n && sum(nums, l, r + 1) <= k) {
                r ++;
            } else {
                l ++;
                r = 0;
            }
            if (sum(nums, l, r) == k) {
                res ++;
            }
        }
        return res;
    }
};
```

一种解法是 先把前缀和找出来 就是说找 当前位置前面有多少个奇数 最后一项为 整个数字的奇数个数

```c++
class Solution {
public:
    int numberOfSubarrays(vector<int>& nums, int k) {
        int n = nums.size();
        if (n < 1) { 
            return n;
        }

        // 求出到 i 位置前面有多少个奇数
        // [1,1,2,1,1]
        //  0 1 2 2 3 4
        vector<int> dp(n + 1, 0);
        for (int i = 0; i <= n ; i++) {
            if ((nums[i - 1] % 2) != 0) {
                dp[i] = dp[i - 1] + 1;
            } else {
                dp[i] = dp[i - 1];
            }
        }
        unordered_map<int, int> m;
        int res = 0;
        for (int i = 0; i < dp.size(); i ++) {
            res += m[dp[i] - k]; // dp[j] - dp[i] = k
            m[dp[i]] ++;
        }
        return res;
    }
};
```

## [5249. 移除无效的括号](https://leetcode-cn.com/contest/weekly-contest-161/problems/minimum-remove-to-make-valid-parentheses/)

这一道题 看到括号匹配 大概就知道是用栈来做了 先把所有左括号入栈 再匹配右括号 一一对应 打上记号 打上记号说明是要保留下来的 然后找结果的时候 直接不算上没被标记的括号就行了

```c++
class Solution {
public:
    string minRemoveToMakeValid(string s) {
        stack<int> stack;// 存储索引
        int n = s.size();
        vector<bool> visited(n, false);
        for (int i = 0; i < n ; i ++) {
            if (s[i] == '(') {
                stack.push(i);
            } else if (s[i] == ')') {
                if (stack.empty()) {
                    continue;
                }
                visited[i] = true;
                visited[stack.top()] = true;
                stack.pop();
            }
        }
        string res = "";
        for (int i = 0; i < n; i ++) {
            if (s[i] == '(' || s[i] == ')') {
                if (visited[i]) {
                    res.push_back(s[i]);
                }
            } else {
                res.push_back(s[i]);
            }
        }
        return res;
    }
};
```

## [5250. 检查「好数组」](https://leetcode-cn.com/problems/check-if-it-is-a-good-array/)

这题 没想出来 看了下讨论区 知道了 是 裴蜀定理
简单的来说就是 `ax + by = m <=> 12x +42y = 6`

换句话说 只要所有数的最大公约数 为 1 既满足了 好数字的 定义

```c++
class Solution {
public:
    int gcd(int a, int b) {
        return (b == 0) ? a : gcd(b, a % b);
    }
    bool isGoodArray(vector<int>& nums) {
        int n = nums.size();
        int res = nums[0];
        for (int i = 1; i < n; i ++) {
            res = gcd(res, nums[i]);
        }
        return res == 1;
    }
};
```
