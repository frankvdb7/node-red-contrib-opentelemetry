const test = require('node:test')
const assert = require('node:assert/strict')
const otelModule = require('../lib/opentelemetry-node')

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
  setLogging,
} = otelModule.__test__

test.beforeEach(() => {
  resetState()
})

test.afterEach(() => {
  resetState()
})

function createFakeSpan (name, options = {}) {
  return {
    name,
    options,
    attributes: options.attributes || {},
    ended: false,
    endTimestamp: undefined,
    end (timestamp) {
      this.ended = true
      this.endTimestamp = timestamp
    },
    setAttributes (attrs) {
      this.attributes = { ...this.attributes, ...attrs }
    },
    setAttribute (key, value) {
      this.attributes[key] = value
    },
    setStatus () {},
    recordException () {},
    updateName (newName) {
      this.updatedName = newName
    },
  }
}

test('getMsgId prefers otelRootMsgId when present', () => {
  assert.equal(getMsgId({ _msgid: '1', otelRootMsgId: 'root' }), 'root')
  assert.equal(getMsgId({ _msgid: '1' }), '1')
})

test('getSpanId includes node id and respects split root id', () => {
  assert.equal(getSpanId({ _msgid: '1' }, { id: 'node', type: 'function' }), '1#node')
  assert.equal(getSpanId({ _msgid: '1', otelRootMsgId: 'root' }, { id: 'node', type: 'split' }), 'root#node')
})

test('isPrimitive recognises primitive values and arrays', () => {
  assert.equal(isPrimitive('hello'), true)
  assert.equal(isPrimitive(42), true)
  assert.equal(isPrimitive(false), true)
  assert.equal(isPrimitive(['a', 1, true]), true)
  assert.equal(isPrimitive([{ foo: 'bar' }]), false)
  assert.equal(isPrimitive({ foo: 'bar' }), false)
})

test('parseAttribute returns undefined when no mappings configured', () => {
  assert.equal(parseAttribute(false, { foo: 'bar' }, 'flow', 'type'), undefined)
})

test('parseAttribute filters mappings by flow, node type and timing', () => {
  setAttributeMappings([
    { flow: '', nodeType: '', isAfter: false, key: 'root', path: 'foo' },
    { flow: 'flow', nodeType: 'type', isAfter: false, key: 'matching', path: 'details.value' },
    { flow: 'flow', nodeType: 'type', isAfter: true, key: 'afterOnly', path: 'details.value' },
  ])
  const attributes = parseAttribute(false, { foo: 'ignored', details: { value: 'kept' } }, 'flow', 'type')
  assert.deepEqual(attributes, { root: 'ignored', matching: 'kept' })
  const afterAttributes = parseAttribute(true, { details: { value: 5 } }, 'flow', 'type')
  assert.deepEqual(afterAttributes, { afterOnly: 5 })
})

test('parseAttribute ignores non primitive results', () => {
  setAttributeMappings([
    { flow: '', nodeType: '', isAfter: false, key: 'object', path: '{ value: foo }' },
  ])
  const attributes = parseAttribute(false, { foo: { nested: true } }, 'flow', 'type')
  assert.deepEqual(attributes, {})
})

test('createSpan creates parent and child spans for new messages', () => {
  const startedSpans = []
  const tracer = {
    startSpan: (name, options) => {
      const span = createFakeSpan(name, options)
      startedSpans.push(span)
      return span
    },
  }
  const span = createSpan(tracer, { _msgid: '1' }, { id: 'node', type: 'function', name: 'Function', z: 'flow' }, {}, false)
  assert.equal(span.name, 'Function')
  assert.equal(startedSpans.length, 2)
  const spansMap = getMsgSpans()
  assert.equal(spansMap.size, 1)
  const entry = spansMap.get('1')
  assert.equal(entry.parentSpan, startedSpans[0])
  assert.ok(entry.spans.has('1#node'))
})

test('createSpan skips creation when span already exists', () => {
  const tracer = { startSpan: (name, options) => createFakeSpan(name, options) }
  const msg = { _msgid: '1' }
  const node = { id: 'node', type: 'function', name: 'Function', z: 'flow' }
  assert.ok(createSpan(tracer, msg, node, {}, false))
  assert.equal(createSpan(tracer, msg, node, {}, false), undefined)
})

