---
title: 让 LLM 实时玩 TPS：一个听得懂自然语言的 Game Bot
categories: AI
date: 2026-09-06 15:05:00
keywords: LLM, TPS, Game AI, Qwen, Game Bot, Post-training
tags: [LLM, TPS, GameAI, Qwen, 游戏]
---

近期在做一个让 LLM 玩游戏的项目：将大语言模型接入 TPS（第三人称射击）对局，让它实时读取游戏状态，根据自然语言指令决定角色的行动策略。这个 LLM Game Bot 由小模型负责策略决策，再由游戏执行器完成移动、瞄准和射击等连续动作。

目前 Qwen3.5-0.8B 和 2B 都已经完成了基础训练和游戏接入，其中 0.8B 已经可以在本地模型服务上持续参与对局。

我觉得这里有意思的地方并不是“LLM 也会打枪”，因为单纯做一个会移动、会找敌人、会开枪的 Bot，Behavior Tree、RL 都能完成。

真正有意思的是：**可以把自然语言直接接到 Bot 的策略层。**

例如：

1. 原地蹲下并持续瞄准敌人，无论发生什么都不要开枪。

{% video /videos/student-clip_01.mp4 /images/video-posters/student-clip_01.jpg %}


换一条指令：

2. 原地站稳并持续瞄准敌人，每次连续打三发。

{% video /videos/student-clip_03.mp4 /images/video-posters/student-clip_03.jpg %}

这两句话要求 Bot 产生完全不同的移动、姿态和武器行为。

从这个角度看，LLM Bot 可以理解为：

```text
自然语言指令
    +
当前游戏状态
    ↓
 LLM Policy
    ↓
游戏战术动作
```

这种能力在游戏中至少有三个比较实际的用途：

1. 策划可以通过自然语言调整 Bot 的打法。
2. 用 Bot 做 Gameplay 自动化测试。
3. 做一个真正能够听懂玩家指令的 AI 队友。

<!-- more -->

## 这东西有什么用

### 1. 给策划调整 Bot 策略

传统 Behavior Tree Bot 最大的问题不是实现不了复杂逻辑，而是随着需求增加，规则组合会越来越多。

最开始的需求可能很简单：

```text
低血 -> 找掩体
```

后面策划继续提出：

```text
低血时不要马上跑，队友正在压制就先换弹。
快把控制点占完的时候，不要因为受伤就直接离开。
如果队友正在绕后，自己不要主动暴露。
敌人残血也不要追得太远。
```

这些需求都可以使用 Behavior Tree 实现。

但是最终它们都会变成新的 Blackboard 状态、Condition、Priority、Decorator 和中断关系。

简单写一下可能是：

```cpp
if (LowHealth)
{
    if (TeammateSuppressing)
    {
        HoldPositionAndReload();
    }
    else if (ObjectiveAlmostCaptured)
    {
        StayOnObjective();
    }
    else
    {
        MoveToCover();
    }
}
```

然后过几天又来一个新的需求：如果只剩最后一个敌人，就算残血也可以继续推进，那就会继续增加条件。

行为树的问题不是不能做，而是**策划描述的是一个战术意图，程序需要不停把这些意图重新翻译成规则。**

而 RL Bot 的问题是每种风格都需要重新进行训练，完全失去泛化能力。

如果 Bot 本身能够接受自然语言，那么策划配置可以尝试直接写成：

```text
这个角色整体偏保守，优先生存。

负责压制，不要主动离开当前区域追击。

看到玩家开始推进以后再跟进，不要抢先暴露。

控制点即将完成时，提高任务优先级。
```

这些文字仍然需要训练数据支持，但至少它提供了一种新的工作流：

![Bot 策略调整流程对比：传统方式需修改行为树或参数，LLM Bot 通过自然语言策略描述驱动游戏中的行为变化。](/images/llm-bot.png)

这里我觉得比较重要的一点是：**它调整的是行为策略，而不只是传统意义上的 Bot 难度。**

很多 Bot 配置最后会变成：

```text
AimAccuracy = 0.6
ReactionTime = 0.3
Aggressive = 0.8
```

这种参数当然有用，但它很难表达：

```text
我希望这个角色积极一点，但是不要单独冲进两个敌人的火力范围。

玩家残血的时候优先帮玩家拉枪线，平时则正常进攻。
```

如果 LLM 能稳定学习这些指令和状态之间的关系，对策划来说应该会是一个比较方便的 Bot 策略入口。


此处举例：主动寻找并消灭敌人，尽量生存并赢下这场对局。

{% video /videos/student-clip_05.mp4 /images/video-posters/student-clip_05.jpg %}


### 2. Gameplay 自动化测试

还有一个很合适的使用场景，就是游戏自动化测试。

传统自动化测试很适合检测确定性的逻辑，但是游戏中还有很多问题，需要一个角色真的在地图里跑起来才容易出现。

