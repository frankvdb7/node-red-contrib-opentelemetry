const Module = require("module");
const path = require("node:path");

const stubPath = path.join(__dirname, "stubs", "node-red-util.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const exporterModule = require("../lib/prometheus-exporter");
Module._resolveFilename = originalResolveFilename;

const {
	resetState,
	getState,
	setRequestDurationHistogram,
	setDependencies,
	resetDependencies,
} = exporterModule.__test__;

class FakeHistogram {
	constructor(name, options) {
		this.name = name;
		this.options = options;
		this.records = [];
	}

	record(value, attributes) {
		this.records.push({ value, attributes });
	}
}

function applyFakeDependencies(ExporterClass, createdHistograms = []) {
	class FakeMeterProvider {
		constructor(config) {
			this.config = config;
		}

		getMeter() {
			return {
				createHistogram: (name, options) => {
					const histogram = new FakeHistogram(name, options);
					createdHistograms.push(histogram);
					return histogram;
				},
			};
		}
	}

	class FakeView {
		constructor(config) {
			this.config = config;
		}
	}

	class FakeAggregation {
		constructor(buckets) {
			this.buckets = buckets;
		}
	}

	class FakeResource {
		constructor(config) {
			this.config = config;
		}
	}

	setDependencies({
		PrometheusExporter: ExporterClass,
		MeterProvider: FakeMeterProvider,
		View: FakeView,
		ExplicitBucketHistogramAggregation: FakeAggregation,
		Resource: FakeResource,
	});

	return createdHistograms;
}

test.beforeEach(() => {
	resetState();
	resetDependencies();
});

test.afterEach(() => {
	resetState();
	resetDependencies();
});

test("startHttpInExporter configures exporter and histogram", async () => {
	class FakeExporter {
		constructor(options, callback) {
			this.options = options;
			this.shutdownCalled = false;
			setImmediate(() => callback(null));
		}

		async shutdown() {
			this.shutdownCalled = true;
		}
	}

	const createdHistograms = applyFakeDependencies(FakeExporter, []);

	await exporterModule.startHttpInExporter(
		9000,
		"/metrics",
		"http_requests",
		"service",
	);
	const state = getState();
	assert.ok(state.exporter instanceof FakeExporter);
	assert.equal(createdHistograms.length, 1);
	assert.equal(state.requestDurationHistogram, createdHistograms[0]);
	assert.equal(createdHistograms[0].name, "http_requests");
});

test("startHttpInExporter rejects when exporter fails to start", async () => {
	class FailingExporter {
		constructor(_options, callback) {
			setImmediate(() => callback(new Error("boom")));
		}

		async shutdown() {}
	}

	applyFakeDependencies(FailingExporter, []);

	await assert.rejects(
		() => exporterModule.startHttpInExporter(9000, "/metrics", "http_requests"),
		/boom/,
	);
	const state = getState();
	assert.equal(state.exporter, undefined);
	assert.equal(state.requestDurationHistogram, undefined);
});

test("stopHttpInExporter shuts down exporter and clears state", async () => {
	class FakeExporter {
		constructor(_options, callback) {
			this.shutdownCalled = false;
			setImmediate(() => callback(null));
		}

		async shutdown() {
			this.shutdownCalled = true;
		}
	}

	applyFakeDependencies(FakeExporter, []);
	await exporterModule.startHttpInExporter(9000, "/metrics", "http_requests");
	const { exporter } = getState();
	await exporterModule.stopHttpInExporter(9000, "/metrics");
	assert.equal(exporter.shutdownCalled, true);
	const state = getState();
	assert.equal(state.exporter, undefined);
	assert.equal(state.requestDurationHistogram, undefined);
});

test("prometheusMiddleware records metrics when histogram available", () => {
	let finishCallback;
	setDependencies({
		onFinished: (_res, callback) => {
			finishCallback = callback;
		},
	});

	const histogram = new FakeHistogram("requests", {});
	setRequestDurationHistogram(histogram);

	const originalNow = Date.now;
	Date.now = () => 1000;

	const req = { method: "GET", path: "/example", ip: "127.0.0.1" };
	const res = { statusCode: 200 };
	let nextCalled = false;
	exporterModule.prometheusMiddleware(req, res, () => {
		nextCalled = true;
	});
	assert.equal(req.startTimestamp, 1000);
	assert.equal(nextCalled, true);

	Date.now = () => 1025;
	finishCallback(null, res);
	assert.equal(histogram.records.length, 1);
	assert.deepEqual(histogram.records[0].attributes, {
		method: "GET",
		route: "/example",
		status: 200,
		ip: "127.0.0.1",
	});
	assert.equal(histogram.records[0].value, 25);

	Date.now = originalNow;
});

test("prometheusMiddleware still calls next when histogram missing", () => {
	let finishCallback;
	setDependencies({
		onFinished: (_res, callback) => {
			finishCallback = callback;
		},
	});

	setRequestDurationHistogram(undefined);
	const req = { method: "POST", path: "/no-metrics", ip: "10.0.0.1" };
	const res = { statusCode: 204 };
	let nextCalled = false;
	exporterModule.prometheusMiddleware(req, res, () => {
		nextCalled = true;
	});
	assert.equal(nextCalled, true);
	assert.equal(req.startTimestamp, undefined);
	assert.equal(typeof finishCallback, "undefined");
});
