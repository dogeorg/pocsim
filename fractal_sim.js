// Fractal Simulator

const num_nodes = 10;
const sim_time = 1000;
const peer_conns = 4; // 1 + Log10(size-of-network) ?
const fail_chance = 0.001 // chance of failure; 0 = no failure
const fail_max_time = 80 // up to 8 seconds
const block_interval = 60 // 6 seconds (10 ticks per second)
const check_interval = 60 // 6 seconds
const mint_interval = 137 // every 13.7 seconds plus a random component
const mint_chance = 1.0 // chance to mint each mint_interval

// The set of nodes under simulation
let nodes = []

// The current simulation time (one tick = 100ms)
let time = 0

// Time of the next mint (in ticks)
let next_mint = 10

// Time of the next block (in ticks)
let next_block = block_interval

// Next block height
let next_height = 1

// Unique hashes
let nextmint = 1
let nexttx = 1

// Currently failing nodes
let failures = []

// Message queue
let queue = []

// Pending transactions
let pending_tx = []

function gen_mint() { return 'M'+(nextmint++); }
function gen_tx() { return 'T'+(nexttx++); }

function init() {
	// reset
	nodes = []
	time = 0
	next_mint = 10
	next_block = block_interval
	next_height = 1
	nextmint = 1
	nexttx = 1
	failures = []
	queue = []
	pending_tx = []
	
	// create nodes
	for (let i=0; i<num_nodes; i++) {
		nodes.push({
			addr: i|0,
			peers: [],
			online: true,
			height: 0,
			peer_height: 0,
			generation: 0,
			tip: 0,
			offline: 0,
			mint: new Map(),
			mempool: new Map(),
			unconfirmed_mint: new Map(),
			blocks: [],
			fail_ends: 0,
			mint_count: 0,
			next_check: 0,
		})
	}

	// connect nodes
	for (let node of nodes) {
		// ensure every peer has some connections
		while (node.peers.length < peer_conns) {
			let id = (Math.random()*num_nodes)|0
			if (id == node.addr) continue;
			if (!node.peers.includes(id)) {
				node.peers.push(id) // I gossip to you
			}
			if (!nodes[id].peers.includes(node.addr)) {
				nodes[id].peers.push(node.addr) // You gossip to me
			}
		}
	}
}

