const assert = require("node:assert/strict");

const { test } = require("node:test");
const { MockserverContainer } = require("@testcontainers/mockserver");

const {
	image,
	runtime,
	receiver,

	poll,
	attributes,
	cleanup,
} = require("./helpers.cjs");
const { httpFlow, outboundFlow, branchingFlow } = require("./flows.cjs");

const traceId = "12345678901234567890123456789012";
const parentId = "1234567890123456";
const headers = {
	traceparent: `00-${traceId}-${parentId}-01`,
	tracestate: "vendor=value",
	baggage: "tenant=integration",
};
const nodeSpans = (collector) =>
	collector
		.spans()
		.filter((span) => attributes(span)["node_red.msg.new"] === false);
const forTrace = (collector, id = traceId) =>
	collector.spans().filter((span) => span.traceId === id);
async function request(url, options) {
	return fetch(url, { signal: AbortSignal.timeout(10000), ...options });
}
async function completedTrace(collector, description) {
	await poll(description, () =>
		forTrace(collector).some(
			(span) => attributes(span)["node_red.msg.new"] === true,
		),
	);
	const spans = forTrace(collector);
	assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length);
	return spans;
}

test("packed plugin in real Node-RED", { timeout: 600000 }, async (suite) => {
	const builtImage = await image(suite);
	await suite.test(
		"HTTP propagation reaches the wire before send; spans, logs and metrics correlate",
		{ timeout: 100000 },
		async (t) => {
			const collector = await receiver(t);
			const endpoint = await new MockserverContainer(
				"mockserver/mockserver:5.15.0",
			)
				.withNetwork(collector.network)
				.withNetworkAliases("downstream")
				.start();
			cleanup(t, () => endpoint.stop());
			async function mockApi(route, body) {
				const response = await request(endpoint.getUrl() + route, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				assert.ok(response.ok, await response.clone().text());
				return response;
			}
			await mockApi("/mockserver/expectation", {
				httpRequest: { path: "/capture" },
				httpResponse: { statusCode: 200, body: "received" },
			});
			const app = await runtime(t, builtImage, collector, outboundFlow());
			assert.equal(
				await (await request(`${app.url}/test`, { headers })).text(),
				"received",
			);
			const capturedRequests = await (
				await mockApi("/mockserver/retrieve?type=REQUESTS", {
					path: "/capture",
				})
			).json();
			assert.equal(capturedRequests.length, 1);
			const captured = Object.fromEntries(
				Object.entries(capturedRequests[0].headers).map(([key, value]) => [
					key.toLowerCase(),
					value[0],
				]),
			);
			assert.match(
				captured.traceparent,
				new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
			);
			assert.equal(captured.tracestate, "vendor=value");
			await t.test(
				"outbound HTTP baggage",
				{ todo: "#112: extracted baggage is not retained during injection" },
				() => {
					assert.equal(captured.baggage, "tenant=integration");
				},
			);
			assert.equal(captured["x-preserved"], "yes");
			const spans = await completedTrace(collector, "completed HTTP trace");
			const root = spans.find(
				(span) => attributes(span)["node_red.msg.new"] === true,
			);
			assert.equal(root.parentSpanId, parentId);
			for (const span of spans.filter((span) => span !== root)) {
				assert.equal(span.parentSpanId, root.spanId);
				assert.equal(span.traceState, "vendor=value");
				assert.ok(
					BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
				);
			}
			const ids = nodeSpans(collector).map(
				(span) => attributes(span)["node_red.node.id"],
			);
			for (const id of ["request", "response", "work"])
				assert.equal(ids.filter((value) => value === id).length, 1);
			await t.test(
				"source node span is exported",
				{ todo: "#115: timeout cleanup discards the unfinished source span" },
				() => {
					assert.deepEqual(ids.sort(), ["in", "request", "response", "work"]);
				},
			);
			const client = spans.find(
				(span) => attributes(span)["node_red.node.id"] === "request",
			);
			assert.equal(captured.traceparent.split("-")[2], client.spanId);
			await poll("correlated flow log", () =>
				collector
					.logs()
					.some(
						(log) =>
							log.traceId === traceId && attributes(log)["node_red.event_type"],
					),
			);
			await poll(
				"HTTP duration export",
				() =>
					collector
						.metrics()
						.some((metric) => metric.name === "http.server.duration"),
				75000,
			);
			const points = collector
				.metrics()
				.filter((metric) => metric.name === "http.server.duration")
				.flatMap((metric) => metric.histogram.dataPoints);
			const point = points.find(
				(entry) => attributes(entry)["url.path"] === "/test",
			);
			assert.ok(point);
			assert.equal(Number(point.count), 1);
			assert.ok(point.sum >= 0);
			assert.equal(attributes(point)["http.request.method"], "GET");
			assert.equal(Number(attributes(point)["http.response.status_code"]), 200);
			assert.deepEqual(collector.errors, []);
		},
	);
	await suite.test(
		"HTTP statuses, node exceptions and runtime warnings/errors",
		async (t) => {
			const collector = await receiver(t);
			const app = await runtime(
				t,
				builtImage,
				collector,
				httpFlow(
					"const status = Number(msg.req.query.status || 200); node.warn('integration warning'); node.error('integration runtime error'); if (status === 599) { throw new Error('integration exception'); } msg.statusCode = status; msg.payload = 'status'; return msg;",
					[
						{
							id: "catch",
							type: "catch",
							x: 100,
							y: 100,
							z: "flow",
							scope: ["work"],
							uncaught: false,
							wires: [["recover"]],
						},
						{
							id: "recover",
							x: 100,
							y: 100,
							type: "function",
							z: "flow",
							func: "msg.statusCode = 500; msg.payload = 'caught'; return msg;",
							outputs: 1,
							wires: [["response"]],
						},
					],
				),
			);
			for (const status of [200, 404, 503, 599]) {
				const id = status.toString().padStart(32, "0");
				assert.equal(
					(
						await request(`${app.url}/test?status=${status}`, {
							headers: { traceparent: `00-${id}-${parentId}-01` },
						})
					).status,
					status === 599 ? 500 : status,
				);
				await poll(`status ${status} trace`, () =>
					forTrace(collector, id).some(
						(span) => attributes(span)["node_red.msg.new"] === true,
					),
				);
				const root = forTrace(collector, id).find(
					(span) => attributes(span)["node_red.msg.new"] === true,
				);
				if (status >= 500) assert.equal(root.status?.code, 2);
				else
					await t.test(
						`HTTP SERVER status ${status}`,
						{
							todo: "#113: successful and ordinary 4xx server spans should remain UNSET",
						},
						() => {
							assert.equal(root.status?.code ?? 0, 0);
						},
					);
				assert.equal(
					Number(attributes(root)["http.response.status_code"]),
					status === 599 ? 500 : status,
				);
			}
			await poll("runtime warning and error logs", () =>
				["integration warning", "integration runtime error"].every((text) =>
					collector.logs().some((log) => log.body?.stringValue?.includes(text)),
				),
			);
		},
	);
	await suite.test(
		"fan-out, split, subflow and asynchronous nodes finish without duplicate spans",
		async (t) => {
			const collector = await receiver(t);
			const app = await runtime(t, builtImage, collector, branchingFlow());
			assert.equal((await request(`${app.url}/test`, { headers })).status, 200);
			const spans = await completedTrace(collector, "branch trace completion");
			for (const id of ["split", "a", "b", "join", "response"]) {
				assert.ok(
					spans.some((span) => attributes(span)["node_red.node.name"] === id),
					`Missing ${id}`,
				);
			}
			const nested = spans.filter((span) =>
				/[.-]nested$/.test(attributes(span)["node_red.node.id"] ?? ""),
			);
			assert.equal(nested.length, 2);
			assert.equal(
				spans.filter((span) => attributes(span)["node_red.node.id"] === "join")
					.length,
				2,
			);
			const spanIds = new Set(spans.map((span) => span.spanId));
			for (const span of spans)
				assert.ok(
					span.parentSpanId === parentId || spanIds.has(span.parentSpanId),
				);
			assert.ok(
				spans.every(
					(span) =>
						BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
				),
			);
		},
	);
	await suite.test(
		"redeploy and restart keep one span per node per request",
		async (t) => {
			const collector = await receiver(t);
			const app = await runtime(t, builtImage, collector, httpFlow());
			for (let iteration = 1; iteration <= 3; iteration++) {
				const id = iteration.toString().padStart(32, "0");
				assert.equal(
					(
						await request(`${app.url}/test`, {
							headers: { traceparent: `00-${id}-${parentId}-01` },
						})
					).status,
					200,
				);
				await poll("one completed request", () =>
					forTrace(collector, id).some(
						(span) => attributes(span)["node_red.msg.new"] === true,
					),
				);
				const spans = forTrace(collector, id);
				assert.equal(
					new Set(spans.map((span) => span.spanId)).size,
					spans.length,
				);
				for (const node of ["work", "response"])
					assert.equal(
						spans.filter(
							(span) => attributes(span)["node_red.node.id"] === node,
						).length,
						1,
					);
				if (iteration === 1) {
					assert.equal(
						(
							await request(`${app.url}/admin/flows`, {
								method: "POST",
								headers: {
									"content-type": "application/json",
									"Node-RED-Deployment-Type": "full",
								},
								body: JSON.stringify(
									httpFlow("msg.payload = 'redeployed'; return msg;"),
								),
							})
						).status,
						204,
					);
				} else if (iteration === 2) {
					await app.restart();
					await poll(
						"runtime ready after restart",
						async () => (await request(`${app.url}/admin/settings`)).ok,
					);
				}
			}
			assert.equal(
				(app.output().match(/runtime hooks registered/g) ?? []).length,
				2,
			);
		},
	);
	await suite.test("graceful shutdown with buffered telemetry", async (t) => {
		const collector = await receiver(t);
		const app = await runtime(
			t,
			builtImage,
			collector,
			httpFlow(),
			{ metricsEnabled: false, logsEnabled: false },
			undefined,
			{ OTEL_BSP_SCHEDULE_DELAY: "60000" },
		);
		assert.equal((await request(`${app.url}/test`, { headers })).status, 200);
		await app.stop();
		assert.ok(app.output().includes("Stopped flows"));
		await t.test(
			"flush pending spans before exit",
			{
				todo: "#111: the Node-RED CLI does not invoke plugin onremove during shutdown",
			},
			async () => {
				await poll(
					"pending spans flushed during shutdown",
					() => collector.spans().length >= 2,
					2000,
				);
			},
		);
	});
	for (const config of [
		{ tracesEnabled: false, metricsEnabled: false, logsEnabled: false },
		{ tracesEnabled: false, metricsEnabled: true, logsEnabled: false },
		{
			tracesEnabled: false,
			metricsEnabled: false,
			logsEnabled: true,
			flowEventLogsEnabled: false,
		},
		{
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
			includedNodeTypes: "http in,http response",
		},
		{
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
			excludedNodeTypes: "function",
		},
	]) {
		await suite.test(
			`signal selection and filtering ${JSON.stringify(config)}`,
			{ timeout: 100000 },
			async (t) => {
				const collector = await receiver(t);
				const app = await runtime(
					t,
					builtImage,
					collector,
					httpFlow(
						"node.warn('selection marker'); msg.payload = msg.req.headers.traceparent; return msg;",
					),
					config,
				);
				const response = await request(`${app.url}/test`, { headers });
				assert.equal(response.status, 200);
				if (!config.tracesEnabled) {
					assert.equal(await response.text(), headers.traceparent);
					if (config.logsEnabled)
						await poll("runtime warning", () =>
							collector
								.logs()
								.some((log) =>
									log.body?.stringValue?.includes("selection marker"),
								),
						);
				} else {
					await poll("filtered trace", () =>
						forTrace(collector).some(
							(span) => attributes(span)["node_red.msg.new"] === true,
						),
					);
					assert.deepEqual(
						nodeSpans(collector)
							.map((span) => attributes(span)["node_red.node.id"])
							.filter((id) => id !== "in")
							.sort(),
						["response"],
					);
				}
				if (config.metricsEnabled) {
					await poll(
						"metrics without tracing",
						() =>
							collector
								.metrics()
								.some((metric) => metric.name === "http.server.duration"),
						75000,
					);
					const points = collector
						.metrics()
						.flatMap((metric) => metric.histogram?.dataPoints ?? []);
					assert.equal(
						Number(
							points.find((point) => attributes(point)["url.path"] === "/test")
								?.count,
						),
						1,
					);
				}
				await app.stop();
				assert.equal(collector.metrics().length > 0, config.metricsEnabled);
				assert.equal(collector.spans().length > 0, config.tracesEnabled);
				if (!config.logsEnabled) assert.equal(collector.logs().length, 0);
				if (config.flowEventLogsEnabled === false)
					assert.ok(
						collector
							.logs()
							.every(
								(log) =>
									attributes(log)["node_red.event_type"] === "runtime.log",
							),
					);
			},
		);
	}
	await suite.test(
		"protobuf HTTP exporter delivers decodable trace data",
		async (t) => {
			const collector = await receiver(t);
			const app = await runtime(t, builtImage, collector, httpFlow(), {
				protocol: "proto",
				metricsEnabled: false,
				logsEnabled: false,
			});
			assert.equal((await request(`${app.url}/test`, { headers })).status, 200);
			await poll("protobuf trace", () => collector.spans().length >= 3);
			const spans = collector.spans();

			assert.ok(spans.every((span) => span.traceId === traceId));
			assert.ok(
				spans.every(
					(span) =>
						BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
				),
			);
			assert.deepEqual(collector.errors, []);
		},
	);
});
