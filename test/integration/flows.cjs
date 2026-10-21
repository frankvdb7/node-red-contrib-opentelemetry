const tab = { id: "flow", type: "tab", label: "Integration flow" };
function node(id, type, wires = [], config = {}) {
	return { id, type, z: "flow", x: 100, y: 100, name: id, wires, ...config };
}
function httpFlow(code = "msg.payload = 'ok'; return msg;", extra = []) {
	return [
		tab,
		node("in", "http in", [["work"]], { url: "/test", method: "get" }),
		node("work", "function", [["response"]], { func: code, outputs: 1 }),
		node("response", "http response", [], { statusCode: "", headers: {} }),
		...extra,
	];
}
function outboundFlow() {
	return httpFlow("msg.headers = { 'x-preserved': 'yes' }; return msg;", [
		node("request", "http request", [["response"]], {
			method: "GET",
			ret: "txt",
			url: "http://downstream:1080/capture",
		}),
	]).map((entry) =>
		entry.id === "work" ? { ...entry, wires: [["request"]] } : entry,
	);
}
function branchingFlow() {
	return [
		tab,
		node("in", "http in", [["split"]], { url: "/test", method: "get" }),
		node("split", "function", [["a", "b"]], {
			func: "msg.payload = [1, 2]; return msg;",
			outputs: 1,
		}),
		node("a", "split", [["sub"]], {
			splt: "\\n",
			spltType: "str",
			arraySplt: 1,
			arraySpltType: "len",
			stream: false,
		}),
		node("b", "function", [["sink"]], {
			func: "setTimeout(() => { node.send(msg); node.done(); }, 30); return;",
			outputs: 1,
		}),
		node("sink", "debug", [], {
			active: true,
			console: false,
			tosidebar: false,
		}),
		{
			id: "subdef",
			type: "subflow",
			name: "Nested",
			in: [{ x: 0, y: 0, wires: [{ id: "nested" }] }],
			out: [{ x: 200, y: 0, wires: [{ id: "nested", port: 0 }] }],
		},
		node("nested", "function", [], {
			z: "subdef",
			func: "return msg;",
			outputs: 1,
		}),
		node("sub", "subflow:subdef", [["join"]]),
		node("join", "join", [["response"]], {
			mode: "auto",
			build: "array",
			property: "payload",
			propertyType: "msg",
			key: "topic",
			count: "2",
		}),
		node("response", "http response", [], { statusCode: "200" }),
	];
}
module.exports = { httpFlow, outboundFlow, branchingFlow };
