const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { GenericContainer, Network, Wait } = require("testcontainers");

const cleanups = new WeakMap();
async function saveLogs(t, component, output) {
	const directory = path.resolve(
		process.env.INTEGRATION_LOG_DIR ?? ".integration-logs",
		process.env.NODE_RED_VERSION ?? "5",
		t.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 120),
	);
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, `${component}.log`), output);
}
function cleanup(t, action) {
	if (!cleanups.has(t)) {
		const stack = [];
		cleanups.set(t, stack);
		t.after(async () => {
			const errors = [];
			for (const dispose of stack.reverse()) {
				try {
					await dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length)
				throw new AggregateError(errors, "Integration cleanup failed");
		});
	}
	cleanups.get(t).push(action);
}

async function poll(description, check, timeout = 20000) {
	const deadline = Date.now() + timeout;
	let lastError;
	do {
		try {
			const result = await check();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await delay(50);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}
async function receiver(t) {
	const records = [],
		errors = [];
	const network = await new Network().start();
	cleanup(t, () => network.stop());
	let pending = "",
		output = "";
	const definition = new GenericContainer(
		"otel/opentelemetry-collector-contrib:0.147.0",
	)
		.withNetwork(network)
		.withNetworkAliases("collector")
		.withUser("0:0")
		.withCopyContentToContainer([
			{
				content: await fs.readFile(
					path.join(__dirname, "collector.yaml"),
					"utf8",
				),
				target: "/etc/integration.yaml",
			},
		])
		.withCommand(["--config=/etc/integration.yaml"])
		.withWaitStrategy(Wait.forLogMessage("Everything is ready"))
		.withStartupTimeout(60000)
		.withLogConsumer((stream) =>
			stream.on("data", (chunk) => {
				output += chunk;
				pending += chunk;
				const lines = pending.split("\n");
				pending = lines.pop();
				for (const line of lines) {
					if (!line.startsWith("{")) {
						if (process.env.CI) process.stdout.write(`[Collector] ${line}\n`);
						continue;
					}
					try {
						const record = JSON.parse(line);
						if (
							record.resourceSpans ||
							record.resourceMetrics ||
							record.resourceLogs
						)
							records.push(record);
						else if (record.level === "error") errors.push(line);
					} catch (error) {
						errors.push(String(error));
					}
				}
			}),
		);
	let container;
	try {
		container = await definition.start();
	} catch (error) {
		await saveLogs(t, "collector", output);
		t.diagnostic(output.slice(-20000));
		throw error;
	}
	cleanup(t, async () => {
		try {
			await container.stop();
		} finally {
			await saveLogs(t, "collector", output);
			if (!t.passed) t.diagnostic(output.slice(-20000));
		}
	});
	return {
		url: "http://collector:4318",
		network,
		errors,
		spans: () =>
			records
				.flatMap((r) => r.resourceSpans ?? [])
				.flatMap((r) => r.scopeSpans ?? [])
				.flatMap((r) => r.spans ?? []),
		logs: () =>
			records
				.flatMap((r) => r.resourceLogs ?? [])
				.flatMap((r) => r.scopeLogs ?? [])
				.flatMap((r) => r.logRecords ?? []),
		metrics: () =>
			records
				.flatMap((r) => r.resourceMetrics ?? [])
				.flatMap((r) => r.scopeMetrics ?? [])
				.flatMap((r) => r.metrics ?? []),
	};
}
async function image(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-otel-integration-"));
	cleanup(t, () => fs.rm(dir, { recursive: true, force: true }));
	// Use npm's CLI script directly so paths with spaces also work on Windows.
	await promisify(execFile)(process.execPath, [
		process.env.npm_execpath,
		"pack",
		"--pack-destination",
		dir,
	]);
	const archive = (await fs.readdir(dir)).find((file) => file.endsWith(".tgz"));
	await fs.rename(path.join(dir, archive), path.join(dir, "plugin.tgz"));
	await fs.copyFile(
		path.join(__dirname, "Dockerfile"),
		path.join(dir, "Dockerfile"),
	);
	const name = `nr-otel-integration:${randomUUID()}`;
	await GenericContainer.fromDockerfile(dir)
		.withBuildArgs({ NODE_RED_VERSION: process.env.NODE_RED_VERSION ?? "5" })
		.build(name);
	return name;
}
async function runtime(
	t,
	builtImage,
	collector,
	flows,
	config = {},
	network,
	environment = {},
) {
	const settings = {
		uiPort: 1880,
		uiHost: "0.0.0.0",
		flowFile: "/data/flows.json",
		httpAdminRoot: "/admin",
		credentialSecret: false,
		editorTheme: { projects: { enabled: false } },
		logging: { console: { level: "info", metrics: false, audit: false } },
		opentelemetry: {
			url: `${collector.url}/v1/traces`,
			metricsUrl: `${collector.url}/v1/metrics`,
			logsUrl: `${collector.url}/v1/logs`,
			protocol: "http",
			tracesEnabled: true,
			metricsEnabled: true,
			logsEnabled: true,
			excludedNodeTypes: "",
			propagateHeaderNodeTypes: "http request",
			serviceName: "integration",
			timeout: 2,
			...config,
		},
	};
	let output = "";
	const consumeLogs = (stream) =>
		stream.on("data", (chunk) => {
			output += chunk;
			if (process.env.CI) process.stdout.write(`[Node-RED] ${chunk}`);
		});
	const definition = new GenericContainer(builtImage)
		.withCopyContentToContainer([
			{
				content: `module.exports = ${JSON.stringify(settings)};`,
				target: "/data/settings.js",
			},
			{ content: JSON.stringify(flows), target: "/data/flows.json" },
		])
		.withExposedPorts(1880)
		.withEnvironment({
			OTEL_BSP_SCHEDULE_DELAY: "100",
			OTEL_BLRP_SCHEDULE_DELAY: "100",
			...environment,
		})
		.withWaitStrategy(Wait.forLogMessage("Started flows"))
		.withStartupTimeout(60000)
		.withLogConsumer(consumeLogs);
	definition.withNetwork(network ?? collector.network);
	let container;
	try {
		container = await definition.start();
	} catch (error) {
		await saveLogs(t, "node-red", output);
		t.diagnostic(output);
		throw error;
	}
	let stopped = false;
	async function stop() {
		if (stopped) return;
		await container.stop({ timeout: 15000 });
		stopped = true;
	}
	cleanup(t, async () => {
		try {
			await stop();
		} finally {
			await saveLogs(t, "node-red", output);
			if (!t.passed)
				t.diagnostic(
					`${output}\nReceiver errors: ${collector.errors.join("\n")}\nSpans: ${JSON.stringify(collector.spans()).slice(-20000)}`,
				);
		}
	});
	return {
		container,
		async restart() {
			await container.restart({ timeout: 15000 });
			output = "";
			consumeLogs(await container.logs({ tail: 1000 }));
		},
		get url() {
			return `http://${container.getHost()}:${container.getMappedPort(1880)}`;
		},
		stop,
		output: () => output,
	};
}
function attributes(item) {
	return Object.fromEntries(
		(item.attributes ?? []).map(({ key, value }) => [
			key,
			Object.values(value)[0],
		]),
	);
}
module.exports = {
	image,
	runtime,
	receiver,
	poll,
	attributes,
	cleanup,
};
