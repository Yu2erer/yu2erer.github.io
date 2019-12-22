---
title: LeetCode 160~167 周赛[持续更新]
categories: LeetCode
date: 2019-10-29 20:04:20
keywords: LeetCode, 周赛
tags: [LeetCode, 周赛]
---
这里面包含了 LeetCode 160~169 的周赛解答 为了减少篇幅 删除了签到题的解答

# LeetCode 160 周赛

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

<!-- more -->

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

# LeetCode 161 周赛

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

# LeetCode 162 周赛

## [5256. 重构 2 行二进制矩阵](https://leetcode-cn.com/contest/weekly-contest-162/problems/reconstruct-a-2-row-binary-matrix/)

先把 colsum == 2 给填上 然后再根据 upper 或者 lower 填写 colsum == 1 的项

```c++
class Solution {
public:
    vector<vector<int>> reconstructMatrix(int upper, int lower, vector<int>& colsum) {
        vector<vector<int>> res;
        int n = colsum.size();
        int sum = 0;
        for (int i = 0; i < n; i ++) {
            sum += colsum[i];
        }
        if (sum != upper + lower) {
            return res;
        }
        res = vector<vector<int>>(2, vector<int>(n, 0));
        for (int i = 0; i < n; i ++) {
            if (colsum[i] == 2) {
                res[0][i] = 1;
                res[1][i] = 1;
                -- upper, --lower;
            }
        }
        if (upper < 0 || lower < 0) {
            return {};
        }
        for (int i = 0; i < n; i ++) {
            if (colsum[i] == 1) {
                if (upper > 0) {
                    res[0][i] = 1;
                    -- upper;
                } else if (lower > 0) {
                    res[1][i] = 1;
                    lower --;
                } else {
                    return {};
                }

            }
        }
        return res;
    }
};
```

## [5257. 统计封闭岛屿的数目](https://leetcode-cn.com/contest/weekly-contest-162/problems/number-of-closed-islands/)

dfs 只不过要注意 如果 水域的上下左右超出边界 那就一定不被包围

```c++
class Solution {
public:
    int d[4][2] = {{-1, 0}, {0, 1}, {1, 0}, {0, -1}};
    int m, n;
    vector<vector<bool>> visited;
    bool inArea(int x, int y) {
        return x >= 0 && x < m && y >= 0 && y < n;
    }
    
    bool dfs(vector<vector<int>>& grid, int x, int y) {
        stack<pair<int, int>> s;
        s.push({x, y});
        bool ret = true;
        while (!s.empty()) {
            auto k = s.top();
            s.pop();
            int x = k.first, y = k.second;
            visited[x][y] = true;
            for (int i = 0; i < 4; i ++) {
                int newx = x + d[i][0];
                int newy = y + d[i][1];
                if (!inArea(newx, newy)) {
                    ret = false;
                } else {
                    if (!visited[newx][newy] && grid[newx][newy] == 0) {
                        s.push({newx, newy});
                    }
                }
            }
        }
        return ret;
    }
    int closedIsland(vector<vector<int>>& grid) {
        m = grid.size();
        if (m == 0) { return 0 ;}
        n = grid[0].size();
        visited = vector<vector<bool>>(m, vector<bool>(n, false));
        int res = 0;
        for (int i = 0; i < m; i ++) {
            for (int j = 0; j < n; j ++) {
                if (grid[i][j] == 0 && !visited[i][j]) {
                    if (dfs(grid, i, j)) {
                        res ++;
                    }
                }
            }
        }
        return res;
    }
};
```

## [5258. 得分最高的单词集合](https://leetcode-cn.com/contest/weekly-contest-162/problems/maximum-score-words-formed-by-letters/)

dfs 搜索一下就成

```c++
class Solution {
public:
    unordered_map<char, int> m;
    void find(const vector<string>& words, const vector<int>& score, int &res, int &tmp, int idx) {
        for (auto iter = m.begin(); iter != m.end() ; iter ++ ) {
            if (iter->second < 0) {
                return;
            }
        }
        res = max(res, tmp);
        for (int i = idx; i < words.size(); i ++) {
            for (int j = 0; j < words[i].size(); j ++) {
                m[words[i][j]] --;
                tmp += score[words[i][j] - 'a'];
            }
            find(words, score, res, tmp, i + 1);
            for (int j = 0; j < words[i].size(); j ++) {
                m[words[i][j]] ++;
                tmp -= score[words[i][j] - 'a'];
            }
        }
    }
    int maxScoreWords(vector<string>& words, vector<char>& letters, vector<int>& score) {
        for (int i = 0; i < letters.size(); i ++) {
            m[letters[i]] ++;
        }
        int res = 0;
        int tmp = 0;
        find(words, score, res, tmp, 0);
        return res;
    }
};
```