function receive(node, name, msg, from) {
	if (!node.online) {
		console.log(`${time}: [${node.addr}] I'm offline! Missed '${name}' from [${from}]`);
		if (name == 'L1_block') {
			// simulate reconnecting to peers when we come back online,
			// which will tell us about L1 blocks we missed.
			const block = msg;
			if (block.height > node.peer_height) {
				console.log(`${time}: [${node.addr}] Noted new block height ${msg.height} while offline`);
				node.peer_height = block.height;
			}
		}
		return;
	}
	node.received++;
	// console.log(`${time}: [${node.addr}] <= [${from}] ${name}`);

	switch (name) {
		case 'mint_api': {
			// Create a mint on this node.
			// Fractal Engine logic:
			const mint_hash = gen_mint(); // assume this hashes some data
			// add to `unconfirmed_mint` table
			const new_mint = { hash:mint_hash, tx_hash:0, height:0 };
			node.unconfirmed_mint.set(mint_hash, new_mint)
			console.log(`${time}: [${node.addr}] I created an unconfirmed mint '${mint_hash}'`);
			node.mint_count++;
			// broadcast the L1 transaction
			const tx_hash = gen_tx();
			const tx = { hash:tx_hash, mint_hash:mint_hash }
			broadcast_tx(tx);
			console.log(`${time}: [${node.addr}] I broadcast transaction '${tx_hash}'`);
			return;
		}

		case 'L1_block': {
			// Received a block.
			// Simulate block propagation (so we can simulate L1 delays)
			const block = msg;
			if (node.height+1 === block.height) {
				console.log(`${time}: [${node.addr}] I received block '${block.height}'`);
				node.blocks.push(block);
				node.height = block.height;
				if (node.peer_height < node.height) { // keep up to date if behind.
					node.peer_height = node.height;
				}
				gossip(node.peers, node.addr, 'L1_block', block);
			} else {
				//console.log(`${time}: [${node.addr}] I ignored block '${block.height}' because I'm at height ${node.height}`);
				return;
			}
			if (block.height > node.peer_height) {
				console.log(`${time}: [${node.addr}] Noted new block height ${msg.height} while online`);
				node.peer_height = block.height;
			}
			check_behind(node);
			// Fractal Engine logic:
			// Process the new block.
			for (const tx of block.tx) {
				// Assume every tx is a Mint for simulation purposes.

				// Skip if mint is already confirmed (in our `mint` table)
				if (node.mint.has(tx.mint_hash)) {
					continue;
				}

				// Check FE mempool.
				let mint = node.mempool.get(tx.mint_hash)
				if (mint != null) {
					// Found the Mint in my mempool.
					// Confirm the mint.
					console.log(`${time}: [${node.addr}] I found mint '${mint.hash}' in my mempool`);
					console.log(`${time}: [${node.addr}] I CONFIRMED mint '${mint.hash}'`);
					// Insert the confirmed mint into `mint` table with a block height.
					const confirmed_mint = { hash:mint.hash, tx_hash:tx.hash, height:block.height };
					node.mint.set(mint.hash, confirmed_mint);
					// Gossip the confirmed mint to my peers.
					// However the peer may be down, and will miss the message.
					// [Presumably if they are down they don't have the L1 yet]
					// [But they might bc we broadcast the Mint after we rcv the L1]
					gossip(node.peers, node.addr, 'mint_gossip', confirmed_mint);
					// Remove the mint from my mempool.
					node.mempool.delete(mint.hash);
					continue;
				}
				
				// OG Minting logic.
				mint = node.unconfirmed_mint.get(tx.mint_hash)
				if (mint != null) {
					// We found the block that contains one of our unconfirmed mints.
					console.log(`${time}: [${node.addr}] I found the L1 to CONFIRM my own mint '${mint.hash}'`);
					console.log(`${time}: [${node.addr}] I CONFIRMED mint '${mint.hash}'`);
					// Insert the confirmed mint into `mint` table with a block height.
					const confirmed_mint = { hash:mint.hash, tx_hash:tx.hash, height:block.height };
					node.mint.set(mint.hash, confirmed_mint);
					// Gossip the confirmed mint to my peers.
					gossip(node.peers, node.addr, 'mint_gossip', confirmed_mint);
					// Remove the mint from my unconfirmed_mint pool.
					node.unconfirmed_mint.delete(mint.hash);
					continue;
				}

				// Not found, ask peers for the Mint metadata.
				gossip(node.peers, node.addr, 'get_mint', { hash:tx.mint_hash });
			}
			return;
		}

		case 'get_block': {
			// Send a block to the peer if we have it.
			const height = msg.height;
			for (const block of node.blocks) {
				if (block.height == height) {
					console.log(`${time}: [${node.addr}] received get_block for '${height}' - sent block to ${from}`);
					send(from, node.addr, 'L1_block', block);
					return;
				}
			}
			console.log(`${time}: [${node.addr}] received get_block for '${height}' - I don't have it`);
			return;
		}

		case 'L1_rollback': {
			// Received a rollback (not exactly how blockchain works, but close enough for sim)
			// Simulate rollback propagation (so we can simulate L1 delays)
			const to_height = msg.to_height;
			if (node.generation < msg.generation) {
				// We haven't processed this rollback yet.
				console.log(`${time}: [${node.addr}] I received a rollback to height '${to_height}'`);
				node.height = to_height;
				if (node.peer_height > to_height) { // keep up to date if ahead.
					node.peer_height = to_height;
				}
				node.generation = msg.generation;
				discard_blocks_above(node, to_height);
				gossip(node.peers, node.addr, 'L1_rollback', msg);
			} else {
				console.log(`${time}: [${node.addr}] I ignored rollback in generation '${msg.generation}' because I'm already in generation ${node.generation}`);
				return;
			}

			// Fractal Engine logic:
			// roll back `mint` above to_height, put them back into `mempool`
			// these mints have become unconfirmed again.
			const undo_mints = []
			for (const mint of node.mint.values()) {
				if (mint.height < to_height) {
					undo_mints.push(mint)
				}
			}
			for (const mint of undo_mints) {
				console.log(`${time}: [${node.addr}] I ROLLED BACK mint '${mint.hash}' and put it back in my mempool`);
				node.mint.delete(mint.hash);
				node.mempool.set(mint.hash, { hash:mint.hash, tx_hash:0, height:0 });
			}
			return;
		}
	
		case 'get_mint': {
			// Received a request for metadata from a peer.
			// Fractal Engine logic:
			const mint = node.mint.get(msg.hash);
			if (mint != null) {
				console.log(`${time}: [${node.addr}] received request for mint - replied with '${msg.hash}' to '${from}'`);
				send(from, node.addr, 'mint_gossip', mint);
			} else {
				console.log(`${time}: [${node.addr}] received request for mint - I don't have mint '${msg.hash}' for '${from}'`);
			}
			return;
		}
	
		case 'mint_gossip': {
			// Receive a Mint gossip from another node.
			// Fractal Engine logic:
			const mint = msg;
			// Stop if mint is already confirmed (in our `mint` table)
			if (node.mint.has(mint.hash)) {
				// console.log(`${time}: [${node.addr}] I ignored it - already confirmed`);
				return;
			}
			console.log(`${time}: [${node.addr}] I received a mint gossip for '${msg.hash}' from '${from}'`);
			// check if I have the L1 block.
			const block = get_block(node, mint.height);
			if (block != null) {
				// Found the L1 block in my node.
				console.log(`${time}: [${node.addr}] I found L1 block '${mint.height}' on my node`);
				// Check if the block has a tx that confirms the mint.
				let confirmed = false;
				let tx_hash = 0;
				for (const tx of block.tx) {
					if (tx.mint_hash === mint.hash) {
						confirmed = true;
						tx_hash = tx.hash;
					}
				}
				if (confirmed) {
					console.log(`${time}: [${node.addr}] I CONFIRMED mint '${mint.hash}'`);
					// Insert the confirmed mint into `mint` table with a block height.
					const confirmed_mint = { hash:mint.hash, tx_hash:tx_hash, height:block.height };
					node.mint.set(mint.hash, confirmed_mint);
					// Gossip the confirmed mint to my peers.
					gossip(node.peers, node.addr, 'mint_gossip', confirmed_mint);
					// Remove the mint from my mempool.
					node.mempool.delete(mint.hash);
				} else {
					// Mint not found in the block (due to L1 rollback, or fake mint)
					// Put the mint in my mempool.
					node.mempool.set(mint.hash, mint);
				}
			} else {
				// No matching L1 block.
				// Put the mint in my mempool.
				node.mempool.set(mint.hash, { hash:mint.hash, tx_hash:0, height:0 });
			}
			return;
		}
	}
}

