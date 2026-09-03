// Tests for native Showrunner agent tools
//
// Focuses on input validation, error handling, and registry behavior
// Execution tests require mocked facade which is tested separately

import test from 'node:test';
import assert from 'node:assert';
import { createToolRegistry, publicToolList } from '../lib/server/agent/tools/registry.js';
import { generateImageTool } from '../lib/server/agent/tools/handlers/generateImage.js';
import { generateVideoTool } from '../lib/server/agent/tools/handlers/generateVideo.js';
import { getJobTool } from '../lib/server/agent/tools/handlers/getJob.js';
import { ToolError, ToolExecutionError } from '../lib/server/agent/tools/schema.js';
import { ToolNotFoundError, DuplicateToolError } from '../lib/server/agent/tools/registry.js';

// ── Test Setup ───────────────────────────────────────────────────────────

const mockContext = {
  threadId: 'thread-abc123',
  projectId: 'proj-xyz789',
  signal: null,
};

const mockContextNoThread = {
  threadId: null,
  projectId: 'proj-xyz789',
  signal: null,
};

const mockContextNoProject = {
  threadId: 'thread-abc123',
  projectId: null,
  signal: null,
};

// ── og.generate_image input validation tests ────────────────────────────

test('og.generate_image: reject missing threadId', async (t) => {
  try {
    await generateImageTool.execute(mockContextNoThread, { prompt: 'A sunset' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /threadId/i);
  }
});

test('og.generate_image: reject missing projectId', async (t) => {
  try {
    await generateImageTool.execute(mockContextNoProject, { prompt: 'A sunset' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /projeto/i);
  }
});

test('og.generate_image: reject empty prompt', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: '' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /obrigatório/i);
  }
});

test('og.generate_image: reject whitespace-only prompt', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: '   \n\t  ' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /obrigatório/i);
  }
});

test('og.generate_image: reject prompt too long (>4000)', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: 'x'.repeat(4001) });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /muito longo/i);
  }
});

test('og.generate_image: reject non-string aspect', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: 'Test', aspect: 123 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /aspect.*string/i);
  }
});

test('og.generate_image: reject non-integer seed', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: 'Test', seed: 3.14 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /seed.*inteiro/i);
  }
});

test('og.generate_image: reject negative seed', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: 'Test', seed: -1 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /seed.*inteiro/i);
  }
});

test('og.generate_image: reject unknown property', async (t) => {
  try {
    await generateImageTool.execute(mockContext, { prompt: 'Test', workflowId: 'custom' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /desconhecidas/i);
    assert.deepStrictEqual(e.detail.unknownKeys, ['workflowId']);
  }
});

test('og.generate_image: reject multiple unknown properties', async (t) => {
  try {
    await generateImageTool.execute(mockContext, {
      prompt: 'Test',
      unknown1: 'val',
      unknown2: 'val',
    });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /desconhecidas/i);
    assert.strictEqual(e.detail.unknownKeys.length, 2);
  }
});

test('og.generate_image: reject null args', async (t) => {
  try {
    await generateImageTool.execute(mockContext, null);
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
  }
});

test('og.generate_image: reject non-object args', async (t) => {
  try {
    await generateImageTool.execute(mockContext, 'not an object');
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
  }
});

// ── og.generate_video input validation tests ────────────────────────────

test('og.generate_video: reject missing threadId', async (t) => {
  try {
    await generateVideoTool.execute(mockContextNoThread, { prompt: 'Test' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /threadId/i);
  }
});

test('og.generate_video: reject missing projectId', async (t) => {
  try {
    await generateVideoTool.execute(mockContextNoProject, { prompt: 'Test' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /projeto/i);
  }
});

test('og.generate_video: reject empty prompt', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: '' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /obrigatório/i);
  }
});

test('og.generate_video: reject prompt too long', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'x'.repeat(4001) });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /muito longo/i);
  }
});