test('createSpan stores fake span when tracing disabled for node', () => {
  const tracer = { startSpan: (name, options) => createFakeSpan(name, options) }
  const msg = { _msgid: '1' }
  const node = { id: 'node', type: 'function', name: 'Function', z: 'flow' }
  const span = createSpan(tracer, msg, node, {}, true)
  assert.equal(typeof span.end, 'function')
  const spansMap = getMsgSpans()
  const storedSpan = spansMap.get('1').spans.get('1#node')
  assert.notEqual(storedSpan, span)
  assert.equal(storedSpan.attributes['node_red.node.type'], 'function')
})

test('endSpan ends child span and clears parent when last span completes', () => {
  const tracer = { startSpan: (name, options) => createFakeSpan(name, options) }
  const msg = { _msgid: '1' }
  const node = { id: 'node', type: 'function', name: 'Function', z: 'flow' }
  const childSpan = createSpan(tracer, msg, node, {}, false)
  const entry = getMsgSpans().get('1')
  let parentEnded = false
  entry.parentSpan.end = () => { parentEnded = true }
  endSpan(msg, null, node)
  assert.equal(childSpan.ended, true)
  assert.equal(parentEnded, true)
  assert.equal(getMsgSpans().size, 0)
})

test('deleteOutdatedMsgSpans removes outdated entries', () => {
  const parentSpan = createFakeSpan('parent')
  const now = Date.now()
  const spans = getMsgSpans()
  spans.set('msg', { parentSpan, spans: new Map(), updateTimestamp: now - 100 })
  setTimeoutMs(0)
  deleteOutdatedMsgSpans()
  assert.equal(spans.size, 0)
  assert.equal(parentSpan.ended, true)
  assert.ok(parentSpan.endTimestamp <= now - 100)
})

test('logEvent should not log when logging is disabled', () => {
    setLogging(false);
    const consoleLogSpy = test.mock.method(console, 'log');
    logEvent({}, 'test', {});
    assert.equal(consoleLogSpy.mock.calls.length, 0);
});

test('createSpan should handle various node types correctly', () => {
    const tracer = {
        startSpan: (name, options) => createFakeSpan(name, options)
    };
    const msg = { _msgid: '1', req: { headers: {} } };
    const httpNode = { id: 'http-node', type: 'http in', name: 'HTTP In', z: 'flow' };
    const tcpNode = { id: 'tcp-node', type: 'tcp in', name: 'TCP In', z: 'flow' };

    createSpan(tracer, msg, httpNode, {}, false);
    const httpSpans = getMsgSpans().get('1');
    assert.ok(httpSpans.parentSpan);

    createSpan(tracer, { _msgid: '2' }, tcpNode, {}, false);
    const tcpSpans = getMsgSpans().get('2');
    assert.ok(tcpSpans.parentSpan);
});

test('createSpan should extract trace context from different sources', () => {
    const tracer = {
        startSpan: (name, options) => createFakeSpan(name, options)
    };
    const mqttMsg = { _msgid: '3', userProperties: {} };
    const mqttNode = { id: 'mqtt-node', type: 'mqtt in', name: 'MQTT In', z: 'flow' };
    createSpan(tracer, mqttMsg, mqttNode, {}, false);
    assert.ok(getMsgSpans().has('3'));

    const amqpMsg = { _msgid: '4', properties: { headers: {} } };
    const amqpNode = { id: 'amqp-node', type: 'amqp-in', name: 'AMQP In', z: 'flow' };
    createSpan(tracer, amqpMsg, amqpNode, {}, false);
    assert.ok(getMsgSpans().has('4'));
});

test('endSpan should handle http request and response correctly', () => {
    const tracer = { startSpan: (name, options) => createFakeSpan(name, options) };
    const msg = { _msgid: '1', statusCode: 200, responseUrl: 'http://example.com/test' };
    const node = { id: 'node', type: 'http request', name: 'HTTP Request', z: 'flow' };
    const childSpan = createSpan(tracer, { _msgid: '1' }, node, {}, false);
    endSpan(msg, null, node);
    assert.equal(childSpan.ended, true);
    assert.deepEqual(childSpan.attributes['http.response.status_code'], 200);
});

test('endSpan should handle errors correctly', () => {
    const tracer = { startSpan: (name, options) => createFakeSpan(name, options) };
    const msg = { _msgid: '1', error: new Error('test error') };
    const node = { id: 'node', type: 'function', name: 'Function', z: 'flow' };
    const childSpan = createSpan(tracer, msg, node, {}, false);
    const recordExceptionSpy = test.mock.method(childSpan, 'recordException');
    endSpan(msg, 'error', node);
    assert.equal(recordExceptionSpy.mock.calls.length, 1);
});
