---
title: Gossip 协议解析
categories: 分布式
date: 2021-03-09 16:45:20
keywords: gossip, raft, cap
tags: [分布式, gossip]
---

一直都对分布式协议比较感兴趣，选择了 `Gossip` 和 `Raft` 作为起点，之所以这么选择有两个原因。

1. 它们足够简单。
2. 一个基于 `AP` ，一个基于 `CP` ，分别是可用性优先和一致性优先的代表。

## Gossip

`Gossip` 协议主要通过谣言传播的形式，传播给其他节点。

我这里称 `Gossip` 为 协议 而不是算法是因为这只是个思想，基于这个思想有很多的变种。

Gossip 能够正常运作需要以下三种实现组合。

1. 广播
2. 反熵(Anti-entropy)
3. 谣言传播

<!-- more -->

### 反熵

`反熵`其实就是通过`推拉`的形式，将两个节点的数据进行交换，进而达成一致。之所以有了广播还要有反熵去推拉，是因为有可能缓存区满了，丢了数据，或者是一个新节点刚刚上线，它肯定就没办法得到之前广播出来的消息啦，那就需要反熵进行修复。

### 谣言传播

其实谣言传播和广播大多数时候都是做到一块的，换句话说 谣言传播是随机从节点里选K个进行广播。

## Gossip 实现