test('og.generate_video: reject non-string aspect', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', aspect: [] });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /aspect.*string/i);
  }
});

test('og.generate_video: reject duration < 1', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', duration: 0 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /duration.*1.*20/i);
  }
});

test('og.generate_video: reject duration > 20', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', duration: 21 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /duration.*1.*20/i);
  }
});

test('og.generate_video: reject non-numeric duration', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', duration: 'five' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /duration.*1.*20/i);
  }
});

test('og.generate_video: reject non-integer seed', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', seed: 'abc' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /seed.*inteiro/i);
  }
});

test('og.generate_video: reject negative seed', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, { prompt: 'Test', seed: -10 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /seed.*inteiro/i);
  }
});

test('og.generate_video: reject non-string sourceAssetId', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, {
      prompt: 'Test',
      sourceAssetId: 12345,
    });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /sourceAssetId.*string/i);
  }
});

test('og.generate_video: reject unknown property', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, {
      prompt: 'Test',
      customParam: 'value',
    });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /desconhecidas/i);
    assert.deepStrictEqual(e.detail.unknownKeys, ['customParam']);
  }
});

test('og.generate_video: reject null args', async (t) => {
  try {
    await generateVideoTool.execute(mockContext, null);
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
  }
});

// ── og.get_job input validation tests ──────────────────────────────────

test('og.get_job: reject missing threadId', async (t) => {
  try {
    await getJobTool.execute(mockContextNoThread, { jobId: 'job-123' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /threadId/i);
  }
});

test('og.get_job: reject missing projectId', async (t) => {
  try {
    await getJobTool.execute(mockContextNoProject, { jobId: 'job-123' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /projeto/i);
  }
});

test('og.get_job: reject missing jobId', async (t) => {
  try {
    await getJobTool.execute(mockContext, {});
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /jobId.*obrigatório/i);
  }
});

test('og.get_job: reject empty jobId', async (t) => {
  try {
    await getJobTool.execute(mockContext, { jobId: '' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /jobId.*obrigatório/i);
  }
});

test('og.get_job: reject whitespace jobId', async (t) => {
  try {
    await getJobTool.execute(mockContext, { jobId: '  \n  ' });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /jobId.*obrigatório/i);
  }
});

test('og.get_job: reject non-string jobId', async (t) => {
  try {
    await getJobTool.execute(mockContext, { jobId: 12345 });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /jobId.*obrigatório/i);
  }
});

test('og.get_job: reject unknown property', async (t) => {
  try {
    await getJobTool.execute(mockContext, {
      jobId: 'job-123',
      extraField: 'value',
    });
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
    assert.match(e.message, /desconhecidas/i);
    assert.deepStrictEqual(e.detail.unknownKeys, ['extraField']);
  }
});

test('og.get_job: reject null args', async (t) => {
  try {
    await getJobTool.execute(mockContext, null);
    assert.fail('Should throw ToolExecutionError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolExecutionError');
  }
});

// ── Tool Registry tests ────────────────────────────────────────────────

test('Tool Registry: creates and registers tools', async (t) => {
  const registry = createToolRegistry([generateImageTool, generateVideoTool, getJobTool]);
  assert.ok(registry.hasTool('og.generate_image'));
  assert.ok(registry.hasTool('og.generate_video'));
  assert.ok(registry.hasTool('og.get_job'));
});

test('Tool Registry: getTool returns tool with execute', async (t) => {
  const registry = createToolRegistry([generateImageTool]);
  const tool = registry.getTool('og.generate_image');
  assert.ok(tool.execute);
  assert.strictEqual(typeof tool.execute, 'function');
  assert.ok(tool.name);
  assert.ok(tool.description);
  assert.ok(tool.inputSchema);
});

test('Tool Registry: getTool unknown tool throws ToolNotFoundError', async (t) => {
  const registry = createToolRegistry([generateImageTool]);
  try {
    registry.getTool('og.nonexistent');
    assert.fail('Should throw ToolNotFoundError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolNotFoundError');
    assert.ok(e.message.includes('og.nonexistent'));
  }
});

