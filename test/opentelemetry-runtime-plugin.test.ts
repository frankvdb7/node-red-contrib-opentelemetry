// @ts-nocheck
const Module = require("node:module");
const path = require("node:path");
const stubPath = path.join(process.cwd(), "test", "stubs", "node-red-util.cjs");
const exporterStubPath = path.join(process.cwd(), "test", "stubs", "otel-exporters.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	if (
		typeof request === "string" &&
		request.startsWith("@opentelemetry/exporter-")
	) {
		return exporterStubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};
const test = require("node:test");
const assert = require("node:assert/strict");
const hashSum = require("hash-sum");
const otelApi = require("@opentelemetry/api");
const otelLogsApi = require("@opentelemetry/api-logs");
const otelModule = require("../src/plugins/opentelemetry-runtime");
const nodeRedUtilStub = require(stubPath);

const mockRed = {
	nodes: {
		getNode: (id) => ({ name: `Flow ${id}` }),
	},
};

const {
	getMsgId,
	getSpanId,
	isPrimitive,
	parseAttribute,
	createSpan,
	endSpan,
	deleteOutdatedMsgSpans,
	setAttributeMappings,
	setTimeout: setTimeoutMs,
	getMsgSpans,
	resetState,
	logEvent,
	setLogLevel,
	resolveOpenTelemetryConfig,
	ensureSignalPath,
	ensureSignalPathFromGenericEndpoint,
	normalizeGrpcEndpoint,
	normalizeNodeType,
	shouldSkipNodeType,
	parseNodeUrl,
	resolveProtocol,
	resolveLogLevel,
	resolveNodeRedLogLevel,
	parseExporterEnv,
	resolveSignalEnabledFromEnv,
	resolveNodeRedSeverity,
	resolveSpanKind,
	buildAutoSpanAttributes,
	hasHttpServerContext,
	hasHttpResponseContext,
	shouldHandleTerminalHttpResponse,
	isSubflowNodeType,
	maskUrlCredentials,
	formatStartupConfigSummary,
	pluginLog,
	resolveExtractionCarrier,
	resolvePropagationCarriers,
	setTraceContextHeaderAliases,
	getSharedState,
} = otelModule.__test__;

const originalEnv = { ...process.env };

function resetEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, originalEnv);
}

test.beforeEach(() => {
	resetState();
	resetEnv();
	nodeRedUtilStub.log.reset();
});

test.afterEach(() => {
	resetState();
	resetEnv();
	nodeRedUtilStub.log.reset();
});

function createFakeSpan(name, options = {}) {
	return {
		name,
		options,
		attributes: options.attributes || {},
		ended: false,
		endTimestamp: undefined,
		end(timestamp) {
			this.ended = true;
			this.endTimestamp = timestamp;
		},
		setAttributes(attrs) {
			this.attributes = { ...this.attributes, ...attrs };
		},
		setAttribute(key, value) {
			this.attributes[key] = value;
		},
		setStatus() {},
		recordException() {},
		updateName(newName) {
			this.updatedName = newName;
		},
	};
}

function getTraceIdFromTraceparent(traceparent) {
	return String(traceparent || "").split("-")[1];
}

function addNodeRedHttpRequestHeaderHash(headers) {
	headers["x-node-red-request-node"] = hashSum(headers);
	return headers;
}

test("getMsgId prefers otelRootMsgId when present", () => {
	assert.equal(getMsgId({ _msgid: "1", otelRootMsgId: "root" }), "root");
	assert.equal(getMsgId({ _msgid: "1" }), "1");
});

test("getSpanId includes node id and respects split root id", () => {
	assert.equal(
		getSpanId({ _msgid: "1" }, { id: "node", type: "function" }),
		"1#node",
	);
	assert.equal(
		getSpanId(
			{ _msgid: "1", otelRootMsgId: "root" },
			{ id: "node", type: "split" },
		),
		"root#node",
	);
});

test("isPrimitive recognises primitive values and arrays", () => {
	assert.equal(isPrimitive("hello"), true);
	assert.equal(isPrimitive(42), true);
	assert.equal(isPrimitive(false), true);
	assert.equal(isPrimitive(["a", 1, true]), true);
	assert.equal(isPrimitive([{ foo: "bar" }]), false);
	assert.equal(isPrimitive({ foo: "bar" }), false);
});

test("parseAttribute returns undefined when no mappings configured", () => {
	assert.equal(
		parseAttribute(false, { foo: "bar" }, "flow", "type"),
		undefined,
	);
});

test("parseAttribute filters mappings by flow, node type and timing", () => {
	setAttributeMappings([
		{ flow: "", nodeType: "", isAfter: false, key: "root", path: "foo" },
		{
			flow: "flow",
			nodeType: "type",
			isAfter: false,
			key: "matching",
			path: "details.value",
		},
		{
			flow: "flow",
			nodeType: "type",
			isAfter: true,
			key: "afterOnly",
			path: "details.value",
		},
	]);
	const attributes = parseAttribute(
		false,
		{ foo: "ignored", details: { value: "kept" } },
		"flow",
		"type",
	);
	assert.deepEqual(attributes, { root: "ignored", matching: "kept" });
	const afterAttributes = parseAttribute(
		true,
		{ details: { value: 5 } },
		"flow",
		"type",
	);
	assert.deepEqual(afterAttributes, { afterOnly: 5 });
});

test("parseAttribute ignores non primitive results", () => {
	setAttributeMappings([
		{
			flow: "",
			nodeType: "",
			isAfter: false,
			key: "object",
			path: "{ value: foo }",
		},
	]);
	const attributes = parseAttribute(
		false,
		{ foo: { nested: true } },
		"flow",
		"type",
	);
	assert.deepEqual(attributes, {});
});

test("parseAttribute ignores mappings with blank key or path", () => {
	setAttributeMappings([
		{ flow: "", nodeType: "", isAfter: false, key: "", path: "foo" },
		{ flow: "", nodeType: "", isAfter: false, key: "valid", path: "foo" },
		{ flow: "", nodeType: "", isAfter: false, key: "ignored", path: " " },
	]);
	const attributes = parseAttribute(false, { foo: "value" }, "flow", "type");
	assert.deepEqual(attributes, { valid: "value" });
});

test("resolveOpenTelemetryConfig reads OTEL env values when node uses defaults", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
	process.env.OTEL_SERVICE_NAME = "env-service";
	const config = resolveOpenTelemetryConfig({
		url: "http://localhost:4318/v1/traces",
		protocol: "http",
		serviceName: "Node-RED",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/v1/logs");
	assert.equal(config.protocol, "proto");
	assert.equal(config.serviceName, "env-service");
});

test("resolveOpenTelemetryConfig gives OTEL env values precedence over explicit settings", () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://collector:4318/v1/traces";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
	process.env.OTEL_SERVICE_NAME = "env-service";
	const config = resolveOpenTelemetryConfig({
		url: "http://custom:4318/v1/traces",
		protocol: "proto",
		serviceName: "custom-service",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.protocol, "http");
	assert.equal(config.serviceName, "env-service");
});

test("resolveOpenTelemetryConfig supports trace-specific env overrides", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://generic:4318";
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://trace-specific:4318/custom";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace-specific:4318/custom");
	assert.equal(config.protocol, "proto");
});

test("resolveOpenTelemetryConfig appends signal paths to generic endpoint base path", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/otlp";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://collector:4318/otlp/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/otlp/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/otlp/v1/logs");
});

test("resolveOpenTelemetryConfig supports per-signal protocol env overrides", () => {
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
	process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";
	const config = resolveOpenTelemetryConfig({ protocol: "http" });
	assert.equal(config.tracesProtocol, "proto");
	assert.equal(config.metricsProtocol, "http");
	assert.equal(config.logsProtocol, "proto");
	assert.equal(config.protocol, "proto");
});

test("resolveOpenTelemetryConfig supports grpc OTEL protocol and keeps generic endpoint as-is", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.tracesProtocol, "grpc");
	assert.equal(config.metricsProtocol, "grpc");
	assert.equal(config.logsProtocol, "grpc");
	assert.equal(config.url, "http://collector:4317");
	assert.equal(config.metricsUrl, "http://collector:4317");
	assert.equal(config.logsUrl, "http://collector:4317");
});

test("resolveOpenTelemetryConfig uses config.url fallback for http/proto metrics and logs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://collector:4318/otlp",
		protocol: "http/protobuf",
	});
	assert.equal(config.protocol, "proto");
	assert.equal(config.url, "http://collector:4318/otlp");
	assert.equal(config.metricsUrl, "http://collector:4318/otlp/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/otlp/v1/logs");
});

test("resolveOpenTelemetryConfig remaps generic trace path to metrics and logs when config.url is reused", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://collector:4318/v1/traces",
		protocol: "http",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/v1/logs");
});

test("resolveOpenTelemetryConfig grpc fallback ignores default http trace URL from config.url", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://localhost:4318/v1/traces",
		protocol: "grpc",
	});
	assert.equal(config.tracesProtocol, "grpc");
	assert.equal(config.metricsProtocol, "grpc");
	assert.equal(config.logsProtocol, "grpc");
	assert.equal(config.url, "http://localhost:4317");
	assert.equal(config.metricsUrl, "http://localhost:4317");
	assert.equal(config.logsUrl, "http://localhost:4317");
});

test("resolveOpenTelemetryConfig reads log level from env variable", () => {
	process.env.OTEL_LOG_LEVEL = "debug";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.logLevel, "debug");
});

test("resolveOpenTelemetryConfig gives env log level precedence over explicit config", () => {
	process.env.OTEL_LOG_LEVEL = "error";
	const config = resolveOpenTelemetryConfig({ logLevel: "info" });
	assert.equal(config.logLevel, "error");
});

test("resolveOpenTelemetryConfig falls back to Node-RED logging level when env and plugin logLevel are unset", () => {
	const config = resolveOpenTelemetryConfig(
		{},
		{ logging: { console: { level: "debug" } } },
	);
	assert.equal(config.logLevel, "debug");
});

test("resolveOpenTelemetryConfig maps Node-RED fatal logging level to plugin error", () => {
	const config = resolveOpenTelemetryConfig(
		{},
		{ logging: { console: { level: "fatal" } } },
	);
	assert.equal(config.logLevel, "error");
});

test("resolveOpenTelemetryConfig gives explicit plugin logLevel precedence over Node-RED logging level", () => {
	const config = resolveOpenTelemetryConfig(
		{ logLevel: "trace" },
		{ logging: { console: { level: "warn" } } },
	);
	assert.equal(config.logLevel, "trace");
});

test("resolveOpenTelemetryConfig reads excludedNodeTypes from env variable", () => {
	process.env.OTEL_EXCLUDED_NODE_TYPES = "debug,catch,inject";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.excludedNodeTypes, "debug,catch,inject");
});

test("resolveOpenTelemetryConfig gives env excludedNodeTypes precedence over explicit", () => {
	process.env.OTEL_EXCLUDED_NODE_TYPES = "debug,catch,inject";
	const config = resolveOpenTelemetryConfig({ excludedNodeTypes: "debug,catch" });
	assert.equal(config.excludedNodeTypes, "debug,catch,inject");

	const explicit = resolveOpenTelemetryConfig({
		excludedNodeTypes: "debug,inject",
	});
	assert.equal(explicit.excludedNodeTypes, "debug,catch,inject");
});

test("resolveOpenTelemetryConfig preserves explicit empty excludedNodeTypes", () => {
	delete process.env.OTEL_EXCLUDED_NODE_TYPES;
	const config = resolveOpenTelemetryConfig({ excludedNodeTypes: "" });
	assert.equal(config.excludedNodeTypes, "");
});

test("resolveOpenTelemetryConfig reads includedNodeTypes from env variable", () => {
	process.env.OTEL_INCLUDED_NODE_TYPES = "function,http request";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.includedNodeTypes, "function,http request");
});

test("resolveOpenTelemetryConfig gives env includedNodeTypes precedence over explicit", () => {
	process.env.OTEL_INCLUDED_NODE_TYPES = "function,http request";
	const config = resolveOpenTelemetryConfig({ includedNodeTypes: "inject,debug" });
	assert.equal(config.includedNodeTypes, "function,http request");

	const explicit = resolveOpenTelemetryConfig({
		includedNodeTypes: "mqtt out,http in",
	});
	assert.equal(explicit.includedNodeTypes, "function,http request");
});

test("resolveOpenTelemetryConfig preserves explicit empty includedNodeTypes", () => {
	delete process.env.OTEL_INCLUDED_NODE_TYPES;
	const config = resolveOpenTelemetryConfig({ includedNodeTypes: "" });
	assert.equal(config.includedNodeTypes, "");
});

test("resolveOpenTelemetryConfig reads propagateHeaderNodeTypes from env variable", () => {
	process.env.OTEL_PROPAGATE_HEADER_NODE_TYPES = "http request,mqtt out";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.propagateHeaderNodeTypes, "http request,mqtt out");
});