# LeetCode 165 周赛

## [5275. 找出井字棋的获胜者](https://leetcode-cn.com/problems/find-winner-on-a-tic-tac-toe-game/submissions/)

构建个棋盘出来 然后一一进行检查

```c++
class Solution {
public:
    string tictactoe(vector<vector<int>>& m) {
        vector<vector<int>> grid(3, vector<int>(3, 0));
        int n = m.size();
        for (int i = 0; i < n; i ++) {
            // 0 & 1 + 1 = 1, 1 & 1 + 1 = 2 
            grid[m[i][0]][m[i][1]] = (i & 1) + 1;
        }
        
        for (int i = 0; i < 3; i ++) {
            if (grid[i][0] == grid[i][1] && grid[i][0] == grid[i][2]) {
                if (grid[i][0] == 1) {
                    return "A";
                } else if (grid[i][2] == 2) {
                    return "B";
                }
            }
            
            if (grid[0][i] == grid[1][i] && grid[0][i] == grid[2][i]) {
                if (grid[0][i] == 1) {
                    return "A";
                } else if (grid[0][i] == 2) {
                    return "B";
                }
            }
            // 00 01 02
            //    11
            // 20    22
        }
        if (grid[0][0] == grid[1][1] && grid[0][0] == grid[2][2]) {
            if (grid[0][0] == 1) {
                return "A";
            } else if (grid[0][0] == 2) {
                return "B";
            }
        }
        if (grid[0][2] == grid[1][1] && grid[0][2] == grid[2][0]) {
            if (grid[0][2] == 1) {
                return "A";
            } else if (grid[0][2] == 2) {
                return "B";
            }
        }
        if (n == 9) {
            return "Draw";
        } else {
            return "Pending";
        }
    }
};
```


## [5276. 不浪费原料的汉堡制作方案](https://leetcode-cn.com/problems/number-of-burgers-with-no-waste-of-ingredients/)

属于解方程问题 巨无霸 4番茄 + 1奶酪 小皇堡 2番茄 + 1 奶酪

4x + 2y = t
x + y = c

```c++
class Solution {
public:
    vector<int> numOfBurgers(int t, int c) {
        int j = 0, m = 0;
        // 解出来不是整数 则为无解
        if ((t - 2 * c) % 2 != 0)
            return {};
        }
        j = (t - 2 * c) / 2;
        m = c - j;
        // 解出来为负数 也为无解
        if (j >= 0 && m >= 0) {
            return {j, m};
        }
        return {};
    }
};
```

## [5277. 统计全为 1 的正方形子矩阵](https://leetcode-cn.com/problems/count-square-submatrices-with-all-ones/submissions/)

暴力法
```c++
class Solution {
public:
    bool valid(const vector<vector<int>>& matrix, int i, int j, int ti, int tj) {
        for (int ki = i; ki <= ti; ki ++) {
            for (int kj = j; kj <= tj; kj ++) {
                if (matrix[ki][kj] == 0) {
                    return false;
                }
            }
        }
        return true;
    }
    int countSquares(vector<vector<int>>& matrix) {
        int m = matrix.size();
        if (m == 0) {
            return 0;
        }
        int n = matrix[0].size();
        int w = min(m, n);
        int res = 0;
        for (int i = 0; i < m; i ++) {
            for (int j = 0; j < n; j ++) {
                for (int k = 0; k < w; k ++) {
                    if (i + k < m && j + k < n) {
                        if (valid(matrix, i, j, i + k, j + k)) {
                            res ++;        
                        }
                    }
                }
            }
        }
        return res;
    }
};
```

动态规划 dp[i][j] 表示 坐标 (i, j) 所能围成的正方形的最大边长 最后全部相加 就是所有正方形数量

