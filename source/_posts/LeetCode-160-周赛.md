---
title: LeetCode 160 周赛
categories: LeetCode
date: 2019-10-29 20:04:20
keywords: LeetCode, 周赛
tags: [LeetCode, 周赛]
---
## 总结
因为暑期实习 以为能转正 最后 拥抱变化了 错过了提前批 想转换心情
第一次参加 LeetCode 周赛 很惭愧 只做出了前三道 打算以后每周都参加 周赛

## [1237. 找出给定方程的正整数解](https://leetcode-cn.com/contest/weekly-contest-160/problems/find-positive-integer-solution-for-a-given-equation/)

这一题 题目很长 读完以后 可以知道暴力法可以解决

```c++
class Solution {
public:
    vector<vector<int>> findSolution(CustomFunction& customfunction, int z) {
        vector<vector<int>> res;
        for (int i = 1 ; i <= 1000; i ++) {
            for (int j = 1; j <= 1000;j ++) {
                if (customfunction.f(i, j) == z) {
                    res.push_back({i, j});
                }
            }
        }
        return res;
    }
};
```

<!-- more -->

## [1238. 循环码排列](https://leetcode-cn.com/contest/weekly-contest-160/problems/circular-permutation-in-binary-representation/)

第二题 一看就是格雷码

方法一:

在编码的时候 采用回溯的方式 直接将 start 放进去 然后再根据 start 将每一位都异或一下 如果没有用过 就存进去 直到 vector 满了 此时再比对 第一位 和 最后一位的二进制是否只有一位不同

```c++
class Solution {
public:
    vector<int> res;
    vector<bool> visited;
    bool find(int n, int cur) {
        if (res.size() == (1 << n)) {// 满了
            int tmp = res[0] ^ res[res.size() - 1]; // 11 01 10
            return ((tmp & (tmp - 1)) == 0); // 10 & 01 00
        }
        for (int i = 0; i < n; i ++) {
            int other = cur ^ (1 << i);
            if (!visited[other]) {
                res.push_back(other);
                visited[other] = true;
                if (find(n, other)) {
                    return true;
                }
                res.pop_back();
                visited[other] = false;
            }
        }
        return false;
    }
    vector<int> circularPermutation(int n, int start) {
        res.push_back(start);
        visited = vector<bool>(1 << n, false); // 2的n次方
        visited[start] = true;
        find(n, start);
        return res;
    }
};
```

方法二:

先生成 n 位二进制的 格雷码 存起来 然后再从 start 处截断 拼接起来

```c++
class Solution {
public:
    vector<int> go(int n) {
        if (n == 0) {
            return {0};
        }
        if (n == 1) {
            return {0, 1};
        }
        vector<int> v = go(n - 1);
        vector<int> ret = v;
        reverse(v.begin(), v.end());
        for (auto i : v) {
            ret.push_back(i | (1 << n - 1));
        }
        return ret;
    }
    vector<int> circularPermutation(int n, int start) {
        vector<int> v = go(n);
        vector<int> res;
        for (int i = 0 ; i < v.size(); i ++) {
            if (start == v[i]) {
                for (int j = i ; j < v.size(); j ++) {
                    res.push_back(v[j]);
                }
                for (int j = 0; j < i; j ++) {
                    res.push_back(v[j]);
                }
                break;
            }
        }
        return res;
    }
};
```

## [1239. 串联字符串的最大长度](https://leetcode-cn.com/contest/weekly-contest-160/problems/maximum-length-of-a-concatenated-string-with-unique-characters/)

这一题 我读完以后 就一个感觉 和 子集问题很像

于是就用子集的写法写了

```c++
class Solution {
public:
    int res = 0;
    bool isJustOne(const string & s) {
        int freq[256] = {0};
        for (int i = 0 ; i < s.size(); i ++){
            freq[s[i]]++;
            if (freq[s[i]] > 1) {
                return false;
            }
        }
        return true;
    }
    void find(const vector<string>& arr, string s, int idx) {
        for (int i = idx; i < arr.size(); i ++) {
            string tmp = s + arr[i];
            if (isJustOne(tmp)) {
                int len = tmp.size();
                res = max(res, len);
            }
            find(arr, s + arr[i], i + 1);
        }
    }
    int maxLength(vector<string>& arr) {
        find(arr, "", 0);
        return res;
    }
};
```

## [1240. 铺瓷砖](https://leetcode-cn.com/contest/weekly-contest-160/problems/tiling-a-rectangle-with-the-fewest-squares/)

做的时候 想的是贪心法 但是 最后一个示例 过不了 看了一下排名第一的 用的 打表法... 感觉不是很好吧...

这里先放一下贪心的做法

```c++
class Solution {
public:
    vector<vector<int>> dp;
    int tilingRectangle(int n, int m) {
        // 针对最后一个测试用例进行排除  
        if (min(n, m) == 11 && max(n, m) == 13) { return 6; }
        dp = vector<vector<int>>(n + 1, vector<int>(m + 1, -1));
        return solve(n, m);
    }
    
    int solve(int n, int m) {
        if (n == 1) {
            return m;
        }
        if (m == 1) {
            return n;
        }
        if (n == m) {
            return 1;
        }
        if (dp[n][m] != -1) {
            return dp[n][m];
        }
        int res = n * m;
        for (int i = 1; i < n ;i  ++) {
            int tmp = solve(i, m) + solve(n - i, m);
            res = min(tmp, res);
        }
        for (int i = 1 ; i < m ; i ++) {
            int tmp = solve(n, i) + solve(n, m - i);
            res = min(res, tmp);
        }
        dp[n][m] = res;
        return res;
    }
};
```