test("resolveOpenTelemetryConfig gives env propagateHeaderNodeTypes precedence over explicit", () => {
	process.env.OTEL_PROPAGATE_HEADER_NODE_TYPES = "http request,mqtt out";
	const config = resolveOpenTelemetryConfig({
		propagateHeaderNodeTypes: "function,inject",
	});
	assert.equal(config.propagateHeaderNodeTypes, "http request,mqtt out");

	const explicit = resolveOpenTelemetryConfig({
		propagateHeaderNodeTypes: "mqtt in,amqp out",
	});
	assert.equal(explicit.propagateHeaderNodeTypes, "http request,mqtt out");
});

test("resolveOpenTelemetryConfig preserves explicit empty propagateHeaderNodeTypes", () => {
	delete process.env.OTEL_PROPAGATE_HEADER_NODE_TYPES;
	const config = resolveOpenTelemetryConfig({ propagateHeaderNodeTypes: "" });
	assert.equal(config.propagateHeaderNodeTypes, "");
});

test("resolveOpenTelemetryConfig reads traceContextHeaderAliases from env variable", () => {
	process.env.OTEL_TRACE_CONTEXT_HEADER_ALIASES = "x-traceparent,x-trace-id";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.traceContextHeaderAliases, "x-traceparent,x-trace-id");
});

test("resolveOpenTelemetryConfig gives env traceContextHeaderAliases precedence over explicit", () => {
	process.env.OTEL_TRACE_CONTEXT_HEADER_ALIASES = "x-traceparent,x-trace-id";
	const config = resolveOpenTelemetryConfig({
		traceContextHeaderAliases: "message-parent-id",
	});
	assert.equal(config.traceContextHeaderAliases, "x-traceparent,x-trace-id");

	const explicit = resolveOpenTelemetryConfig({
		traceContextHeaderAliases: "parent-trace",
	});
	assert.equal(explicit.traceContextHeaderAliases, "x-traceparent,x-trace-id");
});

test("resolveOpenTelemetryConfig preserves explicit empty traceContextHeaderAliases", () => {
	delete process.env.OTEL_TRACE_CONTEXT_HEADER_ALIASES;
	const config = resolveOpenTelemetryConfig({ traceContextHeaderAliases: "" });
	assert.equal(config.traceContextHeaderAliases, "");
});

test("resolveOpenTelemetryConfig appends signal paths for specific endpoints without path", () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://trace:4318";
	process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://metrics:4318";
	process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://logs:4318";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://metrics:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://logs:4318/v1/logs");
});

test("resolveOpenTelemetryConfig preserves existing endpoint paths", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/otlp";
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://trace-specific:4318/custom-traces";
	process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
		"http://metrics-specific:4318/custom-metrics";
	process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
		"http://logs-specific:4318/custom-logs";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace-specific:4318/custom-traces");
	assert.equal(config.metricsUrl, "http://metrics-specific:4318/custom-metrics");
	assert.equal(config.logsUrl, "http://logs-specific:4318/custom-logs");
});

test("resolveOpenTelemetryConfig keeps malformed env endpoint without throwing", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://[::1";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://[::1");
	assert.equal(config.metricsUrl, "http://[::1");
	assert.equal(config.logsUrl, "http://[::1");
});

test("resolveOpenTelemetryConfig enables metrics and logs when OTLP endpoint env is provided", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.tracesEnabled, true);
	assert.equal(config.metricsEnabled, true);
	assert.equal(config.logsEnabled, true);
});

test("resolveOpenTelemetryConfig respects OTEL_*_EXPORTER none to disable signals", () => {
	process.env.OTEL_TRACES_EXPORTER = "none";
	process.env.OTEL_METRICS_EXPORTER = "none";
	process.env.OTEL_LOGS_EXPORTER = "none";
	const config = resolveOpenTelemetryConfig({
		tracesEnabled: true,
		metricsEnabled: true,
		logsEnabled: true,
	});
	assert.equal(config.tracesEnabled, false);
	assert.equal(config.metricsEnabled, false);
	assert.equal(config.logsEnabled, false);
});

test("resolveOpenTelemetryConfig appends signal paths for explicit base node URLs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://trace-explicit:4318",
		metricsUrl: "http://metrics-explicit:4318",
		logsUrl: "http://logs-explicit:4318",
	});
	assert.equal(config.url, "http://trace-explicit:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://metrics-explicit:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://logs-explicit:4318/v1/logs");
});

test("resolveOpenTelemetryConfig keeps explicit custom paths for node URLs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://trace-explicit:4318/custom-traces",
		metricsUrl: "http://metrics-explicit:4318/custom-metrics",
		logsUrl: "http://logs-explicit:4318/custom-logs",
	});
	assert.equal(config.url, "http://trace-explicit:4318/custom-traces");
	assert.equal(config.metricsUrl, "http://metrics-explicit:4318/custom-metrics");
	assert.equal(config.logsUrl, "http://logs-explicit:4318/custom-logs");
});

test("maskUrlCredentials redacts password in URLs", () => {
	assert.equal(
		maskUrlCredentials("http://user:secret@collector:4318/v1/traces"),
		"http://user:***@collector:4318/v1/traces",
	);
	assert.equal(
		maskUrlCredentials("https://collector:4318/v1/traces"),
		"https://collector:4318/v1/traces",
	);
	assert.equal(maskUrlCredentials("http://[::1"), "http://[::1");
});

test("formatStartupConfigSummary masks credentials in endpoint URLs", () => {
	const summary = formatStartupConfigSummary({
		url: "http://user:trace-secret@trace:4318/v1/traces",
		metricsUrl: "http://metrics:4318/v1/metrics",
		logsUrl: "http://user:logs-secret@logs:4318/v1/logs",
		protocol: "http",
		tracesProtocol: "http",
		metricsProtocol: "http",
		logsProtocol: "http",
		serviceName: "Node-RED",
		tracesEnabled: true,
		metricsEnabled: true,
		logsEnabled: true,
		rootPrefix: "",
		excludedNodeTypes: "debug,catch",
		includedNodeTypes: "",
		propagateHeaderNodeTypes: "",
		logLevel: "warn",
		timeout: 10,
		attributeMappings: [],
	});
	assert.match(summary, /tracesUrl=http:\/\/user:\*\*\*@trace:4318\/v1\/traces/);
	assert.match(summary, /logsUrl=http:\/\/user:\*\*\*@logs:4318\/v1\/logs/);
	assert.doesNotMatch(summary, /trace-secret|logs-secret/);
});

test("createSpan creates parent and child spans for new messages", () => {
	const startedSpans = [];
	const tracer = {
		startSpan: (name, options) => {
			const span = createFakeSpan(name, options);
			startedSpans.push(span);
			return span;
		},
	};
	const span = createSpan(
		mockRed,
		tracer,
		{ _msgid: "1" },
		{ id: "node", type: "function", name: "Function", z: "flow" },
		{},
		false,
	);
	assert.equal(span.name, "Function");
	assert.equal(startedSpans.length, 2);
	const spansMap = getMsgSpans();
	assert.equal(spansMap.size, 1);
	const entry = spansMap.get("1");
	assert.equal(entry.parentSpan, startedSpans[0]);
	assert.ok(entry.spans.has("1#node"));
});

test("createSpan skips creation when span already exists", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	assert.ok(createSpan(mockRed, tracer, msg, node, {}, false));
	assert.equal(createSpan(mockRed, tracer, msg, node, {}, false), undefined);
});

test("createSpan skips root span creation when tracing is disabled for the first node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const span = createSpan(mockRed, tracer, msg, node, {}, true);
	assert.equal(span, undefined);
	assert.equal(getMsgSpans().size, 0);
});

test("createSpan stores fake span for ignored non-root nodes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const rootNode = {
		id: "root-node",
		type: "function",
		name: "Function Root",
		z: "flow",
	};
	const ignoredNode = {
		id: "ignored-node",
		type: "debug",
		name: "Debug",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const ignoredSpan = createSpan(mockRed, tracer, msg, ignoredNode, {}, true);
	assert.equal(typeof ignoredSpan.end, "function");
	const spansMap = getMsgSpans();
	const storedSpan = spansMap.get("1").spans.get("1#ignored-node");
	assert.notEqual(storedSpan, ignoredSpan);
	assert.equal(storedSpan.attributes["node_red.node.type"], "debug");
});

test("endSpan ends child span and clears parent when last span completes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const entry = getMsgSpans().get("1");
	let parentEnded = false;
	entry.parentSpan.end = () => {
		parentEnded = true;
	};
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.equal(parentEnded, true);
	assert.equal(getMsgSpans().size, 0);
});

test("deleteOutdatedMsgSpans removes outdated entries", () => {
	const parentSpan = createFakeSpan("parent");
	const now = Date.now();
	const spans = getMsgSpans();
	spans.set("msg", {
		parentSpan,
		spans: new Map(),
		updateTimestamp: now - 100,
	});
	setTimeoutMs(0);
	deleteOutdatedMsgSpans();
	assert.equal(spans.size, 0);
	assert.equal(parentSpan.ended, true);
	assert.ok(parentSpan.endTimestamp <= now - 100);
});

test("deleteOutdatedMsgSpans continues when one parent span end throws", () => {
	const spans = getMsgSpans();
	const now = Date.now();
	const brokenParent = createFakeSpan("broken-parent");
	const healthyParent = createFakeSpan("healthy-parent");
	brokenParent.end = () => {
		throw new Error("parent end failed");
	};
	spans.set("broken-msg", {
		parentSpan: brokenParent,
		spans: new Map(),
		updateTimestamp: now - 200,
	});
	spans.set("healthy-msg", {
		parentSpan: healthyParent,
		spans: new Map(),
		updateTimestamp: now - 200,
	});
	setTimeoutMs(0);

	deleteOutdatedMsgSpans();

	assert.equal(spans.has("healthy-msg"), false);
});

test("logEvent forwards diagnostic debug logs to Node-RED even when plugin log level is off", () => {
	setLogLevel("off");
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(logSpy.mock.calls.length, 1);
	assert.equal(logSpy.mock.calls[0].arguments[0].level, nodeRedUtilStub.log.DEBUG);
});

test("logEvent respects debug log level", () => {
	setLogLevel("debug");
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(logSpy.mock.calls.length, 1);
});

test("logEvent forwards diagnostic debug logs to Node-RED when plugin log level is warn", () => {
	setLogLevel("warn");
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(logSpy.mock.calls.length, 1);
	assert.equal(logSpy.mock.calls[0].arguments[0].level, nodeRedUtilStub.log.DEBUG);
});

test("logEvent respects logLevel for structured OTel logs", () => {
	setLogLevel("warn");
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(emitSpy.mock.calls.length, 0);

	setLogLevel("info");
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(emitSpy.mock.calls.length, 1);
});

test("logEvent can disable flow event logs independently from runtime logs", () => {
	setLogLevel("warn");
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;
	sharedState.flowEventLogsEnabled = false;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(emitSpy.mock.calls.length, 0);
});

test("logEvent emits with explicit span context when message span exists", () => {
	setLogLevel("info");
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;
	const msg = { _msgid: "log-context-msg", z: "flow" };
	const node = { id: "function-node", type: "function", z: "flow" };
	const eventSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(eventSpan);
	const parent = getMsgSpans().get("log-context-msg");
	assert.ok(parent);

	logEvent(mockRed, {}, "test", { msg, node: { node } });

	assert.equal(emitSpy.mock.calls.length, 1);
	const emitArg = emitSpy.mock.calls[0].arguments[0];
	assert.equal(otelApi.trace.getSpan(emitArg.context), eventSpan);
});

test("logEvent falls back to active context when no message span exists", () => {
	setLogLevel("info");
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "no-span-msg" } });
	assert.equal(emitSpy.mock.calls.length, 1);
	const emitArg = emitSpy.mock.calls[0].arguments[0];
	assert.equal(otelApi.trace.getSpan(emitArg.context), undefined);
});

test("createSpan should handle various node types correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1", req: { headers: {} } };
	const httpNode = {
		id: "http-node",
		type: "http in",
		name: "HTTP In",
		z: "flow",
	};
	const tcpNode = { id: "tcp-node", type: "tcp in", name: "TCP In", z: "flow" };

	createSpan(mockRed, tracer, msg, httpNode, {}, false);
	const httpSpans = getMsgSpans().get("1");
	assert.ok(httpSpans.parentSpan);

	createSpan(mockRed, tracer, { _msgid: "2" }, tcpNode, {}, false);
	const tcpSpans = getMsgSpans().get("2");
	assert.ok(tcpSpans.parentSpan);
});

test("createSpan includes subflow name when subflow node type is used", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const redWithSubflow = {
		nodes: {
			getNode: (id) => {
				if (id === "flow") {
					return { name: "Flow flow" };
				}
				if (id === "subflow-template-id") {
					return { name: "My Subflow" };
				}
				return undefined;
			},
		},
	};
	const msg = { _msgid: "subflow-msg" };
	const subflowNode = {
		id: "subflow-instance-node",
		type: "subflow:subflow-template-id",
		z: "flow",
	};

	const span = createSpan(redWithSubflow, tracer, msg, subflowNode, {}, false);
	assert.ok(span);
	assert.equal(span.name, "subflow:subflow-template-id My Subflow");
	assert.equal(span.attributes["node_red.node.name"], "My Subflow");
});

