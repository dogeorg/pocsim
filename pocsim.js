// ComPOS Simulator

const num_nodes = 100;
const sim_time = 10000;
const peer_conns = 4; // 1 + Log10(size-of-network) ?
const fail_chance = 0.01 // chance of failure; 0 = no failure
const fail_max_time = 80 // up to 8 seconds
const block_interval = 60 // 6 seconds (10 ticks per second)
const attest_interval = 20 // 2 second attestation period
const catchup_timeout = 30 // 3 seconds to get a catchup-block

// The ring contains the schedule of staking nodes and is
// consensus state (we assume all nodes agree on this state)
let ring = []

// The set of nodes under simulation
let nodes = []

// Index of the next staking node to propose a block, in the ring
let turn = 3 // prior 3 nodes will attest 1st block

// The current simulation time (one tick = 100ms)
let time = 0

// Number of block-intervals that have passed
let num_intervals = 1

// Unique block hash so nodes can compare tip
let nexthash = 286127

// Currently failing nodes
let failures = []

// Message queue
let queue = []

function init() {
	for (let i=0; i<num_nodes; i++) {
		nodes.push({
			addr: i,
			peers: [],
			online: true,
			height: 0,
			tip: 0,
			catchup: 0,
			block: null,
			started: 0,
			offline: 0,
			received: 0,
			proposed: 0,
			accepted: 0,
			attested: 0,
			staking: false,
			fail_ends: 0,
		})
	}
	for (let node of nodes) {
		// ensure every peer has some inbound connections
		const peers = [];
		let n = peer_conns
		while (n) {
			let id = Math.floor(Math.random()*num_nodes)
			if (peers.includes(id)) continue
			peers.push(id)
			nodes[id].peers.push(node.addr) // gossip to me
			n--;
		}
	}
	for (let node of nodes) {
		// ensure every peer has some outbound connections
		while (node.peers.length < peer_conns) {
			let id = Math.floor(Math.random()*num_nodes)
			if (node.peers.includes(id)) continue
			node.peers.push(id)
		}
	}
	// populate the ring with a random permutation of 1/4 of the nodes.
	let n = Math.floor(nodes.length/4);
	while (n) {
		let id = Math.floor(Math.random()*nodes.length)
		if (ring.includes(id)) continue
		ring.push(id)
		nodes[id].staking = true;
		n--;
	}
}

function failure() {
	// end prior failures
	let to = 0;
	for (let node of failures) {
		if (node.fail_ends <= time) {
			node.online = true
			console.log(`${time}: [${node.addr}] I'm back online!`);
		} else {
			failures[to++] = node; // keep
		}
	}
	failures.length = to;
	// randomly flip one node online/offline
	if (Math.random() < fail_chance) {
		let id = Math.floor(Math.random()*nodes.length)
		let node = nodes[id];
		if (node.online) {
			node.online = false
			node.offline++;
			node.fail_ends = time + Math.floor(Math.random()*fail_max_time)
			failures.push(node)
			console.log(`${time}: [${id}] I went offline :O`);
		}
	}
}

function prev(n) {
	n = turn - n;
	if (n < 0) n += ring.length;
	return ring[n]
}

function think(node, proposer) {
	if (!node.online) return;

	if (node === proposer) {
		// my turn to mint a block
		if (!node.block) {
			let block = { block:"block", sig:node.addr, hash:nexthash++, height:node.height+1, time:time, attest:[] };
			node.block = block;
			node.started = time;
			node.proposed++;
			console.log(`${time}: [${node.addr}] I propose a block at height ${block.height}`);
			// send request to 3 prior nodes to attest the block
			send(prev(1), node.addr, 'attest', block);
			send(prev(2), node.addr, 'attest', block);
			send(prev(3), node.addr, 'attest', block);
		}
	} else {
		node.block = null;
		node.started = 0;
	}
}

function ask_a_peer(node) {
	node.catchup = time + catchup_timeout; // start or extend catch-up period
	if (node.peers.length) {
		let who = node.peers[Math.floor(Math.random()*node.peers.length)];
		send(who, node.addr, 'getblock', { height:node.height+1 });
	} else {
		console.log(`${time}: [${node.addr}] Fie! I don't have any peers.`);
	}
}