主要分析 [memberlist](https://github.com/hashicorp/memberlist) 的实现，其依赖于 `Gossip` 的变种，`SWIM`: [Scalable Weakly-consistent Infection-style Process Group Membership Protocol](http://ieeexplore.ieee.org/document/1028914/) 

每个节点有有以下四种状态，存活，怀疑，死亡，离开(相当于死亡的一种补充)。

```go
const (
	StateAlive NodeStateType = iota
	StateSuspect
	StateDead
	StateLeft
)
```

### Create

根据配置创建节点

```go
func Create(conf *Config) (*Memberlist, error) {
	m, err := newMemberlist(conf)
	if err != nil {
		return nil, err
	}
	if err := m.setAlive(); err != nil {
		m.Shutdown()
		return nil, err
	}
	m.schedule()
	return m, nil
}
```

### newMemberlist

填充结构体，建立 TCP 与 UDP 连接。

```go
func newMemberlist(conf *Config) (*Memberlist, error) {
	....
	m := &Memberlist{
		config:               conf,
		shutdownCh:           make(chan struct{}),
		leaveBroadcast:       make(chan struct{}, 1),
		transport:            nodeAwareTransport,
		handoffCh:            make(chan struct{}, 1),
		highPriorityMsgQueue: list.New(),
		lowPriorityMsgQueue:  list.New(),
		nodeMap:              make(map[string]*nodeState),
		nodeTimers:           make(map[string]*suspicion),
		awareness:            newAwareness(conf.AwarenessMaxMultiplier),
		ackHandlers:          make(map[uint32]*ackHandler),
		broadcasts:           &TransmitLimitedQueue{RetransmitMult: conf.RetransmitMult},
		logger:               logger,
	}
	....
	go m.streamListen()
	go m.packetListen()
	go m.packetHandler()
	return m, nil
}
```

### TCP 处理

节点状态同步，Push-Pull，用户数据同步。

读出数据，根据消息类型进行操作，反熵体现在 pushPullMsg 这个类型中。

```go
func (m *Memberlist) handleConn(conn net.Conn) {
	defer conn.Close()
	m.logger.Printf("[DEBUG] memberlist: Stream connection %s", LogConn(conn))

	metrics.IncrCounter([]string{"memberlist", "tcp", "accept"}, 1)

	conn.SetDeadline(time.Now().Add(m.config.TCPTimeout))
	msgType, bufConn, dec, err := m.readStream(conn)

	switch msgType {
	case userMsg:
		if err := m.readUserMsg(bufConn, dec); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to receive user message: %s %s", err, LogConn(conn))
		}
	case pushPullMsg:
		// Increment counter of pending push/pulls
		numConcurrent := atomic.AddUint32(&m.pushPullReq, 1)
		defer atomic.AddUint32(&m.pushPullReq, ^uint32(0))

		// Check if we have too many open push/pull requests
		if numConcurrent >= maxPushPullRequests {
			m.logger.Printf("[ERR] memberlist: Too many pending push/pull requests")
			return
		}

		join, remoteNodes, userState, err := m.readRemoteState(bufConn, dec)
		if err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to read remote state: %s %s", err, LogConn(conn))
			return
		}

		if err := m.sendLocalState(conn, join); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to push local state: %s %s", err, LogConn(conn))
			return
		}

		if err := m.mergeRemoteState(join, remoteNodes, userState); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed push/pull merge: %s %s", err, LogConn(conn))
			return
		}
	case pingMsg:
		var p ping
		if err := dec.Decode(&p); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to decode ping: %s %s", err, LogConn(conn))
			return
		}

		if p.Node != "" && p.Node != m.config.Name {
			m.logger.Printf("[WARN] memberlist: Got ping for unexpected node %s %s", p.Node, LogConn(conn))
			return
		}

		ack := ackResp{p.SeqNo, nil}
		out, err := encode(ackRespMsg, &ack)
		if err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to encode ack: %s", err)
			return
		}

		err = m.rawSendMsgStream(conn, out.Bytes())
		if err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to send ack: %s %s", err, LogConn(conn))
			return
		}
	default:
		m.logger.Printf("[ERR] memberlist: Received invalid msgType (%d) %s", msgType, LogConn(conn))
	}
}
```

### UDP 处理

各种消息处理。

将数据转为命令进行处理，用户自定义数据分优先级。

```go
func (m *Memberlist) ingestPacket(buf []byte, from net.Addr, timestamp time.Time) {
	....
	m.handleCommand(buf, from, timestamp)
}

func (m *Memberlist) handleCommand(buf []byte, from net.Addr, timestamp time.Time) {
	// Decode the message type
	msgType := messageType(buf[0])
	buf = buf[1:]

	// Switch on the msgType
	switch msgType {
	case compoundMsg:
		m.handleCompound(buf, from, timestamp)
	case compressMsg:
		m.handleCompressed(buf, from, timestamp)

	case pingMsg:
		m.handlePing(buf, from)
	case indirectPingMsg:
		m.handleIndirectPing(buf, from)
	case ackRespMsg:
		m.handleAck(buf, from, timestamp)
	case nackRespMsg:
		m.handleNack(buf, from)

	case suspectMsg:
		fallthrough
	case aliveMsg:
		fallthrough
	case deadMsg:
		fallthrough
	case userMsg:
		// Determine the message queue, prioritize alive
		queue := m.lowPriorityMsgQueue
		if msgType == aliveMsg {
			queue = m.highPriorityMsgQueue
		}

		// Check for overflow and append if not full
		m.msgQueueLock.Lock()
		if queue.Len() >= m.config.HandoffQueueDepth {
			m.logger.Printf("[WARN] memberlist: handler queue full, dropping message (%d) %s", msgType, LogAddress(from))
		} else {
			queue.PushBack(msgHandoff{msgType, buf, from})
		}
		m.msgQueueLock.Unlock()

		// Notify of pending message
		select {
		case m.handoffCh <- struct{}{}:
		default:
		}

	default:
		m.logger.Printf("[ERR] memberlist: msg type (%d) not supported %s", msgType, LogAddress(from))
	}
}
```

### schedule

开三个协程

1. probe 协程
2. push-pull 协程
3. gossip 协程

```go
func (m *Memberlist) schedule() {
	m.tickerLock.Lock()
	defer m.tickerLock.Unlock()

	// If we already have tickers, then don't do anything, since we're
	// scheduled
	if len(m.tickers) > 0 {
		return
	}

	// Create the stop tick channel, a blocking channel. We close this
	// when we should stop the tickers.
	stopCh := make(chan struct{})

	// Create a new probeTicker
	if m.config.ProbeInterval > 0 {
		t := time.NewTicker(m.config.ProbeInterval)
		go m.triggerFunc(m.config.ProbeInterval, t.C, stopCh, m.probe)
		m.tickers = append(m.tickers, t)
	}

	// Create a push pull ticker if needed
	if m.config.PushPullInterval > 0 {
		go m.pushPullTrigger(stopCh)
	}

	// Create a gossip ticker if needed
	if m.config.GossipInterval > 0 && m.config.GossipNodes > 0 {
		t := time.NewTicker(m.config.GossipInterval)
		go m.triggerFunc(m.config.GossipInterval, t.C, stopCh, m.gossip)
		m.tickers = append(m.tickers, t)
	}

	// If we made any tickers, then record the stopTick channel for
	// later.
	if len(m.tickers) > 0 {
		m.stopTick = stopCh
	}
}
```

### probe 协程

随机选取一个节点，然后通过UDP发送 ping 消息，如果不通则通过 indirect-ping 消息完成，意思是发给其他随机几个节点，由他们替你去 ping。

如果配置打开 TCP 开关，也会通过 TCP 去 ping（如果 TCP 判断存活，UDP间接判断不存活，还是认为存活）。

```go
func (m *Memberlist) probeNode(node *nodeState) {
	defer metrics.MeasureSince([]string{"memberlist", "probeNode"}, time.Now())

	// We use our health awareness to scale the overall probe interval, so we
	// slow down if we detect problems. The ticker that calls us can handle
	// us running over the base interval, and will skip missed ticks.
	probeInterval := m.awareness.ScaleTimeout(m.config.ProbeInterval)
	if probeInterval > m.config.ProbeInterval {
		metrics.IncrCounter([]string{"memberlist", "degraded", "probe"}, 1)
	}

	// Prepare a ping message and setup an ack handler.
	selfAddr, selfPort := m.getAdvertise()
	ping := ping{
		SeqNo:      m.nextSeqNo(),
		Node:       node.Name,
		SourceAddr: selfAddr,
		SourcePort: selfPort,
		SourceNode: m.config.Name,
	}
	ackCh := make(chan ackMessage, m.config.IndirectChecks+1)
	nackCh := make(chan struct{}, m.config.IndirectChecks+1)
	m.setProbeChannels(ping.SeqNo, ackCh, nackCh, probeInterval)

	// Mark the sent time here, which should be after any pre-processing but
	// before system calls to do the actual send. This probably over-reports
	// a bit, but it's the best we can do. We had originally put this right
	// after the I/O, but that would sometimes give negative RTT measurements
	// which was not desirable.
	sent := time.Now()

	// Send a ping to the node. If this node looks like it's suspect or dead,
	// also tack on a suspect message so that it has a chance to refute as
	// soon as possible.
	deadline := sent.Add(probeInterval)
	addr := node.Address()

	// Arrange for our self-awareness to get updated.
	var awarenessDelta int
	defer func() {
		m.awareness.ApplyDelta(awarenessDelta)
	}()
	if node.State == StateAlive {
		if err := m.encodeAndSendMsg(node.FullAddress(), pingMsg, &ping); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to send ping: %s", err)
			if failedRemote(err) {
				goto HANDLE_REMOTE_FAILURE
			} else {
				return
			}
		}
	} else {
		var msgs [][]byte
		if buf, err := encode(pingMsg, &ping); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to encode ping message: %s", err)
			return
		} else {
			msgs = append(msgs, buf.Bytes())
		}
		s := suspect{Incarnation: node.Incarnation, Node: node.Name, From: m.config.Name}
		if buf, err := encode(suspectMsg, &s); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to encode suspect message: %s", err)
			return
		} else {
			msgs = append(msgs, buf.Bytes())
		}

		compound := makeCompoundMessage(msgs)
		if err := m.rawSendMsgPacket(node.FullAddress(), &node.Node, compound.Bytes()); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to send compound ping and suspect message to %s: %s", addr, err)
			if failedRemote(err) {
				goto HANDLE_REMOTE_FAILURE
			} else {
				return
			}
		}
	}

	// Arrange for our self-awareness to get updated. At this point we've
	// sent the ping, so any return statement means the probe succeeded
	// which will improve our health until we get to the failure scenarios
	// at the end of this function, which will alter this delta variable
	// accordingly.
	awarenessDelta = -1

	// Wait for response or round-trip-time.
	select {
	case v := <-ackCh:
		if v.Complete == true {
			if m.config.Ping != nil {
				rtt := v.Timestamp.Sub(sent)
				m.config.Ping.NotifyPingComplete(&node.Node, rtt, v.Payload)
			}
			return
		}

		// As an edge case, if we get a timeout, we need to re-enqueue it
		// here to break out of the select below.
		if v.Complete == false {
			ackCh <- v
		}
	case <-time.After(m.config.ProbeTimeout):
		// Note that we don't scale this timeout based on awareness and
		// the health score. That's because we don't really expect waiting
		// longer to help get UDP through. Since health does extend the
		// probe interval it will give the TCP fallback more time, which
		// is more active in dealing with lost packets, and it gives more
		// time to wait for indirect acks/nacks.
		m.logger.Printf("[DEBUG] memberlist: Failed ping: %s (timeout reached)", node.Name)
	}

HANDLE_REMOTE_FAILURE:
	// Get some random live nodes.
	m.nodeLock.RLock()
	kNodes := kRandomNodes(m.config.IndirectChecks, m.nodes, func(n *nodeState) bool {
		return n.Name == m.config.Name ||
			n.Name == node.Name ||
			n.State != StateAlive
	})
	m.nodeLock.RUnlock()

	// Attempt an indirect ping.
	expectedNacks := 0
	selfAddr, selfPort = m.getAdvertise()
	ind := indirectPingReq{
		SeqNo:      ping.SeqNo,
		Target:     node.Addr,
		Port:       node.Port,
		Node:       node.Name,
		SourceAddr: selfAddr,
		SourcePort: selfPort,
		SourceNode: m.config.Name,
	}
	for _, peer := range kNodes {
		// We only expect nack to be sent from peers who understand
		// version 4 of the protocol.
		if ind.Nack = peer.PMax >= 4; ind.Nack {
			expectedNacks++
		}

		if err := m.encodeAndSendMsg(peer.FullAddress(), indirectPingMsg, &ind); err != nil {
			m.logger.Printf("[ERR] memberlist: Failed to send indirect ping: %s", err)
		}
	}

	// Also make an attempt to contact the node directly over TCP. This
	// helps prevent confused clients who get isolated from UDP traffic
	// but can still speak TCP (which also means they can possibly report
	// misinformation to other nodes via anti-entropy), avoiding flapping in
	// the cluster.
	//
	// This is a little unusual because we will attempt a TCP ping to any
	// member who understands version 3 of the protocol, regardless of
	// which protocol version we are speaking. That's why we've included a
	// config option to turn this off if desired.
	fallbackCh := make(chan bool, 1)

	disableTcpPings := m.config.DisableTcpPings ||
		(m.config.DisableTcpPingsForNode != nil && m.config.DisableTcpPingsForNode(node.Name))
	if (!disableTcpPings) && (node.PMax >= 3) {
		go func() {
			defer close(fallbackCh)
			didContact, err := m.sendPingAndWaitForAck(node.FullAddress(), ping, deadline)
			if err != nil {
				m.logger.Printf("[ERR] memberlist: Failed fallback ping: %s", err)
			} else {
				fallbackCh <- didContact
			}
		}()
	} else {
		close(fallbackCh)
	}

	// Wait for the acks or timeout. Note that we don't check the fallback
	// channel here because we want to issue a warning below if that's the
	// *only* way we hear back from the peer, so we have to let this time
	// out first to allow the normal UDP-based acks to come in.
	select {
	case v := <-ackCh:
		if v.Complete == true {
			return
		}
	}

	// Finally, poll the fallback channel. The timeouts are set such that
	// the channel will have something or be closed without having to wait
	// any additional time here.
	for didContact := range fallbackCh {
		if didContact {
			m.logger.Printf("[WARN] memberlist: Was able to connect to %s but other probes failed, network may be misconfigured", node.Name)
			return
		}
	}

	// Update our self-awareness based on the results of this failed probe.
	// If we don't have peers who will send nacks then we penalize for any
	// failed probe as a simple health metric. If we do have peers to nack
	// verify, then we can use that as a more sophisticated measure of self-
	// health because we assume them to be working, and they can help us
	// decide if the probed node was really dead or if it was something wrong
	// with ourselves.
	awarenessDelta = 0
	if expectedNacks > 0 {
		if nackCount := len(nackCh); nackCount < expectedNacks {
			awarenessDelta += (expectedNacks - nackCount)
		}
	} else {
		awarenessDelta += 1
	}

	// No acks received from target, suspect it as failed.
	m.logger.Printf("[INFO] memberlist: Suspect %s has failed, no acks received", node.Name)
	s := suspect{Incarnation: node.Incarnation, Node: node.Name, From: m.config.Name}
	m.suspectNode(&s)
}
```

### push-pull 协程

随机选 1 个节点，通过 UDP 进行推拉，反熵修复值。

```go
func (m *Memberlist) pushPull() {
	// Get a random live node
	m.nodeLock.RLock()
	nodes := kRandomNodes(1, m.nodes, func(n *nodeState) bool {
		return n.Name == m.config.Name ||
			n.State != StateAlive
	})
	m.nodeLock.RUnlock()

	// If no nodes, bail
	if len(nodes) == 0 {
		return
	}
	node := nodes[0]

	// Attempt a push pull
	if err := m.pushPullNode(node.FullAddress(), false); err != nil {
		m.logger.Printf("[ERR] memberlist: Push/Pull with %s failed: %s", node.Name, err)
	}
}

// pushPullNode does a complete state exchange with a specific node.
func (m *Memberlist) pushPullNode(a Address, join bool) error {
	defer metrics.MeasureSince([]string{"memberlist", "pushPullNode"}, time.Now())

	// Attempt to send and receive with the node
	remote, userState, err := m.sendAndReceiveState(a, join)
	if err != nil {
		return err
	}

	if err := m.mergeRemoteState(join, remote, userState); err != nil {
		return err
	}
	return nil
}
```

### gossip 协程

根据配置随机找几个节点，通过 UDP 进行谣言传播，即从广播队列（TCP 同步节点状态的时候会将消息放入广播队列）中取出来进行广播。

```go
func (m *Memberlist) gossip() {
	defer metrics.MeasureSince([]string{"memberlist", "gossip"}, time.Now())

	// Get some random live, suspect, or recently dead nodes
	m.nodeLock.RLock()
	kNodes := kRandomNodes(m.config.GossipNodes, m.nodes, func(n *nodeState) bool {
		if n.Name == m.config.Name {
			return true
		}

		switch n.State {
		case StateAlive, StateSuspect:
			return false

		case StateDead:
			return time.Since(n.StateChange) > m.config.GossipToTheDeadTime

		default:
			return true
		}
	})
	m.nodeLock.RUnlock()

	// Compute the bytes available
	bytesAvail := m.config.UDPBufferSize - compoundHeaderOverhead
	if m.config.EncryptionEnabled() {
		bytesAvail -= encryptOverhead(m.encryptionVersion())
	}

	for _, node := range kNodes {
		// Get any pending broadcasts
		msgs := m.getBroadcasts(compoundOverhead, bytesAvail)
		if len(msgs) == 0 {
			return
		}

		addr := node.Address()
		if len(msgs) == 1 {
			// Send single message as is
			if err := m.rawSendMsgPacket(node.FullAddress(), &node.Node, msgs[0]); err != nil {
				m.logger.Printf("[ERR] memberlist: Failed to send gossip to %s: %s", addr, err)
			}
		} else {
			// Otherwise create and send a compound message
			compound := makeCompoundMessage(msgs)
			if err := m.rawSendMsgPacket(node.FullAddress(), &node.Node, compound.Bytes()); err != nil {
				m.logger.Printf("[ERR] memberlist: Failed to send gossip to %s: %s", addr, err)
			}
		}
	}
}
```

如果配置打开 TCP 开关，也会通过 TCP 去 ping（如果 TCP 判断存活，UDP间接判断不存活，还是认为存活）。

## 结语

`Gossip` 是一个 `AP` 的分布式协议，总体来说还是比较简单的。