test("createSpan resolves subflow and flow names from RED.nodes.getFlows()", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const redWithFlowConfig = {
		nodes: {
			getNode: () => undefined,
			getFlows: () => ({
				flows: [
					{ id: "flow-tab-id", type: "tab", label: "Orders Flow" },
					{ id: "subflow-template-id", type: "subflow", name: "Retry Wrapper" },
				],
			}),
		},
	};
	const msg = { _msgid: "flow-config-subflow-msg" };
	const span = createSpan(
		redWithFlowConfig,
		tracer,
		msg,
		{
			id: "subflow-instance-node",
			type: "subflow:subflow-template-id",
			z: "flow-tab-id",
		},
		{},
		false,
	);
	assert.ok(span);
	assert.equal(span.name, "subflow:subflow-template-id Retry Wrapper");
	assert.equal(span.attributes["node_red.node.name"], "Retry Wrapper");
	assert.equal(span.attributes["node_red.flow.name"], "Orders Flow");
});

test("createSpan resolves subflow and flow names from runtime node internals", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const redWithRuntimeNodeInternals = {
		nodes: {
			getNode: (id) => {
				if (id === "subflow-instance-node") {
					return {
						name: "Subflow Instance Node",
						_flow: {
							label: "Runtime Flow Label",
							subflow: { name: "Runtime Subflow Name" },
						},
						_def: { label: "Runtime Definition Label" },
					};
				}
				return undefined;
			},
			getFlows: () => undefined,
		},
	};
	const msg = { _msgid: "runtime-internals-subflow-msg" };
	const span = createSpan(
		redWithRuntimeNodeInternals,
		tracer,
		msg,
		{
			id: "subflow-instance-node",
			type: "subflow:unknown-template-id",
			z: "missing-flow-id",
		},
		{},
		false,
	);
	assert.ok(span);
	assert.equal(span.name, "subflow:unknown-template-id Runtime Subflow Name");
	assert.equal(span.attributes["node_red.node.name"], "Runtime Subflow Name");
	assert.equal(span.attributes["node_red.flow.name"], "Runtime Flow Label");
});

test("createSpan uses active subflow span as parent context for nested node spans", () => {
	const calls = [];
	const tracer = {
		startSpan: (name, options, parentContext) => {
			const span = createFakeSpan(name, options);
			calls.push({ span, parentContext });
			return span;
		},
	};
	const redWithSubflow = {
		nodes: {
			getNode: (id) => {
				if (id === "flow") {
					return { name: "Flow flow" };
				}
				if (id === "subflow-template-id") {
					return { name: "My Subflow" };
				}
				return undefined;
			},
		},
	};
	const msg = { _msgid: "nested-subflow-msg" };
	createSpan(
		redWithSubflow,
		tracer,
		msg,
		{
			id: "subflow-instance-node",
			type: "subflow:subflow-template-id",
			z: "flow",
		},
		{},
		false,
	);
	const subflowSpan = getMsgSpans()
		.get("nested-subflow-msg")
		?.spans.get("nested-subflow-msg#subflow-instance-node");
	assert.ok(subflowSpan);

	createSpan(
		redWithSubflow,
		tracer,
		msg,
		{
			id: "inner-node",
			type: "function",
			name: "Inner Function",
			z: "flow",
		},
		{},
		false,
	);
	const innerSpanCall = calls[calls.length - 1];
	assert.ok(innerSpanCall.parentContext);
	assert.equal(otelApi.trace.getSpan(innerSpanCall.parentContext), subflowSpan);
});

test("nested subflow spans use LIFO parent context and unwind correctly", () => {
	const calls = [];
	const tracer = {
		startSpan: (name, options, parentContext) => {
			const span = createFakeSpan(name, options);
			calls.push({ span, parentContext });
			return span;
		},
	};
	const redWithSubflow = {
		nodes: {
			getNode: (id) => {
				if (id === "flow") return { name: "Flow flow" };
				if (id === "outer-subflow-id") return { name: "Outer Subflow" };
				if (id === "inner-subflow-id") return { name: "Inner Subflow" };
				return undefined;
			},
		},
	};
	const msg = { _msgid: "nested-stack-msg" };
	const outerSubflowNode = {
		id: "outer-subflow-instance",
		type: "subflow:outer-subflow-id",
		z: "flow",
	};
	const innerSubflowNode = {
		id: "inner-subflow-instance",
		type: "subflow:inner-subflow-id",
		z: "flow",
	};

	createSpan(redWithSubflow, tracer, msg, outerSubflowNode, {}, false);
	createSpan(redWithSubflow, tracer, msg, innerSubflowNode, {}, false);

	const spansRecord = getMsgSpans().get("nested-stack-msg");
	const outerSubflowSpan = spansRecord?.spans.get(
		"nested-stack-msg#outer-subflow-instance",
	);
	const innerSubflowSpan = spansRecord?.spans.get(
		"nested-stack-msg#inner-subflow-instance",
	);
	assert.ok(outerSubflowSpan);
	assert.ok(innerSubflowSpan);

	createSpan(
		redWithSubflow,
		tracer,
		msg,
		{
			id: "inner-node",
			type: "function",
			name: "Inner Node",
			z: "flow",
		},
		{},
		false,
	);
	const innerNodeCall = calls[calls.length - 1];
	assert.equal(otelApi.trace.getSpan(innerNodeCall.parentContext), innerSubflowSpan);

	endSpan(redWithSubflow, msg, null, innerSubflowNode);

	createSpan(
		redWithSubflow,
		tracer,
		msg,
		{
			id: "outer-node",
			type: "function",
			name: "Outer Node",
			z: "flow",
		},
		{},
		false,
	);
	const outerNodeCall = calls[calls.length - 1];
	assert.equal(otelApi.trace.getSpan(outerNodeCall.parentContext), outerSubflowSpan);
});

test("carrier resolver selects HTTP req.headers for extraction", () => {
	const traceparent =
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
	const msg = {
		_msgid: "http-in-msg",
		req: { headers: { traceparent }, method: "GET" },
	};
	assert.equal(resolveExtractionCarrier(msg), msg.req.headers);
});

test("carrier resolver selects MQTT userProperties for extraction", () => {
	const traceparent =
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
	const msg = {
		_msgid: "mqtt-in-msg",
		userProperties: { traceparent },
	};
	assert.equal(resolveExtractionCarrier(msg), msg.userProperties);
});

test("carrier resolver selects AMQP properties.headers for extraction", () => {
	const traceparent =
		"00-11111111111111111111111111111111-2222222222222222-01";
	const msg = {
		_msgid: "amqp-in-msg",
		properties: { headers: { traceparent } },
	};
	assert.equal(resolveExtractionCarrier(msg), msg.properties.headers);
});

test("carrier resolver covers amqp-in-manual-ack via same AMQP message shape", () => {
	const msg = {
		_msgid: "amqp-shape",
		properties: {
			headers: {
				traceparent: "00-33333333333333333333333333333333-4444444444444444-01",
			},
		},
	};
	assert.equal(resolveExtractionCarrier(msg), msg.properties.headers);
});

test("createSpan extracts configured trace-context alias as trace context", () => {
	const traceparent =
		"00-25800e6074324d4bed01afc3eae6886f-4060804c162f7495-01";
	const calls = [];
	const tracer = {
		startSpan: (name, options, parentContext) => {
			const span = createFakeSpan(name, options);
			calls.push({ span, parentContext });
			return span;
		},
	};
	setTraceContextHeaderAliases(["x-traceparent"]);

	createSpan(
		mockRed,
		tracer,
		{
			_msgid: "trace-alias-msg",
			properties: {
				headers: {
					"x-traceparent": traceparent,
				},
			},
		},
		{ id: "node", type: "function", z: "flow" },
		{},
		false,
	);

	assert.ok(calls[0]?.parentContext);
	assert.equal(
		otelApi.trace.getSpanContext(calls[0].parentContext)?.traceId,
		"25800e6074324d4bed01afc3eae6886f",
	);
});

test("carrier resolver prefers explicit transport carriers over req.headers without HTTP request metadata", () => {
	const msg = {
		_msgid: "stale-http-shape",
		req: {
			headers: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
			},
		},
		userProperties: {
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
		},
	};
	assert.equal(resolveExtractionCarrier(msg), msg.userProperties);
});

test("resolvePropagationCarriers tolerates nullish or invalid message inputs", () => {
	assert.doesNotThrow(() => resolvePropagationCarriers(null as any));
	assert.doesNotThrow(() => resolvePropagationCarriers(undefined as any));
	assert.doesNotThrow(() => resolvePropagationCarriers("invalid" as any));

	const carriersFromNull = resolvePropagationCarriers(null as any);
	const carriersFromUndefined = resolvePropagationCarriers(undefined as any);
	assert.equal(Array.isArray(carriersFromNull), true);
	assert.equal(Array.isArray(carriersFromUndefined), true);
	assert.equal(typeof carriersFromNull[0], "object");
	assert.equal(typeof carriersFromUndefined[0], "object");
});

test("resolvePropagationCarriers handles frozen message mutation failures safely", () => {
	const frozenMsg = Object.freeze({
		_msgid: "frozen-msg",
	});
	assert.doesNotThrow(() => resolvePropagationCarriers(frozenMsg as any));
	const carriers = resolvePropagationCarriers(frozenMsg as any);
	assert.equal(Array.isArray(carriers), true);
	assert.equal(typeof carriers[0], "object");
});

test("resolvePropagationCarriers preserves extensible existing carriers when msg is frozen", () => {
	const amqpHeaders = { existing: "keep" };
	const frozenMsg = Object.freeze({
		_msgid: "frozen-with-carrier-msg",
		properties: { headers: amqpHeaders },
	});

	const carriers = resolvePropagationCarriers(frozenMsg as any);

	assert.equal(Array.isArray(carriers), true);
	assert.equal(carriers.includes(amqpHeaders), true);
});

test("resolvePropagationCarriers creates AMQP carrier when msg is frozen but msg.properties is extensible", () => {
	const msg = {
		_msgid: "frozen-msg-extensible-properties",
		properties: {},
	};
	Object.freeze(msg);

	const carriers = resolvePropagationCarriers(msg as any);

	assert.equal(Array.isArray(carriers), true);
	assert.ok(msg.properties.headers);
	assert.equal(carriers.includes(msg.properties.headers), true);
	assert.equal(typeof msg.properties.headers, "object");
});

test("resolvePropagationCarriers preserves extensible existing headers when msg is non-extensible", () => {
	const headers = { existing: "keep" };
	const msg = {
		_msgid: "nonextensible-msg",
		headers,
	};
	Object.preventExtensions(msg);

	const carriers = resolvePropagationCarriers(msg as any);

	assert.equal(Array.isArray(carriers), true);
	assert.equal(carriers.includes(headers), true);
	assert.equal(carriers.length >= 1, true);
});

test("resolvePropagationCarriers does not emit warning logs for frozen msg with extensible carrier", () => {
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;
	const amqpHeaders = { existing: "keep" };
	const frozenMsg = Object.freeze({
		_msgid: "frozen-no-warn-msg",
		properties: { headers: amqpHeaders },
	});

	const carriers = resolvePropagationCarriers(frozenMsg as any);

	assert.equal(carriers.includes(amqpHeaders), true);
	assert.equal(
		logSpy.mock.calls.some((call) =>
			String(call.arguments?.[0]?.msg || "").includes(
				"Failed to resolve propagation carriers",
			),
		),
		false,
	);
});

test("resolvePropagationCarriers does not emit warning logs for non-extensible msg fallback", () => {
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;
	const msg = { _msgid: "nonextensible-no-warn-msg" };
	Object.preventExtensions(msg);

	const carriers = resolvePropagationCarriers(msg as any);

	assert.equal(Array.isArray(carriers), true);
	assert.equal(typeof carriers[0], "object");
	assert.equal(
		logSpy.mock.calls.some((call) =>
			String(call.arguments?.[0]?.msg || "").includes(
				"Failed to resolve propagation carriers",
			),
		),
		false,
	);
});

test("resolvePropagationCarriers fallback preserves existing headers when recreating extensible carrier", () => {
	const headers = Object.freeze({
		authorization: "Bearer token",
		"content-type": "application/json",
		"x-custom": "value",
	});
	const msg = {
		_msgid: "preserve-headers-msg",
		headers,
	};

	const carriers = resolvePropagationCarriers(msg as any);

	assert.equal(Array.isArray(carriers), true);
	assert.equal(
		typeof msg.headers === "object" && msg.headers !== null && !Array.isArray(msg.headers),
		true,
	);
	assert.notEqual(msg.headers, headers);
	assert.equal(msg.headers.authorization, "Bearer token");
	assert.equal(msg.headers["content-type"], "application/json");
	assert.equal(msg.headers["x-custom"], "value");
});

test("endSpan should handle http request and response correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "1",
		statusCode: 200,
		responseUrl: "http://example.com/test",
	};
	const node = {
		id: "node",
		type: "http request",
		name: "HTTP Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "1" },
		node,
		{},
		false,
	);
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.deepEqual(childSpan.attributes["http.response.status_code"], 200);
});

