const Module = require("module");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("Prometheus node close awaits exporter shutdown", async () => {
	let stopResolve;
	let stopCalled = false;
	let NodeConstructor;
	const statusCalls = [];

	const stubExporter = {
		startHttpInExporter: () => Promise.resolve(),
		stopHttpInExporter: () => {
			stopCalled = true;
			return new Promise((resolve) => {
				stopResolve = resolve;
			});
		},
	};

	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (
			request === "./prometheus-exporter" &&
			parent &&
			parent.filename.endsWith(path.join("lib", "prometheus-node.js"))
		) {
			return stubExporter;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	const prometheusNodeModule = require("../lib/prometheus-node");
	Module._load = originalLoad;

	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (_name, constructor) => {
				NodeConstructor = constructor;
			},
		},
	};
	prometheusNodeModule(mockRed);

	let closeHandler;
	const nodeInstance = {
		on: (event, handler) => {
			if (event === "close") closeHandler = handler;
		},
		status: (status) => statusCalls.push(status),
		error: () => {},
	};

	NodeConstructor.call(nodeInstance, {
		endpoint: "/metrics",
		port: 1881,
		instrumentName: "http_request_duration",
		serviceName: "Node-RED",
	});

	assert.ok(closeHandler);
	const closePromise = closeHandler.call(nodeInstance);
	assert.equal(stopCalled, true);
	assert.equal(
		statusCalls.some((status) => status.text === "disabled"),
		false,
	);

	stopResolve();
	await closePromise;

	assert.equal(
		statusCalls.some((status) => status.text === "disabled"),
		true,
	);
});
