---
title: Raft 共识算法解析
categories: 分布式
date: 2021-03-14 10:01:20
keywords: raft, gossip, cap
tags: [分布式, raft]
---

前篇解析了 `Gossip` 协议，这篇主要看看 `Raft` 是如何实现的。

本文主要分为两个部分，首先是粗略讲解一遍 `Raft` 的设计思想，在这一部分不会将 `RPC` 的各种字段（因为没有意义，只会徒增心智负担），而在第二部分则是通过解析一份优质的 `Raft` 源码实现，在这个部分再深入到 `RPC` 各个字段。

如果看了一遍看不懂也没关系，建议多去看看 `Raft` 的论文，笔者也是反复看了两周才大致理解其指导思想。

## Raft

一提到共识算法，相信大部分人都能马上想到 `Paxos`，但是我认为它不是算法，它的论文里面顶多算是一个指导思想，很少有人能够读完它就实现出一个可靠的共识算法（关键是要验证其的正确性），但是 `Raft` 不一样，它的一些设计非常巧妙，能够令人非常好的理解其指导思想，同时比较容易的实现（因为 `Raft` 从诞生那一刻就是为了弥补 `Paxos` 的可理解性，看看人家的论文名字 `In Search of an Understandable Consensus Algorithm` 可理解的分布式共识算法）。

用过 `Zookeeper` 的可能知道其内部的协议就是根据 `Paxos` 的指导实现的一个 `Zab` 算法，之所以不用 `Raft` 是因为 `Raft` 那时候还没出世呢。

<!-- more -->

### 三种角色

Raft 中的节点只有三种类型。

- 领导人，Leader
- 候选人，Candidate
- 跟随者，Follower

### 领导人 Leader

领导人主要是负责一切的写入操作，当领导人收到客户端的日志条目（请求）时，将其先记录下来（你可以理解为拿个小本本记下我收到了这个请求，但是不提交），然后广播复制（通过心跳）到其他的服务器上，当收到大多数服务器成功的响应后，就将其提交(Commit)到自身的状态机（这个时候才是真正的应用于kv存储），最后通过心跳广播到所有服务器，告诉他们你们也可以应用。

### 候选人 Candidate

如果领导人宕机了，这个时候就需要有候选人竞选领导，谁先收获到足够多的选票，谁就胜出。

### 跟随者 Follower

当领导人还在的时候，整个分布式只会有领导人和跟随者，他们之间通过心跳维持，当领导者宕机了，跟随者就会跳出来说我来当候选人，于是就切换到候选人的身份了。

### 领导选举

`Raft` 和 `Paxos` 最大的异同点我认为是引入了 强领导 的机制，因为这会使得整个分布式系统变得简单，多领导的机制简直就是灾难，你很难保证整个系统指令的顺序。

初始阶段，所有的节点都应该是跟随者，因为这个时候没有领导者与其维持心跳，因此会有一个跟随者发生心跳超时的情况，谁先超时，谁就变身成候选人，之所以有个先字，主要是因为 `Raft` 设计心跳超时的时候，采用了一种随机超时的机制，这个机制我个人觉得是非常巧妙地，它大幅度的减少了整个系统的复杂度，不再需要优先级各种系统的设计，直接通过随机的形式，也避免了瓜分选票导致长时间不能服务的问题。

有了候选人之后，先给自己来一票，然后发起 `RequestVote` ，当选票足够的时候就进化为领导人，如果一直没选出来则进入选举超时，重来一轮，如果收到领导者的消息，则对比 `Term` 任期，比候选人大则乖乖退回跟随者，小则无视。

决定投不投它一票的流程也很简单，采用 `FIFO` 先来先服务的形式，大前提是候选人的信息要比我的新。