test("endSpan resolves flow name from runtime node internals when flow lookup is unavailable", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const redWithRuntimeNodeInternals = {
		nodes: {
			getNode: (id) => {
				if (id === "runtime-node") {
					return { _flow: { name: "Runtime Flow Name" } };
				}
				return undefined;
			},
			getFlows: () => undefined,
		},
	};
	const msg = { _msgid: "runtime-flow-end-msg" };
	const node = {
		id: "runtime-node",
		type: "function",
		name: "Function",
		z: "missing-flow-id",
	};
	const childSpan = createSpan(
		redWithRuntimeNodeInternals,
		tracer,
		msg,
		node,
		{},
		false,
	);
	endSpan(redWithRuntimeNodeInternals, msg, null, node);
	assert.equal(childSpan.attributes["node_red.flow.name"], "Runtime Flow Name");
});

test("endSpan auto-applies client HTTP response attributes for unknown node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-client",
		statusCode: 202,
		responseUrl: "http://example.com/queue/result",
	};
	const node = {
		id: "queue-client-node",
		type: "custom queue request",
		name: "Queue Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "unknown-http-client" },
		node,
		{},
		false,
	);
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.equal(childSpan.attributes["http.response.status_code"], 202);
	assert.equal(childSpan.attributes["url.path"], "/queue/result");
	assert.equal(childSpan.attributes["server.address"], "example.com");
});

test("endSpan should handle errors correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1", error: new Error("test error") };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const recordExceptionSpy = test.mock.method(childSpan, "recordException");
	endSpan(mockRed, msg, "error", node);
	assert.equal(recordExceptionSpy.mock.calls.length, 1);
});

test("endSpan should stringify non-Error exception objects", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "obj-error", error: { reason: "bad payload" } };
	const node = {
		id: "obj-node",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const recordExceptionSpy = test.mock.method(childSpan, "recordException");
	endSpan(mockRed, msg, { code: 500 }, node);
	assert.equal(recordExceptionSpy.mock.calls.length, 1);
	assert.equal(typeof recordExceptionSpy.mock.calls[0].arguments[0], "string");
	assert.match(
		String(recordExceptionSpy.mock.calls[0].arguments[0]),
		/"reason":"bad payload"/,
	);
});

test("endSpan should use msg.error for span status message when available", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "status-msg-error", error: { reason: "bad payload" } };
	const node = {
		id: "status-msg-node",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(childSpan);
	const setStatusSpy = test.mock.method(childSpan, "setStatus");

	endSpan(mockRed, msg, "generic error", node);

	assert.equal(setStatusSpy.mock.calls.length > 0, true);
	const errorStatusCall = setStatusSpy.mock.calls.find(
		(call) => call.arguments?.[0]?.code === 2,
	);
	assert.ok(errorStatusCall);
	assert.match(String(errorStatusCall.arguments[0].message), /"reason":"bad payload"/);
});

test("endSpan should prefer non-Error exception.message for span status message", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "status-custom-message",
		error: { message: "custom object message", reason: "bad payload" },
	};
	const node = {
		id: "status-custom-message-node",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(childSpan);
	const setStatusSpy = test.mock.method(childSpan, "setStatus");

	endSpan(mockRed, msg, "generic error", node);

	const errorStatusCall = setStatusSpy.mock.calls.find(
		(call) => call.arguments?.[0]?.code === 2,
	);
	assert.ok(errorStatusCall);
	assert.equal(errorStatusCall.arguments[0].message, "custom object message");
});

test("endSpan should stringify non-Error exception when message is not a string", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "status-nonstring-message",
		error: { message: { nested: "value" }, reason: "bad payload" },
	};
	const node = {
		id: "status-nonstring-message-node",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(childSpan);
	const setStatusSpy = test.mock.method(childSpan, "setStatus");

	endSpan(mockRed, msg, "generic error", node);

	const errorStatusCall = setStatusSpy.mock.calls.find(
		(call) => call.arguments?.[0]?.code === 2,
	);
	assert.ok(errorStatusCall);
	assert.match(String(errorStatusCall.arguments[0].message), /"reason":"bad payload"/);
});

test("endSpan should continue cleanup when child span end throws", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "end-throw-msg" };
	const node = {
		id: "node-end-throw",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(childSpan);
	childSpan.end = () => {
		throw new Error("child end failed");
	};

	endSpan(mockRed, msg, null, node);

	assert.equal(getMsgSpans().has("end-throw-msg"), false);
});

test("createSpan should handle websocket nodes correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const wsInMsg = { _msgid: "ws-in" };
	const wsInNode = {
		id: "ws-in-node",
		type: "websocket in",
		name: "WS In",
		z: "flow",
		serverConfig: { path: "/ws/in" },
	};
	createSpan(mockRed, tracer, wsInMsg, wsInNode, {}, false);
	const wsInSpans = getMsgSpans().get("ws-in");
	assert.ok(wsInSpans.parentSpan);
	assert.deepEqual(wsInSpans.parentSpan.attributes["url.path"], "/ws/in");

	const wsOutMsg = { _msgid: "ws-out" };
	const wsOutNode = {
		id: "ws-out-node",
		type: "websocket out",
		name: "WS Out",
		z: "flow",
		serverConfig: { path: "ws://localhost:1880/ws/out" },
	};
	const wsOutSpan = createSpan(mockRed, tracer, wsOutMsg, wsOutNode, {}, false);
	assert.ok(wsOutSpan);
	assert.deepEqual(wsOutSpan.attributes["url.path"], "/ws/out");
	assert.deepEqual(wsOutSpan.attributes["server.address"], "localhost");
	assert.deepEqual(wsOutSpan.attributes["server.port"], "1880");
	assert.deepEqual(wsOutSpan.attributes["url.scheme"], "ws");

});

test("createSpan websocket out should support relative serverConfig path", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const wsOutRelativeMsg = { _msgid: "ws-out-relative" };
	const wsOutRelativeNode = {
		id: "ws-out-relative-node",
		type: "websocket out",
		name: "WS Out Relative",
		z: "flow",
		serverConfig: { path: "/ws/events" },
	};
	const wsOutRelativeSpan = createSpan(
		mockRed,
		tracer,
		wsOutRelativeMsg,
		wsOutRelativeNode,
		{},
		false,
	);
	assert.ok(wsOutRelativeSpan);
	assert.deepEqual(wsOutRelativeSpan.attributes["url.path"], "/ws/events");
	assert.equal(wsOutRelativeSpan.attributes["server.address"], undefined);
	assert.equal(wsOutRelativeSpan.attributes["server.port"], undefined);
	assert.equal(wsOutRelativeSpan.attributes["url.scheme"], undefined);
});

test("createSpan websocket out should keep malformed endpoint as url.path", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "ws-out-malformed" };
	const node = {
		id: "ws-out-malformed-node",
		type: "websocket out",
		name: "WS Out Malformed",
		z: "flow",
		serverConfig: { path: "http://[::1" },
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(span.attributes["url.path"], "http://[::1");
	assert.equal(span.attributes["server.address"], undefined);
	assert.equal(span.attributes["server.port"], undefined);
	assert.equal(span.attributes["url.scheme"], undefined);
});

test("endSpan should ignore malformed responseUrl without throwing", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const node = {
		id: "http-request-malformed-url",
		type: "http request",
		name: "HTTP Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "malformed-response-url" },
		node,
		{},
		false,
	);
	assert.doesNotThrow(() => {
		endSpan(
			mockRed,
			{
				_msgid: "malformed-response-url",
				statusCode: 200,
				responseUrl: "http://[::1",
			},
			null,
			node,
		);
	});
	assert.equal(childSpan.ended, true);
});

test("createSpan auto-enriches unknown node with HTTP-like message context", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-like",
		req: {
			method: "post",
			path: "/queue/consume",
			ip: "10.0.0.8",
			headers: {
				"user-agent": "test-agent",
			},
		},
		topic: "orders",
		queue: "orders-queue",
	};
	const node = {
		id: "queue-node",
		type: "custom queue in",
		name: "Queue In",
		z: "flow",
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(msg.otelStartTime !== undefined, true);
	assert.equal(span.attributes["http.request.method"], "POST");
	assert.equal(span.attributes["url.path"], "/queue/consume");
	assert.equal(span.attributes["client.address"], "10.0.0.8");
	assert.equal(span.attributes["node_red.msg.topic"], "orders");
	assert.equal(span.attributes["node_red.msg.queue"], "orders-queue");
});

test("createSpan auto-enriches unknown node endpoint path from node config", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "unknown-endpoint" };
	const node = {
		id: "custom-endpoint-node",
		type: "custom endpoint",
		name: "Custom Endpoint",
		z: "flow",
		serverConfig: { path: "/mq/events" },
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(span.attributes["url.path"], "/mq/events");
});

test("endSpan should set span status to ERROR on error", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const setStatusSpy = test.mock.method(childSpan, "setStatus");
	const parentSpan = getMsgSpans().get("1").parentSpan;
	const parentSetStatusSpy = test.mock.method(parentSpan, "setStatus");
	endSpan(mockRed, msg, new Error("test error"), node);
	assert.equal(setStatusSpy.mock.calls.length, 1);
	assert.deepEqual(setStatusSpy.mock.calls[0].arguments[0].code, 2); // 2 = ERROR
	assert.equal(parentSetStatusSpy.mock.calls.length, 1);
});

test("endSpan records http metrics even when there is no active span", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const startTime = Date.now() - 50;
	endSpan(
		mockRed,
		{
			_msgid: "metrics-only-msg",
			otelStartTime: startTime,
			req: { method: "GET", path: "/health" },
			res: { _res: { statusCode: 204 } },
		},
		null,
		{ id: "http-response", type: "http response", z: "flow" },
	);
	assert.equal(recordSpy.mock.calls.length, 1);
	const call = recordSpy.mock.calls[0];
	assert.equal(typeof call.arguments[0], "number");
	assert.ok(call.arguments[0] >= 0);
	assert.deepEqual(call.arguments[1], {
		"http.response.status_code": 204,
		"http.request.method": "GET",
		"url.path": "/health",
	});
	assert.equal(call.arguments.length, 3);
	assert.equal(otelApi.trace.getSpan(call.arguments[2]), undefined);
});

test("endSpan records http metrics with parent span context when span exists", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-trace-linked-msg",
		otelStartTime: Date.now() - 50,
		req: { method: "GET", path: "/health" },
		res: { _res: { statusCode: 204 } },
	};
	const node = { id: "http-response", type: "http response", z: "flow" };
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	const parentSpan = getMsgSpans().get(msg._msgid)?.parentSpan;
	assert.ok(parentSpan);

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	const call = recordSpy.mock.calls[0];
	assert.equal(call.arguments.length, 3);
	assert.equal(otelApi.trace.getSpan(call.arguments[2]), parentSpan);
});

test("endSpan records http metrics only once per message", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-once-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/once" },
		res: { _res: { statusCode: 200 } },
	};
	const node = { id: "resp-node", type: "http response", z: "flow" };

	endSpan(mockRed, msg, null, node);
	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	assert.equal(msg.otelHttpMetricsRecorded, true);
});

test("endSpan records http metrics once across cloned messages with same _msgid", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "resp-node", type: "http response", z: "flow" };

	const msgCloneA = {
		_msgid: "metrics-clone-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/clone" },
		res: { _res: { statusCode: 200 } },
	};
	const msgCloneB = {
		_msgid: "metrics-clone-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/clone" },
		res: { _res: { statusCode: 200 } },
	};

	endSpan(mockRed, msgCloneA, null, node);
	endSpan(mockRed, msgCloneB, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
});

test("endSpan records terminal HTTP metrics for custom responder when response is finished", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "custom-responder", type: "custom responder", z: "flow" };
	const msg = {
		_msgid: "metrics-custom-terminal",
		otelStartTime: Date.now() - 40,
		req: { method: "GET", path: "/custom" },
		res: { _res: { statusCode: 204, finished: true } },
	};

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	assert.equal(msg.otelHttpMetricsRecorded, true);
});

test("endSpan records custom terminal HTTP metrics with parent span context when span exists", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "custom-responder", type: "custom responder", z: "flow" };
	const msg = {
		_msgid: "metrics-custom-trace-linked-msg",
		otelStartTime: Date.now() - 40,
		req: { method: "GET", path: "/custom" },
		res: { _res: { statusCode: 204, finished: true } },
	};
	const rootNode = {
		id: "root-node",
		type: "http in",
		name: "Ingress",
		z: "flow",
		method: "GET",
		url: "/custom",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	const parentSpan = getMsgSpans().get(msg._msgid)?.parentSpan;
	assert.ok(parentSpan);

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	const call = recordSpy.mock.calls[0];
	assert.equal(call.arguments.length, 3);
	assert.equal(otelApi.trace.getSpan(call.arguments[2]), parentSpan);
});

test("endSpan records http metrics once per message when span context is available", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-once-with-span-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/once-with-span" },
		res: { _res: { statusCode: 200 } },
	};
	const node = { id: "resp-node", type: "http response", z: "flow" };
	createSpan(mockRed, tracer, msg, node, {}, false);

	endSpan(mockRed, msg, null, node);
	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	assert.equal(msg.otelHttpMetricsRecorded, true);
});