test('Tool Registry: listTools returns all tools', async (t) => {
  const registry = createToolRegistry([generateImageTool, generateVideoTool, getJobTool]);
  const tools = registry.listTools();
  assert.strictEqual(tools.length, 3);
  assert.ok(tools.some(t => t.name === 'og.generate_image'));
  assert.ok(tools.some(t => t.name === 'og.generate_video'));
  assert.ok(tools.some(t => t.name === 'og.get_job'));
});

test('Tool Registry: listTools includes execute handler', async (t) => {
  const registry = createToolRegistry([generateImageTool]);
  const tools = registry.listTools();
  tools.forEach(tool => {
    assert.strictEqual(typeof tool.execute, 'function',
      `Tool ${tool.name} should have execute for internal use`);
  });
});

test('Tool Registry: duplicate tool name throws DuplicateToolError', async (t) => {
  const tool = generateImageTool;
  try {
    createToolRegistry([tool, tool]);
    assert.fail('Should throw DuplicateToolError');
  } catch (e) {
    assert.strictEqual(e.name, 'DuplicateToolError');
  }
});

test('Tool Registry: invalid descriptor throws ToolError', async (t) => {
  const notATool = { name: 'invalid' };
  try {
    createToolRegistry([notATool]);
    assert.fail('Should throw ToolError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolError');
  }
});

test('publicToolList: strips execute handlers', async (t) => {
  const registry = createToolRegistry([generateImageTool, generateVideoTool]);
  const publicTools = publicToolList(registry);

  assert.strictEqual(publicTools.length, 2);
  publicTools.forEach(tool => {
    assert.ok(tool.name);
    assert.ok(tool.description);
    assert.ok(tool.inputSchema);
    assert.strictEqual(tool.execute, undefined,
      `Public tool ${tool.name} should not expose execute`);
  });
});

test('publicToolList: preserves schema correctness', async (t) => {
  const registry = createToolRegistry([generateImageTool]);
  const publicTools = publicToolList(registry);
  const imageTool = publicTools[0];

  assert.strictEqual(imageTool.name, 'og.generate_image');
  assert.ok(imageTool.description.length > 0);
  assert.strictEqual(imageTool.inputSchema.type, 'object');
  assert.ok(Array.isArray(imageTool.inputSchema.required));
  assert.strictEqual(imageTool.inputSchema.required[0], 'prompt');
});

// ── Tool invocation tests ────────────────────────────────────────────────

test('Tool Registry: invoke with unknown tool throws ToolNotFoundError', async (t) => {
  const registry = createToolRegistry([generateImageTool]);
  try {
    await registry.invoke('og.nonexistent', mockContext, {});
    assert.fail('Should throw ToolNotFoundError');
  } catch (e) {
    assert.strictEqual(e.name, 'ToolNotFoundError');
  }
});

// ── Error class tests ──────────────────────────────────────────────────

test('ToolExecutionError: stores detail object', async (t) => {
  const error = new ToolExecutionError('Test message', { code: 'TEST_ERROR' });
  assert.strictEqual(error.name, 'ToolExecutionError');
  assert.strictEqual(error.message, 'Test message');
  assert.deepStrictEqual(error.detail, { code: 'TEST_ERROR' });
});

test('ToolNotFoundError: formats properly', async (t) => {
  const error = new ToolNotFoundError('og.unknown');
  assert.strictEqual(error.name, 'ToolNotFoundError');
  assert.ok(error.message.includes('og.unknown'));
});

test('DuplicateToolError: formats properly', async (t) => {
  const error = new DuplicateToolError('og.generate_image');
  assert.strictEqual(error.name, 'DuplicateToolError');
  assert.ok(error.message.includes('og.generate_image'));
});