例如：

```text
不断寻找敌人并交战 30 分钟。

使用地图中所有可拾取武器。

低血时尝试寻找恢复资源。

不断在几个区域之间导航。

反复进行死亡、复活、移动、换弹和射击。
```

这类测试完全可以写一个专门的自动化 Bot，但是玩法不断变化以后，对应的测试流程也需要继续维护。

如果可以针对自己的项目训练一个简单的 LLM，那么可以让测试脚本直接描述测试目标：

```text
持续在地图中寻找敌人并交战，尽量使用所有可到达的掩体。

依次拾取地图中的不同武器，并完成射击和换弹。

在控制点附近持续作战 20 分钟，不要主动离开任务区域。

不断尝试不同路线前往目标点。
```

LLM Bot 负责把这些测试场景跑出来，往上一层使用一个 慢速，但更聪明的 LLM 来负责检查结果是否符合预期。

这样可能会比人工编写大量固定测试路线覆盖更多 Gameplay 状态组合。

### 3. 能听懂人话的 Bot 队友

第三种用途就是正常游戏里的 Bot。

传统游戏也有这种队友指令：

```text
Follow
Attack
Defend
Hold Position
```

如果 Bot 本身可以把自然语言作为策略输入，那么理论上可以进一步变成：

```text
你先在这里架住，我去右边。

先别开枪，等我靠近一点。

别追这个人了，回来占点。

我没血了，你往前顶一下。

右边那个掩体有人，不要正面过去。
```

这句话应该可以真的改变它后面的游戏行为，我觉得这才是游戏里 LLM bot 或者 NPC 比较值得做的方向。

## 为什么不直接用大 LLM 玩游戏

到这里可能会有一个很自然的问题：

既然大模型理解能力更强，为什么不直接拿一个几十 B 的模型接游戏，让它实时做决策？

问题很明显：**太慢。**

TPS 和聊天最大的区别是，游戏世界不会等模型慢慢回答。

TPS Bot 慢一秒，情况可能已经完全变了：

```text
模型开始推理：
敌人在前面。

500ms 后：
敌人已经移动到掩体后。

1000ms 后模型返回：
继续向原来位置射击。
```

这时候模型即使推理本身没有错，输出也已经过期了。

特别是大模型，如果还打开 Thinking，让它每次先输出一段推理再决定动作，就更加不适合直接放在实时 TPS Loop 中。

因此最终方案如下：

```text
大模型 Teacher
    ↓
lockstep 产生 TPS 决策轨迹
    ↓
训练小模型 Student
    ↓
Qwen 0.8B / 2B Student 实时运行
```

也就是把大模型的决策能力尽可能压缩到一个小模型里面。

关于 Teacher 的选型，我选择了 Qwen 3.8 27b，即使我用上了当前最快的 API (Groq)，关闭 thinking，也是非常慢的。

这里附上一个 Teacher 游玩视频，它经过剪辑和加速，使得观感上看起来流畅，它在里面会寻找掩体，然后快速击杀敌人。

{% video /videos/teacher-Qwen-3.8-27b.mp4 /images/video-posters/teacher-Qwen-3.8-27b.jpg %}

## 整体思路

整个系统可以拆成训练和运行两部分。

![LLM Game Bot 的训练与运行流程：Teacher 生成动作标签训练 Student，运行时由 Student 输出动作交给 TPS 执行器。](/images/llm-train.png)

这里 Student 也不是每一个 Game Tick 都运行一次，模型负责相对高层的策略决策，游戏执行器负责两个决策之间的连续行为。

例如：

```text
模型：
去 south_west_hide，蹲下，持续瞄准 H0，执行三发点射。
```

游戏负责：

```text
计算导航
移动角色
转向敌人
等待射击间隔
发射三颗子弹
更新弹药
```

## 游戏给模型看什么

目前 Student 输入不是游戏截图，而是一份结构化的战场状态。

删减以后大概是：

```text
COMMAND
主动寻找并消灭敌人，自己决定移动、蹲伏和射击节奏。

FRAME[0]

MAP
node=teacher_spawn
region=teacher_side

SELF
hp=1
speed=0
stance=standing

GUN
mag=12/12
reserve=48
reload=idle
task=idle

H0
distance=20.1
los=1
shoot=1

EXEC
movement=hold_position
stance=stand
aim=clear
weapon=hold_fire

CAND
...

ACTION
```

`SELF` 是自己当前状态。

`GUN` 是武器状态。

`H0/H1` 是当前敌人状态。

`CAND` 提供当前可以选择的战术位置，以及导航和暴露相关的信息。

另外还有一个非常重要的 `EXEC`：

```text
EXEC movement=continue_move
EXEC weapon=continue_weapon_task
```

它表示角色当前正在执行什么任务。

因为 TPS 是连续世界，模型不能每次都认为自己是在重新开始。