test("endSpan records metrics for different messages independently", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "resp-node", type: "http response", z: "flow" };

	const msgA = {
		_msgid: "metrics-a",
		otelStartTime: Date.now() - 20,
		req: { method: "GET", path: "/a" },
		res: { _res: { statusCode: 200 } },
	};
	const msgB = {
		_msgid: "metrics-b",
		otelStartTime: Date.now() - 30,
		req: { method: "POST", path: "/b" },
		res: { _res: { statusCode: 201 } },
	};

	endSpan(mockRed, msgA, null, node);
	endSpan(mockRed, msgB, null, node);

	assert.equal(recordSpy.mock.calls.length, 2);
	assert.equal(msgA.otelHttpMetricsRecorded, true);
	assert.equal(msgB.otelHttpMetricsRecorded, true);
});

test("endSpan skips metrics when otelStartTime is missing", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-no-start",
		req: { method: "GET", path: "/missing" },
		res: { _res: { statusCode: 200 } },
	};
	const node = { id: "resp-node", type: "http response", z: "flow" };

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 0);
	assert.equal(msg.otelHttpMetricsRecorded, undefined);
});

test("endSpan does not apply server response status for non-terminal custom nodes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 200 } },
	};
	const rootNode = {
		id: "root-node",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node",
		type: "custom responder",
		name: "Responder",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response");
	const rootSpanId = "unknown-http-response#root-node";
	const rootSpan = parent.spans.get(rootSpanId);
	assert.ok(rootSpan);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);
	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 0);
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], undefined);
});

test("endSpan applies response status to root span for terminal http response node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response-error",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 500 } },
	};
	const rootNode = {
		id: "root-node-error",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node-error",
		type: "http response",
		name: "HTTP Response",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response-error");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);

	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 1);
	assert.equal(parentStatusSpy.mock.calls[0].arguments[0].code, 2); // ERROR
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], 500);
});

test("endSpan applies response status to root span for custom terminal responder", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response-custom-terminal",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 201, finished: true } },
	};
	const rootNode = {
		id: "root-node-custom-terminal",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node-custom-terminal",
		type: "custom responder",
		name: "Responder",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response-custom-terminal");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);

	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 1);
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], 201);
});

test("endSpan keeps error status when terminal response has 2xx status", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "error-with-2xx-response",
		req: { method: "POST", path: "/orders" },
		res: { _res: { statusCode: 201 } },
	};
	const rootNode = {
		id: "root-node-error-2xx",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "POST",
	};
	const endNode = {
		id: "resp-node-error-2xx",
		type: "http response",
		name: "HTTP Response",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("error-with-2xx-response");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const childSetStatusSpy = test.mock.method(endSpanRef, "setStatus");
	const parentSetStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, new Error("request failed"), endNode);

	const childStatusCodes = childSetStatusSpy.mock.calls
		.map((call) => call.arguments[0]?.code)
		.filter((code) => typeof code === "number");
	const parentStatusCodes = parentSetStatusSpy.mock.calls
		.map((call) => call.arguments[0]?.code)
		.filter((code) => typeof code === "number");
	assert.ok(childStatusCodes.includes(2));
	assert.ok(parentStatusCodes.includes(2));
	assert.equal(childStatusCodes.includes(1), false);
	assert.equal(parentStatusCodes.includes(1), false);
});

function createPluginHarness(withHookListeners: boolean = false) {
	let runtimePlugin: any;
	const hooks = withHookListeners
		? {
				listeners: {},
				add: function (name, listener) {
					this.listeners[name] = listener;
				},
				remove: function (pattern) {
					if (!pattern || !String(pattern).startsWith(".")) {
						delete this.listeners[pattern];
						return;
					}
					Object.keys(this.listeners)
						.filter((name) => name.endsWith(pattern.substring(1)))
						.forEach((name) => {
							delete this.listeners[name];
						});
				},
			}
		: {
				add: () => {},
				remove: () => {},
			};
	const mockRed: any = {
		nodes: {
			getNode: (id) => ({ name: `Flow ${id}` }),
		},
		settings: {},
		hooks,
		plugins: {
			registerPlugin: (_id, plugin) => {
				runtimePlugin = {
					onSettings: async (settings) => {
						mockRed.settings.opentelemetry =
							(settings && settings.opentelemetry) || settings || {};
						return plugin.onadd?.();
					},
					onClose: async () => plugin.onremove?.(),
				};
			},
		},
	};

	assert.doesNotThrow(() => {
		otelModule(mockRed);
	});
	return { runtimePlugin, mockRed };
}

test("postDeliver.otel hook injects trace context into AMQP properties.headers", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "amqp out",
			traceContextHeaderAliases: "x-traceparent",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "amqp-msg",
			properties: {
				headers: {
					existing: "keep",
					traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
				},
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "amqp out", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.ok(sendEvent.msg.properties?.headers);
	assert.equal(sendEvent.msg.properties?.headers.existing, "keep");
	assert.ok(sendEvent.msg.properties?.headers.traceparent);
	assert.equal(sendEvent.msg.properties?.headers["x-traceparent"], sendEvent.msg.properties?.headers.traceparent);
	assert.notEqual(
		sendEvent.msg.properties?.headers.traceparent,
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
	);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook injects trace context into MQTT userProperties", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "mqtt out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "mqtt-msg",
			userProperties: {
				existing: "keep",
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "mqtt out", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.ok(sendEvent.msg.userProperties);
	assert.equal(sendEvent.msg.userProperties.existing, "keep");
	assert.ok(sendEvent.msg.userProperties.traceparent);
	assert.notEqual(
		sendEvent.msg.userProperties.traceparent,
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
	);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook falls back to msg.headers injection", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: { _msgid: "http-msg", payload: "hello" },
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.ok(sendEvent.msg.headers);
	assert.ok(sendEvent.msg.headers.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook removes stale http propagation headers before injection", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "http-header-cleanup-msg",
			headers: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				tracestate: "old=state",
				baggage: "old=value",
				authorization: "Bearer token",
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};

	postDeliverListener(sendEvent);

	assert.notEqual(
		sendEvent.msg.headers.traceparent,
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
	);
	assert.equal(sendEvent.msg.headers.tracestate, "old=state");
	assert.equal(sendEvent.msg.headers.baggage, undefined);
	assert.equal(sendEvent.msg.headers.authorization, "Bearer token");

	await runtimePlugin.onClose();
});

test("postDeliver.otel fallback should create msg.headers when missing", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "headers-fallback-create-msg",
			headers: null,
			userProperties: null,
			properties: { headers: null },
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	assert.doesNotThrow(() => postDeliverListener(sendEvent));
	assert.equal(typeof sendEvent.msg.headers, "object");
	assert.ok(sendEvent.msg.headers.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook does not turn unchanged Node-RED response headers into http request headers", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "http-msg-with-response-headers",
			payload: { hello: "world" },
			headers: addNodeRedHttpRequestHeaderHash({
				"content-length": "0",
				date: "Tue, 12 May 2026 08:44:01 GMT",
				server: "Kestrel",
			}),
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);

	assert.ok(sendEvent.msg.headers);
	assert.ok(sendEvent.msg.headers.traceparent);
	assert.equal(sendEvent.msg.headers["content-length"], undefined);
	assert.equal(sendEvent.msg.headers.date, undefined);
	assert.equal(sendEvent.msg.headers.server, undefined);
	assert.equal(sendEvent.msg.headers["x-node-red-request-node"], undefined);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook injects into all existing carriers on mixed-shape message", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "mixed-msg",
			headers: { existingHttp: "keep" },
			properties: { headers: { existingAmqp: "keep" } },
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);

	assert.equal(sendEvent.msg.headers.existingHttp, "keep");
	assert.equal(sendEvent.msg.properties.headers.existingAmqp, "keep");
	assert.ok(sendEvent.msg.headers.traceparent);
	assert.ok(sendEvent.msg.properties.headers.traceparent);
	assert.equal(
		getTraceIdFromTraceparent(sendEvent.msg.headers.traceparent),
		getTraceIdFromTraceparent(sendEvent.msg.properties.headers.traceparent),
	);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook creates and injects msg.headers for http request when only AMQP carrier exists", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "http-from-amqp-shape",
			properties: { headers: { existingAmqp: "keep" } },
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);

	assert.equal(sendEvent.msg.properties.headers.existingAmqp, "keep");
	assert.ok(sendEvent.msg.properties.headers.traceparent);
	assert.ok(sendEvent.msg.headers);
	assert.ok(sendEvent.msg.headers.traceparent);
	assert.equal(
		getTraceIdFromTraceparent(sendEvent.msg.properties.headers.traceparent),
		getTraceIdFromTraceparent(sendEvent.msg.headers.traceparent),
	);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook tolerates malformed primitive carriers", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "malformed-carriers-msg",
			headers: "bad-headers-shape",
			userProperties: "bad-user-props-shape",
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	assert.doesNotThrow(() => postDeliverListener(sendEvent));
	assert.equal(typeof sendEvent.msg.headers, "object");
	assert.ok(sendEvent.msg.headers.traceparent);

	await runtimePlugin.onClose();
});