function receive(node, name, data, from) {
	if (!node.online) {
		console.log(`${time}: [${node.addr}] I'm offline! Missed '${name}' from [${from}]`);
		return;
	}
	node.received++;
	// console.log(`${time}: [${node.addr}] <= [${from}] ${name}`);

	switch (name) {
		case 'attest': {
			// another node has requested attestation
			const block = data;
			if (!block.sig == ring[turn]) {
				console.log(`${time}: [${node.addr}] I refuse to attest: it's not your turn, ${block.sig}!`);
				return;
			}
			if (time > block.time + attest_interval) {
				console.log(`${time}: [${node.addr}] I refuse to attest: your block is too old: ${block.time} vs ${time}`);
				return;
			}
			if (block.height !== node.height+1) {
				console.log(`${time}: [${node.addr}] I refuse to attest: your block has the wrong height: ${block.height} (expecting ${node.height+1})`);
				return;
			}
			node.attested++;
			send(from, node.addr, 'attested', { sig: node.addr });
			return;
		}
		case 'attested': {
			// another node has attested to my block
			const block = node.block;
			if (block != null) {
				// I am minting a block.
				block.attest.push(data.sig);
				console.log(`${time}: [${node.addr}] I received your attestation, [${from}]; have=${block.attest.length} start=${node.started} time=${time}`);
				// Do I have 3 attestations, within the attestation period?
				if (block.attest.length == 3 && time < node.started + attest_interval) {
					// Success! Gossip the new block.
					console.log(`${time}: [${node.addr}] I minted a block at height ${block.height}!`);
					// But first, I should accept my own block.
					node.height = block.height
					node.tip = block.hash
					gossip(node.peers, node.addr, 'block', block);
				}

			}
			return;
		}
		case 'block': {
			// if the block has 3 attestations and matches my height, accept the block.
			const block = data;
			if (block.hash != node.tip) {
				// simulation: assume I verify signature, attestations, prev_hash, transactions vs chainstate, etc.
				if (block.height !== node.height + 1) {
					console.log(`${time}: [${node.addr}] I reject your block: wrong height: ${block.height} (expecting ${node.height+1})`);
					if (block.height > node.height) {
						// I need to catch up, but can't really trust the sender.
						// But first, am I already catching up?
						if (time >= node.catchup) {
							// OK to start catching up.
							// I'll ask a peer to send me the next block, and see if that works.
							console.log(`${time}: [${node.addr}] I am behind; asking a peer for help.`);
							ask_a_peer(node);
						}
					}
				} else if (block.attest.length !== 3) {
					console.log(`${time}: [${node.addr}] I reject your block: not enough attestations`);
				} else if (block.time > time) {
					console.log(`${time}: [${node.addr}] I reject your block: it is too new: ${block.time} vs ${time}`);
				} else {
					node.height = block.height
					node.tip = block.hash;
					node.accepted++;
					console.log(`${time}: [${node.addr}] I accepted a block at height ${block.height}`);
					if (time < node.catchup) {
						// I'm catching up on missed blocks.
						// OK I did receive a valid, newer block. I'll ask a peer again.
						console.log(`${time}: [${node.addr}] I am still behind; asking a peer again.`);
						ask_a_peer(node);
					} else {
						// forward the block to my peers.
						gossip(node.peers, node.addr, 'block', block);
					}
				}
			}
			return;
		}
		case 'getblock': {
			// send back a block if I have it.
			const request = data;
			if (request.height <= node.height) {
				// simulation: reconstitute the block on the fly.
				let when = time - block_interval * (node.height - request.height);
				let block = { block:"block", sig:node.addr, hash:nexthash++, height:request.height, time:when, attest:[1,2,3] };
				send(from, node.addr, 'block', block);
			} else {
				console.log(`${time}: [${node.addr}] I don't have block ${request.height}`);
			}
			return;
		}
	}
}

function send(to,from,name,data) {
	if (to==null) throw 1;
	if (from==null) throw 1;
	let delay = Math.floor(Math.random()*4) // simulates 0-300ms (0-3 ticks)
	queue.push({at:time+delay,to,from,name,data})
	// console.log(`${time}: [${from}] => [${to}] ${name}`);
}

function gossip(peers,from,name,data) {
	for (let peer of peers) {
		send(peer,from,name,data);
	}
}

function tick() {
	time++;

	let step = time % block_interval;
	if (step == 0) {
		turn = (turn+1) % ring.length; // next node's turn
		num_intervals++;
		console.log(`${time}: Start of ${ring[turn]}'s turn, at block-interval ${num_intervals}`);
	}

	failure(); // random node failure.

	// make queued messages arrive.
	let to = 0;
	for (let msg of queue) {
		if (msg.at <= time) {
			if (msg.to==null) throw 1;
			if (msg.from==null) throw 1;
			receive(nodes[msg.to], msg.name, msg.data, msg.from);
		} else {
			queue[to++] = msg; // keep
		}
	}
	queue.length = to;

	// let each node think
	let proposer = nodes[ring[turn]];
	for (let node of nodes) {
		think(node, proposer);
	}
}

function run() {
	console.log(`${time}: Start of ${ring[turn]}'s turn, at block-interval ${num_intervals}`);
	for (let i=0; i<sim_time; i++) {
		tick();
	}
}

function results() {
	for (let node of nodes) {
		console.log(`[${node.addr}]: height ${node.height} offline ${node.offline} received ${node.received} proposed ${node.proposed} accepted ${node.accepted} attested ${node.attested} [${node.peers}] ${node.staking?'staking':''}`);
	}
}

init()
console.log(ring.length,ring)
run()
results()