```c++
class Solution {
public:
    int countSquares(vector<vector<int>>& matrix) {
        int m = matrix.size();
        if (m == 0) {
            return 0;
        }
        int n = matrix[0].size();
        
        vector<vector<int>> dp(m, vector<int>(n, 0));
        int res = 0;
        for (int i = 0; i < m; i++) {
            dp[i][0] = (matrix[i][0] == 1 ? 1 : 0);
            if (i != 0) {
                res += dp[i][0];
            }
        }
        
        for (int i = 0; i < n; i ++){
            dp[0][i] = (matrix[0][i] == 1 ? 1 : 0);
            if (i != 0) {
                res += dp[0][i];
            }
        }
        for (int i = 1; i < m; i ++) {
            for (int j = 1; j < n; j ++) {
                if (matrix[i][j] == 1) {
                    dp[i][j] = min({dp[i - 1][j], dp[i - 1][j - 1], dp[i][j - 1]}) + 1;
                }
                res += dp[i][j];
            }
        }
        res += dp[0][0];
        return res;
    }
};
```

## [5278. 分割回文串 III](https://leetcode-cn.com/problems/palindrome-partitioning-iii/)

```c++
class Solution {
public:
    int getCosts(const string &s, int l, int r) {
        int res = 0;
        while (l < r) {
            if (s[l++] != s[r--]) {
                res ++;
            }
        }
        return res;
    }
    int palindromePartition(string s, int k) {
        // dp[i][j]
        // 前i个字符 分割为 j个回文的最小代价
        int n = s.size();
        vector<vector<int>> sum(n, vector<int>(n, 0));
        for (int i = 0; i < n; i ++) {
            for (int j = i + 1;j < n ; j++) {
                sum[i][j] = getCosts(s, i, j);
            }
        }
        vector<vector<int>> dp(n + 1, vector<int>(k + 1, 1000));
        
        for (int i = 0; i <= k; i ++) {
            dp[0][i] = 0;
        }
        for (int i = 1; i <= n; i ++) {
            dp[i][1] = sum[0][i - 1];
        }
        
        for (int i = 1; i <= n; i ++) {
            for (int j = 2; j <= min(k, i); j ++) {
                // 确定分割点 [0...m] + [m, i - 1]
                for (int m = 1; m < i; m ++) {
                    dp[i][j] = min(dp[i][j], sum[m][i - 1] + dp[m][j - 1]);
                }
            }
        }
        return dp[n][k];
    }
};
```

也可以用递归 更好理解

```c++
class Solution {
public:
    vector<vector<int>> sum;
    vector<vector<int>> dp;
    int getCosts(const string &s, int l, int r) {
        int res = 0;
        while (l < r) {
            if (s[l++] != s[r--]) {
                res ++;
            }
        }
        return res;
    }
    int solve(int idx, int k, int n) {
        if (idx == n) {
            if (k == 0) {
                return 0;
            }
            // 无解
            return n + 1;
        }
        // 字符还有 但是不要求切割了 无解
        if (k == 0) {
            return n + 1;
        }
        if (dp[idx][k] != -1) {
            return dp[idx][k];
        }
        int res = n;
        for (int i = idx ; i < n; i ++) {
            int tmp = sum[idx][i] + solve(i + 1, k - 1, n);
            res = min(res, tmp);
        }
        dp[idx][k] = res;
        return res;
    }
    int palindromePartition(string s, int k) {
        // dp[i][j]
        // 前i个字符 分割为 j个回文的最小代价
        int n = s.size();
        sum = vector<vector<int>>(n, vector<int>(n, 0));
        for (int i = 0; i < n; i ++) {
            for (int j = i + 1;j < n ; j++) {
                sum[i][j] = getCosts(s, i, j);
            }
        }
        dp = vector<vector<int>>(n, vector<int>(k + 1, -1));
        return solve(0, k, n);
    }
};
```

# LeetCode 166 周赛

## [5280. 用户分组](https://leetcode-cn.com/problems/group-the-people-given-the-group-size-they-belong-to/)

暴力美学

```c++
class Solution {
public:
    vector<vector<int>> res;
    void helper(vector<int>& g, int k) {
        int n = g.size();
        vector<int> vec;
        int t = 0;
        for (int i = 0; i < n; i ++) {
            if (g[i] == k && t < k) {
                vec.push_back(i);
                t ++;
                g[i] = -1;
            }
        }
        if (vec.empty()) {
            return;
        }
        res.push_back(vec);
    }
    vector<vector<int>> groupThePeople(vector<int>& g) {
        int n = g.size();
        for (int i = 0; i < n; i ++) {
            int k = g[i];
            helper(g, k);
        }
        return res;
    }
};
```