关于这块如果不能理解，建议看 [thesecretlivesofdata](http://thesecretlivesofdata.com/raft/) 这里的动画演示。

### 日志复制

首先要认识日志，日志由三部分组成，日志于哪个任期产生，日志的索引，日志的内容。

领导人收到客户端的请求之后，将请求组装成日志，然后先存储下来（不是应用，只是记录一下），接着通过广播发给其他节点，当大多数节点成功响应，则应用到自身的kv存储（或者说应用于自身的状态机），这个时候就可以返回了，同时心跳广播也会将最新的提交记录传递给所有节点，其他节点也会将其应用于自身，这里面的提前返回相当于是将二阶段提交给优化为了一阶段（因为它只要大多数节点回应就行了），降低了一半的消息延迟。

如果是跟随者收到客户端的写请求则有多种方法，比如拒绝并返回领导者的地址给客户端，或转发给领导者，将领导者的返回结果返回给客户端，充当代理身份。

为什么我只提到了写请求呢？因为读请求也是需要视情况而定的，我们知道 `Raft` 是一个共识算法，很多人一直以为它实现出来的就一定是强一致性，然而它是不是强一致性取决于你客户端怎么实现。比如说你想要强一致性，则强制读的时候一定在领导者上读，同时要经过半数节点确认，这样一定不会返回旧数据。如果无所谓强一致性，则可以设计成任意节点上读，这样很有可能是旧数据。还有一种模式是虽然在领导者身上读，但是不经过大多数节点的确认就直接返回，这样有可能会有旧数据（比如 新的 ~~风暴~~（领导者） 已经出现，但是因为网络的关系，没能通过心跳广播通知到其退位，它觉得它还是个领导者就擅自返回了数据，殊不知这个数据很有可能被新的领导者已经修改了）。

以上的三种读操作的一致性模型其实就是 `Consul` 所实现的。

这么一看， `Raft` 的缺点很明显，因为强领导者导致写性能很弱，相当于单机，这也是为什么在分布式存储领域中，大多采用分片的形式去使用（相当于多个 `Raft` 组），而不是采用大分布式的形式。

日志复制的`安全性`来自于几个方面。

首先`领导者`不能删除和覆盖日志，只能够新增，如果跟随者和领导者不一致则强制让跟随者的日志与领导者同步。这么做之所以是安全的是因为，领导者的日志一定是最新最全的。

如何保证领导者的日志一定是最新的呢？前面也提到了 日志由 `Term` 任期， `index` 日志索引，日志内容所构成，每次复制都会去检查前一个日志的任期和索引是否相同，如果相同，我们则可以断定前面的日志也一定是相同的。

其次如果领导者复制给了跟随者日志，但是随后就宕机了，这个时候没有应用于状态机，怎么办？这个时候就依赖于 `Term` 任期字段，新的领导者首先通过上面的机制保证了它的日志一定是最全的，同时它的任期一定是更高的，于是就可以将其任期之前的未提交的直接提交了，然后同步给其他节点。再加上 `Raft` 整个系统实现是幂等性的，即使因为超时或者种种原因重新执行指令也不会发生任何副作用。

那么可能有的人就会想，日志一直在增加，我总不能一直存着所有的日志来和其他跟随者进行比对吧？论文里面的 `Snapshot` 就是做这块功能，将日志进行快照压缩，其实和 `Redis` aof重写挺像的，然后将快照同步出去即可。

关于日志复制，如果有疑惑的可以参阅 [Raft Visualization](https://raft.github.io/) 一个非常详细的动画演示。

### 集群变化

`Raft` 通过单节点变更，避免了集群变化时出现的脑裂情况，每次只添加单个节点不会形成另一个大多数，从而避免多个领导者。除了单节点变更还可以用 `联合共识` （其实就是个二阶段的规则，集群之间互相试探），但是难实现啊。

## hashicorp/raft 源码解析

有了以上的前置知识，我们就可以通过阅读知名的 [hashicorp/raft](https://github.com/hashicorp/raft) 实现来更深入的理解 `Raft`。

### 几个数据结构

`RaftState` 是 `Raft` 当前所处的状态，如上所说有三种状态。

```go
type RaftState uint32
const (
	// Follower is the initial state of a Raft node.
	Follower RaftState = iota
	// Candidate is one of the valid states of a Raft node.
	Candidate
	// Leader is one of the valid states of a Raft node.
	Leader
	// Shutdown is the terminal state of a Raft node.
	Shutdown // 关闭状态
)
```

`raftState` 则代表 `Raft` 节点信息。

```go
type raftState struct {
	// The current term, cache of StableStore
	currentTerm uint64 // 当前任期

	// Highest committed log entry
	commitIndex uint64 // 最高提交的日志索引

	// Last applied log to the FSM
	lastApplied uint64 // 最后一条应用到状态机的索引

	// Cache the latest snapshot index/term
	lastSnapshotIndex uint64 // 快照索引
	lastSnapshotTerm  uint64 // 快照任期

	// Cache the latest log from LogStore
	lastLogIndex uint64 // 最后一条索引
	lastLogTerm  uint64 // 最后一条日志任期

	// The current state
	state RaftState // 节点状态，前面的三态
}
```

附加日志 RPC 请求，这里可以对照着论文看了。

```go
type AppendEntriesRequest struct {
	RPCHeader // 协议版本

	// Provide the current term and leader
	Term   uint64 // 任期
	Leader []byte // 领导者信息

	// Provide the previous entries for integrity checking
	PrevLogEntry uint64 // 前一个日志的索引
	PrevLogTerm  uint64 // 前一个日志的任期

	// New entries to commit
	Entries []*Log // 新的日志

	// Commit index on the leader
	LeaderCommitIndex uint64 // 已提交的最大编号，心跳带出，让跟随者也附加
}
```

附加日志 RPC 响应。

```go
type AppendEntriesResponse struct {
	RPCHeader

	// Newer term if leader is out of date
	Term uint64 // 当前任期

	// Last Log is a hint to help accelerate rebuilding slow nodes
	LastLog uint64 // 最后一条日志索引 用于快速找到缺失的日志（论文里没有）

	// We may not succeed if we have a conflicting entry
	Success bool // 是否成功 如果不匹配就不成功

	// There are scenarios where this request didn't succeed
	// but there's no need to wait/back-off the next attempt.
	NoRetryBackoff bool // 是否不等待直接重试，论文没有 属于扩充项 加速用
}
```

投票 RPC 请求。

```go
type RequestVoteRequest struct {
	RPCHeader

	// Provide the term and our id
	Term      uint64 // 任期
	Candidate []byte // 候选人信息

	// Used to ensure safety
	LastLogIndex uint64 // 最后一条日志索引
	LastLogTerm  uint64 // 最后一条日志任期

	// Used to indicate to peers if this vote was triggered by a leadership
	// transfer. It is required for leadership transfer to work, because servers
	// wouldn't vote otherwise if they are aware of an existing leader.
	LeadershipTransfer bool // hashicorp 实现的一种主动转移领导的快速项，论文没有
}
```

投票 RPC 响应。

```go
type RequestVoteResponse struct {
	RPCHeader

	// Newer term if leader is out of date.
	Term uint64 // 任期

	// Is the vote granted.
	Granted bool // 投我吗
}
```

安装快照 RPC 请求。

快照主要是当 日志项太多的时候，将其合并成一个快照复制。

```go
type InstallSnapshotRequest struct {
	RPCHeader
	SnapshotVersion SnapshotVersion // 快照版本 扩展

	Term   uint64 // 任期
	Leader []byte // 领导信息

	// These are the last index/term included in the snapshot
	LastLogIndex uint64 // 快照中最后一条日志索引
	LastLogTerm  uint64 // 快照中最后一条日志任期

	// Cluster membership.
	Configuration []byte // 配置
	// Log index where 'Configuration' entry was originally written.
	ConfigurationIndex uint64 // 配置项索引

	// Size of the snapshot
	Size int64 // 大小
}
```

安装快照 RPC 响应。

```go
type InstallSnapshotResponse struct {
	RPCHeader

	Term    uint64 // 任期
	Success bool // 是否成功
}
```

### NewRaft

这里就是创建一个 `Raft` 节点的方法，其实就是验证一下配置，初始化日志，从db中拿出旧的数据（如果有），默认是一个 `Follower` 的状态，就开着三个协程去跑了。

```go
func NewRaft(conf *Config, fsm FSM, logs LogStore, stable StableStore, snaps SnapshotStore, trans Transport) (*Raft, error) {
	....
	// Initialize as a follower.
	r.setState(Follower)

	// Start as leader if specified. This should only be used
	// for testing purposes.
	if conf.StartAsLeader {
		r.setState(Leader)
		r.setLeader(r.localAddr)
	}
	....
	// Start the background work.
	r.goFunc(r.run)
	r.goFunc(r.runFSM)
	r.goFunc(r.runSnapshots)
	return r, nil
}
```

以下围绕着三个协程去讨论。

### run

协程 `run` 则根据节点状态跑相应的函数。

```go
func (r *Raft) run() {
	for {
		// Check if we are doing a shutdown
		select {
		case <-r.shutdownCh:
			// Clear the leader to prevent forwarding
			r.setLeader("")
			return
		default:
		}

		// Enter into a sub-FSM
		switch r.getState() {
		case Follower:
			r.runFollower()
		case Candidate:
			r.runCandidate()
		case Leader:
			r.runLeader()
		}
	}
}
```

### runFollower

跟随者下接收RPC请求，这里有一个 `bootstrapCh`，用于启动时接收集群信息。

除了接收附加日志，投票，安装快照请求，其他请求都不支持（代码已省略）。

心跳超时之后会变为候选者，即 `Candidate` 。

```go
func (r *Raft) runFollower() {
	heartbeatTimer := randomTimeout(r.conf.HeartbeatTimeout)

	for r.getState() == Follower {
		select {
		case rpc := <-r.rpcCh:
			r.processRPC(rpc)

		....

		case b := <-r.bootstrapCh:
			b.respond(r.liveBootstrap(b.configuration))

		case <-heartbeatTimer:
			// Restart the heartbeat timer
			heartbeatTimer = randomTimeout(r.conf.HeartbeatTimeout)

			// Check if we have had a successful contact
			lastContact := r.LastContact()
			if time.Now().Sub(lastContact) < r.conf.HeartbeatTimeout {
				continue
			}

			// Heartbeat failed! Transition to the candidate state
			lastLeader := r.Leader()
			r.setLeader("")

			if r.configurations.latestIndex == 0 {
				if !didWarn {
					r.logger.Warn("no known peers, aborting election")
					didWarn = true
				}
			} else if r.configurations.latestIndex == r.configurations.committedIndex &&
				!hasVote(r.configurations.latest, r.localID) {
				if !didWarn {
					r.logger.Warn("not part of stable configuration, aborting election")
					didWarn = true
				}
			} else {
				r.logger.Warn(fmt.Sprintf("Heartbeat timeout from %q reached, starting election", lastLeader))
				r.setState(Candidate)
				return
			}

		case <-r.shutdownCh:
			return
		}
	}
}
```

### runCandidate

候选人默认先给自己来上一票，然后就到处要票，视情况决定是退回到跟随者，还是当上领导者。

除了日志和投票的请求，其他都是直接返回错误，选举超时则退回到跟随者，等待新一轮选举。

```go
func (r *Raft) runCandidate() {
	// Start vote for us, and set a timeout
	voteCh := r.electSelf()
	....
	electionTimer := randomTimeout(r.conf.ElectionTimeout)

	// Tally the votes, need a simple majority
	grantedVotes := 0
	votesNeeded := r.quorumSize()
	r.logger.Debug(fmt.Sprintf("Votes needed: %d", votesNeeded))

	for r.getState() == Candidate {
		select {
		case rpc := <-r.rpcCh:
			r.processRPC(rpc)

		case vote := <-voteCh:
			// Check if the term is greater than ours, bail
			if vote.Term > r.getCurrentTerm() {
				r.logger.Debug("Newer term discovered, fallback to follower")
				r.setState(Follower)
				r.setCurrentTerm(vote.Term)
				return
			}

			// Check if the vote is granted
			if vote.Granted {
				grantedVotes++
				r.logger.Debug(fmt.Sprintf("Vote granted from %s in term %v. Tally: %d",
					vote.voterID, vote.Term, grantedVotes))
			}

			// Check if we've become the leader
			if grantedVotes >= votesNeeded {
				r.logger.Info(fmt.Sprintf("Election won. Tally: %d", grantedVotes))
				r.setState(Leader)
				r.setLeader(r.localAddr)
				return
			}

		case c := <-r.configurationChangeCh:
			// Reject any operations since we are not the leader
			c.respond(ErrNotLeader)

		case a := <-r.applyCh:
			// Reject any operations since we are not the leader
			a.respond(ErrNotLeader)

		case v := <-r.verifyCh:
			// Reject any operations since we are not the leader
			v.respond(ErrNotLeader)

		case r := <-r.userRestoreCh:
			// Reject any restores since we are not the leader
			r.respond(ErrNotLeader)

		case c := <-r.configurationsCh:
			c.configurations = r.configurations.Clone()
			c.respond(nil)

		case b := <-r.bootstrapCh:
			b.respond(ErrCantBootstrap)

		case <-electionTimer:
			// Election failed! Restart the election. We simply return,
			// which will kick us back into runCandidate
			r.logger.Warn("Election timeout reached, restarting election")
			return

		case <-r.shutdownCh:
			return
		}
	}
}
```

### runLeader

领导者主要是初始化多个拷贝协程，然后新建一个 `noop` 的日志项（就是不应用到状态机的日志），非常重要，相当于领导者一当选就马上告诉其他跟随者你们给我把之前任期未提交的日志给我提交了（隐式提交）。

`noop` 日志相当于一条分界线，只有其他节点同步到了这个日志，才正式提供服务，避免客户端从其他节点读到未 `Commit` 的数据（过时数据）。

```go
func (r *Raft) runLeader() {
	....
	// setup leader state. This is only supposed to be accessed within the
	// leaderloop.
	r.setupLeaderState()
	....
	// Start a replication routine for each peer
	r.startStopReplication()

	// Dispatch a no-op log entry first. This gets this leader up to the latest
	// possible commit index, even in the absence of client commands. This used
	// to append a configuration entry instead of a noop. However, that permits
	// an unbounded number of uncommitted configurations in the log. We now
	// maintain that there exists at most one uncommitted configuration entry in
	// any log, so we have to do proper no-ops here.
	noop := &logFuture{
		log: Log{
			Type: LogNoop,
		},
	}
	r.dispatchLogs([]*logFuture{noop})

	// Sit in the leader loop until we step down
	r.leaderLoop()
}
```

剩余的 `RPC` 请求处理，就不继续解析了，无非就是根据当前身上的信息和心跳发来的信息进行比对。

## 一些改进

1. 流水线传输日志。
2. 采用 `MultiRaft`， 因为 `Raft` 是强领导者类型的，性能相当于单点。
3. 跟随者变为候选者之前先与集群中确认是否真的没有 `Leader` 这有助于避免在对称网络分区错误（三节点，两机房，两节点在同一个机房）的时候把一个明明有 `Leader` 的集群转换为选举状态。
4. 非对称网络分区错误（三节点，三机房，都在不同的机房），导致一直重新选举，通过检查上次 `Leader` 到当前的通信时间是否超过重新选举的时间可避免这一问题。

## 总结

`Raft` 把 `超时` 玩出了花，通过引入超时机制（心跳超时选举领导，选举超时重新选举领导）把整个系统的复杂性降低，同时通过心跳来附加日志和提交日志，不需要等待完全确认，将 二阶段的提交过程优化为了一阶段。 `Leader` 上位后通过 `noop` 日志巧妙的避免了即日志不一致，旧读的问题。关于成员变更，则是采用单节点变更的形式，避免了 `脑裂`，不得不说 `Raft` 真的是把可理解这一特性发挥到了极致。