test("AMQP trace context survives publish/consume round trip via shared carrier resolver", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "amqp out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const publishEvent = {
		msg: {
			_msgid: "amqp-publish-msg",
			properties: {
				headers: { existing: "keep" },
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "amqp out", z: "flow" } },
	};
	postDeliverListener(publishEvent);
	const injectedTraceparent = publishEvent.msg.properties?.headers.traceparent;
	assert.ok(injectedTraceparent);

	const consumedMsg = {
		_msgid: "amqp-consume-msg",
		properties: {
			headers: publishEvent.msg.properties?.headers,
		},
	};
	const consumedCarrier = resolveExtractionCarrier(consumedMsg);
	const consumedTraceId = getTraceIdFromTraceparent(
		consumedCarrier?.traceparent,
	);
	assert.equal(consumedTraceId, getTraceIdFromTraceparent(injectedTraceparent));

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook clears all propagated trace headers safely", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			traceContextHeaderAliases: "x-traceparent",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			headers: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
				tracestate: "vendor=value",
				baggage: "k=v",
				"x-traceparent": "00-25800e6074324d4bed01afc3eae6886f-4060804c162f7495-01",
				"x-b3-traceid": "80f198ee56343ba864fe8b2a57d3eff7",
				"x-b3-spanid": "e457b5a2e4d86bd1",
				"x-b3-sampled": "1",
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.traceparent, undefined);
	assert.equal(sendEvent.msg.headers.tracestate, undefined);
	assert.equal(sendEvent.msg.headers.baggage, undefined);
	assert.equal(sendEvent.msg.headers["x-traceparent"], undefined);
	assert.equal(sendEvent.msg.headers["x-b3-traceid"], undefined);
	assert.equal(sendEvent.msg.headers["x-b3-spanid"], undefined);
	assert.equal(sendEvent.msg.headers["x-b3-sampled"], undefined);

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook preserves Node-RED response header ignore marker after cleaning http request headers", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "http request" } },
		msg: {
			headers: addNodeRedHttpRequestHeaderHash({
				"content-length": "0",
				traceparent:
					"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
			}),
		},
	};
	preDeliverListener(sendEvent);

	assert.equal(sendEvent.msg.headers.traceparent, undefined);
	const expectedHashInput = { ...sendEvent.msg.headers };
	delete expectedHashInput["x-node-red-request-node"];
	assert.equal(
		sendEvent.msg.headers["x-node-red-request-node"],
		hashSum(expectedHashInput),
	);

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook clears propagated fields from AMQP properties.headers", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			traceContextHeaderAliases: "x-traceparent",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			properties: {
				headers: {
					traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
					tracestate: "vendor=value",
					baggage: "k=v",
					"x-traceparent": "00-25800e6074324d4bed01afc3eae6886f-4060804c162f7495-01",
					"x-b3-traceid": "80f198ee56343ba864fe8b2a57d3eff7",
					"x-b3-spanid": "e457b5a2e4d86bd1",
					"x-b3-sampled": "1",
					existing: "keep",
				},
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.properties.headers.traceparent, undefined);
	assert.equal(sendEvent.msg.properties.headers.tracestate, undefined);
	assert.equal(sendEvent.msg.properties.headers.baggage, undefined);
	assert.equal(sendEvent.msg.properties.headers["x-traceparent"], undefined);
	assert.equal(sendEvent.msg.properties.headers["x-b3-traceid"], undefined);
	assert.equal(sendEvent.msg.properties.headers["x-b3-spanid"], undefined);
	assert.equal(sendEvent.msg.properties.headers["x-b3-sampled"], undefined);
	assert.equal(sendEvent.msg.properties.headers.existing, "keep");

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook clears propagated fields from MQTT userProperties", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			userProperties: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
				tracestate: "vendor=value",
				baggage: "k=v",
				"x-b3-traceid": "80f198ee56343ba864fe8b2a57d3eff7",
				"x-b3-spanid": "e457b5a2e4d86bd1",
				"x-b3-sampled": "1",
				existing: "keep",
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.userProperties.traceparent, undefined);
	assert.equal(sendEvent.msg.userProperties.tracestate, undefined);
	assert.equal(sendEvent.msg.userProperties.baggage, undefined);
	assert.equal(sendEvent.msg.userProperties["x-b3-traceid"], undefined);
	assert.equal(sendEvent.msg.userProperties["x-b3-spanid"], undefined);
	assert.equal(sendEvent.msg.userProperties["x-b3-sampled"], undefined);
	assert.equal(sendEvent.msg.userProperties.existing, "keep");

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook clears propagation fields case-insensitively", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			headers: {
				Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
				Tracestate: "vendor=value",
				Baggage: "k=v",
				B3: "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1",
				"X-B3-TraceId": "80f198ee56343ba864fe8b2a57d3eff7",
				existing: "keep",
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.Traceparent, undefined);
	assert.equal(sendEvent.msg.headers.Tracestate, undefined);
	assert.equal(sendEvent.msg.headers.Baggage, undefined);
	assert.equal(sendEvent.msg.headers.B3, undefined);
	assert.equal(sendEvent.msg.headers["X-B3-TraceId"], undefined);
	assert.equal(sendEvent.msg.headers.existing, "keep");

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook skips frozen carriers without throwing", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const frozenHeaders = Object.freeze({
		traceparent:
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
		existing: "keep",
	});
	const sendEvent = {
		source: { node: { type: "function" } },
		msg: { headers: frozenHeaders },
	};
	assert.doesNotThrow(() => preDeliverListener(sendEvent));
	assert.equal(sendEvent.msg.headers, frozenHeaders);
	assert.equal(sendEvent.msg.headers.traceparent, frozenHeaders.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel does not inject when destination node type is not allowed", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "mqtt out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const staleTraceparent =
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00";
	const sendEvent = {
		msg: {
			_msgid: "not-allowed-destination",
			headers: {
				traceparent: staleTraceparent,
				existing: "keep",
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.traceparent, staleTraceparent);
	assert.equal(sendEvent.msg.headers.existing, "keep");

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook removes duplicate propagation keys with mixed casing", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			headers: {
				traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
				Traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
				b3: "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1",
				B3: "80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-0",
				existing: "keep",
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.traceparent, undefined);
	assert.equal(sendEvent.msg.headers.Traceparent, undefined);
	assert.equal(sendEvent.msg.headers.b3, undefined);
	assert.equal(sendEvent.msg.headers.B3, undefined);
	assert.equal(sendEvent.msg.headers.existing, "keep");

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook preserves non-string userProperties values while injecting trace context", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "mqtt out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const sendEvent = {
		msg: {
			_msgid: "mqtt-preserve-types",
			userProperties: {
				counter: 42,
				flag: true,
				payloadSize: 1024,
			},
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "mqtt out", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.userProperties.counter, 42);
	assert.equal(sendEvent.msg.userProperties.flag, true);
	assert.equal(sendEvent.msg.userProperties.payloadSize, 1024);
	assert.ok(sendEvent.msg.userProperties.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook handles Object.create(null) headers carrier", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const headers = Object.create(null);
	headers.existing = "keep";
	const sendEvent = {
		msg: {
			_msgid: "null-proto-headers",
			headers,
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.existing, "keep");
	assert.ok(sendEvent.msg.headers.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook skips frozen carriers and injects into extensible fallback", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const frozenHeaders = Object.freeze({ existing: "keep" });
	const sendEvent = {
		msg: {
			_msgid: "frozen-postdeliver-msg",
			headers: frozenHeaders,
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	assert.doesNotThrow(() => postDeliverListener(sendEvent));
	assert.notEqual(sendEvent.msg.headers, frozenHeaders);
	assert.ok(sendEvent.msg.headers.traceparent);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook skips non-extensible userProperties carrier", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "mqtt out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const fixedUserProperties = Object.preventExtensions({ existing: "keep" });
	const sendEvent = {
		msg: {
			_msgid: "nonextensible-userprops-msg",
			userProperties: fixedUserProperties,
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "mqtt out", z: "flow" } },
	};
	assert.doesNotThrow(() => postDeliverListener(sendEvent));
	assert.ok(sendEvent.msg.headers);
	assert.ok(sendEvent.msg.headers.traceparent);
	assert.equal(sendEvent.msg.userProperties, fixedUserProperties);

	await runtimePlugin.onClose();
});

test("postDeliver.otel hook skips frozen AMQP headers carrier", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "amqp out",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const frozenAmqpHeaders = Object.freeze({ existing: "keep" });
	const sendEvent = {
		msg: {
			_msgid: "frozen-amqp-headers-msg",
			properties: { headers: frozenAmqpHeaders },
		},
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "amqp out", z: "flow" } },
	};
	assert.doesNotThrow(() => postDeliverListener(sendEvent));
	assert.ok(sendEvent.msg.headers);
	assert.ok(sendEvent.msg.headers.traceparent);
	assert.equal(sendEvent.msg.properties.headers, frozenAmqpHeaders);

	await runtimePlugin.onClose();
});

test("postDeliver.otel allow-list is enforced per destination in fan-out", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const msg = { _msgid: "fanout-msg", headers: {} };
	postDeliverListener({
		msg,
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "http-node", type: "http request", z: "flow" } },
	});
	const httpTraceparent = msg.headers.traceparent;
	assert.ok(httpTraceparent);

	msg.headers.traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00";
	postDeliverListener({
		msg,
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "mqtt-node", type: "mqtt out", z: "flow" } },
	});
	assert.equal(
		msg.headers.traceparent,
		"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
	);

	await runtimePlugin.onClose();
});

test("onReceive.otel hook sets otelRootMsgId for split nodes", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "",
		},
	});

	const onReceiveListener = mockRed.hooks.listeners["onReceive.otel"];
	assert.ok(onReceiveListener);

	const splitEvent = {
		msg: { _msgid: "original-msg-id" },
		destination: { node: { id: "split-node", type: "split" } },
	};
	onReceiveListener(splitEvent);
	assert.equal(splitEvent.msg.otelRootMsgId, "original-msg-id");

	const otherEvent = {
		msg: { _msgid: "other-msg-id" },
		destination: { node: { id: "other-node", type: "function" } },
	};
	onReceiveListener(otherEvent);
	assert.equal(otherEvent.msg.otelRootMsgId, undefined);

	await runtimePlugin.onClose();
});

test("runtime plugin onSettings does not create providers when all signals are disabled", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
});

test("runtime plugin onSettings creates only configured signal providers", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: true,
			logsEnabled: true,
		},
	});
	const sharedState = getSharedState();
	assert.equal(sharedState.provider, null);
	assert.ok(sharedState.meterProvider);
	assert.ok(sharedState.loggerProvider);
	await runtimePlugin.onClose();
});

test("runtime plugin registers and removes Node-RED runtime log handler with logs signal", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "error",
		},
	});
	assert.equal(nodeRedUtilStub.log.handlerCount(), 1);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: false,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "error",
		},
	});
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
	await runtimePlugin.onClose();
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
});

test("runtime plugin forwards Node-RED runtime logs to OTel logger", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "error",
		},
	});
	const logger = getSharedState().logger;
	assert.ok(logger);
	const emitSpy = test.mock.method(logger, "emit");
	nodeRedUtilStub.log.emit({
		level: nodeRedUtilStub.log.ERROR,
		msg: "Started flows",
		type: "runtime",
		id: "runtime-id",
		name: "runtime-name",
	});
	assert.equal(emitSpy.mock.calls.length, 1);
	assert.equal(emitSpy.mock.calls[0].arguments[0].body, "Started flows");
	assert.equal(emitSpy.mock.calls[0].arguments[0].severityText, "ERROR");
	assert.equal(
		emitSpy.mock.calls[0].arguments[0].attributes["node_red.log.type"],
		"runtime",
	);
	await runtimePlugin.onClose();
});

test("runtime plugin should filter Trace logs when logLevel is warn", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "warn",
		},
	});
	const logger = getSharedState().logger;
	assert.ok(logger);
	const emitSpy = test.mock.method(logger, "emit");

	// Emit a TRACE log (should be filtered)
	nodeRedUtilStub.log.emit({
		level: nodeRedUtilStub.log.TRACE,
		msg: "This is a trace log",
		type: "runtime",
	});

	assert.equal(emitSpy.mock.calls.length, 0);

	// Emit an ERROR log (should NOT be filtered)
	nodeRedUtilStub.log.emit({
		level: nodeRedUtilStub.log.ERROR,
		msg: "This is an error log",
		type: "runtime",
	});

	assert.equal(emitSpy.mock.calls.length, 1);
	assert.equal(emitSpy.mock.calls[0].arguments[0].severityText, "ERROR");

	await runtimePlugin.onClose();
});

test("runtime plugin maps numeric Node-RED levels to OTel severity", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "error",
		},
	});
	const logger = getSharedState().logger;
	assert.ok(logger);
	const emitSpy = test.mock.method(logger, "emit");
	nodeRedUtilStub.log.emit({
		level: nodeRedUtilStub.log.ERROR,
		msg: "numeric level",
		type: "runtime",
	});
	assert.equal(emitSpy.mock.calls.length, 1);
	assert.equal(emitSpy.mock.calls[0].arguments[0].severityText, "ERROR");
	await runtimePlugin.onClose();
});

test("runtime plugin should exhaustively filter logs based on logLevel", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;

	const levels = [
		{ name: "FATAL", nr: nodeRedUtilStub.log.FATAL },
		{ name: "ERROR", nr: nodeRedUtilStub.log.ERROR },
		{ name: "WARN", nr: nodeRedUtilStub.log.WARN },
		{ name: "INFO", nr: nodeRedUtilStub.log.INFO },
		{ name: "DEBUG", nr: nodeRedUtilStub.log.DEBUG },
		{ name: "TRACE", nr: nodeRedUtilStub.log.TRACE },
	];

	const testMatrix = [
		{
			configLevel: "off",
			expected: {
				FATAL: false,
				ERROR: false,
				WARN: false,
				INFO: false,
				DEBUG: false,
				TRACE: false,
			},
		},
		{
			configLevel: "error",
			expected: {
				FATAL: true,
				ERROR: true,
				WARN: false,
				INFO: false,
				DEBUG: false,
				TRACE: false,
			},
		},
		{
			configLevel: "warn",
			expected: {
				FATAL: true,
				ERROR: true,
				WARN: true,
				INFO: false,
				DEBUG: false,
				TRACE: false,
			},
		},
		{
			configLevel: "info",
			expected: {
				FATAL: true,
				ERROR: true,
				WARN: true,
				INFO: true,
				DEBUG: false,
				TRACE: false,
			},
		},
		{
			configLevel: "debug",
			expected: {
				FATAL: true,
				ERROR: true,
				WARN: true,
				INFO: true,
				DEBUG: true,
				TRACE: false,
			},
		},
		{
			configLevel: "trace",
			expected: {
				FATAL: true,
				ERROR: true,
				WARN: true,
				INFO: true,
				DEBUG: true,
				TRACE: true,
			},
		},
	];

	for (const { configLevel, expected } of testMatrix) {
		await runtimePlugin.onSettings({
			opentelemetry: {
				logsEnabled: true,
				logsUrl: "http://localhost:4318/v1/logs",
				logLevel: configLevel,
			},
		});
		// Re-mock logger because onSettings might have replaced it
		sharedState.logger = logger;

		for (const level of levels) {
			emitSpy.mock.resetCalls();
			nodeRedUtilStub.log.emit({
				level: level.nr,
				msg: `Test ${level.name} at ${configLevel}`,
				type: "runtime",
			});

			const shouldBeEmitted = (expected as any)[level.name];
			assert.equal(
				emitSpy.mock.calls.length,
				shouldBeEmitted ? 1 : 0,
				`Level ${level.name} should ${shouldBeEmitted ? "" : "NOT "}be emitted when logLevel is ${configLevel}`,
			);
		}
	}

	await runtimePlugin.onClose();
});

test("runtime plugin shutdown should not disable global OpenTelemetry APIs", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
		},
	});
	const traceDisableSpy = test.mock.method(otelApi.trace, "disable");
	const metricsDisableSpy = test.mock.method(otelApi.metrics, "disable");
	const logsDisableSpy = test.mock.method(otelLogsApi.logs, "disable");
	await runtimePlugin.onClose();
	assert.equal(traceDisableSpy.mock.calls.length, 0);
	assert.equal(metricsDisableSpy.mock.calls.length, 0);
	assert.equal(logsDisableSpy.mock.calls.length, 0);
});

test("module initialization tolerates duplicate runtime plugin registration", () => {
	const registeredPlugins = new Set();
	const mockRed = {
		hooks: { add: () => {}, remove: () => {} },
		plugins: {
			registerPlugin: (id) => {
				if (registeredPlugins.has(id)) {
					throw new Error(`${id} already registered`);
				}
				registeredPlugins.add(id);
			},
		},
	};
	assert.doesNotThrow(() => {
		otelModule(mockRed);
		otelModule(mockRed);
	});
	assert.equal(registeredPlugins.has("opentelemetry-runtime"), true);
});