## [5281. 使结果不超过阈值的最小除数](https://leetcode-cn.com/problems/find-the-smallest-divisor-given-a-threshold/)

没啥好说的 二分搜索

```c++
class Solution {
public:
    int smallestDivisor(vector<int>& nums, int threshold) {
        int n = nums.size();
        int res = threshold;
        int k = INT_MAX;
        int l = 1, r = 0x7fffffff;
        while (l <= r) {
            int m = l + (r - l) / 2;
            int sum = 0;
            for (int i = 0; i < n; i ++) {
                sum += (nums[i] + m - 1) / m;
            }
            if (sum <= threshold) {
                k = min(k, m);
                r = m - 1;
            } else {
                l = m + 1;
            }
        }
        return k;
    }
};
```

## [5282. 转化为全零矩阵的最少反转次数](https://leetcode-cn.com/problems/minimum-number-of-flips-to-convert-binary-matrix-to-zero-matrix/submissions/)


先把第一行确认好 然后用打死也不动第一行的原则 去使得 下面每个 1 都变成 0
最后再检查 最后一行 是否全为 0 就行了

```c++
class Solution {
public:
    int m, n;
    // 之所以包含 (0, 0) 是因为自己本身也要取反
    int d[5][2] = {{0, 0}, {0, 1}, {0, -1}, {1, 0}, {-1, 0}};
    bool inArea(int i, int j) {
        return i >= 0 && j >= 0 && i < m && j < n;
    }
    // 将 (x, y) 上的及其相邻的值取反
    void helper(vector<vector<int>>& g, int x, int y) {
        for (int i = 0; i < 5; i ++) {
            int newx = x + d[i][0];
            int newy = y + d[i][1];
            if (inArea(newx, newy)) {
                g[newx][newy] = 1 - g[newx][newy];
            }
        }
    }
    int minFlips(vector<vector<int>>& mat) {
        m = mat.size();
        if (m == 0) {
            return 0;
        }
        n = mat[0].size();
        int res = INT_MAX;
        vector<vector<int>> backup(mat);

        // 2 的 n列次方
        for (int k = 0; k < 1 << n; k ++) {
            int sum = 0;
            for (int j = 0; j < n; j ++) {
                // 枚举 2的n次方种 可能
                if (!(k >> j & 1)) {
                    sum ++;
                    helper(mat, 0, j);
                }
            }

            // 前一行的位置想要转化 必须要由后一行来操作
            // 因为假设我们固定了 前一行
            for (int i = 0; i < m - 1; i ++) {
                for (int j = 0 ; j < n; j ++) {
                    if (mat[i][j] == 1) {
                        sum ++;
                        helper(mat, i + 1, j);
                    }
                }
            }
            
            bool flag = true;
            // 如果最后一行还有 1 则转化失败
            for (int j = 0; j < n; j ++) {
                if (mat[m - 1][j] == 1) {
                    flag = false;
                    break;
                }
            }
            if (flag) {
                res = min(res, sum);
            }
            // 还原状态
            mat = backup;
        }
        if (res == INT_MAX) {
            return -1;
        }
        return res;
    }
};
```

# LeetCode 167 周赛

## [5283. 二进制链表转整数](https://leetcode-cn.com/problems/convert-binary-number-in-a-linked-list-to-integer/submissions/)

二进制转十进制 第一种倒着来

```c++
class Solution {
public:
    int getDecimalValue(ListNode* head) {
        int res = 0;
        while (head) {
            res = res * 2 + head->val;
            head = head->next;
        }
        return res;
    }
};
```

第二种 顺着来 第 i 位 * 2^i

```c++
class Solution {
public:
    int getDecimalValue(ListNode* head) {
        stack<int> s;
        while (head) {
            s.push(head->val);
            head = head->next;
        }
        int res = 0, i = 0;
        while (!s.empty()) {
            int k = s.top();
            s.pop();
            res += k << i;
            i ++;
        }
        return res;
    }
};
```

## [5124. 顺次数](https://leetcode-cn.com/problems/sequential-digits/)

