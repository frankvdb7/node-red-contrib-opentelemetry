# Runtime integration tests

Run `npm ci`, start a Docker-compatible Linux container runtime, then run:

```sh
npm run test:integration
```

The suite builds and packs this checkout. Testcontainers builds a Node.js 24
image, installs the tarball and Node-RED, and starts the ordinary Node-RED CLI.
The plugin is discovered through its published `node-red.plugins` registration.
No Node-RED hooks, SDK providers, or exporters are stubbed. No palette or
configuration nodes are added to this package.

Testcontainers starts an isolated network and a real OpenTelemetry Collector
for each scenario. Its file exporter writes received telemetry as OTLP JSON to
container stdout. Tests inspect that data, including data decoded by the
Collector's protobuf HTTP receiver. MockServer captures outbound HTTP requests.
Broker transports are outside this suite's scope.

Containers use dynamic host ports and network aliases. Cleanup runs in reverse
dependency order, including on assertion failure; Testcontainers' resource
reaper also handles unexpected test-process exits. Container output and received
span details are printed when a scenario fails. Polling has bounded timeouts.
Runtime and Collector logs are saved under `.integration-logs/`, or the directory
specified by `INTEGRATION_LOG_DIR`. CI also prints the Node-RED console and
Collector operational output, and uploads the complete logs as artifacts even
when tests fail. Collector artifacts include received telemetry.
The duration-metric checks allow 75 seconds because the plugin's real periodic
metric reader exports every 60 seconds.

Set `NODE_RED_VERSION` to select a Node-RED major. GitHub Actions runs the same
suite for both supported majors, 4 and 5, on Node.js 24. For example:

```sh
NODE_RED_VERSION=4 npm run test:integration
```

```powershell
$env:NODE_RED_VERSION = '4'
npm run test:integration
```

Coverage includes HTTP trace relationships and propagation, HTTP statuses and
exceptions, warnings/errors and correlated flow logs, duration metrics and
deduplication, signal selection, node filters, fan-out/split/subflows/delays,
redeploy/restart, graceful shutdown, and protobuf export.
Plugin settings changes require a restart, as documented in the main README;
there is no live settings-reconfiguration endpoint to exercise.

Some desired behavior is already tracked in separate issues. These assertions
run as Node.js TODO tests, so they remain visible without blocking unrelated
integration checks:
- #111: the ordinary CLI does not remove the plugin or flush buffered spans on
  shutdown.
- #112: outbound HTTP injection loses extracted baggage.
- #113: successful and ordinary 4xx HTTP server spans should leave status unset.
- #115: timeout cleanup drops the unfinished source-node span.

Remove the corresponding TODO marker when its issue is fixed. All other failed
assertions fail the integration job. The fast unit suite remains `npm test` and
does not require Docker.