test("module initialization tolerates plugin-only Node-RED context", async () => {
	let runtimePlugin: any;
	const mockRed = {
		settings: {},
		plugins: {
			registerPlugin: (_id, plugin) => {
				runtimePlugin = {
					onSettings: async (settings) => {
						mockRed.settings.opentelemetry =
							(settings && settings.opentelemetry) || settings || {};
						return plugin.onadd?.();
					},
					onClose: async () => plugin.onremove?.(),
				};
			},
		},
	};
	assert.doesNotThrow(() => {
		otelModule(mockRed);
	});
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
		},
	});
	assert.equal(getSharedState().hooksRegistered, false);
	await runtimePlugin.onClose();
});

test("module initialization logs warning when runtime plugin API is unavailable", () => {
	const warnSpy = test.mock.method(nodeRedUtilStub.log, "log");
	otelModule({
		settings: {},
		nodes: mockRed.nodes,
		hooks: {},
	});
	assert.ok(
		warnSpy.mock.calls.some(
			(call) =>
				call.arguments[0]?.level === nodeRedUtilStub.log.WARN &&
				String(call.arguments[0]?.msg).includes(
					"runtime plugin API is unavailable",
				),
		),
	);
});

test("runtime plugin onadd catches initialization errors", async () => {
	const registeredPlugins = new Map();
	const brokenRed = {
		settings: {
			opentelemetry: {
				url: "http://localhost:4318/v1/traces",
			},
		},
		nodes: mockRed.nodes,
		hooks: {
			add: () => {
				throw new Error("hook add failed");
			},
			remove: () => {},
		},
		plugins: {
			registerPlugin: (id, plugin) => {
				registeredPlugins.set(id, plugin);
			},
		},
	};
	const errorSpy = test.mock.method(nodeRedUtilStub.log, "log");

	otelModule(brokenRed);
	const plugin = registeredPlugins.get("opentelemetry-runtime");
	assert.ok(plugin);
	await plugin.onadd();

	assert.ok(
		errorSpy.mock.calls.some(
			(call) =>
				call.arguments[0]?.level === nodeRedUtilStub.log.ERROR &&
				String(call.arguments[0]?.msg).includes(
					"runtime plugin settings failed",
				),
		),
	);
});

test("runtime plugin onremove catches shutdown errors", async () => {
	const registeredPlugins = new Map();
	const brokenRed = {
		settings: {
			opentelemetry: {
				url: "http://localhost:4318/v1/traces",
			},
		},
		nodes: mockRed.nodes,
		hooks: {
			add: () => {},
			remove: () => {
				throw new Error("hook remove failed");
			},
		},
		plugins: {
			registerPlugin: (id, plugin) => {
				registeredPlugins.set(id, plugin);
			},
		},
	};
	const errorSpy = test.mock.method(nodeRedUtilStub.log, "log");

	otelModule(brokenRed);
	const plugin = registeredPlugins.get("opentelemetry-runtime");
	assert.ok(plugin);
	await plugin.onadd();
	await plugin.onremove();

	assert.ok(
		errorSpy.mock.calls.some(
			(call) =>
				call.arguments[0]?.level === nodeRedUtilStub.log.ERROR &&
				String(call.arguments[0]?.msg).includes(
					"runtime plugin shutdown failed",
				),
		),
	);
});

test("resetState shuts down existing providers and clears interval", () => {
	const sharedState = getSharedState();
	let tracerShutdownCalled = 0;
	let meterShutdownCalled = 0;
	let loggerShutdownCalled = 0;
	sharedState.provider = { shutdown: () => tracerShutdownCalled++ };
	sharedState.meterProvider = { shutdown: () => meterShutdownCalled++ };
	sharedState.loggerProvider = { shutdown: () => loggerShutdownCalled++ };
	sharedState.intervalId = setInterval(() => {}, 10);

	resetState();

	assert.equal(tracerShutdownCalled, 1);
	assert.equal(meterShutdownCalled, 1);
	assert.equal(loggerShutdownCalled, 1);
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
	assert.equal(sharedState.intervalId, null);
});

test("runtime plugin onSettings updates runtime config", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			logLevel: "warn",
			flowEventLogsEnabled: false,
			timeout: 10,
		},
	});
	assert.equal(getSharedState().logLevel, "warn");
	assert.equal(getSharedState().flowEventLogsEnabled, false);
	assert.equal(getSharedState().timeout, 10000);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			logLevel: "debug",
			flowEventLogsEnabled: true,
			timeout: 3,
		},
	});
	assert.equal(getSharedState().logLevel, "debug");
	assert.equal(getSharedState().flowEventLogsEnabled, true);
	assert.equal(getSharedState().timeout, 3000);
	await runtimePlugin.onClose();
});

test("runtime plugin onSettings reconfigures active providers", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	assert.ok(getSharedState().provider);
	assert.equal(getSharedState().meterProvider, null);
	assert.equal(getSharedState().loggerProvider, null);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: true,
			logsEnabled: true,
		},
	});
	assert.equal(getSharedState().provider, null);
	assert.ok(getSharedState().meterProvider);
	assert.ok(getSharedState().loggerProvider);
	await runtimePlugin.onClose();
});

test("runtime plugin onSettings awaits provider shutdown before reconfigure", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.ok(sharedState.provider);
	const oldProvider = sharedState.provider;
	let resolveShutdown: any;
	let shutdownCompleted = false;
	oldProvider.shutdown = () =>
		new Promise((resolve) => {
			resolveShutdown = () => {
				shutdownCompleted = true;
				resolve();
			};
		});
	const reconfigurePromise = runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	await Promise.resolve();
	assert.equal(shutdownCompleted, false);
	resolveShutdown();
	await reconfigurePromise;
	assert.equal(shutdownCompleted, true);
	assert.notEqual(getSharedState().provider, oldProvider);
	await runtimePlugin.onClose();
});

test("onSend.otel hook creates spans for every event in batch", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});
	const onSendListener = mockRed.hooks.listeners["onSend.otel"];
	assert.ok(onSendListener);
	onSendListener([
		{
			msg: { _msgid: "a" },
			source: { node: { id: "node-a", type: "function", z: "flow-a" } },
		},
		{
			msg: { _msgid: "b" },
			source: { node: { id: "node-b", type: "function", z: "flow-b" } },
		},
	]);
	assert.equal(getMsgSpans().size, 2);
	await runtimePlugin.onClose();
});

test("onSend.otel hook ignores node types using normalized matching", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: " Inject , debug ",
			propagateHeaderNodeTypes: "",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});
	const onSendListener = mockRed.hooks.listeners["onSend.otel"];
	assert.ok(onSendListener);
	onSendListener([
		{
			msg: { _msgid: "inject-msg" },
			source: { node: { id: "inject-node", type: "inject", z: "flow-a" } },
		},
		{
			msg: { _msgid: "function-msg" },
			source: { node: { id: "fn-node", type: "function", z: "flow-b" } },
		},
	]);
	assert.equal(getMsgSpans().size, 1);
	assert.ok(getMsgSpans().has("function-msg"));
	assert.equal(getMsgSpans().has("inject-msg"), false);
	await runtimePlugin.onClose();
});

test("onSend.otel hook traces only included node types when include list is set", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			excludedNodeTypes: "",
			includedNodeTypes: " Function , HTTP request ",
			propagateHeaderNodeTypes: "",
			logLevel: "error",
			timeout: 10,
			attributeMappings: [],
		},
	});
	const onSendListener = mockRed.hooks.listeners["onSend.otel"];
	assert.ok(onSendListener);
	onSendListener([
		{
			msg: { _msgid: "function-msg" },
			source: { node: { id: "fn-node", type: "function", z: "flow-a" } },
		},
		{
			msg: { _msgid: "inject-msg" },
			source: { node: { id: "inject-node", type: "inject", z: "flow-b" } },
		},
	]);
	assert.equal(getMsgSpans().size, 1);
	assert.ok(getMsgSpans().has("function-msg"));
	assert.equal(getMsgSpans().has("inject-msg"), false);
	await runtimePlugin.onClose();
});

test("runtime plugin onClose waits for provider shutdown before resolving", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.ok(sharedState.provider);
	let resolveShutdown: any;
	sharedState.provider.shutdown = () =>
		new Promise((resolve) => {
			resolveShutdown = resolve;
		});
	let closeResolved = false;
	const closePromise = runtimePlugin.onClose().then(() => {
		closeResolved = true;
	});
	await Promise.resolve();
	assert.equal(closeResolved, false);
	resolveShutdown();
	await closePromise;
	assert.equal(closeResolved, true);
});

test("endSpan should handle orphan spans from switch nodes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const switchNode = {
		id: "switch-node",
		type: "switch",
		name: "Switch",
		z: "flow",
	};
	const functionNode = {
		id: "function-node",
		type: "function",
		name: "Function",
		z: "flow",
	};

	// Create a parent span and a switch span
	createSpan(mockRed, tracer, msg, switchNode, {}, false);
	const parent = getMsgSpans().get("1");
	assert.ok(parent);

	// Create a function span that will be ended
	const functionSpan = createSpan(
		mockRed,
		tracer,
		msg,
		functionNode,
		{},
		false,
	);
	assert.ok(functionSpan);

	// End the function span. This should trigger the orphan logic for the switch span.
	endSpan(mockRed, msg, null, functionNode);

	// The parent span should be ended because the only remaining child is an orphan
	assert.equal(getMsgSpans().size, 0);
});

test("endSpan orphan cleanup should continue when parent end throws", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "orphan-parent-end-throws" };
	const switchNode = {
		id: "switch-node-throws",
		type: "switch",
		name: "Switch",
		z: "flow",
	};
	const functionNode = {
		id: "function-node-throws",
		type: "function",
		name: "Function",
		z: "flow",
	};

	createSpan(mockRed, tracer, msg, switchNode, {}, false);
	createSpan(mockRed, tracer, msg, functionNode, {}, false);
	const parent = getMsgSpans().get("orphan-parent-end-throws");
	assert.ok(parent);
	parent.parentSpan.end = () => {
		throw new Error("parent end failed in orphan cleanup");
	};

	endSpan(mockRed, msg, null, functionNode);

	assert.equal(getMsgSpans().has("orphan-parent-end-throws"), false);
});

test("endSpan keeps parent active when remaining child span is non-orphan", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "active-child-msg" };
	const functionNodeA = {
		id: "function-node-a",
		type: "function",
		name: "Function A",
		z: "flow",
	};
	const functionNodeB = {
		id: "function-node-b",
		type: "function",
		name: "Function B",
		z: "flow",
	};

	createSpan(mockRed, tracer, msg, functionNodeA, {}, false);
	createSpan(mockRed, tracer, msg, functionNodeB, {}, false);
	endSpan(mockRed, msg, null, functionNodeA);

	const parent = getMsgSpans().get("active-child-msg");
	assert.ok(parent);
	assert.equal(parent.spans.has("active-child-msg#function-node-b"), true);
});

test("endSpan should not fail when remaining child span has missing attributes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "missing-attrs-msg" };
	const functionNodeA = {
		id: "function-node-a",
		type: "function",
		name: "Function A",
		z: "flow",
	};
	const functionNodeB = {
		id: "function-node-b",
		type: "function",
		name: "Function B",
		z: "flow",
	};
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	getSharedState().nodeRedLogApi = nodeRedUtilStub.log;

	createSpan(mockRed, tracer, msg, functionNodeA, {}, false);
	createSpan(mockRed, tracer, msg, functionNodeB, {}, false);

	const parentBeforeEnd = getMsgSpans().get("missing-attrs-msg");
	assert.ok(parentBeforeEnd);
	parentBeforeEnd.spans.set("missing-attrs-msg#function-node-b", {
		name: "broken-child-span",
		ended: false,
		end() {
			this.ended = true;
		},
		setAttributes() {},
		setAttribute() {},
		setStatus() {},
		recordException() {},
		updateName() {},
	});

	endSpan(mockRed, msg, null, functionNodeA);

	const parentAfterEnd = getMsgSpans().get("missing-attrs-msg");
	assert.ok(parentAfterEnd);
	assert.equal(parentAfterEnd.spans.has("missing-attrs-msg#function-node-b"), true);
	assert.equal(
		logSpy.mock.calls.some((call) =>
			String(call.arguments?.[0]?.msg || "").includes(
				"An error occurred during span ending",
			),
		),
		false,
	);
});

test("pluginLog should use Node-RED log API when available", () => {
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;

	setLogLevel("debug");
	
	pluginLog("info", "test info message");
	assert.equal(logSpy.mock.calls.length, 1);
	assert.equal(logSpy.mock.calls[0].arguments[0].msg, "test info message");
	assert.equal(logSpy.mock.calls[0].arguments[0].level, nodeRedUtilStub.log.INFO);

	logSpy.mock.resetCalls();
	pluginLog("error", "test error message", new Error("boom"));
	assert.equal(logSpy.mock.calls.length, 1);
	assert.match(logSpy.mock.calls[0].arguments[0].msg, /test error message Error: boom/);
	assert.equal(logSpy.mock.calls[0].arguments[0].level, nodeRedUtilStub.log.ERROR);
});