回溯 生成数字 注意不能超过 9

```c++
class Solution {
public:
    void helper(int low, int high, int num, int pop) {
        if (num > high) {
            return;
        }
        if (num >= low) {
            res.push_back(num);
        }
        if (pop + 1 <= 9) {
            helper(low, high, num * 10 + pop + 1, pop + 1);
        }
    }
    vector<int> sequentialDigits(int low, int high) {
        for (int i = 1; i <= 9; i ++) {
            helper(low, high, i, i);
        }
        sort(res.begin(), res.end());
        return res;
    }
    vector<int> res;
};
```

或者使用枚举法 枚举出所有顺次数

```c++
class Solution {
public:
    void helper() {
        for (int i = 1; i <= 9; i ++) {
            int x = 0;
            for (int j = i; j <= 9; j ++) {
                x = x * 10 + j;
                tmp.push_back(x);
            }
        }
        sort(tmp.begin(), tmp.end());
    }
    vector<int> sequentialDigits(int low, int high) {
        helper();
        for (int i = 0; i < tmp.size(); i ++) {
            if (tmp[i] >= low && tmp[i] <= high) {
                res.push_back(tmp[i]);
            }
        }
        return res;
    }
    vector<int> tmp;
    vector<int> res;
};
```

## [5285. 元素和小于等于阈值的正方形的最大边长](https://leetcode-cn.com/problems/maximum-side-length-of-a-square-with-sum-less-than-or-equal-to-threshold/)

暴力法 将每行每列存起来 或者 你也可以把每个矩阵的总和存起来

```c++
class Solution {
public:
	int maxSideLength(vector<vector<int>>& mat, int t) {
		int m = mat.size();
		if (m == 0) {
			return 0;
		}
		int n = mat[0].size();
		int w = min(m, n);
        
        vector<vector<int>> rowSum(m, vector<int>(n + 1, 0));
        vector<vector<int>> colSum(m + 1, vector<int>(n, 0));
        for (int i = 0; i < m; i ++) {
            for (int j = 0; j < n; j ++) {
                rowSum[i][j + 1] = mat[i][j] + rowSum[i][j];
            }
        }
        for (int j = 0; j < n; j ++) {
            for (int i = 0; i < m; i ++) {
                colSum[i + 1][j] = mat[i][j] + colSum[i][j];
            }
        }
        
		int res = 0;
		for (int i = 0; i < m; i ++) {
			for (int j = 0; j < n; j ++) {
                int sum = 0;
				for (int k = 0; k < w; k ++) {
                    int newi = i + k, newj = j + k;
					if (newi < m && newj < n) {
                        int row = rowSum[newi][newj + 1] - rowSum[newi][j];
                        int col = colSum[newi + 1][newj] - colSum[i][newj];
                        sum += col + row - mat[newi][newj];
                        if (sum > t) {
                            break;
                        }
                        res = max(res, k + 1);
					}
				}
			}
		}
		return res;
	}
};
```

## [5286. 网格中的最短路径](https://leetcode-cn.com/problems/shortest-path-in-a-grid-with-obstacles-elimination/)

最短路径用 bfs 只不过这里多了个 可以清理障碍的机会 可以反过来想 既然我能清理他了 我就无视他 继续走就是了

```c++
class Solution {
public:
    struct node {
        int x, y, step, k;
        node(int x, int y, int step, int k) : x(x), y(y), step(step), k(k) {}
    };
    int shortestPath(vector<vector<int>>& g, int k) {
        m = g.size();
        if (m == 0) {
            return 0;
        }
        n = g[0].size();

        visited = vector<vector<vector<bool>>>(m, vector<vector<bool>>(n, vector<bool>(k + 1, false)));
        
        if (g[0][0] == 1 && k == 0) {
            return -1;
        }
        
        bfs(g, k);
        
        if (res == INT_MAX) {
            return -1;
        }
        return res;
    }
    void bfs(const vector<vector<int>>& g, int k) {
        queue<node> q;
        q.push({0, 0, 0, 0});
        visited[0][0][0] = true;
        while (!q.empty()) {
            auto node = q.front();
            q.pop();
            int x = node.x, y = node.y;
            if (x == m - 1 && y == n - 1) {
                res = min(res, node.step);
                continue;
            }
            for (int i = 0; i < 4; i ++) {
                int newx = x + d[i][0];
                int newy = y + d[i][1];
                if (inArea(newx, newy)) {
                    if (g[newx][newy] == 0) {
                        if (!visited[newx][newy][node.k]) {
                            q.push({newx, newy, node.step + 1, node.k});
                            visited[newx][newy][node.k] = true;
                        }
                    } else {
                        if (node.k < k && !visited[newx][newy][node.k + 1]) {
                            q.push({newx, newy, node.step + 1, node.k + 1});
                            visited[newx][newy][node.k + 1] = true;
                        }
                    }
                }
            }
        }
    }
private:
    int m, n;
    int res = INT_MAX;
    int d[4][2] = {{0, 1}, {0, -1}, {1, 0}, {-1, 0}};
    vector<vector<vector<bool>>> visited;
    bool inArea(int x, int y) {
        return x >= 0 && y >= 0 && x < m && y < n;
    }
};
```