function get_block(node, height) {
	for (const block of node.blocks) {
		if (block.height === height) {
			return block
		}
	}
	return null
}

function broadcast_tx(tx) {
	pending_tx.push(tx);
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

function check_behind(node) {
	if (node.height < node.peer_height) {
		// we notice we're behind on blocks, so ask a peer.
		console.log(`${time}: [${node.addr}] I am behind on blocks - asking a peer for ${node.height+1}`);
		gossip(node.peers, node.addr, 'get_block', { height: node.height+1 });
	}
}

function failure() {
	// end prior failures
	let to = 0;
	for (let node of failures) {
		if (node.fail_ends <= time) {
			node.online = true
			node.next_check = time + 1
			console.log(`${time}: [${node.addr}] I'm back online!`);
		} else {
			failures[to++] = node; // keep
		}
	}
	failures.length = to;
	// randomly flip one node offline
	if (Math.random() < fail_chance && time < sim_time) {
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

function tick() {

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

	// check if nodes are behind
	for (const node of nodes) {
		if (time >= node.next_check) {
			node.next_check = time + check_interval;
			check_behind(node);
		}
	}

	// randomly trigger a mint
	if (time >= next_mint && time < sim_time) {
		// send a mint_api call to a random node.
		if (Math.random() <= mint_chance) {
			const target = Math.floor(Math.random() * nodes.length);
			send(target, 0, 'mint_api', {});
		}
		next_mint = time + mint_interval + Math.floor(Math.random()*mint_interval)
	}

	// mine a block regularly
	if (time >= next_block && (pending_tx.length || time < sim_time)) {
		// put all pending transactions into a block.
		const block = { height:next_height, tx:pending_tx };
		pending_tx = [];
		next_height += 1;
		next_block = time + block_interval;
		// choose a random node to receive the new block.
		let target = Math.floor(Math.random() * nodes.length);
		while (nodes[target].offline) {
			target = Math.floor(Math.random() * nodes.length);
		}
		console.log(`[miner] minted block ${block.height} - sending to ${target}`);
		// explicit send so the node cannot go offline
		receive(nodes[target], 'L1_block', block, 0);
	}
}

function run() {
	while (time < sim_time+500) {
		time++;
		tick();
	}
}

function results() {
	let total = 0;
	for (let node of nodes) {
		console.log(`[${node.addr}]: height ${node.height} offline ${node.offline} confirmed ${node.mint.size} mempool ${node.mempool.size} minted ${node.mint_count} peers ${node.peers}`);
		total += node.mint_count;
	}
	console.log(`total mints created: ${total}`);
	let valid = true;
	for (let node of nodes) {
		if (node.mint.size !== total) {
			const missing = [];
			for (let i=1; i<=total; i++) {
				const mint = 'M'+i;
				if (!node.mint.has(mint)) missing.push(mint);
			}
			console.log(`[${node.addr}]: ERRORS! only confirmed ${node.mint.size} of ${total} - missing ${missing.join(', ')}`);
			valid = false;
		}
	}
	return valid;
}

function do_sim() {
	let valid = false;
	let runs = 1000;
	do {
		console.log("\n\n\n");
		init()
		run()
		valid = results()
		runs--;
	} while (valid && runs >= 0);
}

do_sim()