test("pluginLog should not apply plugin log-level filtering", () => {
	const logSpy = test.mock.method(nodeRedUtilStub.log, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = nodeRedUtilStub.log;

	setLogLevel("off");
	pluginLog("info", "still forwarded");

	assert.equal(logSpy.mock.calls.length, 1);
	assert.equal(logSpy.mock.calls[0].arguments[0].msg, "still forwarded");
	assert.equal(logSpy.mock.calls[0].arguments[0].level, nodeRedUtilStub.log.INFO);
});

test("pluginLog falls back to console logging when Node-RED log API is unavailable", () => {
	const originalResolver = Module._resolveFilename;
	const errorSpy = test.mock.method(console, "error");
	const warnSpy = test.mock.method(console, "warn");
	const infoSpy = test.mock.method(console, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = null;

	try {
		Module._resolveFilename = function (request, parent, isMain, options) {
			if (request === "@node-red/util") {
				throw new Error("forced missing @node-red/util");
			}
			return originalResolveFilename.call(this, request, parent, isMain, options);
		};
		pluginLog("error", "console error message");
		pluginLog("warn", "console warn message");
		pluginLog("info", "console info message");
		pluginLog("debug", "console debug message");
		pluginLog("trace", "console trace message");
	} finally {
		Module._resolveFilename = originalResolver;
	}

	assert.equal(errorSpy.mock.calls.length, 1);
	assert.equal(errorSpy.mock.calls[0].arguments[0], "console error message");
	assert.equal(warnSpy.mock.calls.length, 1);
	assert.equal(warnSpy.mock.calls[0].arguments[0], "console warn message");
	assert.equal(infoSpy.mock.calls.length, 3);
	assert.equal(infoSpy.mock.calls[0].arguments[0], "console info message");
	assert.equal(infoSpy.mock.calls[1].arguments[0], "console debug message");
	assert.equal(infoSpy.mock.calls[2].arguments[0], "console trace message");
});

test("pluginLog console fallback includes error objects when provided", () => {
	const originalResolver = Module._resolveFilename;
	const boom = new Error("boom");
	const errorSpy = test.mock.method(console, "error");
	const warnSpy = test.mock.method(console, "warn");
	const logSpy = test.mock.method(console, "log");
	const sharedState = getSharedState();
	sharedState.nodeRedLogApi = null;

	try {
		Module._resolveFilename = function (request, parent, isMain, options) {
			if (request === "@node-red/util") {
				throw new Error("forced missing @node-red/util");
			}
			return originalResolveFilename.call(this, request, parent, isMain, options);
		};
		pluginLog("error", "error with object", boom);
		pluginLog("warn", "warn with object", boom);
		pluginLog("info", "info with object", boom);
	} finally {
		Module._resolveFilename = originalResolver;
	}

	assert.equal(errorSpy.mock.calls.length, 1);
	assert.equal(errorSpy.mock.calls[0].arguments[0], "error with object");
	assert.equal(errorSpy.mock.calls[0].arguments[1], boom);
	assert.equal(warnSpy.mock.calls.length, 1);
	assert.equal(warnSpy.mock.calls[0].arguments[0], "warn with object");
	assert.equal(warnSpy.mock.calls[0].arguments[1], boom);
	assert.equal(logSpy.mock.calls.length, 1);
	assert.equal(logSpy.mock.calls[0].arguments[0], "info with object");
	assert.equal(logSpy.mock.calls[0].arguments[1], boom);
});

test("resolveOpenTelemetryConfig accepts additional protocol aliases", () => {
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "json";
	const jsonResolved = resolveOpenTelemetryConfig({}, {});
	assert.equal(jsonResolved.protocol, "http");
	assert.equal(jsonResolved.tracesProtocol, "http");
	assert.equal(jsonResolved.metricsProtocol, "http");
	assert.equal(jsonResolved.logsProtocol, "http");

	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "protobuf";
	const protoResolved = resolveOpenTelemetryConfig({}, {});
	assert.equal(protoResolved.protocol, "proto");
	assert.equal(protoResolved.tracesProtocol, "proto");
	assert.equal(protoResolved.metricsProtocol, "proto");
	assert.equal(protoResolved.logsProtocol, "proto");
});

test("resolveOpenTelemetryConfig ignores unsupported protocols", () => {
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "invalid-protocol";
	const resolved = resolveOpenTelemetryConfig({}, {});
	assert.equal(resolved.protocol, "http");
	assert.equal(resolved.tracesProtocol, "http");
	assert.equal(resolved.metricsProtocol, "http");
	assert.equal(resolved.logsProtocol, "http");
});

test("ensureSignalPath handles parse failures and append modes", () => {
	assert.equal(ensureSignalPath(undefined, "/v1/traces"), undefined);
	assert.equal(
		ensureSignalPath("://bad-url", "/v1/traces"),
		"://bad-url",
	);
	assert.equal(
		ensureSignalPath("http://localhost", "/v1/traces"),
		"http://localhost/v1/traces",
	);
	assert.equal(
		ensureSignalPath("http://localhost/api", "/v1/traces", true),
		"http://localhost/api/v1/traces",
	);
	assert.equal(
		ensureSignalPath("http://localhost/v1/traces", "/v1/traces", true),
		"http://localhost/v1/traces",
	);
});

test("ensureSignalPathFromGenericEndpoint remaps, appends, and handles invalid URLs", () => {
	assert.equal(
		ensureSignalPathFromGenericEndpoint("://bad-url", "/v1/metrics"),
		"://bad-url",
	);
	assert.equal(
		ensureSignalPathFromGenericEndpoint("http://localhost", "/v1/metrics"),
		"http://localhost/v1/metrics",
	);
	assert.equal(
		ensureSignalPathFromGenericEndpoint(
			"http://localhost/custom/v1/traces",
			"/v1/logs",
		),
		"http://localhost/custom/v1/logs",
	);
	assert.equal(
		ensureSignalPathFromGenericEndpoint("http://localhost/custom", "/v1/logs"),
		"http://localhost/custom/v1/logs",
	);
	assert.equal(
		ensureSignalPathFromGenericEndpoint("http://localhost/custom/v1/logs", "/v1/logs"),
		"http://localhost/custom/v1/logs",
	);
});

test("normalizeGrpcEndpoint handles defaults, signal paths, and malformed URLs", () => {
	assert.equal(normalizeGrpcEndpoint(undefined), undefined);
	assert.equal(
		normalizeGrpcEndpoint("http://localhost:4318/v1/traces"),
		"http://localhost:4317",
	);
	assert.equal(
		normalizeGrpcEndpoint("http://localhost:4318/v1/metrics"),
		"http://localhost:4317",
	);
	assert.equal(
		normalizeGrpcEndpoint("http://localhost:4318/v1/logs"),
		"http://localhost:4317",
	);
	assert.equal(normalizeGrpcEndpoint("://bad-url"), "://bad-url");
	assert.equal(
		normalizeGrpcEndpoint("http://collector:4318/v1/traces"),
		"http://collector:4318/",
	);
	assert.equal(
		normalizeGrpcEndpoint("http://collector:4318/custom"),
		"http://collector:4318/custom",
	);
});

test("protocol and log-level resolver helpers cover aliases and invalid values", () => {
	assert.equal(resolveProtocol("grpc"), "grpc");
	assert.equal(resolveProtocol("http/protobuf"), "proto");
	assert.equal(resolveProtocol("proto"), "proto");
	assert.equal(resolveProtocol("json"), "http");
	assert.equal(resolveProtocol("http/json"), "http");
	assert.equal(resolveProtocol("invalid"), undefined);

	assert.equal(resolveLogLevel("OFF"), "off");
	assert.equal(resolveLogLevel("trace"), "trace");
	assert.equal(resolveLogLevel("invalid"), undefined);
});

test("resolveNodeRedLogLevel handles object variants and invalid settings", () => {
	assert.equal(resolveNodeRedLogLevel(undefined), undefined);
	assert.equal(resolveNodeRedLogLevel({}), undefined);
	assert.equal(resolveNodeRedLogLevel({ logging: {} }), undefined);
	assert.equal(
		resolveNodeRedLogLevel({
			logging: {
				console: { level: "fatal" },
			},
		}),
		"error",
	);
	assert.equal(
		resolveNodeRedLogLevel({
			logging: {
				customTarget: { level: "debug" },
			},
		}),
		"debug",
	);
	assert.equal(
		resolveNodeRedLogLevel({
			logging: {
				console: { level: "invalid" },
				level: "warn",
			},
		}),
		"warn",
	);
});

test("exporter env resolver handles defaults and precedence", () => {
	assert.deepEqual(parseExporterEnv(undefined), []);
	assert.deepEqual(parseExporterEnv(" OTLP , none "), ["otlp", "none"]);
	assert.equal(resolveSignalEnabledFromEnv(undefined), undefined);
	assert.equal(resolveSignalEnabledFromEnv(""), undefined);
	assert.equal(resolveSignalEnabledFromEnv("otlp"), true);
	assert.equal(resolveSignalEnabledFromEnv("none"), false);
	assert.equal(resolveSignalEnabledFromEnv("none,otlp"), false);
	assert.equal(resolveSignalEnabledFromEnv("zipkin"), false);
});

test("resolveNodeRedSeverity maps numeric and textual levels", () => {
	const logApi = nodeRedUtilStub.log;
	assert.equal(resolveNodeRedSeverity(logApi.FATAL, logApi).severityText, "FATAL");
	assert.equal(resolveNodeRedSeverity(logApi.ERROR, logApi).severityText, "ERROR");
	assert.equal(resolveNodeRedSeverity(logApi.WARN, logApi).severityText, "WARN");
	assert.equal(resolveNodeRedSeverity(logApi.DEBUG, logApi).severityText, "DEBUG");
	assert.equal(resolveNodeRedSeverity(logApi.TRACE, logApi).severityText, "TRACE");
	assert.equal(resolveNodeRedSeverity("warning", null).severityText, "WARN");
	assert.equal(resolveNodeRedSeverity("audit", null).severityText, "INFO");
	assert.equal(resolveNodeRedSeverity("metric", null).severityText, "INFO");
	assert.equal(resolveNodeRedSeverity("info", null).severityText, "INFO");
	assert.equal(resolveNodeRedSeverity("unknown", null).severityText, "INFO");
});

test("node type normalization and skip filtering behave correctly", () => {
	assert.equal(normalizeNodeType(" Function "), "function");
	assert.equal(normalizeNodeType(undefined), "");
	const sharedState = getSharedState();
	sharedState.excludedNodeTypesList = ["debug"];
	sharedState.includedNodeTypesList = [];
	assert.equal(shouldSkipNodeType("debug"), true);
	assert.equal(shouldSkipNodeType("function"), false);
	sharedState.includedNodeTypesList = ["function"];
	assert.equal(shouldSkipNodeType("function"), false);
	assert.equal(shouldSkipNodeType("inject"), true);
});

test("parseNodeUrl supports absolute, relative, and invalid URLs", () => {
	const absolute = parseNodeUrl("http://example.com/path");
	assert.ok(absolute);
	assert.equal(absolute.isAbsolute, true);
	assert.equal(absolute.url.pathname, "/path");

	const relative = parseNodeUrl("/relative/path");
	assert.ok(relative);
	assert.equal(relative.isAbsolute, false);
	assert.equal(relative.url.pathname, "/relative/path");

	assert.equal(parseNodeUrl("http://[::invalid"), undefined);
});

test("resolveSpanKind covers common transport kinds", () => {
	assert.equal(resolveSpanKind("http in"), otelApi.SpanKind.SERVER);
	assert.equal(resolveSpanKind("http request"), otelApi.SpanKind.CLIENT);
	assert.equal(resolveSpanKind("mqtt in"), otelApi.SpanKind.CONSUMER);
	assert.equal(resolveSpanKind("mqtt out"), otelApi.SpanKind.PRODUCER);
	assert.equal(resolveSpanKind("function"), otelApi.SpanKind.INTERNAL);
});

test("HTTP helper predicates and auto attributes handle mixed message shapes", () => {
	const msg = {
		req: {
			ip: "127.0.0.1",
			method: "GET",
			path: "/orders",
			headers: { "user-agent": "curl/8" },
		},
		res: { _res: { statusCode: 200, finished: true } },
	};
	const node = { id: "n1", type: "custom responder", z: "flow", method: "GET", url: "/orders" };
	assert.equal(hasHttpServerContext(msg, node), true);
	assert.equal(hasHttpResponseContext(msg), true);
	assert.equal(shouldHandleTerminalHttpResponse(msg, { id: "n2", type: "http response", z: "flow" }), true);
	assert.equal(shouldHandleTerminalHttpResponse(msg, node), true);
	assert.equal(shouldHandleTerminalHttpResponse({ req: {}, res: { _res: { finished: false } } }, node), false);

	const attrs = buildAutoSpanAttributes(msg, {
		id: "http-req-node",
		type: "http request",
		z: "flow",
		url: "http://api.example.com:8080/v1/items",
	});
	assert.equal(attrs["http.request.method"], "GET");
	assert.equal(attrs["url.path"], "/v1/items");
	assert.equal(attrs["server.address"], "api.example.com");
	assert.equal(attrs["server.port"], "8080");
});

test("isSubflowNodeType identifies subflow prefixed node types", () => {
	assert.equal(isSubflowNodeType("subflow:abc"), true);
	assert.equal(isSubflowNodeType("function"), false);
});