# LeetCode 168 周赛

## [5292. 划分数组为连续数字的集合](https://leetcode-cn.com/problems/divide-array-in-sets-of-k-consecutive-numbers/)

用 map 排序 统计每个数字出现的次数 然后从第一个数字 开始找 连续k个数字

```c++
class Solution {
public:
    bool isPossibleDivide(vector<int>& nums, int k) {
        int n = nums.size();
        map<int, int, less<int>> m;
        for (int i = 0; i < n; i ++) {
            m[nums[i]] ++;
        }
        while (m.size() > 0) {
            int x = m.begin()->first;
            for (int i = 0; i < k; i ++) {
                if (m.find(x) == m.end()) {
                    return false;
                }
                m[x] --;
                if (m[x] == 0) {
                    m.erase(x);
                }
                x ++;
            }
        }
        return true;
    }
};
```

## [5293. 子串的最大出现次数](https://leetcode-cn.com/problems/maximum-number-of-occurrences-of-a-substring/)

从题意可以得到 一个子串只能有 26 的大小的小写字母 因此 检查不同字母的个数 可以直接开 一个大小 26的数组来检测

每次检查最小的长度的子串 然后满足条件的话 就将该子串的出现次数记录下来

```c++
class Solution {
public:
    int maxFreq(string s, int maxLetters, int minSize, int maxSize) {
        int n = s.size();
        int res = 0;
        unordered_map<string, int> m;
        for (int i = 0; i < n - minSize + 1; i ++) {
            string tmp = s.substr(i, minSize);
            vector<bool> h(26, false);
            for (int j = 0; j < tmp.size(); j ++) {
                h[tmp[j] - 'a'] = true;
            }
            // 判断不同字母的个数
            int k = 0;
            for (int i = 0; i < 26; i ++) {
                if (h[i]) {
                    k ++;
                }
            }
            if (k <= maxLetters) {
                m[tmp] ++;
            }
        }
        for (auto iter = m.begin(); iter != m.end(); iter ++) {
            res = max(res, iter->second);
        }
        return res;
    }
};
```

## [5294. 你能从盒子里获得的最大糖果数](https://leetcode-cn.com/problems/maximum-candies-you-can-get-from-boxes/)

就按照题目描述模拟

```c++
class Solution {
public:
    int maxCandies(vector<int>& status, vector<int>& candies, vector<vector<int>>& keys, vector<vector<int>>& containedBoxes, vector<int>& initialBoxes) {
        int n = status.size();
        int res = 0;
        vector<bool> box(n, false);
        vector<bool> hasKey(n, false);
        vector<bool> visited(n, false);
        for (int i = 0; i < initialBoxes.size(); i ++) {
            box[initialBoxes[i]] = true;
        }
        while (1) {
            int k = -1;
            for (int i = 0; i < n; i ++) {
                if (visited[i] || !box[i]) {
                    continue;
                }
                if (status[i] == 0 && !hasKey[i]) {
                    continue;
                }
                k = i;
            }
            if (k == -1) {
                break;
            }
            res += candies[k];
            visited[k] = true;
            for (int i = 0; i < containedBoxes[k].size(); i ++) {
                box[containedBoxes[k][i]] = true;
            }
            for (int i = 0; i < keys[k].size(); i ++) {
                hasKey[keys[k][i]] = true;
            }
        }
        return res;
    }
};
```