例如上一轮已经开始三发点射：

```text
start_burst:3
```

下一轮只需要：

```text
continue_weapon_task
```

而不是再次创建一个新的三发点射。

移动也是一样。

因此真正输入给模型的是：

```text
当前世界状态
+
当前正在执行的动作
+
当前自然语言任务
```

为了保证推理速度，丢弃了历史上下文，只保留过去1-2帧的信息。

## 动作协议

为了减少模型输出长度，没有让 Student 输出 JSON，更没有让它生成一段自然语言解释。

当前动作只有四个通道：

```text
movement | stance | aim | weapon
```

实际输出采用数字编码：

```text
MM|S|A|WW
```

例如：

```text
00|1|1|03
```

可以解码成：

```text
hold_position
crouch
target:H0
start_burst:2
```

也就是：

```text
原地不动
蹲下
持续瞄准 H0
进行两发点射
```

模型每次只需要生成十几个 Token 以内的动作。

运行时也关闭 Thinking：

```text
temperature     = 0
max_tokens      = 16
enable_thinking = false
```

并使用 Grammar 限制输出格式。

例如：

```text
root ::= movement "|" stance "|" aim "|" weapon
```

这样可以避免模型突然开始：

```text
根据当前情况，我认为应该......
```

实时游戏根本不需要这些输出。

## Action Executor

可能有人看到这里会问：既然最后还是游戏代码在导航、射击、换弹，那这和 Behavior Tree 有什么区别？

这里需要区分**策略**和**执行**。

假设 Student 输出：

```text
node:south_west_hide
crouch
target:H0
start_burst:2
```

游戏需要负责：

```text
1. 找到前往 south_west_hide 的路径；
2. 驱动角色移动；
3. 切换成蹲伏状态；
4. 持续朝 H0 旋转；
5. 等待武器达到可射击状态；
6. 按射击间隔完成两发点射；
7. 更新弹药和 Weapon Task；
8. 把结果反馈给下一轮 Student。
```

这些本来就属于游戏执行层，这些确定性的逻辑没有必要全部换成神经网络。

## Teacher 和 Student

Teacher 负责产生 TPS 示范。

一条轨迹实际上包含很多连续决策：

```text
decision_1 -> action_1
decision_2 -> action_2
decision_3 -> action_3
...
```

一个训练样本类似：

```json
{
    "prompt": "COMMAND ... FRAME[0] ... ACTION",
    "target": "08|0|1|04",
    "tokens": {
        "movement": "node:north_west_hide",
        "stance": "stand",
        "aim": "target:H0",
        "weapon": "start_burst:3"
    }
}
```

目前轨迹中用过 Qwen3.8 27B 作为 Teacher。

Student 则使用：

```text
Qwen3.5-0.8B
Qwen3.5-2B
```

使用 LoRA 学习这套 TPS 状态和动作协议，当前训练配置大概是：

```text
task_type              = CAUSAL_LM
lora_rank              = 16
lora_alpha             = 32
lora_dropout           = 0.05
```

训练目标也很简单：

```text
Prompt:
    Instruction + Observation

Target:
    08|0|1|04
```

Student 不需要学习生成 Teacher 的长推理，只学习最终动作。

## 实时运行

LLM 接入实时游戏最麻烦的问题就是延迟。

当前 0.8B endpoint 的保存测试中，P50 推理延迟大约为：181ms

这个结果已经明显比直接使用几十 B 的 Teacher 更适合放到实时循环里。

因此整个架构必须针对这一点设计。

第一，模型输出必须非常短。

```text
MM|S|A|WW
```

而不是几十个 Token 的 JSON 或自然语言。

第二，关闭 Thinking。

第三，游戏执行器在两个模型决策之间继续运行。

例如：

```text
LLM 1.5 ~ 5 Hz
        ↓
高层战术意图

Game Tick
        ↓
连续执行移动 / 转向 / 武器 / 动画
```

第四，后续还可以摘掉 `lm_head`，针对四个通道添加 4个并行 `action head` 进行训练，达到更快的响应速度。

## 最后

本文实验环境：`AMD 7900 GRE`，基于 `UE5.8` Lyra 射击游戏二次开发。

后续可以考虑抽象出这层游戏客户端的适配层，只要该模型输出的动作空间是该游戏操作的子集，就应该能无缝接入。

举个例子，换一个 tps 游戏，虽然你不会用里面的大招，但是基础的移动、射击、蹲伏总还是会的，那就已经能玩了。

最后的最后，再放上几个实机演示例子：

1. 向敌人推进并持续瞄准，武器一就绪就快速连续射击。

{% video /videos/student-clip_04.mp4 /images/video-posters/student-clip_04.jpg %}

2. 原地站稳并持续瞄准敌人，每次只打一发。

{% video /videos/student-clip_02.mp4 /images/video-posters/student-clip_02.jpg %}
